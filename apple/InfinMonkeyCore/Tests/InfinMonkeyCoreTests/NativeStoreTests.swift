import XCTest

@testable import InfinMonkeyCore

func temporaryRoot() -> URL {
  FileManager.default.temporaryDirectory
    .appendingPathComponent("infinmonkey-tests-\(UUID().uuidString)", isDirectory: true)
}

func scriptCode(name: String = "Demo") -> String {
  """
  // ==UserScript==
  // @name \(name)
  // @match https://example.org/*
  // ==/UserScript==
  console.log(1);
  """
}

func demoMeta(name: String = "Demo") -> ScriptMeta {
  ScriptMeta(name: name, headerFound: true)
}

/// A record whose code content stands in for a hex digest in tests that do not
/// exercise hashing.
func makeRecord(
  id: String,
  kind: EntryKind = .script,
  enabled: Bool = true,
  position: Int = 0,
  meta: ScriptMeta? = nil,
  metaStale: Bool = false,
  source: EntrySource = .inline
) -> EntryRecord {
  EntryRecord(
    id: id, kind: kind, enabled: enabled, position: position, installedAt: 0, updatedAt: 0,
    rev: 0, codeSha: "", metaStale: metaStale, meta: meta, source: source)
}

func valuesBlob(_ object: [String: Any]) -> Data {
  try! JSONSerialization.data(withJSONObject: object)
}

/// Reads a value's description back out of an opaque blob.
func valueDescription(_ blob: Data?, _ key: String) -> String? {
  guard let blob, let object = try? JSONSerialization.jsonObject(with: blob) as? [String: Any]
  else {
    return nil
  }
  return object[key].map { String(describing: $0) }
}

final class NativeStoreTests: XCTestCase {

  func testCreateAndListRoundTrip() async throws {
    let store = NativeStore(root: temporaryRoot())
    let entry = try await store.create(
      kind: .script, code: scriptCode(), meta: demoMeta(), source: .inline, enabled: true,
      values: valuesBlob(["token": "abc"]))

    let snapshot = try await store.snapshot()
    XCTAssertEqual(snapshot.entries.count, 1)
    let full = snapshot.entries[0]
    XCTAssertEqual(full.record.id, entry.record.id)
    XCTAssertEqual(full.code, scriptCode())
    XCTAssertEqual(valueDescription(full.values, "token"), "abc")
    XCTAssertFalse(full.record.metaStale)
  }

  func testCodeFileLayoutOnDisk() async throws {
    let store = NativeStore(root: temporaryRoot())
    let entry = try await store.create(
      kind: .style, code: "body{}", meta: demoMeta(name: "S"), source: .inline, enabled: true,
      values: nil)
    XCTAssertEqual(entry.record.fileName, "\(entry.record.id).user.css")
    XCTAssertTrue(
      FileManager.default.fileExists(atPath: store.layout.codeURL(entry.record).path))
    XCTAssertNil(entry.values, "styles have no values file")
  }

  func testMissingMetaRoundTripsAsEmptyObject() async throws {
    let store = NativeStore(root: temporaryRoot())
    let entry = try await store.create(
      kind: .script, code: scriptCode(), meta: nil, source: .inline, enabled: true,
      values: nil)

    XCTAssertNil(entry.record.meta)
    XCTAssertTrue(entry.record.metaStale, "no metadata means the extension must parse the code")

    // A fresh read from disk keeps it absent.
    let reloaded = try await store.entry(id: entry.record.id)
    XCTAssertNil(reloaded.record.meta)
    XCTAssertTrue(reloaded.record.metaStale)
  }

  func testEmptyMetaObjectInAnOlderStoreReadsAsAbsent() async throws {
    // Older builds wrote "not parsed yet" as `{}`; that must still mean absent
    // rather than an empty-but-parsed result.
    let store = NativeStore(root: temporaryRoot())
    let entry = try await store.create(
      kind: .script, code: scriptCode(), meta: demoMeta(), source: .inline, enabled: true,
      values: nil)

    var index = try XCTUnwrap(
      try JSONSerialization.jsonObject(with: try Data(contentsOf: store.layout.indexURL))
        as? [String: Any])
    var entries = try XCTUnwrap(index["entries"] as? [[String: Any]])
    entries[0]["meta"] = [String: Any]()
    index["entries"] = entries
    try JSONSerialization.data(withJSONObject: index).write(to: store.layout.indexURL)

    let reloaded = try await store.entry(id: entry.record.id)
    XCTAssertNil(reloaded.record.meta, "`{}` means nothing has been parsed")
    XCTAssertTrue(reloaded.record.metaStale)
  }

  func testSummaryUsesPlaceholderForUnparsedEntry() async throws {
    let store = NativeStore(root: temporaryRoot())
    let entry = try await store.create(
      kind: .script, code: scriptCode(), meta: nil, source: .inline, enabled: true, values: nil)
    let summaries = try await store.summaries(sinceRev: nil)
    let summary = try XCTUnwrap(summaries.entries.first { $0.id == entry.record.id })
    XCTAssertNil(summary.name, "no name to report yet, and no placeholder invented")
    XCTAssertNil(summary.version)
  }

  func testExternalEditMarksMetaStale() async throws {
    let store = NativeStore(root: temporaryRoot())
    let entry = try await store.create(
      kind: .script, code: scriptCode(), meta: demoMeta(), source: .inline, enabled: true,
      values: nil)

    // Simulate an editor writing behind the store's back.
    try Data("/* rewritten */".utf8).write(to: store.layout.codeURL(entry.record))

    let after = try await store.entry(id: entry.record.id)
    XCTAssertTrue(after.record.metaStale)

    // The extension re-parses and pushes fresh metadata; the flag clears.
    let fixed = try await store.updateMeta(
      id: entry.record.id, meta: demoMeta(name: "Renamed"), fromParsing: true)
    XCTAssertFalse(fixed.record.metaStale)
    XCTAssertEqual(fixed.record.meta?.name, "Renamed")
  }

  func testOrphanFileIsAdoptedAndMissingFileIsTombstoned() async throws {
    let store = NativeStore(root: temporaryRoot())
    let first = try await store.create(
      kind: .script, code: scriptCode(), meta: demoMeta(), source: .inline, enabled: true,
      values: nil)

    // A file with no index record.
    let orphan = store.layout.entriesDir.appendingPathComponent("dropped-in.user.js")
    try Data("// ==UserScript==\n// @name Dropped\n// ==/UserScript==\n".utf8).write(to: orphan)
    // A record whose file vanished.
    try FileManager.default.removeItem(at: store.layout.codeURL(first.record))

    let snapshot = try await store.snapshot()
    let ids = Set(snapshot.entries.map(\.record.id))
    XCTAssertTrue(ids.contains("dropped-in"), "orphan should be adopted")
    XCTAssertFalse(ids.contains(first.record.id), "vanished record should be dropped")

    let adopted = try XCTUnwrap(snapshot.entries.first { $0.record.id == "dropped-in" })
    XCTAssertTrue(adopted.record.metaStale, "adopted code has not been parsed yet")
    XCTAssertNil(adopted.record.meta)

    let changes = try await store.changes(sinceRev: 0)
    XCTAssertTrue(changes.deletedIds.contains(first.record.id))
    XCTAssertTrue(changes.upserts.contains { $0.record.id == "dropped-in" })
  }

  func testRevisionAdvancesPerMutation() async throws {
    let store = NativeStore(root: temporaryRoot())
    let entry = try await store.create(
      kind: .script, code: scriptCode(), meta: demoMeta(), source: .inline, enabled: true,
      values: nil)

    let revAfterCreate = try await store.currentRev()
    _ = try await store.setEnabled(id: entry.record.id, enabled: false)
    let revAfterDisable = try await store.currentRev()
    XCTAssertGreaterThan(revAfterDisable, revAfterCreate)

    // A no-op write must not advance the revision: clients watch it to decide
    // whether they need to sync.
    _ = try await store.setEnabled(id: entry.record.id, enabled: false)
    let revAfterNoOp = try await store.currentRev()
    XCTAssertEqual(revAfterNoOp, revAfterDisable)
  }

  func testChangesStreamReportsUpsertsAndDeletes() async throws {
    let store = NativeStore(root: temporaryRoot())
    let a = try await store.create(
      kind: .script, code: scriptCode(), meta: demoMeta(name: "A"), source: .inline, enabled: true,
      values: nil)
    let rev1 = try await store.currentRev()
    let b = try await store.create(
      kind: .style, code: "p{}", meta: demoMeta(name: "B"), source: .inline, enabled: true,
      values: nil)
    _ = try await store.setEnabled(id: a.record.id, enabled: false)
    _ = try await store.delete(id: b.record.id)

    let changes = try await store.changes(sinceRev: rev1)
    XCTAssertTrue(changes.upserts.contains { $0.record.id == a.record.id && !$0.record.enabled })
    XCTAssertTrue(changes.deletedIds.contains(b.record.id))
    XCTAssertFalse(changes.upserts.contains { $0.record.id == b.record.id })
  }

  func testPutUpsertsByIdAndKeepsPosition() async throws {
    let store = NativeStore(root: temporaryRoot())
    let existing = try await store.create(
      kind: .script, code: scriptCode(), meta: demoMeta(), source: .inline, enabled: true,
      values: nil)

    let mirror = FullEntry(
      record: makeRecord(
        id: existing.record.id, enabled: false, meta: demoMeta(name: "Mirror")),
      code: "console.log(2)",
      values: valuesBlob(["k": "v"]))

    _ = try await store.put(entry: mirror)

    let snapshot = try await store.snapshot()
    XCTAssertEqual(snapshot.entries.count, 1, "put must replace, not append")
    let stored = snapshot.entries[0]
    XCTAssertEqual(stored.code, "console.log(2)")
    XCTAssertEqual(stored.record.position, existing.record.position, "position is store-owned")
    XCTAssertEqual(valueDescription(stored.values, "k"), "v")

    // An id that cannot be a file name is rejected rather than sanitized silently.
    let bad = FullEntry(record: makeRecord(id: "x/y"), code: "", values: nil)
    do {
      _ = try await store.put(entry: bad)
      XCTFail("expected badRequest for an unusable id")
    } catch let error as StoreError {
      guard case .badRequest = error else { return XCTFail("unexpected error \(error)") }
    }
  }

  func testExportImportRoundTripPreservesIdentityAndValues() async throws {
    let store = NativeStore(root: temporaryRoot())
    let entry = try await store.create(
      kind: .script, code: scriptCode(), meta: demoMeta(name: "Demo"), source: .inline,
      enabled: true, values: valuesBlob(["k": 42]))
    _ = try await store.create(
      kind: .style, code: "b{}", meta: demoMeta(name: "S"), source: .inline, enabled: false,
      values: nil)

    let bundle = try await store.exportBundle()
    XCTAssertEqual(bundle.scripts.count, 1)
    XCTAssertEqual(bundle.styles.count, 1)

    let other = NativeStore(root: temporaryRoot())
    let count = try await other.importBundle(bundle, mode: .merge)
    XCTAssertEqual(count, 2)

    let imported = try await other.entry(id: entry.record.id)
    XCTAssertEqual(imported.code, scriptCode())
    XCTAssertEqual(valueDescription(imported.values, "k"), "42")
    XCTAssertEqual(imported.record.meta?.name, "Demo")
  }

  func testImportReplaceWipesExistingEntries() async throws {
    let store = NativeStore(root: temporaryRoot())
    _ = try await store.create(
      kind: .script, code: scriptCode(), meta: demoMeta(name: "Old"), source: .inline,
      enabled: true, values: nil)

    let replacement = FullEntry(
      record: makeRecord(id: "repl-1", position: 1, meta: demoMeta(name: "New")),
      code: "console.log(2)", values: nil)
    let count = try await store.importBundle(
      ExportBundle(version: "0.1.0", exportedAt: 0, scripts: [replacement], styles: []),
      mode: .replace)

    XCTAssertEqual(count, 1)
    let snapshot = try await store.snapshot()
    XCTAssertEqual(snapshot.entries.count, 1)
    XCTAssertEqual(snapshot.entries[0].record.id, "repl-1")
  }

  func testReorderAssignsContiguousPositions() async throws {
    let store = NativeStore(root: temporaryRoot())
    let a = try await store.create(
      kind: .script, code: scriptCode(), meta: demoMeta(name: "A"), source: .inline, enabled: true,
      values: nil)
    let b = try await store.create(
      kind: .script, code: scriptCode(name: "B"), meta: demoMeta(name: "B"), source: .inline,
      enabled: true, values: nil)

    try await store.reorder(ids: [b.record.id, a.record.id])
    let snapshot = try await store.snapshot()
    XCTAssertEqual(snapshot.entries.map(\.record.id), [b.record.id, a.record.id])
    XCTAssertEqual(snapshot.entries.map(\.record.position), [1, 2])
  }

  func testCrossInstanceVisibilityThroughFileLock() async throws {
    let root = temporaryRoot()
    let a = NativeStore(root: root)
    let b = NativeStore(root: root)

    let entry = try await a.create(
      kind: .script, code: scriptCode(), meta: demoMeta(), source: .inline, enabled: true,
      values: nil)
    _ = try await b.setEnabled(id: entry.record.id, enabled: false)

    // Instance a sees what instance b wrote, because every read reloads.
    let seen = try await a.entry(id: entry.record.id)
    XCTAssertFalse(seen.record.enabled)
  }

  func testCorruptIndexIsReportedNotRebuilt() async throws {
    let root = temporaryRoot()
    let store = NativeStore(root: root)
    _ = try await store.create(
      kind: .script, code: scriptCode(), meta: demoMeta(), source: .inline, enabled: true,
      values: nil)

    try Data("{ not json".utf8).write(to: store.layout.indexURL)

    do {
      _ = try await store.snapshot()
      XCTFail("expected the store to refuse an unreadable index")
    } catch let error as StoreError {
      guard case .corruptIndex = error else { return XCTFail("unexpected error \(error)") }
    }
  }

  func testIdSanitization() {
    XCTAssertEqual(StoreLayout.sanitizeId("abc-DEF_123"), "abc-DEF_123")
    XCTAssertEqual(StoreLayout.sanitizeId("a/b\\c:d"), "abcd")
    XCTAssertNil(StoreLayout.sanitizeId(""))
    XCTAssertNil(StoreLayout.sanitizeId(String(repeating: "x", count: 65)))
  }
}
