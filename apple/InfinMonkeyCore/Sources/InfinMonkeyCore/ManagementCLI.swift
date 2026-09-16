import Foundation

/// The management command line: the developer-facing half of the app binary.
///
/// It exists because the store is a plain directory of files and the interesting
/// questions about it ("what does the host think the revision is?", "what would
/// we send to the app?") are answerable without a window. Every command writes
/// JSON to stdout so the output composes with `jq` and with tests; diagnostics
/// go to stderr.
///
/// Sandbox note: this runs inside the app's sandbox, so it cannot open arbitrary
/// paths — `~/Downloads/foo.user.js` is refused by the sandbox, not by this code.
/// Reading a file the shell opened (`infinmonkey import < script.user.js`) works
/// because the file descriptor is opened by the parent; a caller-supplied path
/// does not. That is why `import` reads stdin instead of taking a path.
public struct ManagementCLI: Sendable {
  public typealias Log = @Sendable (String) -> Void

  /// Exit codes, conventional for a command line tool.
  public enum Exit: Int32 {
    case ok = 0
    /// The command line itself was wrong.
    case usage = 2
    /// The command ran and failed.
    case failed = 1
  }

  private let service: LibraryService
  private let input: FileHandle
  private let output: FileHandle
  private let log: Log

  public init(
    service: LibraryService,
    input: FileHandle = .standardInput,
    output: FileHandle = .standardOutput,
    log: @escaping Log = { FileHandle.standardError.write(Data(($0 + "\n").utf8)) }
  ) {
    self.service = service
    self.input = input
    self.output = output
    self.log = log
  }

  /// Entry for `main.swift`: runs the subcommand and ends the process with its
  /// exit code. See `runToCompletionAndExit` for why this does not simply return.
  public func runAndExit(subcommand: String, arguments: [String]) -> Never {
    runToCompletionAndExit { await self.run(subcommand: subcommand, arguments: arguments) }
  }

  public func run(subcommand: String, arguments: [String]) async -> Int32 {
    do {
      switch subcommand {
      case "version", "--version": return try emit(VersionReport())
      case "status": return try await status()
      case "list": return try await list()
      case "export": return try await exportBundle()
      case "import": return try await importFromStdin(arguments: arguments)
      case "help", "--help", "-h":
        // Asked for, not an error: help the user requested goes to stdout so
        // `infinmonkey --help | less` shows something. Usage text printed
        // *because* of a mistake stays on stderr (see the default case).
        try write(Data(Self.usage.utf8))
        return Exit.ok.rawValue
      default:
        log("infinmonkey: unknown subcommand '\(subcommand)'\n\n\(Self.usage)")
        return Exit.usage.rawValue
      }
    } catch {
      log("infinmonkey: \(subcommand) failed: \(Self.describe(error))")
      return Exit.failed.rawValue
    }
  }

  // MARK: - Commands

  private func status() async throws -> Int32 {
    // The store itself reports failure per call, so a broken location shows up
    // as a report rather than as a command that cannot run: the point of this
    // command is to say what is wrong.
    if let locationError = service.locationError {
      return try emit(
        StatusReport(
          storagePath: nil, locationError: locationError, rev: nil, scripts: nil, styles: nil))
    }
    let snapshot = try await service.summaries()
    return try emit(
      StatusReport(
        storagePath: service.storagePath.isEmpty ? nil : service.storagePath,
        locationError: nil,
        rev: snapshot.rev,
        scripts: snapshot.entries.filter { $0.kind == .script }.count,
        styles: snapshot.entries.filter { $0.kind == .style }.count))
  }

  private func list() async throws -> Int32 {
    let snapshot = try await service.summaries()
    let entries = snapshot.entries
      .sorted { ($0.position, $0.id) < ($1.position, $1.id) }
      .map(EntryReport.init(summary:))
    return try emit(ListReport(rev: snapshot.rev, entries: entries))
  }

  private func exportBundle() async throws -> Int32 {
    try write(try await service.exportData())
    return Exit.ok.rawValue
  }

  private func importFromStdin(arguments: [String]) async throws -> Int32 {
    var mode = ImportMode.merge
    var fileName: String?
    for argument in arguments {
      switch argument {
      case "--replace": mode = .replace
      case "--merge": mode = .merge
      default:
        guard !argument.hasPrefix("-") else {
          log("infinmonkey: unknown option '\(argument)' for import\n\n\(Self.usage)")
          return Exit.usage.rawValue
        }
        // The shell knows the name; a pipe does not, so the caller supplies it
        // when what is on stdin is a single script or style rather than a bundle.
        guard fileName == nil else {
          // Silently keeping the last one would import under a name the caller
          // did not intend, and the name decides what the bytes mean.
          log(
            "infinmonkey: import takes at most one name (got '\(fileName!)' and '\(argument)')\n\n\(Self.usage)"
          )
          return Exit.usage.rawValue
        }
        fileName = argument
      }
    }
    let name = fileName ?? "bundle.json"
    let data = input.readDataToEndOfFile()
    try await service.importData(data, fileName: name, mode: mode)
    log("infinmonkey: imported \(data.count) bytes from stdin as \(name) (\(mode.rawValue))")
    return Exit.ok.rawValue
  }

  // MARK: - Reports

  private struct VersionReport: Encodable {
    var app = CoreConstants.appName
    var version = CoreConstants.storeVersionString
    var platform = PlatformName.current
    var protocolVersion = CoreConstants.protocolVersion
    var storeVersion = CoreConstants.storeVersion
  }

  private struct StatusReport: Encodable {
    var app = CoreConstants.appName
    var platform = PlatformName.current
    var storagePath: String?
    var locationError: String?
    var rev: Int?
    var scripts: Int?
    var styles: Int?
  }

  private struct ListReport: Encodable {
    var rev: Int
    var entries: [EntryReport]
  }

  private struct EntryReport: Encodable {
    var id: String
    var kind: String
    var name: String?
    var version: String?
    var enabled: Bool
    var position: Int
    var updatedAt: Int64
    var metaStale: Bool

    init(summary: EntrySummary) {
      self.id = summary.id
      self.kind = summary.kind.rawValue
      self.name = summary.name
      self.version = summary.version
      self.enabled = summary.enabled
      self.position = summary.position
      self.updatedAt = summary.updatedAt
      self.metaStale = summary.metaStale
    }
  }

  // MARK: - Output

  private func emit(_ report: some Encodable) throws -> Int32 {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    try write(try encoder.encode(report))
    return Exit.ok.rawValue
  }

  /// Writes a payload followed by a newline, so the output ends a line whether
  /// or not the caller is looking at a terminal.
  private func write(_ data: Data) throws {
    var out = data
    out.append(0x0A)
    try output.write(contentsOf: out)
  }

  /// `ImportError` carries payloads rather than wording (the UI picks the
  /// language), so the command line phrases it here.
  private static func describe(_ error: Error) -> String {
    guard let importError = error as? ImportError else { return String(describing: error) }
    switch importError {
    case .invalidBundle(let underlying):
      return "not a valid export bundle: \(underlying)"
    case .unrecognizedFileType(let name):
      return "'\(name)': expected a .json bundle or a .user.js/.user.css entry"
    case .notUTF8(let name):
      return "'\(name)': not valid UTF-8"
    }
  }

  static let usage = """
    usage: infinmonkey <subcommand>

      version           protocol and store versions this build speaks
      status            store location, revision, entry counts
      list              entries with id, kind, name, and enabled state (JSON)
      export            the export bundle, to stdout
      import [opts] [name]
                        read a bundle (name ending .json, the default) or one
                        entry (.user.js / .user.css) from stdin
                        --merge (default) | --replace

    Exit codes: 0 ok, 1 failed, 2 usage.
    """
}
