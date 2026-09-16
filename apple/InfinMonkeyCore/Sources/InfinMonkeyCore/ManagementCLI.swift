import ArgumentParser
import Foundation

/// The management command line: the developer-facing half of the app binary.
///
/// It exists because the store is a plain directory of files and the interesting
/// questions about it ("what does the host think the revision is?", "what would
/// we send to the app?") are answerable without a window. Every command writes
/// JSON to stdout so the output composes with `jq` and with tests; diagnostics
/// go to stderr.
///
/// Argument syntax, help text, and usage errors come from ArgumentParser
/// (`CLICommands.swift`); this type maps a parsed command to an `Invocation` and
/// executes it against an injected store and streams. That split is what makes
/// the executor testable — no command reaches for `FileHandle.standardOutput` or
/// builds its own store — while the grammar stays declarative.
public struct ManagementCLI: Sendable {
  public typealias Log = @Sendable (String) -> Void

  /// Exit codes this executor returns.
  ///
  /// A rejected command line is not here: ArgumentParser owns that path and
  /// exits with EX_USAGE (64) itself, which is why the executor never returns a
  /// usage code of its own.
  public enum Exit: Int32 {
    case ok = 0
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

  /// Entry for `main.swift`: runs the command and ends the process with its exit
  /// code. See `runToCompletionAndExit` for why this does not simply return.
  ///
  /// - Parameter arguments: everything after the executable, as the shell split
  ///   it. The browsers' calling convention never reaches here — `LaunchMode`
  ///   recognizes a host launch first.
  public func runAndExit(arguments: [String]) -> Never {
    runToCompletionAndExit { await self.run(arguments: arguments) }
  }

  /// Parses `arguments` and runs what they name.
  public func run(arguments: [String]) async -> Int32 {
    let command: ParsableCommand
    do {
      command = try InfinMonkeyCommand.parseAsRoot(arguments)
    } catch {
      // A rejected command line. ArgumentParser owns that rendering (its
      // renderer is internal, `exit(withError:)` is the supported way in), and
      // it writes to stderr and exits with EX_USAGE — which is what a rejected
      // command line should do.
      InfinMonkeyCommand.exit(withError: error)
    }

    guard let invocation = Invocation(command) else {
      // Help, or the bare root: nothing to run, so print the help that fits.
      // This is a normal path, not an error — `--help` parses successfully
      // rather than throwing, so the request arrives here as a command that maps
      // to no invocation.
      // Help does not end in a newline of its own, so the shell prompt would
      // land on the last line.
      write(Data((Self.help(for: arguments) + "\n").utf8))
      return Exit.ok.rawValue
    }
    return await execute(invocation)
  }

  // MARK: - Dispatch

  private func execute(_ invocation: Invocation) async -> Int32 {
    do {
      switch invocation {
      case .version: return try emit(VersionReport())
      case .status: return try await status()
      case .list: return try await list()
      case .export: return try await exportBundle()
      case .importPayload(let fileName, let replace):
        return try await importFromStdin(fileName: fileName, mode: replace ? .replace : .merge)
      }
    } catch {
      log("infinmonkey: \(invocation.name) failed: \(Self.describe(error))")
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
    write(try await service.exportData())
    return Exit.ok.rawValue
  }

  private func importFromStdin(fileName: String?, mode: ImportMode) async throws -> Int32 {
    // The shell knows the name; a pipe does not, so the caller supplies it when
    // what is on stdin is a single script or style rather than a bundle.
    let name = fileName ?? "bundle.json"
    let data = input.readDataToEndOfFile()
    try await service.importData(data, fileName: name, mode: mode)
    log("infinmonkey: imported \(data.count) bytes from stdin as \(name) (\(mode.rawValue))")
    return Exit.ok.rawValue
  }

  // MARK: - Help

  /// Help for whichever command the arguments name, or the root's.
  ///
  /// Candidates come from the configuration rather than a second list, so adding
  /// a subcommand updates both the grammar and this lookup at once. The match is
  /// by subcommand *type*: `configuration.commandName` is only set for commands
  /// whose name differs from the type (`import`), so matching on it sent every
  /// other command's `--help` to the root's help.
  static func help(for arguments: [String]) -> String {
    guard let name = arguments.first(where: { !$0.hasPrefix("-") }) else {
      return InfinMonkeyCommand.helpMessage()
    }
    let match = InfinMonkeyCommand.configuration.subcommands.first { $0._commandName == name }
    guard let match else { return InfinMonkeyCommand.helpMessage() }
    // The library resolves the command stack, so the rendered screen is the same
    // one `--help` would produce for that subcommand.
    return InfinMonkeyCommand.helpMessage(for: match)
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
    var payload = try encoder.encode(report)
    payload.append(0x0A)
    write(payload)
    return Exit.ok.rawValue
  }

  private func write(_ data: Data) {
    try? output.write(contentsOf: data)
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
}

extension Invocation {
  /// The command name, for a failure message.
  fileprivate var name: String {
    switch self {
    case .version: return "version"
    case .status: return "status"
    case .list: return "list"
    case .export: return "export"
    case .importPayload: return "import"
    }
  }
}
