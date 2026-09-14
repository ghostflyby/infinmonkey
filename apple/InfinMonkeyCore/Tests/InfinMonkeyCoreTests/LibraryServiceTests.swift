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
    XCTAssertEqual(created.record.meta.name, "新脚本")
    XCTAssertTrue(created.record.meta.headerFound)
    XCTAssertFalse(created.record.metaStale)
    XCTAssertNotNil(created.values, "a new script starts with an empty values object")
  }

  func testCreateStyleHasNoValuesFile() async throws {
    let store = FakeStore()
    let created = try await service(store).create(kind: .style)
    XCTAssertEqual(created.record.kind, .style)
    XCTAssertTrue(created.code.contains("==UserStyle=="))
    XCTAssertNil(created.values)
  }

  func testSaveMetadataKeepsUnparsedMarkerForUnparsedEntry() async throws {
    // Simulates the app editing an entry the extension has not parsed yet.
    var entry = seededEntry()
    entry.record.meta = .unparsed
    entry.record.metaStale = true
    let store = FakeStore(seeded: [entry])

    let saved = try await service(store).saveMetadata(
      id: entry.record.id, name: "我的脚本", version: "1.2.0", description: "说明")

    XCTAssertEqual(saved.record.meta.name, "我的脚本")
    XCTAssertEqual(saved.record.meta.version, "1.2.0")
    XCTAssertEqual(saved.record.meta.description, "说明")
    XCTAssertTrue(
      saved.record.meta.isUnparsed,
      "describing an entry by hand does not tell us its match rules, so the extension must still parse"
    )
    XCTAssertTrue(saved.record.metaStale)
  }

  func testSaveMetadataPreservesFieldsBeyondTheThreeEdited() async throws {
    var entry = seededEntry()
    var meta = demoMeta(name: "Original")
    meta.matches = ["https://a.example/*"]
    meta.grants = ["GM_getValue"]
    meta.others = ["custom": ["kept"]]
    entry.record.meta = meta
    let store = FakeStore(seeded: [entry])

    let saved = try await service(store).saveMetadata(
      id: entry.record.id, name: "Renamed", version: "", description: "")

    XCTAssertEqual(saved.record.meta.name, "Renamed")
    XCTAssertNil(saved.record.meta.version, "an emptied field clears the value")
    XCTAssertEqual(
      saved.record.meta.matches, ["https://a.example/*"], "match rules survive an edit")
    XCTAssertEqual(saved.record.meta.grants, ["GM_getValue"], "grants survive an edit")
    XCTAssertEqual(
      saved.record.meta.others, ["custom": ["kept"]], "unknown directives survive an edit")
  }

  func testSaveCodeDoesNotInventMetadata() async throws {
    var entry = seededEntry()
    var meta = demoMeta(name: "Original")
    meta.matches = ["https://a.example/*"]
    entry.record.meta = meta
    let store = FakeStore(seeded: [entry])

    let saved = try await service(store).saveCode(id: entry.record.id, code: "console.log(2)")
    XCTAssertEqual(saved.code, "console.log(2)")
    XCTAssertEqual(saved.record.meta.matches, ["https://a.example/*"])
  }

  func testImportValidBundleMerges() async throws {
    let store = FakeStore()
    let fixture = try fixtureURL("wire-entry.json")
    let object = try JSONSerialization.jsonObject(with: try Data(contentsOf: fixture))
    let entry = try WireEntry(jsonObject: object).fullEntry()
    let bundle = ExportBundle(version: "0.1.0", exportedAt: 0, scripts: [entry], styles: [])

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
    XCTAssertTrue(
      entry.record.meta.isUnparsed,
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
