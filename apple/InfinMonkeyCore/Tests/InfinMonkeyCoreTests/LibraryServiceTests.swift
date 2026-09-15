import Foundation
import Testing

@testable import InfinMonkeyCore

func fixtureURL(_ name: String, file: StaticString = #filePath) throws -> URL {
  URL(fileURLWithPath: "\(file)")
    .deletingLastPathComponent()
    .appendingPathComponent("../../../../packages/tests/fixtures/protocol/\(name)")
}

@Suite struct LibraryServiceTests {

  private func service(_ store: FakeStore) -> LibraryService {
    LibraryService(store: store, storagePath: "/tmp/fake")
  }

  @Test func createUsesScaffoldAndParsedMeta() async throws {
    let store = FakeStore()
    let created = try await service(store).create(kind: .script)

    #expect(created.code.contains("==UserScript=="))
    #expect(created.record.meta?.name == "新脚本")
    #expect(created.record.meta?.headerFound ?? false)
    #expect(!created.record.metaStale)
    // The scaffold declares its own @match, so it is complete enough to run.
    #expect(created.record.meta?.matches == ["https://example.org/*"])
    #expect(created.values != nil, "a new script starts with an empty values object")
  }

  @Test func createStyleHasNoValuesFile() async throws {
    let store = FakeStore()
    let created = try await service(store).create(kind: .style)
    #expect(created.record.kind == .style)
    #expect(created.code.contains("==UserStyle=="))
    #expect(created.values == nil)
  }

  @Test func saveMetadataOnUnparsedEntrySurvivesAndStaysStale() async throws {
    // An entry created from a dropped file: no parsed metadata yet.
    let store = NativeStore(root: temporaryRoot())
    let created = try await store.create(
      kind: .script, code: scriptCode(), meta: nil, source: .inline, enabled: true, values: nil)
    let service = LibraryService(store: store, storagePath: "/tmp/unused")

    let saved = try await service.saveMetadata(
      id: created.record.id, name: "我的脚本", version: "1.2.0", description: "说明")
    #expect(saved.record.meta?.name == "我的脚本")
    #expect(saved.record.meta?.version == "1.2.0")
    #expect(saved.record.meta?.description == "说明")
    #expect(
      saved.record.metaStale,
      "a hand-written summary says nothing about match rules, so parsing is still required")

    // The regression this guards: the edit used to be serialized away, so a
    // fresh reader saw an empty name.
    let reloaded = try await NativeStore(root: store.layout.root).entry(id: created.record.id)
    #expect(reloaded.record.meta?.name == "我的脚本", "the edit must reach disk")
    #expect(reloaded.record.metaStale)
  }

  @Test func parsedMetadataClearsStale() async throws {
    let store = NativeStore(root: temporaryRoot())
    let created = try await store.create(
      kind: .script, code: scriptCode(), meta: nil, source: .inline, enabled: true, values: nil)
    let service = LibraryService(store: store, storagePath: "/tmp/unused")

    var parsed = demoMeta(name: "Parsed")
    parsed = parsed.withSummary(name: "Parsed", version: "", description: "")
    let saved = try await service.saveParsedMetadata(id: created.record.id, meta: parsed)
    #expect(!saved.record.metaStale, "parser output is authoritative")
  }

  @Test func saveMetadataPreservesFieldsBeyondTheThreeEdited() async throws {
    let entry = seededEntry(
      meta: ScriptMeta(
        name: "Original", matches: ["https://a.example/*"], grants: ["GM_getValue"],
        others: ["custom": ["kept"]]))
    let store = FakeStore(seeded: [entry])

    let saved = try await service(store).saveMetadata(
      id: entry.record.id, name: "Renamed", version: "", description: "")

    #expect(saved.record.meta?.name == "Renamed")
    #expect(saved.record.meta?.version == nil, "an emptied field clears the value")
    #expect(saved.record.meta?.matches == ["https://a.example/*"], "match rules survive an edit")
    #expect(saved.record.meta?.grants == ["GM_getValue"], "grants survive an edit")
    #expect(
      saved.record.meta?.others == ["custom": ["kept"]], "unknown directives survive an edit")
  }

  @Test func saveCodeMarksMetadataStaleRatherThanInventingIt() async throws {
    let entry = seededEntry(meta: ScriptMeta(name: "Original", matches: ["https://a.example/*"]))
    let store = FakeStore(seeded: [entry])

    let saved = try await service(store).saveCode(id: entry.record.id, code: "console.log(2)")
    #expect(saved.code == "console.log(2)")
    #expect(saved.record.meta?.matches == ["https://a.example/*"])
  }

  @Test func importValidBundleMerges() async throws {
    let store = FakeStore()
    let fixture = try fixtureURL("wire-entry.json")
    let entry = try JSONBody(data: try Data(contentsOf: fixture), requiringValidJSON: true)
      .decoded(as: WireEntry.self)

    let bundle = WireBundle(
      infinmonkey: 1, version: "0.1.0", exportedAt: 0, scripts: [entry], styles: [])
    let encoder = JSONEncoder()
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("bundle-\(UUID().uuidString).json")
    try encoder.encode(bundle).write(to: url)
    defer { try? FileManager.default.removeItem(at: url) }

    try await service(store).importFile(at: url)
    let snapshot = try await store.snapshot()
    #expect(snapshot.entries.count == 1)
    #expect(snapshot.entries[0].record.id == "e1")
  }

  @Test func importSingleScriptFileLeavesMetadataForTheExtension() async throws {
    let store = FakeStore()
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("dropped-\(UUID().uuidString).user.js")
    try Data(scriptCode(name: "Dropped").utf8).write(to: url)
    defer { try? FileManager.default.removeItem(at: url) }

    try await service(store).importFile(at: url)
    let snapshot = try await store.snapshot()
    let entry = try #require(snapshot.entries.first)
    #expect(
      entry.record.meta == nil,
      "only the extension parses userscript headers, so the app must not guess")
    #expect(entry.record.kind == .script)
  }

  @Test func importRejectsUnknownFileType() async throws {
    let store = FakeStore()
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("notes-\(UUID().uuidString).txt")
    try Data("hello".utf8).write(to: url)
    defer { try? FileManager.default.removeItem(at: url) }

    await #expect {
      try await service(store).importFile(at: url)
    } throws: { error in
      guard let importError = error as? ImportError else { return false }
      if case .unrecognizedFileType = importError { return true }
      return false
    }
  }

  @Test func importBundleStoreFailureIsNotMislabeledAsFileFault() async throws {
    // A store failure while importing a *valid* bundle is an io error; only a
    // failed decode of the file itself is a verdict on the file.
    let store = FakeStore()
    await store.setFailNext(StoreError.io("disk went away"))
    let bundle = WireBundle(
      infinmonkey: 1, version: "0.1.0", exportedAt: 0,
      scripts: [WireEntry(full: seededEntry())], styles: [])
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("bundle-\(UUID().uuidString).json")
    try JSONEncoder().encode(bundle).write(to: url)
    defer { try? FileManager.default.removeItem(at: url) }

    await #expect {
      try await service(store).importFile(at: url)
    } throws: { error in
      guard let storeError = error as? StoreError, case .io = storeError else { return false }
      return true
    }
  }

  @Test func unavailableServiceReportsReasonInsteadOfWriting() async throws {
    let service = LibraryService.unavailable(error: "app group missing")
    #expect(service.locationError != nil)
    await #expect(throws: StoreError.io("app group missing")) {
      _ = try await service.summaries()
    }
  }
}
