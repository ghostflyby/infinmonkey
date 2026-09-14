import Foundation

public enum EntryKind: String, Codable, Sendable, CaseIterable {
  case script
  case style
}

/// Where an entry's code comes from; mirrors `EntrySource` in
/// packages/shared/src/types.ts.
///
/// A closed set with known structure, so it is modeled rather than carried
/// opaquely. The wire shape is an **internally tagged** union, keeping the
/// TypeScript discriminator alongside its payload:
/// `{"type":"inline"}` or `{"type":"dev","url":"...","autoReload":true}`.
///
/// That shape is not a stylistic choice. Swift's synthesized enum coding emits an
/// *externally tagged* union instead (`{"dev":{"url":…}}`, plus a redundant
/// `{"inline":{}}` for the payload-free case), and the other two implementations
/// cannot read it: `System.Text.Json` has first-class support for internal
/// tagging (`[JsonPolymorphic]`, and it rejects an untagged payload outright),
/// while TypeScript narrows on `source.type === "dev"`. Internal tagging is the
/// one form that is idiomatic in all three, and it matches the frame envelope,
/// which already carries `v`/`id`/`type` side by side.
///
/// The members live on a payload struct so synthesis writes them: adding a member
/// is a change in one place, rather than another line in a hand-written coder.
public enum EntrySource: Sendable, Equatable {
  case inline
  case dev(Dev)

  /// Payload of the `dev` case.
  public struct Dev: Codable, Sendable, Equatable {
    public var url: String
    /// Required, matching the TypeScript type: every construction site sends it.
    public var autoReload: Bool

    public init(url: String, autoReload: Bool) {
      self.url = url
      self.autoReload = autoReload
    }
  }
}

extension EntrySource: Codable {
  /// Reads only the discriminator. `JSONDecoder` ignores members it does not
  /// know, so this tolerates the payload sitting beside it.
  private struct Discriminator: Codable {
    var type: String
  }

  /// Hand-written for the discriminator only; both cases then decode from the
  /// same decoder — `try X(from: decoder)` does not consume it.
  ///
  /// An unrecognized tag is an error rather than a fallback: a sender that
  /// invents a source kind is telling us it expects behavior we do not have.
  public init(from decoder: Decoder) throws {
    switch try Discriminator(from: decoder).type {
    case "inline":
      self = .inline
    case "dev":
      self = .dev(try Dev(from: decoder))
    default:
      throw DecodingError.dataCorrupted(
        .init(
          codingPath: decoder.codingPath,
          debugDescription: "unknown EntrySource discriminator"))
    }
  }

  /// Encodes the discriminator and the payload into the same object. Writing both
  /// to one encoder merges them, which is what keeps the tag a sibling of the
  /// payload instead of a wrapper.
  ///
  /// The payload must not declare a `type` member: a later write to the same
  /// encoder silently overwrites an earlier one, so a name collision would
  /// replace the discriminator.
  public func encode(to encoder: Encoder) throws {
    switch self {
    case .inline:
      try Discriminator(type: "inline").encode(to: encoder)
    case .dev(let payload):
      try Discriminator(type: "dev").encode(to: encoder)
      try payload.encode(to: encoder)
    }
  }
}

/// Index record: everything about an entry except its code (its own file) and
/// its GM values (the opaque sidecar file).
///
/// `fileName` is derived from `id` and `kind` rather than stored, so the three
/// cannot drift apart.
public struct EntryRecord: Codable, Sendable, Equatable {

  public var id: String
  public var kind: EntryKind
  public var enabled: Bool
  public var position: Int
  public var installedAt: Int64
  public var updatedAt: Int64
  /// Revision at which this entry was last mutated; drives the change stream.
  public var rev: Int
  /// SHA-256 hex of the code file at last known state.
  public var codeSha: String
  /// True when the code file changed outside the app: the parsed metadata is
  /// stale and the extension must re-parse the code.
  public var metaStale: Bool
  /// Parsed metadata, or nil when nothing has parsed this entry's code yet
  /// (an adopted file, a fresh import, a create from the app). The extension
  /// owns parsing, so nil means "it must parse this and push the result back".
  public var meta: ScriptMeta?
  public var source: EntrySource
  public var connectGrants: [String]

  init(
    id: String,
    kind: EntryKind,
    enabled: Bool,
    position: Int,
    installedAt: Int64,
    updatedAt: Int64,
    rev: Int,
    codeSha: String,
    metaStale: Bool,
    meta: ScriptMeta?,
    source: EntrySource,
    connectGrants: [String] = []
  ) {
    self.id = id
    self.kind = kind
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

  /// File name holding this entry's code.
  public var fileName: String { StoreLayout.codeFileName(id: id, kind: kind) }

  private enum CodingKeys: String, CodingKey {
    case id, kind, enabled, position, installedAt, updatedAt, rev, codeSha, metaStale
    case meta, source, connectGrants
  }

  /// Hand-written because a non-optional member whose key is absent throws even
  /// when the property has a default value, and the index is read back from
  /// another build. Absent members therefore take their documented default while
  /// a wrongly typed one is still an error.
  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    self.init(
      id: try container.decode(String.self, forKey: .id),
      kind: try container.decode(EntryKind.self, forKey: .kind),
      enabled: try container.decode(Bool.self, forKey: .enabled),
      position: try container.decode(Int.self, forKey: .position),
      installedAt: try container.decode(Int64.self, forKey: .installedAt),
      updatedAt: try container.decode(Int64.self, forKey: .updatedAt),
      rev: try container.decode(Int.self, forKey: .rev),
      codeSha: try container.decodeIfPresent(String.self, forKey: .codeSha) ?? "",
      metaStale: try container.decodeIfPresent(Bool.self, forKey: .metaStale) ?? false,
      meta: try container.decodeIfPresent(ScriptMeta.self, forKey: .meta),
      source: try container.decodeIfPresent(EntrySource.self, forKey: .source) ?? .inline,
      connectGrants: try container.decodeIfPresent([String].self, forKey: .connectGrants) ?? [])
  }

}

/// A record together with its code file and its opaque GM values.
///
/// `values` is raw JSON — the extension owns its meaning, and this layer only
/// carries the bytes. `nil` means the entry has no values file (styles).
///
/// Deliberately **not** `Codable`: `Data` encodes as a base64 string, so an
/// exported file would carry `"values": "eyJrIjoxfQ=="` instead of an object and
/// break the contract the extension reads. Serialization goes through
/// `WireEntry`, which carries values as a `JSONBody`.
public struct FullEntry: Sendable, Equatable {
  public var record: EntryRecord
  public var code: String
  public var values: Data?

}

/// Lightweight descriptor for handshakes and list views.
public struct EntrySummary: Sendable, Equatable {
  public var id: String
  public var kind: EntryKind
  /// nil when there is no name to report: the code has not been parsed yet, or
  /// it parsed to an empty `@name`. Choosing what to display is a presentation
  /// concern, so no placeholder is invented here.
  public var name: String?
  public var version: String?
  public var enabled: Bool
  public var position: Int
  public var updatedAt: Int64
  public var metaStale: Bool

  init(record: EntryRecord) {
    self.id = record.id
    self.kind = record.kind
    self.name = record.meta.flatMap { $0.name.isEmpty ? nil : $0.name }
    self.version = record.meta?.version
    self.enabled = record.enabled
    self.position = record.position
    self.updatedAt = record.updatedAt
    self.metaStale = record.metaStale
  }
}

/// A deletion marker: entries removed at or before `rev` must be dropped by a
/// client syncing from an earlier revision.
public struct Tombstone: Codable, Sendable, Equatable {
  public var id: String
  public var rev: Int

}

// MARK: - Operation results

public struct Snapshot: Sendable, Equatable {
  public var rev: Int
  public var entries: [FullEntry]

}

public struct SummarySnapshot: Sendable, Equatable {
  public var rev: Int
  public var entries: [EntrySummary]

}

public struct Changes: Sendable, Equatable {
  public var rev: Int
  public var upserts: [FullEntry]
  public var deletedIds: [String]

}

/// Entries plus their code, as an import/export payload; mirrors
/// `ExportBundle` in packages/shared/src/types.ts.
///
/// In-memory only, and deliberately not `Codable` for the same reason as
/// `FullEntry`: its entries carry opaque bytes, which `Data` would turn into
/// base64. The file format is `WireBundle`.
public struct ExportBundle: Sendable, Equatable {
  /// Format version of the bundle; the only member with a default.
  public var infinmonkey: Int = 1
  public var version: String
  public var exportedAt: Int64
  public var scripts: [FullEntry]
  public var styles: [FullEntry]

  public var allEntries: [FullEntry] { scripts + styles }
}

public enum ImportMode: String, Sendable, Codable {
  case merge
  case replace
}
