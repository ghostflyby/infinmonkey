import XCTest

@testable import InfinMonkeyCore

func fixtureURL(_ name: String, file: StaticString = #filePath) throws -> URL {
  URL(fileURLWithPath: "\(file)")
    .deletingLastPathComponent()
    .appendingPathComponent("../../../../packages/tests/fixtures/protocol/\(name)")
}

final class LibraryServiceTests: XCTestCase {

  private func service(_ store: FakeStore) -> LibraryService {
    LibraryService(store: store, storagePath: "/tmp/fake")
  }

  func testCreateUsesScaffoldAndParsedMeta() async throws {
    let store = FakeStore()
    let created = try await service(store).create(kind: .script)

    XCTAssertTrue(created.code.contains("==UserScript=="))
    XCTAssertEqual(created.record.meta?.name, "新脚本")
    XCTAssertTrue(created.record.meta?.headerFound ?? false)
    XCTAssertFalse(created.record.metaStale)
    // The scaffold declares its own @match, so it is complete enough to run.
    XCTAssertEqual(created.record.meta?.matches, ["https://example.org/*"])
    XCTAssertNotNil(created.values, "a new script starts with an empty values object")
  }

  func testCreateStyleHasNoValuesFile() async throws {
    let store = FakeStore()
    let created = try await service(store).create(kind: .style)
    XCTAssertEqual(created.record.kind, .style)
    XCTAssertTrue(created.code.contains("==UserStyle=="))
    XCTAssertNil(created.values)
  }

  func testSaveMetadataOnUnparsedEntrySurvivesAndStaysStale() async throws {
    // An entry created from a dropped file: no parsed metadata yet.
    let store = NativeStore(root: temporaryRoot())
    let created = try await store.create(
      kind: .script, code: scriptCode(), meta: nil, source: .inline, enabled: true, values: nil)
    let service = LibraryService(store: store, storagePath: "/tmp/unused")

    let saved = try await service.saveMetadata(
      id: created.record.id, name: "我的脚本", version: "1.2.0", description: "说明")
    XCTAssertEqual(saved.record.meta?.name, "我的脚本")
    XCTAssertEqual(saved.record.meta?.version, "1.2.0")
    XCTAssertEqual(saved.record.meta?.description, "说明")
    XCTAssertTrue(
      saved.record.metaStale,
      "a hand-written summary says nothing about match rules, so parsing is still required")

    // The regression this guards: the edit used to be serialized away, so a
    // fresh reader saw an empty name.
    let reloaded = try await NativeStore(root: store.layout.root).entry(id: created.record.id)
    XCTAssertEqual(reloaded.record.meta?.name, "我的脚本", "the edit must reach disk")
    XCTAssertTrue(reloaded.record.metaStale)
  }

  func testParsedMetadataClearsStale() async throws {
    let store = NativeStore(root: temporaryRoot())
    let created = try await store.create(
      kind: .script, code: scriptCode(), meta: nil, source: .inline, enabled: true, values: nil)
    let service = LibraryService(store: store, storagePath: "/tmp/unused")

    var parsed = demoMeta(name: "Parsed")
    parsed = parsed.withSummary(name: "Parsed", version: "", description: "")
    let saved = try await service.saveParsedMetadata(id: created.record.id, meta: parsed)
    XCTAssertFalse(saved.record.metaStale, "parser output is authoritative")
  }

  func testSaveMetadataPreservesFieldsBeyondTheThreeEdited() async throws {
    let entry = seededEntry(
      meta: ScriptMeta(
        name: "Original", matches: ["https://a.example/*"], grants: ["GM_getValue"],
        others: ["custom": ["kept"]]))
    let store = FakeStore(seeded: [entry])

    let saved = try await service(store).saveMetadata(
      id: entry.record.id, name: "Renamed", version: "", description: "")

    XCTAssertEqual(saved.record.meta?.name, "Renamed")
    XCTAssertNil(saved.record.meta?.version, "an emptied field clears the value")
    XCTAssertEqual(
      saved.record.meta?.matches, ["https://a.example/*"], "match rules survive an edit")
    XCTAssertEqual(saved.record.meta?.grants, ["GM_getValue"], "grants survive an edit")
    XCTAssertEqual(
      saved.record.meta?.others, ["custom": ["kept"]], "unknown directives survive an edit")
  }

  func testSaveCodeMarksMetadataStaleRatherThanInventingIt() async throws {
    let entry = seededEntry(meta: ScriptMeta(name: "Original", matches: ["https://a.example/*"]))
    let store = FakeStore(seeded: [entry])

    let saved = try await service(store).saveCode(id: entry.record.id, code: "console.log(2)")
    XCTAssertEqual(saved.code, "console.log(2)")
    XCTAssertEqual(saved.record.meta?.matches, ["https://a.example/*"])
  }

  func testImportValidBundleMerges() async throws {
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
    XCTAssertEqual(snapshot.entries.count, 1)
    XCTAssertEqual(snapshot.entries[0].record.id, "e1")
  }

  func testImportSingleScriptFileLeavesMetadataForTheExtension() async throws {
    let store = FakeStore()
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("dropped-\(UUID().uuidString).user.js")
    try Data(scriptCode(name: "Dropped").utf8).write(to: url)
    defer { try? FileManager.default.removeItem(at: url) }

    try await service(store).importFile(at: url)
    let snapshot = try await store.snapshot()
    let entry = try XCTUnwrap(snapshot.entries.first)
    XCTAssertNil(
      entry.record.meta,
      "only the extension parses userscript headers, so the app must not guess")
    XCTAssertEqual(entry.record.kind, .script)
  }

  func testImportRejectsUnknownFileType() async throws {
    let store = FakeStore()
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("notes-\(UUID().uuidString).txt")
    try Data("hello".utf8).write(to: url)
    defer { try? FileManager.default.removeItem(at: url) }

    do {
      try await service(store).importFile(at: url)
      XCTFail("expected the importer to reject an unknown extension")
    } catch let error as StoreError {
      guard case .badRequest = error else { return XCTFail("unexpected error \(error)") }
    }
  }

  func testUnavailableServiceReportsReasonInsteadOfWriting() async throws {
    let service = LibraryService.unavailable(error: "app group missing")
    XCTAssertNotNil(service.locationError)
    do {
      _ = try await service.summaries()
      XCTFail("expected operations to fail when the store is unavailable")
    } catch let error as StoreError {
      XCTAssertEqual(error, .io("app group missing"))
    }
  }

  func testAppGroupKeyMissingFailsFast() throws {
    // A bundle without the passthrough key is a build fault.
    XCTAssertThrowsError(try StoreLayout.appGroupID(bundle: .init(for: LibraryServiceTests.self)))
  }
}
