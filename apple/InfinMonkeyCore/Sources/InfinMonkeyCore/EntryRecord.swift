import Foundation

/// Wire/model constants shared by the extension and the native app.
public enum CoreConstants {
  public static let protocolVersion = 1
  public static let appName = "InfinMonkey"
  /// Store document version (index.json "v").
  public static let storeVersion = 1
  /// Version string written into export bundles.
  public static let storeVersionString = "0.1.0"
  /// Tombstones older than this many revisions are pruned from index.json.
  public static let tombstoneRetention = 1_000
}

public enum EntryKind: String, Sendable {
  case script
  case style
}

/// Lightweight metadata fields extracted from the parsed-meta blob for display.
/// The full blob is stored verbatim; the native side never interprets the rest.
public struct MetaSummary: Sendable, Equatable {
  public var name: String
  public var version: String?
  public var description: String?

  public init(name: String, version: String? = nil, description: String? = nil) {
    self.name = name
    self.version = version
    self.description = description
  }

  public init(meta: [String: Any]) {
    self.name = meta["name"] as? String ?? "未命名"
    self.version = meta["version"] as? String
    self.description = meta["description"] as? String
  }
}

/// Index record: everything about an entry except its code (entries/<id> file)
/// and its GM values (values/<id>.json). `meta` and `source` stay opaque.
public struct EntryRecord: Sendable {
  public var id: String
  public var kind: EntryKind
  public var fileName: String
  public var enabled: Bool
  public var position: Int
  public var installedAt: Int64
  public var updatedAt: Int64
  /// Revision at which this entry was last mutated (drives getChanges).
  public var rev: Int
  /// SHA-256 hex of the code file contents at last known state.
  public var codeSha: String
  /// True when the code file changed outside the app and `meta` needs re-parsing.
  public var metaStale: Bool
  public var meta: [String: Any]
  public var source: [String: Any]
  public var connectGrants: [String]

  public var summary: MetaSummary { MetaSummary(meta: meta) }

  public init(
    id: String,
    kind: EntryKind,
    fileName: String,
    enabled: Bool,
    position: Int,
    installedAt: Int64,
    updatedAt: Int64,
    rev: Int,
    codeSha: String,
    metaStale: Bool,
    meta: [String: Any],
    source: [String: Any],
    connectGrants: [String] = []
  ) {
    self.id = id
    self.kind = kind
    self.fileName = fileName
    self.enabled = enabled
    self.position = position
    self.installedAt = installedAt
    self.updatedAt = updatedAt
    self.rev = rev
    self.codeSha = codeSha
    self.metaStale = metaStale
    self.meta = meta
    self.source = source
    self.connectGrants = connectGrants
  }

  /// Deserialize from an index.json entry dict. Throws StoreError.io on shape violations.
  public init(dict: [String: Any]) throws {
    guard let id = dict["id"] as? String,
      let kindRaw = dict["kind"] as? String,
      let kind = EntryKind(rawValue: kindRaw),
      let fileName = dict["fileName"] as? String,
      let enabled = dict["enabled"] as? Bool,
      let position = dict["position"] as? Int,
      let installedAt = dict["installedAt"] as? Int64,
      let updatedAt = dict["updatedAt"] as? Int64,
      let rev = dict["rev"] as? Int,
      let codeSha = dict["codeSha"] as? String
    else {
      throw StoreError.io("malformed entry record in index")
    }
    let metaStale = dict["metaStale"] as? Bool ?? false
    let meta = dict["meta"] as? [String: Any] ?? [:]
    let source = dict["source"] as? [String: Any] ?? [:]
    let grants = dict["connectGrants"] as? [String] ?? []
    self.init(
      id: id, kind: kind, fileName: fileName, enabled: enabled, position: position,
      installedAt: installedAt, updatedAt: updatedAt, rev: rev, codeSha: codeSha,
      metaStale: metaStale, meta: meta, source: source, connectGrants: grants)
  }

  public func toDict() -> [String: Any] {
    [
      "id": id,
      "kind": kind.rawValue,
      "fileName": fileName,
      "enabled": enabled,
      "position": position,
      "installedAt": installedAt,
      "updatedAt": updatedAt,
      "rev": rev,
      "codeSha": codeSha,
      "metaStale": metaStale,
      "meta": meta,
      "source": source,
      "connectGrants": connectGrants,
    ]
  }
}

/// A full entry as transferred over the protocol: record fields + code + GM values.
public struct FullEntry: Sendable {
  public var record: EntryRecord
  public var code: String
  public var values: [String: Any]

  public init(record: EntryRecord, code: String, values: [String: Any]) {
    self.record = record
    self.code = code
    self.values = values
  }

  /// Wire shape checked by the TS guard `isWireEntry` (packages/protocol).
  public func toDict() -> [String: Any] {
    var d = record.toDict()
    d.removeValue(forKey: "fileName")
    d.removeValue(forKey: "rev")
    d.removeValue(forKey: "codeSha")
    d["code"] = code
    if record.kind == .script { d["values"] = values }
    return d
  }
}

public struct EntrySummary: Sendable {
  public var id: String
  public var kind: EntryKind
  public var summary: MetaSummary
  public var enabled: Bool
  public var position: Int
  public var updatedAt: Int64
  public var metaStale: Bool

  init(record: EntryRecord) {
    self.id = record.id
    self.kind = record.kind
    self.summary = record.summary
    self.enabled = record.enabled
    self.position = record.position
    self.updatedAt = record.updatedAt
    self.metaStale = record.metaStale
  }

  public func toDict() -> [String: Any] {
    var d: [String: Any] = [
      "id": id,
      "kind": kind.rawValue,
      "name": summary.name,
      "enabled": enabled,
      "position": position,
      "updatedAt": updatedAt,
      "metaStale": metaStale,
    ]
    if let v = summary.version { d["version"] = v }
    if let d2 = summary.description { d["description"] = d2 }
    return d
  }
}

public struct Tombstone: Sendable {
  public var id: String
  public var rev: Int

  public init(id: String, rev: Int) {
    self.id = id
    self.rev = rev
  }
}
