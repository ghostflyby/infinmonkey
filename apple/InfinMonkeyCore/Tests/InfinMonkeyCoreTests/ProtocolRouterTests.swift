import XCTest

@testable import InfinMonkeyCore

/// In-memory `EntryStoring`, so protocol behavior is testable without the file
/// system. This is the seam that keeps dispatch tests fast and makes error
/// paths provokable on demand.
actor FakeStore: EntryStoring {
  private var entries: [String: FullEntry] = [:]
  private var order: [String] = []
  private var rev = 0
  private var removed: [String] = []
  private var failNextWith: StoreError?
  private var nextId = 0

  init(seeded: [FullEntry] = []) {
    for entry in seeded {
      entries[entry.record.id] = entry
      order.append(entry.record.id)
    }
  }

  /// Arms the next operation to throw.
  func setFailNext(_ error: StoreError) {
    failNextWith = error
  }

  private func checkFailure() throws {
    if let error = failNextWith {
      failNextWith = nil
      throw error
    }
  }

  private func bump() { rev += 1 }

  func currentRev() throws -> Int { rev }

  func summaries(sinceRev: Int?) throws -> SummarySnapshot {
    let all = order.compactMap { entries[$0] }
    let filtered = sinceRev.map { since in all.filter { $0.record.rev > since } } ?? all
    return SummarySnapshot(rev: rev, entries: filtered.map { EntrySummary(record: $0.record) })
  }

  func snapshot() throws -> Snapshot {
    Snapshot(rev: rev, entries: order.compactMap { entries[$0] })
  }

  func entry(id: String) throws -> FullEntry {
    try checkFailure()
    guard let entry = entries[id] else { throw StoreError.notFound }
    return entry
  }

  func changes(sinceRev: Int) throws -> Changes {
    let upserts = order.compactMap { entries[$0] }.filter { $0.record.rev > sinceRev }
    return Changes(rev: rev, upserts: upserts, deletedIds: removed)
  }

  func values(id: String) throws -> Data? {
    try checkFailure()
    guard let entry = entries[id] else { throw StoreError.notFound }
    return entry.values
  }

  @discardableResult
  func create(
    kind: EntryKind,
    code: String,
    meta: ScriptMeta,
    source: EntrySource,
    enabled: Bool,
    values: Data?
  ) throws -> FullEntry {
    try checkFailure()
    bump()
    nextId += 1
    let id = "fake-\(nextId)"
    let record = EntryRecord(
      id: id, kind: kind, enabled: enabled, position: order.count + 1, installedAt: 0,
      updatedAt: 0, rev: rev, codeSha: "sha", metaStale: meta.isUnparsed, meta: meta,
      source: source)
    let entry = FullEntry(record: record, code: code, values: kind == .script ? values : nil)
    entries[id] = entry
    order.append(id)
    return entry
  }

  @discardableResult
  func updateCode(id: String, code: String, meta: ScriptMeta?) throws -> FullEntry {
    try checkFailure()
    guard var entry = entries[id] else { throw StoreError.notFound }
    bump()
    entry.code = code
    if let meta {
      entry.record.meta = meta
      entry.record.metaStale = meta.isUnparsed
    }
    entry.record.rev = rev
    entries[id] = entry
    return entry
  }

  @discardableResult
  func updateMeta(id: String, meta: ScriptMeta) throws -> FullEntry {
    try checkFailure()
    guard var entry = entries[id] else { throw StoreError.notFound }
    bump()
    entry.record.meta = meta
    entry.record.metaStale = meta.isUnparsed
    entry.record.rev = rev
    entries[id] = entry
    return entry
  }

  @discardableResult
  func setEnabled(id: String, enabled: Bool) throws -> FullEntry {
    try checkFailure()
    guard var entry = entries[id] else { throw StoreError.notFound }
    bump()
    entry.record.enabled = enabled
    entry.record.rev = rev
    entries[id] = entry
    return entry
  }

  @discardableResult
  func put(entry: FullEntry) throws -> FullEntry {
    try checkFailure()
    guard StoreLayout.sanitizeId(entry.record.id) != nil else {
      throw StoreError.badRequest("bad id")
    }
    bump()
    var stored = entry
    stored.record.rev = rev
    if entries[entry.record.id] == nil { order.append(entry.record.id) }
    entries[entry.record.id] = stored
    return stored
  }

  func reorder(ids: [String]) throws {
    try checkFailure()
    guard Set(ids) == Set(order) else { throw StoreError.notFound }
    bump()
    order = ids
  }

  @discardableResult
  func delete(id: String) throws -> Bool {
    try checkFailure()
    guard entries.removeValue(forKey: id) != nil else { return false }
    bump()
    order.removeAll { $0 == id }
    removed.append(id)
    return true
  }

  func exportBundle() throws -> ExportBundle {
    let all = order.compactMap { entries[$0] }
    return ExportBundle(
      version: CoreConstants.storeVersionString,
      exportedAt: 0,
      scripts: all.filter { $0.record.kind == .script },
      styles: all.filter { $0.record.kind == .style })
  }

  @discardableResult
  func importBundle(_ bundle: ExportBundle, mode: ImportMode) throws -> Int {
    try checkFailure()
    if mode == .replace {
      entries.removeAll()
      order.removeAll()
    }
    for entry in bundle.allEntries {
      entries[entry.record.id] = entry
      if !order.contains(entry.record.id) { order.append(entry.record.id) }
    }
    bump()
    return bundle.allEntries.count
  }
}

// MARK: - Test helpers

func requestData(_ type: String, _ payload: [String: Any], version: Int = 1) -> Data {
  try! JSONSerialization.data(withJSONObject: [
    "v": version, "id": "req-1", "type": type, "payload": payload,
  ])
}

func responseObject(_ data: Data) throws -> [String: Any] {
  try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
}

func errorCode(_ response: [String: Any]) -> String? {
  (response["error"] as? [String: Any])?["code"] as? String
}

func seededEntry(id: String = "e1", kind: EntryKind = .script) -> FullEntry {
  FullEntry(
    record: EntryRecord(
      id: id, kind: kind, enabled: true, position: 1, installedAt: 0, updatedAt: 0, rev: 1,
      codeSha: "", metaStale: false, meta: demoMeta(name: "Demo"), source: .inline),
    code: scriptCode(),
    values: kind == .script ? valuesBlob(["token": "abc"]) : nil)
}

final class ProtocolRouterTests: XCTestCase {

  private func router(_ store: FakeStore) -> ProtocolRouter {
    ProtocolRouter(store: store, platform: "macos")
  }

  func testPingAndHello() async throws {
    let store = FakeStore(seeded: [seededEntry()])
    let router = router(store)

    let pong = try await responseObject(await router.handle(requestData: requestData("ping", [:])))
    XCTAssertEqual(pong["ok"] as? Bool, true)
    let pongResult = try XCTUnwrap(pong["result"] as? [String: Any])
    XCTAssertEqual(pongResult["proto"] as? Int, 1)
    XCTAssertEqual(pongResult["platform"] as? String, "macos")

    let hello = try await responseObject(
      await router.handle(requestData: requestData("hello", [:])))
    let helloResult = try XCTUnwrap(hello["result"] as? [String: Any])
    XCTAssertEqual(helloResult["app"] as? String, "InfinMonkey")
    let entries = try XCTUnwrap(helloResult["entries"] as? [[String: Any]])
    XCTAssertEqual(entries.count, 1)
    XCTAssertEqual(entries[0]["name"] as? String, "Demo")
  }

  func testListEntriesCarriesCodeAndOpaqueValues() async throws {
    let store = FakeStore(seeded: [seededEntry()])
    let response = try await responseObject(
      await router(store).handle(requestData: requestData("listEntries", [:])))
    let result = try XCTUnwrap(response["result"] as? [String: Any])
    let entries = try XCTUnwrap(result["entries"] as? [[String: Any]])
    XCTAssertEqual(entries[0]["code"] as? String, scriptCode())
    XCTAssertEqual(entries[0]["kind"] as? String, "script")
    // Opaque values come back as JSON, not as a mangled string.
    let values = try XCTUnwrap(entries[0]["values"] as? [String: Any])
    XCTAssertEqual(values["token"] as? String, "abc")
  }

  func testCreateEntryKeepsNestedOpaqueValues() async throws {
    let store = FakeStore()
    let payload: [String: Any] = [
      "kind": "script",
      "code": scriptCode(),
      "meta": ["name": "Created"],
      "values": ["nested": ["deep": true], "n": 7],
    ]
    let response = try await responseObject(
      await router(store).handle(requestData: requestData("createEntry", payload)))
    XCTAssertEqual(response["ok"] as? Bool, true)

    let snapshot = try await store.snapshot()
    let entry = try XCTUnwrap(snapshot.entries.first)
    let blob = try XCTUnwrap(entry.values)
    let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: blob) as? [String: Any])
    let nested = try XCTUnwrap(object["nested"] as? [String: Any])
    XCTAssertEqual(nested["deep"] as? Bool, true)
    XCTAssertEqual(object["n"] as? Int, 7)
  }

  func testGetValuesReturnsValuesObject() async throws {
    let store = FakeStore(seeded: [seededEntry()])
    let response = try await responseObject(
      await router(store).handle(requestData: requestData("getValues", ["id": "e1"])))
    let result = try XCTUnwrap(response["result"] as? [String: Any])
    let values = try XCTUnwrap(result["values"] as? [String: Any])
    XCTAssertEqual(values["token"] as? String, "abc")
  }

  func testSetEnabledAndDelete() async throws {
    let store = FakeStore(seeded: [seededEntry()])
    let router = router(store)

    let disabled = try await responseObject(
      await router.handle(requestData: requestData("setEnabled", ["id": "e1", "enabled": false])))
    XCTAssertEqual(disabled["ok"] as? Bool, true)

    let deleted = try await responseObject(
      await router.handle(requestData: requestData("deleteEntry", ["id": "e1"])))
    let result = try XCTUnwrap(deleted["result"] as? [String: Any])
    XCTAssertEqual(result["deleted"] as? Bool, true)

    // Deleting something absent reports false rather than failing: the caller
    // is mirroring and may simply be behind.
    let missing = try await responseObject(
      await router.handle(requestData: requestData("deleteEntry", ["id": "gone"])))
    let missingResult = try XCTUnwrap(missing["result"] as? [String: Any])
    XCTAssertEqual(missingResult["deleted"] as? Bool, false)
  }

  func testPutEntryRoutesToUpsert() async throws {
    let store = FakeStore()
    let payload: [String: Any] = [
      "entry": [
        "id": "mirror-1", "kind": "script", "enabled": true, "position": 1,
        "installedAt": 1, "updatedAt": 2, "code": "console.log(1)",
        "meta": ["name": "Mirror"], "source": ["type": "inline"], "values": ["k": "v"],
      ]
    ]
    let response = try await responseObject(
      await router(store).handle(requestData: requestData("putEntry", payload)))
    XCTAssertEqual(response["ok"] as? Bool, true)

    let snapshot = try await store.snapshot()
    let entry = try XCTUnwrap(snapshot.entries.first)
    XCTAssertEqual(entry.record.id, "mirror-1")
    XCTAssertEqual(valueDescription(entry.values, "k"), "v")
  }

  func testExportImportRoundTripThroughWire() async throws {
    let store = FakeStore(seeded: [seededEntry()])
    let source = router(store)

    let exported = try await responseObject(
      await source.handle(requestData: requestData("exportAll", [:])))
    let exportedResult = try XCTUnwrap(exported["result"] as? [String: Any])
    let bundle = try XCTUnwrap(exportedResult["bundle"] as? [String: Any])
    XCTAssertEqual((bundle["scripts"] as? [Any])?.count, 1)

    let target = FakeStore()
    let imported = try await responseObject(
      await router(target).handle(
        requestData: requestData("importAll", ["bundle": bundle, "mode": "merge"])))
    let importedResult = try XCTUnwrap(imported["result"] as? [String: Any])
    XCTAssertEqual(importedResult["count"] as? Int, 1)
  }

  func testBadEnvelopeUnknownOpAndWrongVersion() async throws {
    let router = router(FakeStore())

    let malformed = try await responseObject(
      await router.handle(requestData: Data("{ not json".utf8)))
    XCTAssertEqual(errorCode(malformed), "badRequest")

    let unknown = try await responseObject(
      await router.handle(requestData: requestData("teleport", [:])))
    XCTAssertEqual(errorCode(unknown), "unsupported")

    let wrongVersion = try await responseObject(
      await router.handle(requestData: requestData("ping", [:], version: 99)))
    XCTAssertEqual(errorCode(wrongVersion), "badRequest")
  }

  func testStoreErrorsMapToWireCodes() async throws {
    let store = FakeStore()
    let router = router(store)

    await store.setFailNext(StoreError.notFound)
    let notFound = try await responseObject(
      await router.handle(requestData: requestData("getValues", ["id": "nope"])))
    XCTAssertEqual(errorCode(notFound), "notFound")

    await store.setFailNext(StoreError.io("disk went away"))
    let io = try await responseObject(
      await router.handle(requestData: requestData("getValues", ["id": "nope"])))
    XCTAssertEqual(errorCode(io), "io")
  }

  func testMissingRequiredPayloadFieldNamesTheKey() async throws {
    // `sinceRev` is required for getChanges: fail fast, and say what is missing.
    let response = try await responseObject(
      await router(FakeStore()).handle(requestData: requestData("getChanges", [:])))
    XCTAssertEqual(errorCode(response), "badRequest")
    let message = try XCTUnwrap((response["error"] as? [String: Any])?["message"] as? String)
    XCTAssertTrue(message.contains("sinceRev"), "message should name the key: \(message)")
  }

  func testWrongPayloadTypeIsRejected() async throws {
    // `enabled` as a string is a type error, not something to coerce.
    let response = try await responseObject(
      await router(FakeStore()).handle(
        requestData: requestData("setEnabled", ["id": "e1", "enabled": "yes"])))
    XCTAssertEqual(errorCode(response), "badRequest")
  }

  func testSharedCreateEntryFixtureIsAccepted() async throws {
    // The same fixture the TypeScript tests use, so one file pins both sides.
    let data = try Data(contentsOf: try fixtureURL("request-createEntry.json"))
    let store = FakeStore()
    let response = try await responseObject(await router(store).handle(requestData: data))
    XCTAssertEqual(response["ok"] as? Bool, true, "shared fixture must be accepted")

    let snapshot = try await store.snapshot()
    let entry = try XCTUnwrap(snapshot.entries.first)
    XCTAssertEqual(entry.record.meta.name, "Demo")
    XCTAssertEqual(entry.record.meta.matches, ["https://example.org/*"])
  }

  func testSharedWireEntryFixtureDecodesAndRoundTrips() async throws {
    let object = try JSONSerialization.jsonObject(
      with: try Data(contentsOf: try fixtureURL("wire-entry.json")))

    let entry = try WireEntry(jsonObject: object)
    XCTAssertEqual(entry.id, "e1")
    XCTAssertEqual(entry.kind, .script)
    XCTAssertEqual(entry.meta.name, "Demo")
    XCTAssertEqual(entry.connectGrants, ["api.example.org"])

    // Opaque values survive a decode/encode cycle unchanged.
    let reencoded = try JSONSerialization.data(withJSONObject: try entry.jsonObject())
    let roundTripped = try WireEntry(jsonObject: try JSONSerialization.jsonObject(with: reencoded))
    XCTAssertEqual(valueDescription(roundTripped.fullEntry().values, "token"), "abc")
  }
}
