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

  func testMissingMetaStaysAbsentAcrossAReload() async throws {
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

  func testIdValidation() {
    // Usable: UUIDs as minted today, and readable names including non-ASCII —
    // the store directory is user-visible, so a chosen name must survive.
    XCTAssertTrue(StoreLayout.isValidID("abc-DEF_123"))
    XCTAssertTrue(StoreLayout.isValidID(UUID().uuidString.lowercased()))
    XCTAssertTrue(StoreLayout.isValidID("我的脚本"))
    XCTAssertTrue(StoreLayout.isValidID("脚本 v2"))

    // Unusable: path structure, separators, and things that break a file name.
    XCTAssertFalse(StoreLayout.isValidID(""), "empty cannot be a file name")
    XCTAssertFalse(StoreLayout.isValidID(".."), "would escape the directory")
    XCTAssertFalse(StoreLayout.isValidID("."))
    XCTAssertFalse(StoreLayout.isValidID("a/b"), "path separator")
    XCTAssertFalse(StoreLayout.isValidID("a\\b"), "path separator")
    XCTAssertFalse(StoreLayout.isValidID("a:b"), "Finder renders a colon as a separator")
    XCTAssertFalse(StoreLayout.isValidID("a\nb"), "control character")
    XCTAssertFalse(StoreLayout.isValidID("a\0b"), "NUL terminates a C path")
    XCTAssertFalse(
      StoreLayout.isValidID(String(repeating: "x", count: 129)), "bounded length")

    // A rejected id is never silently repaired: `put` depends on that, because a
    // rewritten id would orphan the entry on the extension's side.
    XCTAssertNotEqual(StoreLayout.isValidID("a/b"), true)
  }
}
