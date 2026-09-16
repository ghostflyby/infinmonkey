import Foundation
import Testing

@testable import InfinMonkeyCore

/// The management command line, driven through its real entry point.
///
/// Output is asserted as parsed JSON with a couple of load-bearing members
/// checked, rather than byte-for-byte: the report is a diagnostic surface, so
/// pinning its full spelling would make every added field a test failure while
/// missing the things that actually matter (exit codes and whether the store was
/// consulted at all).
@Suite("Management CLI")
struct ManagementCLITests {

  private struct Run {
    var code: Int32
    var stdout: Data
    var stderr: String

    var json: [String: Any]? {
      try? JSONSerialization.jsonObject(with: stdout) as? [String: Any]
    }
    var lines: [String] {
      String(decoding: stdout, as: UTF8.self)
        .split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
    }
  }

  /// Runs a subcommand against `store`, over pipes.
  private func run(
    _ subcommand: String,
    arguments: [String] = [],
    stdin: Data = Data(),
    store: NativeStore
  ) async throws -> Run {
    let inPipe = Pipe()
    let outPipe = Pipe()
    let errPipe = Pipe()
    inPipe.fileHandleForWriting.write(stdin)
    try inPipe.fileHandleForWriting.close()

    let cli = ManagementCLI(
      service: LibraryService(store: store, storagePath: store.layout.root.path),
      input: inPipe.fileHandleForReading,
      output: outPipe.fileHandleForWriting,
      log: { line in errPipe.fileHandleForWriting.write(Data((line + "\n").utf8)) })

    let code = await cli.run(subcommand: subcommand, arguments: arguments)
    try outPipe.fileHandleForWriting.close()
    try errPipe.fileHandleForWriting.close()
    return Run(
      code: code,
      stdout: try outPipe.fileHandleForReading.readToEnd() ?? Data(),
      stderr: String(
        decoding: try errPipe.fileHandleForReading.readToEnd() ?? Data(), as: UTF8.self))
  }

  /// A store holding one script, which is what most of these cases start from.
  private func seededStore() async throws -> NativeStore {
    let store = NativeStore(layout: StoreLayout(root: temporaryRoot()))
    _ = try await store.create(
      kind: .script,
      code: scriptCode(name: "cli-test"),
      meta: nil,
      source: .inline,
      enabled: true,
      values: NativeStore.emptyJSONObject)
    return store
  }

  @Test("version reports this build's protocol and store versions")
  func versionReportsContract() async throws {
    let result = try await run("version", store: try await seededStore())
    #expect(result.code == 0)
    let json = try #require(result.json)
    #expect(json["app"] as? String == CoreConstants.appName)
    #expect(json["protocolVersion"] as? Int == CoreConstants.protocolVersion)
  }

  @Test("status counts what is in the store")
  func statusCountsEntries() async throws {
    let result = try await run("status", store: try await seededStore())
    #expect(result.code == 0)
    let json = try #require(result.json)
    #expect(json["scripts"] as? Int == 1)
    #expect(json["styles"] as? Int == 0)
    #expect(json["locationError"] == nil)
    #expect(json["storagePath"] as? String != nil)
  }

  @Test("list reports the entries with their ids")
  func listReportsEntries() async throws {
    let result = try await run("list", store: try await seededStore())
    #expect(result.code == 0)
    let json = try #require(result.json)
    let entries = try #require(json["entries"] as? [[String: Any]])
    #expect(entries.count == 1)
    #expect(entries.first?["kind"] as? String == "script")
    // The name is not set: only the extension parses headers, and this store was
    // seeded with `meta: nil`. The report must not invent one.
    #expect(entries.first?["name"] is NSNull || entries.first?["name"] == nil)
  }

  @Test("import reads one entry from stdin, because a sandbox cannot open a path")
  func importReadsEntryFromStdin() async throws {
    let code = "// ==UserScript==\n// @name piped\n// ==/UserScript==\n"
    // One store across both invocations: the point is that the import landed.
    let store = try await seededStore()
    let result = try await run(
      "import", arguments: ["piped.user.js"], stdin: Data(code.utf8), store: store)

    #expect(result.code == 0)
    // Diagnostics go to stderr, so stdout stays parseable.
    #expect(result.stderr.contains("piped.user.js"))
    #expect(result.stdout.isEmpty)

    let after = try await run("status", store: store)
    #expect(after.json?["scripts"] as? Int == 2)
  }

  @Test("import of a name it does not recognize is a failure, not a silent skip")
  func importRejectsUnknownFileType() async throws {
    let result = try await run(
      "import", arguments: ["notes.txt"], stdin: Data("hello".utf8), store: try await seededStore())
    #expect(result.code == 1)
    #expect(result.stderr.contains("notes.txt"))
  }

  @Test("export writes a bundle that can be read back")
  func exportWritesBundle() async throws {
    let result = try await run("export", store: try await seededStore())
    #expect(result.code == 0)
    let json = try #require(
      try JSONSerialization.jsonObject(with: result.stdout) as? [String: Any])
    #expect(json["infinmonkey"] as? Int == 1)
    #expect((json["scripts"] as? [Any])?.count == 1)
  }

  @Test("an unknown subcommand reports usage and exits 2")
  func unknownSubcommandIsUsage() async throws {
    let result = try await run("bogus", store: try await seededStore())
    #expect(result.code == ManagementCLI.Exit.usage.rawValue)
    #expect(result.stdout.isEmpty)
    #expect(result.stderr.contains("unknown subcommand"))
  }

  @Test("import rejects an unknown option with usage")
  func importRejectsUnknownOption() async throws {
    let result = try await run(
      "import", arguments: ["--wat"], stdin: Data(), store: try await seededStore())
    #expect(result.code == ManagementCLI.Exit.usage.rawValue)
    #expect(result.stderr.contains("--wat"))
  }

  @Test("a store that cannot be located is reported, not fatal")
  func unavailableStoreIsReported() async throws {
    // This is the unsigned-developer-build case: the point of `status` is to say
    // what is wrong, so it must run and report rather than refuse to start.
    let inPipe = Pipe()
    let outPipe = Pipe()
    try inPipe.fileHandleForWriting.close()
    let cli = ManagementCLI(
      service: .unavailable(error: "no app group container"),
      input: inPipe.fileHandleForReading,
      output: outPipe.fileHandleForWriting,
      log: { _ in })

    let code = await cli.run(subcommand: "status", arguments: [])
    try outPipe.fileHandleForWriting.close()
    let out = try outPipe.fileHandleForReading.readToEnd() ?? Data()

    #expect(code == 0)
    let json = try #require(try JSONSerialization.jsonObject(with: out) as? [String: Any])
    #expect(json["locationError"] as? String == "no app group container")
    #expect(json["rev"] == nil)
  }
}
