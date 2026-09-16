import ArgumentParser
import Foundation
import Testing

@testable import InfinMonkeyCore

/// The management command line's executor.
///
/// Only *valid* command lines are exercised here, and that is a constraint of the
/// library rather than a choice: ArgumentParser renders usage errors through
/// `exit(withError:)`, whose supported path terminates the process, so a test
/// that fed it a rejected command line would kill the test runner. The grammar
/// is covered instead by `InvocationTests` below (what each spelling means) and
/// by the CLI cases in `LaunchModeTests` (what a launch looks like), while this
/// suite asserts what the commands *do* to an injected store.
///
/// Reports are asserted as parsed JSON with the load-bearing members checked,
/// not byte-for-byte: this is a diagnostic surface, so pinning its full spelling
/// would fail every time a field is added while missing what matters.
@Suite("Management CLI")
struct ManagementCLITests {

  private struct Run {
    var code: Int32
    var stdout: Data
    var stderr: String

    var json: [String: Any]? {
      try? JSONSerialization.jsonObject(with: stdout) as? [String: Any]
    }
  }

  /// Runs arguments against `store`, over pipes.
  private func run(_ arguments: [String], stdin: Data = Data(), store: NativeStore) async throws
    -> Run
  {
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

    let code = await cli.run(arguments: arguments)
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
    let result = try await run(["version"], store: try await seededStore())
    #expect(result.code == 0)
    let json = try #require(result.json)
    #expect(json["app"] as? String == CoreConstants.appName)
    #expect(json["protocolVersion"] as? Int == CoreConstants.protocolVersion)
  }

  @Test("status counts what is in the store")
  func statusCountsEntries() async throws {
    let result = try await run(["status"], store: try await seededStore())
    #expect(result.code == 0)
    let json = try #require(result.json)
    #expect(json["scripts"] as? Int == 1)
    #expect(json["styles"] as? Int == 0)
    #expect(json["locationError"] == nil)
    #expect(json["storagePath"] as? String != nil)
  }

  @Test("list reports the entries with their ids")
  func listReportsEntries() async throws {
    let result = try await run(["list"], store: try await seededStore())
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
    let result = try await run(["import", "piped.user.js"], stdin: Data(code.utf8), store: store)

    #expect(result.code == 0)
    // Diagnostics go to stderr, so stdout stays parseable.
    #expect(result.stderr.contains("piped.user.js"))
    #expect(result.stdout.isEmpty)

    let after = try await run(["status"], store: store)
    #expect(after.json?["scripts"] as? Int == 2)
  }

  @Test("import defaults to a bundle name when none is given")
  func importDefaultsToBundle() async throws {
    // A pipe has no path to read a name from, so the default has to describe a
    // bundle — which is what makes `infinmonkey export | infinmonkey import` work.
    let store = try await seededStore()
    let bundle = try await run(["export"], store: store).stdout
    let result = try await run(["import"], stdin: bundle, store: store)

    #expect(result.code == 0)
    #expect(result.stderr.contains("bundle.json"))
  }

  @Test("import --replace is read as a flag, and replaces rather than merges")
  func importReplaceFlag() async throws {
    let store = try await seededStore()
    // A real bundle: the default name means stdin must carry one, and the point
    // here is the flag, not the payload's shape.
    let bundle = try await run(["export"], store: store).stdout
    let result = try await run(["import", "--replace"], stdin: bundle, store: store)

    #expect(result.code == 0)
    #expect(result.stderr.contains("replace"), "the chosen mode is reported")
    // Replace wipes first, so the count is the bundle's own rather than a sum.
    let after = try await run(["status"], store: store)
    #expect(after.json?["scripts"] as? Int == 1)
  }

  @Test("export writes a bundle that can be read back")
  func exportWritesBundle() async throws {
    let result = try await run(["export"], store: try await seededStore())
    #expect(result.code == 0)
    let json = try #require(
      try JSONSerialization.jsonObject(with: result.stdout) as? [String: Any])
    #expect(json["infinmonkey"] as? Int == 1)
    #expect((json["scripts"] as? [Any])?.count == 1)
  }

  @Test("help is printed for the root and for a named subcommand")
  func helpIsPrinted() async throws {
    // `--help` parses successfully and arrives as a command mapping to no
    // invocation, which is the path that renders help.
    for (arguments, expected) in [
      (["--help"], "SUBCOMMANDS"),
      (["help"], "SUBCOMMANDS"),
      (["import", "--help"], "--replace"),
    ] {
      let result = try await run(arguments, store: try await seededStore())
      #expect(result.code == 0, "\(arguments) should exit cleanly")
      let text = String(decoding: result.stdout, as: UTF8.self)
      #expect(text.contains(expected), "\(arguments) help should mention \(expected)")
    }
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

    let code = await cli.run(arguments: ["status"])
    try outPipe.fileHandleForWriting.close()
    let out = try outPipe.fileHandleForReading.readToEnd() ?? Data()

    #expect(code == 0)
    let json = try #require(try JSONSerialization.jsonObject(with: out) as? [String: Any])
    #expect(json["locationError"] as? String == "no app group container")
    #expect(json["rev"] == nil)
  }
}

/// What each accepted spelling means.
///
/// Parse succeeded for all of these, so enumerating them here documents the
/// grammar's surface without depending on how ArgumentParser reports a rejection.
@Suite("Invocation mapping")
struct InvocationTests {

  private func invocation(_ arguments: [String]) throws -> Invocation? {
    Invocation(try InfinMonkeyCommand.parseAsRoot(arguments))
  }

  @Test("each subcommand maps to its own invocation")
  func subcommandsMap() throws {
    #expect(try invocation(["version"]) == .version)
    #expect(try invocation(["status"]) == .status)
    #expect(try invocation(["list"]) == .list)
    #expect(try invocation(["export"]) == .export)
  }

  @Test("import carries the optional name and the replace flag")
  func importArguments() throws {
    #expect(try invocation(["import"]) == .importPayload(fileName: nil, replace: false))
    #expect(
      try invocation(["import", "a.user.js"])
        == .importPayload(fileName: "a.user.js", replace: false))
    #expect(
      try invocation(["import", "--replace"])
        == .importPayload(fileName: nil, replace: true))
    #expect(
      try invocation(["import", "a.user.js", "--replace"])
        == .importPayload(fileName: "a.user.js", replace: true))
  }

  @Test("help and the bare root name nothing to run")
  func helpMapsToNoInvocation() throws {
    // Both parse cleanly; the difference from a rejection is the whole reason
    // the executor can treat them as a normal path.
    for arguments in [["--help"], ["help"], []] as [[String]] {
      #expect(try invocation(arguments) == nil, "\(arguments) should map to nothing")
    }
  }

  @Test("help text is chosen by the command the arguments name")
  func helpTargetsTheNamedCommand() {
    #expect(ManagementCLI.help(for: ["--help"]).contains("SUBCOMMANDS"))
    #expect(ManagementCLI.help(for: ["import", "--help"]).contains("--replace"))
    // An unknown word falls back to the root rather than producing nothing.
    #expect(ManagementCLI.help(for: ["nonexistent"]).contains("SUBCOMMANDS"))
  }
}
