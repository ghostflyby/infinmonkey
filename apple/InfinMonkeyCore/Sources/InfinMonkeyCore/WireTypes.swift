import Foundation

/// Wire projection of an entry, matching the field names the extension uses.
///
/// `Codable` throughout: the compiler writes the mapping, required members are
/// required (a missing or wrongly typed one fails the request instead of being
/// silently defaulted), and keys a newer extension sends are ignored.
///
/// The type exists because the wire and the store agree on most but not all
/// members — the store also tracks `rev` and `codeSha`, which the extension has
/// no business seeing — so the conversion is written out rather than shared.
struct WireEntry: Codable, Sendable, Equatable {
  var id: String
  var kind: EntryKind
  var enabled: Bool
  var position: Int
  var installedAt: Int64
  var updatedAt: Int64
  var code: String
  /// nil means "nothing parsed this code yet". The extension's contract has the
  /// member present and always an object, so nil is written as `{}`.
  var meta: ScriptMeta?
  var source: EntrySource
  var connectGrants: [String]?
  /// GM values, carried as the graph itself. The extension owns their meaning.
  var values: JSONBody?
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
    self.values = full.values.map { JSONBody(data: $0) }
    self.metaStale = full.record.metaStale ? true : nil
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
      metaStale: metaStale ?? (meta == nil),
      meta: meta,
      source: source,
      connectGrants: connectGrants ?? [])
    return FullEntry(record: record, code: code, values: values?.data)
  }

  private enum CodingKeys: String, CodingKey {
    case id, kind, enabled, position, installedAt, updatedAt, code, meta, source
    case connectGrants, values, metaStale
  }

  /// `meta` is optional (absent and `null` both mean "nothing has parsed this
  /// code yet") while the remaining members are a one-to-one mapping. Required
  /// members use `decode`, matching the contract: a missing one fails the
  /// request rather than defaulting.
  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    // Required by the contract: absent or wrongly typed fails the request.
    self.id = try container.decode(String.self, forKey: .id)
    self.kind = try container.decode(EntryKind.self, forKey: .kind)
    self.enabled = try container.decode(Bool.self, forKey: .enabled)
    self.position = try container.decode(Int.self, forKey: .position)
    self.installedAt = try container.decode(Int64.self, forKey: .installedAt)
    self.updatedAt = try container.decode(Int64.self, forKey: .updatedAt)
    self.code = try container.decode(String.self, forKey: .code)
    self.source = try container.decode(EntrySource.self, forKey: .source)
    // Optional by contract.
    self.connectGrants = try container.decodeIfPresent([String].self, forKey: .connectGrants)
    self.values = try container.decodeIfPresent(JSONBody.self, forKey: .values)
    self.metaStale = try container.decodeIfPresent(Bool.self, forKey: .metaStale)
    // `null` and an absent member both mean "nothing has parsed this code yet".
    self.meta = try container.decodeIfPresent(ScriptMeta.self, forKey: .meta)
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(id, forKey: .id)
    try container.encode(kind, forKey: .kind)
    try container.encode(enabled, forKey: .enabled)
    try container.encode(position, forKey: .position)
    try container.encode(installedAt, forKey: .installedAt)
    try container.encode(updatedAt, forKey: .updatedAt)
    try container.encode(code, forKey: .code)
    try container.encode(source, forKey: .source)
    try container.encodeIfPresent(connectGrants, forKey: .connectGrants)
    try container.encodeIfPresent(values, forKey: .values)
    try container.encodeIfPresent(metaStale, forKey: .metaStale)
    // Present as `null` when nothing has parsed this code yet: the key stays in
    // the frame, and `null` is what the TypeScript side's `unknown` already
    // admits, so no consumer needs a special "empty object" case.
    try container.encode(meta, forKey: .meta)
  }
}

/// Wire projection of an entry summary.
struct WireSummary: Codable, Sendable, Equatable {
  var id: String
  var kind: EntryKind
  /// Absent when the entry has no name to report yet (nothing parsed, or an
  /// empty `@name`); the receiver decides what to show.
  var name: String?
  var version: String?
  var enabled: Bool
  var position: Int
  var updatedAt: Int64
  var metaStale: Bool

  init(summary: EntrySummary) {
    self.id = summary.id
    self.kind = summary.kind
    self.name = summary.name
    self.version = summary.version
    self.enabled = summary.enabled
    self.position = summary.position
    self.updatedAt = summary.updatedAt
    self.metaStale = summary.metaStale
  }
}

/// Wire projection of an export bundle: the file the app writes, and the payload
/// `importAll` accepts. Entries keep their values as JSON objects.
struct WireBundle: Codable, Sendable, Equatable {
  var infinmonkey: Int
  var version: String
  var exportedAt: Int64
  var scripts: [WireEntry]
  var styles: [WireEntry]

  init(
    infinmonkey: Int = 1,
    version: String,
    exportedAt: Int64,
    scripts: [WireEntry],
    styles: [WireEntry]
  ) {
    self.infinmonkey = infinmonkey
    self.version = version
    self.exportedAt = exportedAt
    self.scripts = scripts
    self.styles = styles
  }

  init(bundle: ExportBundle) {
    self.init(
      infinmonkey: bundle.infinmonkey,
      version: bundle.version,
      exportedAt: bundle.exportedAt,
      scripts: bundle.scripts.map(WireEntry.init(full:)),
      styles: bundle.styles.map(WireEntry.init(full:)))
  }

  func exportBundle() -> ExportBundle {
    ExportBundle(
      infinmonkey: infinmonkey,
      version: version,
      exportedAt: exportedAt,
      scripts: scripts.map { $0.fullEntry() },
      styles: styles.map { $0.fullEntry() })
  }
}

/// Typed op payloads: what the extension sends. A member is typed when the
/// native side must reason about it, and absent when it is opaque (those live in
/// the frame's opaque body).
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

  /// `values` is absent here on purpose: it is opaque, so the router reads it
  /// from the frame body into a `JSONBody` and never models it.
  struct CreateEntry: Codable, Sendable {
    var kind: EntryKind
    var code: String
    var meta: ScriptMeta?
    var source: EntrySource?
    var enabled: Bool?
  }

  struct PutEntry: Codable, Sendable {
    var entry: WireEntry
  }

  struct ImportAll: Codable, Sendable {
    var bundle: WireBundle
    var mode: ImportMode
  }
}

/// Typed op results: what the native side sends back.
enum WireResult {
  struct Pong: Codable, Sendable {
    var proto: Int
    var app: String
    var platform: String
  }

  struct Hello: Codable, Sendable {
    var proto: Int
    var app: String
    var platform: String
    var rev: Int
    var entries: [WireSummary]
  }

  struct List: Codable, Sendable {
    var rev: Int
    var entries: [WireEntry]
  }

  struct Changes: Codable, Sendable {
    var rev: Int
    var upserts: [WireEntry]
    var deletedIds: [String]
  }

  struct Entry: Codable, Sendable {
    var rev: Int
    var entry: WireEntry
  }

  struct Rev: Codable, Sendable {
    var rev: Int
  }

  struct Deleted: Codable, Sendable {
    var rev: Int
    var deleted: Bool
  }

  struct Values: Codable, Sendable {
    var values: JSONBody
  }

  struct Imported: Codable, Sendable {
    var rev: Int
    var count: Int
  }

  struct Export: Codable, Sendable {
    var bundle: WireBundle
  }
}
