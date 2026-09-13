import XCTest

@testable import InfinMonkeyCore

private func tempStore() -> NativeStore {
  let root = FileManager.default.temporaryDirectory
    .appendingPathComponent("infinmonkey-tests-\(UUID().uuidString)", isDirectory: true)
  return NativeStore(layout: StoreLayout(root: root))
}

private func scriptCode(name: String = "Demo") -> String {
  """
  // ==UserScript==
  // @name \(name)
  // @match https://example.org/*
  // ==/UserScript==
  console.log(1);
  """
}

final class NativeStoreTests: XCTestCase {

  func testCreateAndListRoundTrip() throws {
    let store = tempStore()
    let entry = try store.createEntry(
      kind: .script, code: scriptCode(), meta: ["name": "Demo"], source: ["type": "inline"],
      enabled: true, values: ["token": "abc"])

    let listed = try store.listEntries()
    XCTAssertEqual(listed.entries.count, 1)
    let full = listed.entries[0]
    XCTAssertEqual(full.record.id, entry.record.id)
    XCTAssertEqual(full.code, scriptCode())
    XCTAssertEqual(full.values["token"] as? String, "abc")
  }

  func testCodeFileLayoutOnDisk() throws {
    let store = tempStore()
    let entry = try store.createEntry(
      kind: .style, code: "body{}", meta: ["name": "S"], source: ["type": "inline"], enabled: true,
      values: nil)
    XCTAssertEqual(entry.record.fileName, "\(entry.record.id).user.css")
    XCTAssertTrue(
      FileManager.default.fileExists(
        atPath: store.layout.entriesDir.appendingPathComponent(entry.record.fileName).path))
  }

  func testExternalEditMarksMetaStale() throws {
    let store = tempStore()
    let entry = try store.createEntry(
      kind: .script, code: scriptCode(), meta: ["name": "Demo"], source: ["type": "inline"],
      enabled: true, values: nil)

    // Simulate an external editor writing new content behind the store's back.
    let root = store.layout.root
    let file = root.appendingPathComponent("entries").appendingPathComponent(entry.record.fileName)
    try Data(Data("/* rewritten */".utf8)).write(to: file)

    let after = try store.getEntry(id: entry.record.id)
    XCTAssertTrue(after.record.metaStale)

    // Extension re-parses and pushes fresh meta → flag clears.
    let fixed = try store.updateMeta(id: entry.record.id, meta: ["name": "Renamed"])
    XCTAssertFalse(fixed.record.metaStale)
    XCTAssertEqual(fixed.record.summary.name, "Renamed")
  }

  func testOrphanFileIsAdoptedAndMissingFileIsTombstoned() throws {
    let store = tempStore()
    let layout = store.layout.root
    let first = try store.createEntry(
      kind: .script, code: scriptCode(), meta: ["name": "Demo"], source: ["type": "inline"],
      enabled: true, values: nil)

    // Orphan: a file dropped in by the user, no index record.
    let orphanName = "dropped-in.user.js"
    try Data("// ==UserScript==\n// @name Dropped\n// ==/UserScript==\n".utf8)
      .write(to: layout.appendingPathComponent("entries").appendingPathComponent(orphanName))

    // Deletion behind the store's back.
    try FileManager.default.removeItem(
      at: layout.appendingPathComponent("entries").appendingPathComponent(first.record.fileName))

    let listed = try store.listEntries()
    let ids = Set(listed.entries.map(\.record.id))
    XCTAssertTrue(ids.contains("dropped-in"), "orphan should be adopted")
    XCTAssertFalse(ids.contains(first.record.id), "vanished record should be dropped")

    let changes = try store.getChanges(sinceRev: 0)
    XCTAssertTrue(changes.deletedIds.contains(first.record.id))
    XCTAssertTrue(changes.upserts.contains { $0.record.id == "dropped-in" })
  }

  func testValuesCrudAndRevisionMonotonicity() throws {
    let store = tempStore()
    let entry = try store.createEntry(
      kind: .script, code: scriptCode(), meta: ["name": "Demo"], source: ["type": "inline"],
      enabled: true, values: nil)
    let id = entry.record.id

    try store.setValue(id: id, key: "k", value: ["nested": 1])
    let stored = try store.getValues(id: id)["k"] as? [String: Int]
    XCTAssertEqual(stored, ["nested": 1])

    let revAfterSet = try store.hello(sinceRev: nil).rev
    let existed = try store.deleteValue(id: id, key: "k")
    XCTAssertTrue(existed)
    let revAfterDelete = try store.hello(sinceRev: nil).rev
    XCTAssertGreaterThan(revAfterDelete, revAfterSet)
    XCTAssertTrue(try store.getValues(id: id).isEmpty)

    XCTAssertThrowsError(try store.setValue(id: "missing", key: "k", value: 1))
  }

  func testChangesStreamReportsUpsertsAndDeletes() throws {
    let store = tempStore()
    let a = try store.createEntry(
      kind: .script, code: scriptCode(), meta: ["name": "A"], source: ["type": "inline"],
      enabled: true, values: nil)
    let rev1 = try store.hello(sinceRev: nil).rev
    let b = try store.createEntry(
      kind: .style, code: "p{}", meta: ["name": "B"], source: ["type": "inline"], enabled: true,
      values: nil)
    try store.setEnabled(id: a.record.id, enabled: false)
    try store.deleteEntry(id: b.record.id)

    let changes = try store.getChanges(sinceRev: rev1)
    XCTAssertTrue(changes.upserts.contains { $0.record.id == a.record.id && !$0.record.enabled })
    XCTAssertTrue(changes.deletedIds.contains(b.record.id))
  }

  func testExportImportRoundTripPreservesIdentity() throws {
    let store = tempStore()
    let entry = try store.createEntry(
      kind: .script, code: scriptCode(), meta: ["name": "Demo", "version": "1.0"],
      source: ["type": "inline"], enabled: true, values: ["k": 42])
    try store.createEntry(
      kind: .style, code: "b{}", meta: ["name": "S"], source: ["type": "inline"], enabled: false,
      values: nil)

    let bundle = try store.exportAll()
    let other = tempStore()
    let count = try other.importAll(bundle: bundle, mode: "merge")
    XCTAssertEqual(count, 2)

    let imported = try other.getEntry(id: entry.record.id)
    XCTAssertEqual(imported.code, scriptCode())
    XCTAssertEqual(imported.values["k"] as? Int, 42)
    XCTAssertEqual(imported.record.summary.version, "1.0")
  }

  func testImportReplaceWipesExistingEntries() throws {
    let store = tempStore()
    _ = try store.createEntry(
      kind: .script, code: scriptCode(), meta: ["name": "Old"], source: ["type": "inline"],
      enabled: true, values: nil)
    let bundle: [String: Any] = [
      "scripts": [
        [
          "id": "repl-1", "kind": "script", "enabled": true, "position": 1,
          "code": "console.log(2)", "meta": ["name": "New"], "source": ["type": "inline"],
        ]
      ],
      "styles": [[String: Any]](),
    ]
    let count = try store.importAll(bundle: bundle, mode: "replace")
    XCTAssertEqual(count, 1)
    XCTAssertEqual(try store.listEntries().entries.count, 1)
    XCTAssertEqual(try store.listEntries().entries[0].record.id, "repl-1")
  }

  func testPutEntryUpsertsById() throws {
    let store = tempStore()
    let wire: [String: Any] = [
      "id": "mirror-1", "kind": "script", "enabled": true, "position": 1,
      "installedAt": Int64(1729990000000), "updatedAt": Int64(1730000000000),
      "code": "console.log(1)", "meta": ["name": "Mirror"], "source": ["type": "inline"],
      "values": ["k": "v"],
    ]
    let put = try store.putEntry(entry: wire)
    XCTAssertEqual(put.record.id, "mirror-1")

    // Second put with the same id replaces in place (no duplicate, id kept).
    var updated = wire
    updated["code"] = "console.log(2)"
    updated["updatedAt"] = Int64(1730000001000)
    let put2 = try store.putEntry(entry: updated)
    XCTAssertEqual(put2.record.id, "mirror-1")
    let listed = try store.listEntries()
    XCTAssertEqual(listed.entries.count, 1)
    XCTAssertEqual(listed.entries[0].code, "console.log(2)")

    XCTAssertThrowsError(try store.putEntry(entry: ["id": "x/y"]))
  }

  func testCrossInstanceVisibilityViaFlock() throws {
    let layout = StoreLayout(
      root: FileManager.default.temporaryDirectory
        .appendingPathComponent("infinmonkey-tests-\(UUID().uuidString)", isDirectory: true))
    let a = NativeStore(layout: layout)
    let b = NativeStore(layout: layout)

    let entry = try a.createEntry(
      kind: .script, code: scriptCode(), meta: ["name": "Demo"], source: ["type": "inline"],
      enabled: true, values: nil)
    try b.setEnabled(id: entry.record.id, enabled: false)

    // Instance a observes b's mutation on next read.
    let seen = try a.getEntry(id: entry.record.id)
    XCTAssertFalse(seen.record.enabled)
    XCTAssertEqual(try b.listEntries().entries.count, 1)
  }

  func testIdSanitization() {
    XCTAssertEqual(StoreLayout.sanitizeId("abc-DEF_123"), "abc-DEF_123")
    XCTAssertEqual(StoreLayout.sanitizeId("a/b\\c:d"), "abcd")
    XCTAssertNil(StoreLayout.sanitizeId(""))
    XCTAssertNil(StoreLayout.sanitizeId(String(repeating: "x", count: 65)))
  }
}
