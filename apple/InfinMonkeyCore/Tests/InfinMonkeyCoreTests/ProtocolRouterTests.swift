import Foundation
import Testing

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
    meta: ScriptMeta?,
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
      updatedAt: 0, rev: rev, codeSha: "sha", metaStale: meta == nil, meta: meta, source: source)
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
      entry.record.metaStale = false  // the caller parsed the code it just sent
    }
    entry.record.rev = rev
    entries[id] = entry
    return entry
  }

  @discardableResult
  func updateMeta(id: String, meta: ScriptMeta, fromParsing: Bool) throws -> FullEntry {
    try checkFailure()
    guard var entry = entries[id] else { throw StoreError.notFound }
    bump()
    let previouslyParsed = entry.record.meta != nil
    entry.record.meta = meta
    entry.record.metaStale = fromParsing ? false : !previouslyParsed
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
    guard StoreLayout.isValidID(entry.record.id) else {
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
  try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
}

func errorCode(_ response: [String: Any]) -> String? {
  (response["error"] as? [String: Any])?["code"] as? String
}

func seededEntry(
  id: String = "e1", kind: EntryKind = .script, meta: ScriptMeta? = nil
) -> FullEntry {
  let resolved = meta ?? demoMeta(name: "Demo")
  return FullEntry(
    record: EntryRecord(
      id: id, kind: kind, enabled: true, position: 1, installedAt: 0, updatedAt: 0, rev: 1,
      codeSha: "", metaStale: false, meta: resolved, source: .inline),
    code: scriptCode(),
    values: kind == .script ? valuesBlob(["token": "abc"]) : nil)
}

@Suite struct ProtocolRouterTests {

  private func router(_ store: FakeStore) -> ProtocolRouter {
    ProtocolRouter(store: store, platform: "macos")
  }

  @Test func pingAndHello() async throws {
    let store = FakeStore(seeded: [seededEntry()])
    let router = router(store)

    let pong = try await responseObject(await router.handle(requestData: requestData("ping", [:])))
    #expect(pong["ok"] as? Bool == true)
    let pongResult = try #require(pong["result"] as? [String: Any])
    #expect(pongResult["proto"] as? Int == 1)
    #expect(pongResult["platform"] as? String == "macos")

    let hello = try await responseObject(
      await router.handle(requestData: requestData("hello", [:])))
    let helloResult = try #require(hello["result"] as? [String: Any])
    #expect(helloResult["app"] as? String == "InfinMonkey")
    let entries = try #require(helloResult["entries"] as? [[String: Any]])
    #expect(entries.count == 1)
    #expect(entries[0]["name"] as? String == "Demo")
  }

  @Test func listEntriesCarriesCodeAndOpaqueValues() async throws {
    let store = FakeStore(seeded: [seededEntry()])
    let response = try await responseObject(
      await router(store).handle(requestData: requestData("listEntries", [:])))
    let result = try #require(response["result"] as? [String: Any])
    let entries = try #require(result["entries"] as? [[String: Any]])
    #expect(entries[0]["code"] as? String == scriptCode())
    #expect(entries[0]["kind"] as? String == "script")
    // Opaque values come back as JSON, not as a mangled string.
    let values = try #require(entries[0]["values"] as? [String: Any])
    #expect(values["token"] as? String == "abc")
  }

  @Test func createEntryKeepsNestedOpaqueValues() async throws {
    let store = FakeStore()
    let payload: [String: Any] = [
      "kind": "script",
      "code": scriptCode(),
      "meta": ["name": "Created"],
      "values": ["nested": ["deep": true], "n": 7],
    ]
    let response = try await responseObject(
      await router(store).handle(requestData: requestData("createEntry", payload)))
    #expect(response["ok"] as? Bool == true)

    let snapshot = try await store.snapshot()
    let entry = try #require(snapshot.entries.first)
    let blob = try #require(entry.values)
    let object = try #require(try JSONSerialization.jsonObject(with: blob) as? [String: Any])
    let nested = try #require(object["nested"] as? [String: Any])
    #expect(nested["deep"] as? Bool == true)
    #expect(object["n"] as? Int == 7)
  }

  @Test func getValuesReturnsValuesObject() async throws {
    let store = FakeStore(seeded: [seededEntry()])
    let response = try await responseObject(
      await router(store).handle(requestData: requestData("getValues", ["id": "e1"])))
    let result = try #require(response["result"] as? [String: Any])
    let values = try #require(result["values"] as? [String: Any])
    #expect(values["token"] as? String == "abc")
  }

  @Test func setEnabledAndDelete() async throws {
    let store = FakeStore(seeded: [seededEntry()])
    let router = router(store)

    let disabled = try await responseObject(
      await router.handle(requestData: requestData("setEnabled", ["id": "e1", "enabled": false])))
    #expect(disabled["ok"] as? Bool == true)

    let deleted = try await responseObject(
      await router.handle(requestData: requestData("deleteEntry", ["id": "e1"])))
    let result = try #require(deleted["result"] as? [String: Any])
    #expect(result["deleted"] as? Bool == true)

    // Deleting something absent reports false rather than failing: the caller
    // is mirroring and may simply be behind.
    let missing = try await responseObject(
      await router.handle(requestData: requestData("deleteEntry", ["id": "gone"])))
    let missingResult = try #require(missing["result"] as? [String: Any])
    #expect(missingResult["deleted"] as? Bool == false)
  }

  @Test func putEntryRoutesToUpsert() async throws {
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
    #expect(response["ok"] as? Bool == true)

    let snapshot = try await store.snapshot()
    let entry = try #require(snapshot.entries.first)
    #expect(entry.record.id == "mirror-1")
    #expect(valueDescription(entry.values, "k") == "v")
  }

  @Test func exportImportRoundTripThroughWire() async throws {
    let store = FakeStore(seeded: [seededEntry()])
    let source = router(store)

    let exported = try await responseObject(
      await source.handle(requestData: requestData("exportAll", [:])))
    let exportedResult = try #require(exported["result"] as? [String: Any])
    let bundle = try #require(exportedResult["bundle"] as? [String: Any])
    #expect((bundle["scripts"] as? [Any])?.count == 1)

    let target = FakeStore()
    let imported = try await responseObject(
      await router(target).handle(
        requestData: requestData("importAll", ["bundle": bundle, "mode": "merge"])))
    let importedResult = try #require(imported["result"] as? [String: Any])
    #expect(importedResult["count"] as? Int == 1)
  }

  @Test func badEnvelopeUnknownOpAndWrongVersion() async throws {
    let router = router(FakeStore())

    let malformed = try await responseObject(
      await router.handle(requestData: Data("{ not json".utf8)))
    #expect(errorCode(malformed) == "badRequest")

    let unknown = try await responseObject(
      await router.handle(requestData: requestData("teleport", [:])))
    #expect(errorCode(unknown) == "unsupported")
    #expect(
      unknown["id"] as? String == "req-1", "the reply echoes the request id even for an unknown op")

    let wrongVersion = try await responseObject(
      await router.handle(requestData: requestData("ping", [:], version: 99)))
    #expect(errorCode(wrongVersion) == "badRequest")
  }

  @Test func storeErrorsMapToWireCodes() async throws {
    let store = FakeStore()
    let router = router(store)

    await store.setFailNext(StoreError.notFound)
    let notFound = try await responseObject(
      await router.handle(requestData: requestData("getValues", ["id": "nope"])))
    #expect(errorCode(notFound) == "notFound")

    await store.setFailNext(StoreError.io("disk went away"))
    let io = try await responseObject(
      await router.handle(requestData: requestData("getValues", ["id": "nope"])))
    #expect(errorCode(io) == "io")
  }

  @Test func missingRequiredPayloadFieldNamesTheKey() async throws {
    // `sinceRev` is required for getChanges: fail fast, and say what is missing.
    let response = try await responseObject(
      await router(FakeStore()).handle(requestData: requestData("getChanges", [:])))
    #expect(errorCode(response) == "badRequest")
    let message = try #require((response["error"] as? [String: Any])?["message"] as? String)
    #expect(message.contains("sinceRev"), "message should name the key: \(message)")
  }

  @Test func wrongPayloadTypeIsRejected() async throws {
    // `enabled` as a string is a type error, not something to coerce. The reply
    // echoes the request id and names the op that failed.
    let response = try await responseObject(
      await router(FakeStore()).handle(
        requestData: requestData("setEnabled", ["id": "e1", "enabled": "yes"])))
    #expect(errorCode(response) == "badRequest")
    #expect(response["id"] as? String == "req-1")
    let message = try #require((response["error"] as? [String: Any])?["message"] as? String)
    #expect(message.hasPrefix("setEnabled:"), "the failure names the op: \(message)")
  }

  @Test func sharedCreateEntryFixtureIsAccepted() async throws {
    // The same fixture the TypeScript tests use, so one file pins both sides.
    let data = try Data(contentsOf: try fixtureURL("request-createEntry.json"))
    let store = FakeStore()
    let response = try await responseObject(await router(store).handle(requestData: data))
    #expect(response["ok"] as? Bool == true, "shared fixture must be accepted")

    let snapshot = try await store.snapshot()
    let entry = try #require(snapshot.entries.first)
    #expect(entry.record.meta?.name == "Demo")
    #expect(entry.record.meta?.matches == ["https://example.org/*"])
  }

  @Test func sharedWireEntryFixtureDecodesAndRoundTrips() async throws {
    // The fixture is read through the same container the transports use, so the
    // test exercises the real path rather than a test-only initializer.
    let data = try Data(contentsOf: try fixtureURL("wire-entry.json"))
    let body = try JSONBody(data: data, requiringValidJSON: true)

    let entry = try body.decoded(as: WireEntry.self)
    #expect(entry.id == "e1")
    #expect(entry.kind == .script)
    #expect(entry.meta?.name == "Demo")
    #expect(entry.connectGrants == ["api.example.org"])

    // Opaque values survive a decode/encode cycle unchanged, as JSON — not base64.
    let reencoded = try JSONEncoder().encode(entry)
    let text = try #require(String(data: reencoded, encoding: .utf8))
    #expect(!text.contains("eyJ"), "values must not be base64: \(text)")
    let roundTripped = try JSONDecoder().decode(WireEntry.self, from: reencoded)
    #expect(valueDescription(roundTripped.fullEntry().values, "token") == "abc")
  }

  @Test func missingMetaIsWrittenAsNull() async throws {
    let entry = FullEntry(record: makeRecord(id: "e1", meta: nil), code: "x", values: nil)
    let data = try JSONEncoder().encode(WireEntry(full: entry))
    let object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])

    // The member stays present, spelled `null` — which the TypeScript side's
    // `unknown` already admits, so no consumer needs an "empty object" case.
    #expect(object.keys.contains("meta"), "meta must be present in the frame")
    #expect(
      object["meta"] is NSNull, "meta must be null, got \(String(describing: object["meta"]))")

    // And it reads back as "nothing parsed", not as a parsed empty value.
    let back = try JSONDecoder().decode(WireEntry.self, from: data)
    #expect(back.meta == nil)
  }
}
