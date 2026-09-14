import Foundation

/// Helpers for moving between Foundation's two JSON paths at the boundary.
///
/// Semantically meaningful types (`ScriptMeta`, `EntrySource`) are `Codable`;
/// the wire envelope and opaque payloads go through `JSONSerialization`. These
/// two functions are the only bridges between them.
enum JSONCoding {
  /// Encode a typed value into `Any` so it can be embedded in a hand-built
  /// JSON object.
  static func object<T: Encodable>(_ value: T) throws -> Any {
    try JSONSerialization.jsonObject(with: JSONEncoder().encode(value))
  }

  /// Decode a typed value out of a value obtained from `JSONSerialization`.
  static func decode<T: Decodable>(_ type: T.Type, from object: Any) throws -> T {
    try JSONDecoder().decode(T.self, from: try JSONSerialization.data(withJSONObject: object))
  }
}

extension Dictionary where Key == String, Value == Any {
  func int(_ key: String) -> Int? { self[key] as? Int }
  func int64(_ key: String) -> Int64? {
    (self[key] as? NSNumber)?.int64Value
  }
  func string(_ key: String) -> String? { self[key] as? String }
  func bool(_ key: String) -> Bool? { self[key] as? Bool }
}

/// Wire projection of an entry, matching the field names the extension uses.
///
/// This is the single place the protocol's naming lives, so the domain model
/// stays free to differ. `values` is passed through as parsed JSON — never
/// inspected, validated, or reordered here.
struct WireEntry {
  var id: String
  var kind: EntryKind
  var enabled: Bool
  var position: Int
  var installedAt: Int64
  var updatedAt: Int64
  var code: String
  var meta: ScriptMeta
  var source: EntrySource
  var connectGrants: [String]?
  /// Opaque GM values (`Record<string, unknown>` on the extension side).
  var values: Any?
  var metaStale: Bool?

  init(full: FullEntry) {
    self.id = full.record.id
    self.kind = full.record.kind
    self.enabled = full.record.enabled
    self.position = full.record.position
    self.installedAt = full.record.installedAt
    self.updatedAt = full.record.updatedAt
    self.code = full.code
    self.meta = full.record.meta
    self.source = full.record.source
    self.connectGrants = full.record.kind == .script ? full.record.connectGrants : nil
    self.values = Self.parseOpaque(full.values)
    self.metaStale = full.record.metaStale ? true : nil
  }

  /// Decodes one entry out of a JSON object. Throws on a structurally invalid
  /// entry so the caller can report `badRequest` instead of storing nonsense.
  init(jsonObject: Any) throws {
    guard let object = jsonObject as? [String: Any],
      let id = object.string("id"), !id.isEmpty,
      let kindRaw = object.string("kind"), let kind = EntryKind(rawValue: kindRaw),
      let code = object.string("code")
    else {
      throw WireError.malformedEnvelope
    }
    self.id = id
    self.kind = kind
    self.code = code
    self.enabled = object.bool("enabled") ?? true
    self.position = object.int("position") ?? 0
    self.installedAt = object.int64("installedAt") ?? 0
    self.updatedAt = object.int64("updatedAt") ?? 0
    self.meta =
      object["meta"].flatMap { try? JSONCoding.decode(ScriptMeta.self, from: $0) } ?? .unparsed
    self.source =
      object["source"].flatMap { try? JSONCoding.decode(EntrySource.self, from: $0) } ?? .inline
    self.connectGrants = object["connectGrants"] as? [String]
    self.values = object["values"]
    self.metaStale = object.bool("metaStale")
  }

  /// Back into the domain model; `rev` and `codeSha` are store bookkeeping and
  /// are recomputed there.
  func fullEntry() -> FullEntry {
    let record = EntryRecord(
      id: id,
      kind: kind,
      enabled: enabled,
      position: position,
      installedAt: installedAt,
      updatedAt: updatedAt,
      rev: 0,
      codeSha: "",
      metaStale: metaStale ?? meta.isUnparsed,
      meta: meta,
      source: source,
      connectGrants: connectGrants ?? [])
    return FullEntry(record: record, code: code, values: Self.serializeOpaque(values))
  }

  func jsonObject() throws -> [String: Any] {
    var object: [String: Any] = [
      "id": id,
      "kind": kind.rawValue,
      "enabled": enabled,
      "position": position,
      "installedAt": installedAt,
      "updatedAt": updatedAt,
      "code": code,
      "meta": try JSONCoding.object(meta),
      "source": try JSONCoding.object(source),
    ]
    if let connectGrants { object["connectGrants"] = connectGrants }
    if let values { object["values"] = values }
    if metaStale == true { object["metaStale"] = true }
    return object
  }

  private static func parseOpaque(_ data: Data?) -> Any? {
    guard let data, !data.isEmpty else { return nil }
    return try? JSONSerialization.jsonObject(with: data)
  }

  private static func serializeOpaque(_ value: Any?) -> Data? {
    guard let value, JSONSerialization.isValidJSONObject(value) else { return nil }
    return try? JSONSerialization.data(withJSONObject: value)
  }
}

/// Wire projection of an entry summary.
struct WireSummary {
  var id: String
  var kind: EntryKind
  var name: String
  var version: String?
  var description: String?
  var enabled: Bool
  var position: Int
  var updatedAt: Int64
  var metaStale: Bool

  init(summary: EntrySummary, meta: ScriptMeta) {
    self.id = summary.id
    self.kind = summary.kind
    self.name = summary.name
    self.version = summary.version
    self.description = meta.description
    self.enabled = summary.enabled
    self.position = summary.position
    self.updatedAt = summary.updatedAt
    self.metaStale = summary.metaStale
  }

  func jsonObject() -> [String: Any] {
    var object: [String: Any] = [
      "id": id,
      "kind": kind.rawValue,
      "name": name,
      "enabled": enabled,
      "position": position,
      "updatedAt": updatedAt,
      "metaStale": metaStale,
    ]
    if let version { object["version"] = version }
    if let description { object["description"] = description }
    return object
  }
}

/// Wire projection of an export bundle.
struct WireBundle {
  var infinmonkey: Int?
  var version: String?
  var exportedAt: Int64?
  var scripts: [WireEntry]
  var styles: [WireEntry]

  init(bundle: ExportBundle) {
    self.infinmonkey = bundle.infinmonkey
    self.version = bundle.version
    self.exportedAt = bundle.exportedAt
    self.scripts = bundle.scripts.map(WireEntry.init(full:))
    self.styles = bundle.styles.map(WireEntry.init(full:))
  }

  init(jsonObject: Any) throws {
    let object = jsonObject as? [String: Any] ?? [:]
    self.infinmonkey = object["infinmonkey"] as? Int
    self.version = object["version"] as? String
    self.exportedAt = (object["exportedAt"] as? NSNumber)?.int64Value
    self.scripts = try (object["scripts"] as? [Any] ?? []).map(WireEntry.init(jsonObject:))
    self.styles = try (object["styles"] as? [Any] ?? []).map(WireEntry.init(jsonObject:))
  }

  func exportBundle() -> ExportBundle {
    ExportBundle(
      infinmonkey: infinmonkey ?? 1,
      version: version ?? CoreConstants.storeVersionString,
      exportedAt: exportedAt ?? 0,
      scripts: scripts.map { $0.fullEntry() },
      styles: styles.map { $0.fullEntry() })
  }

  func jsonObject() throws -> [String: Any] {
    [
      "infinmonkey": infinmonkey ?? 1,
      "version": version ?? CoreConstants.storeVersionString,
      "exportedAt": exportedAt ?? 0,
      "scripts": try scripts.map { try $0.jsonObject() },
      "styles": try styles.map { try $0.jsonObject() },
    ]
  }
}

/// Typed op payloads.
///
/// Only fields the native side must reason about are modeled. `values` is
/// deliberately absent from `CreateEntry`: it is opaque, so the router reads it
/// out of the raw payload with `JSONSerialization` and passes the bytes to the
/// store untouched. `JSONDecoder` ignores the keys it does not know, so the two
/// paths coexist without a wrapper type.
enum WirePayload {
  struct Hello: Codable, Sendable {
    var sinceRev: Int?
  }

  struct SinceRev: Codable, Sendable {
    var sinceRev: Int
  }

  struct Id: Codable, Sendable {
    var id: String
  }

  struct SetEnabled: Codable, Sendable {
    var id: String
    var enabled: Bool
  }

  struct Reorder: Codable, Sendable {
    var ids: [String]
  }

  struct UpdateMeta: Codable, Sendable {
    var id: String
    var meta: ScriptMeta
  }

  struct UpdateCode: Codable, Sendable {
    var id: String
    var code: String
    var meta: ScriptMeta?
  }

  struct CreateEntry: Codable, Sendable {
    var kind: EntryKind
    var code: String
    var meta: ScriptMeta?
    var source: EntrySource?
    var enabled: Bool?
  }
}

extension JSONCoding {
  /// The opaque `values` member of a payload, as bytes, or nil when absent.
  static func opaqueMember(_ key: String, in payload: Data) -> Data? {
    guard let object = try? JSONSerialization.jsonObject(with: payload) as? [String: Any],
      let value = object[key],
      JSONSerialization.isValidJSONObject(value)
    else { return nil }
    return try? JSONSerialization.data(withJSONObject: value)
  }
}
