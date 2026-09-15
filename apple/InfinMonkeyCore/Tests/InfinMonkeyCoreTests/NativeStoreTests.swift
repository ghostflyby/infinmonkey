import Foundation
import Testing

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

@Suite struct NativeStoreTests {

  @Test func createAndListRoundTrip() async throws {
    let store = NativeStore(root: temporaryRoot())
    let entry = try await store.create(
      kind: .script, code: scriptCode(), meta: demoMeta(), source: .inline, enabled: true,
      values: valuesBlob(["token": "abc"]))

    let snapshot = try await store.snapshot()
    #expect(snapshot.entries.count == 1)
    let full = snapshot.entries[0]
    #expect(full.record.id == entry.record.id)
    #expect(full.code == scriptCode())
    #expect(valueDescription(full.values, "token") == "abc")
    #expect(!full.record.metaStale)
  }

  @Test func codeFileLayoutOnDisk() async throws {
    let store = NativeStore(root: temporaryRoot())
    let entry = try await store.create(
      kind: .style, code: "body{}", meta: demoMeta(name: "S"), source: .inline, enabled: true,
      values: nil)
    #expect(entry.record.fileName == "\(entry.record.id).user.css")
    #expect(FileManager.default.fileExists(atPath: store.layout.codeURL(entry.record).path))
    #expect(entry.values == nil, "styles have no values file")
  }

  @Test func missingMetaStaysAbsentAcrossAReload() async throws {
    let store = NativeStore(root: temporaryRoot())
    let entry = try await store.create(
      kind: .script, code: scriptCode(), meta: nil, source: .inline, enabled: true,
      values: nil)

    #expect(entry.record.meta == nil)
    #expect(entry.record.metaStale, "no metadata means the extension must parse the code")

    // A fresh read from disk keeps it absent.
    let reloaded = try await store.entry(id: entry.record.id)
    #expect(reloaded.record.meta == nil)
    #expect(reloaded.record.metaStale)
  }

  @Test func changesStreamReportsUpsertsAndDeletes() async throws {
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
    #expect(changes.upserts.contains { $0.record.id == a.record.id && !$0.record.enabled })
    #expect(changes.deletedIds.contains(b.record.id))
    #expect(!changes.upserts.contains { $0.record.id == b.record.id })
  }

  @Test func putUpsertsByIdAndKeepsPosition() async throws {
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
    #expect(snapshot.entries.count == 1, "put must replace, not append")
    let stored = snapshot.entries[0]
    #expect(stored.code == "console.log(2)")
    #expect(stored.record.position == existing.record.position, "position is store-owned")
    #expect(valueDescription(stored.values, "k") == "v")

    // An id that cannot be a file name is rejected rather than sanitized silently.
    let bad = FullEntry(record: makeRecord(id: "x/y"), code: "", values: nil)
    await #expect {
      _ = try await store.put(entry: bad)
    } throws: { error in
      guard let storeError = error as? StoreError, case .badRequest = storeError else {
        return false
      }
      return true
    }
  }

  @Test func exportImportRoundTripPreservesIdentityAndValues() async throws {
    let store = NativeStore(root: temporaryRoot())
    let entry = try await store.create(
      kind: .script, code: scriptCode(), meta: demoMeta(name: "Demo"), source: .inline,
      enabled: true, values: valuesBlob(["k": 42]))
    _ = try await store.create(
      kind: .style, code: "b{}", meta: demoMeta(name: "S"), source: .inline, enabled: false,
      values: nil)

    let bundle = try await store.exportBundle()
    #expect(bundle.scripts.count == 1)
    #expect(bundle.styles.count == 1)

    let other = NativeStore(root: temporaryRoot())
    let count = try await other.importBundle(bundle, mode: .merge)
    #expect(count == 2)

    let imported = try await other.entry(id: entry.record.id)
    #expect(imported.code == scriptCode())
    #expect(valueDescription(imported.values, "k") == "42")
    #expect(imported.record.meta?.name == "Demo")
  }

  @Test func importReplaceWipesExistingEntries() async throws {
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

    #expect(count == 1)
    let snapshot = try await store.snapshot()
    #expect(snapshot.entries.count == 1)
    #expect(snapshot.entries[0].record.id == "repl-1")
  }

  @Test func reorderAssignsContiguousPositions() async throws {
    let store = NativeStore(root: temporaryRoot())
    let a = try await store.create(
      kind: .script, code: scriptCode(), meta: demoMeta(name: "A"), source: .inline, enabled: true,
      values: nil)
    let b = try await store.create(
      kind: .script, code: scriptCode(name: "B"), meta: demoMeta(name: "B"), source: .inline,
      enabled: true, values: nil)

    try await store.reorder(ids: [b.record.id, a.record.id])
    let snapshot = try await store.snapshot()
    #expect(snapshot.entries.map(\.record.id) == [b.record.id, a.record.id])
    #expect(snapshot.entries.map(\.record.position) == [1, 2])
  }

  @Test func crossInstanceVisibilityThroughFileLock() async throws {
    let root = temporaryRoot()
    let a = NativeStore(root: root)
    let b = NativeStore(root: root)

    let entry = try await a.create(
      kind: .script, code: scriptCode(), meta: demoMeta(), source: .inline, enabled: true,
      values: nil)
    _ = try await b.setEnabled(id: entry.record.id, enabled: false)

    // Instance a sees what instance b wrote, because every read reloads.
    let seen = try await a.entry(id: entry.record.id)
    #expect(!seen.record.enabled)
  }

  @Test func corruptIndexIsReportedNotRebuilt() async throws {
    let root = temporaryRoot()
    let store = NativeStore(root: root)
    _ = try await store.create(
      kind: .script, code: scriptCode(), meta: demoMeta(), source: .inline, enabled: true,
      values: nil)

    try Data("{ not json".utf8).write(to: store.layout.indexURL)

    await #expect {
      _ = try await store.snapshot()
    } throws: { error in
      guard let storeError = error as? StoreError, case .corruptIndex = storeError else {
        return false
      }
      return true
    }
  }

  @Test func idValidation() {
    // Usable: UUIDs as minted today, and readable names including non-ASCII —
    // the store directory is user-visible, so a chosen name must survive.
    #expect(StoreLayout.isValidID("abc-DEF_123"))
    #expect(StoreLayout.isValidID(UUID().uuidString.lowercased()))
    #expect(StoreLayout.isValidID("我的脚本"))
    #expect(StoreLayout.isValidID("脚本 v2"))

    // Unusable: path structure, separators, and things that break a file name.
    #expect(!StoreLayout.isValidID(""), "empty cannot be a file name")
    #expect(!StoreLayout.isValidID(".."), "would escape the directory")
    #expect(!StoreLayout.isValidID("."))
    #expect(!StoreLayout.isValidID("a/b"), "path separator")
    #expect(!StoreLayout.isValidID("a\\b"), "path separator")
    #expect(!StoreLayout.isValidID("a:b"), "Finder renders a colon as a separator")
    #expect(!StoreLayout.isValidID("a\nb"), "control character")
    #expect(!StoreLayout.isValidID("a\0b"), "NUL terminates a C path")
    #expect(!StoreLayout.isValidID(String(repeating: "x", count: 129)), "bounded length")

    // A rejected id is never silently repaired: `put` depends on that, because a
    // rewritten id would orphan the entry on the extension's side.
    #expect(StoreLayout.isValidID("a/b") != true)
  }
}
