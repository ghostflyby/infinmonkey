import Foundation

public enum EntryKind: String, Codable, Sendable, CaseIterable {
  case script
  case style
}

/// Where an entry's code comes from; mirrors `EntrySource` in
/// packages/shared/src/types.ts.
///
/// A closed set with known structure, so it is modeled rather than carried
/// opaquely. The wire shape keeps the TypeScript discriminator:
/// `{"type":"inline"}` or `{"type":"dev","url":"...","autoReload":true}`.
public enum EntrySource: Sendable, Equatable {
  case inline
  case dev(url: String, autoReload: Bool)

  private enum CodingKeys: String, CodingKey {
    case type, url, autoReload
  }

  private enum Kind: String, Codable {
    case inline, dev
  }
}

extension EntrySource: Codable {
  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    switch try container.decode(Kind.self, forKey: .type) {
    case .inline:
      self = .inline
    case .dev:
      self = .dev(
        url: try container.decode(String.self, forKey: .url),
        autoReload: try container.decodeIfPresent(Bool.self, forKey: .autoReload) ?? false)
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .inline:
      try container.encode(Kind.inline, forKey: .type)
    case .dev(let url, let autoReload):
      try container.encode(Kind.dev, forKey: .type)
      try container.encode(url, forKey: .url)
      try container.encode(autoReload, forKey: .autoReload)
    }
  }

  public var isDev: Bool {
    if case .dev = self { return true }
    return false
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
  public var meta: ScriptMeta
  public var source: EntrySource
  public var connectGrants: [String]

  public init(
    id: String,
    kind: EntryKind,
    enabled: Bool,
    position: Int,
    installedAt: Int64,
    updatedAt: Int64,
    rev: Int,
    codeSha: String,
    metaStale: Bool,
    meta: ScriptMeta,
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
}

/// A record together with its code file and its opaque GM values.
///
/// `values` is raw JSON — the extension owns its meaning, and this layer only
/// carries the bytes. `nil` means the entry has no values file (styles).
public struct FullEntry: Codable, Sendable, Equatable {
  public var record: EntryRecord
  public var code: String
  public var values: Data?

  public init(record: EntryRecord, code: String, values: Data?) {
    self.record = record
    self.code = code
    self.values = values
  }
}

/// Lightweight descriptor for handshakes and list views.
public struct EntrySummary: Sendable, Equatable {
  public var id: String
  public var kind: EntryKind
  public var name: String
  public var version: String?
  public var enabled: Bool
  public var position: Int
  public var updatedAt: Int64
  public var metaStale: Bool

  public init(record: EntryRecord) {
    self.id = record.id
    self.kind = record.kind
    self.name = record.meta.displayName
    self.version = record.meta.version
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

  public init(id: String, rev: Int) {
    self.id = id
    self.rev = rev
  }
}

// MARK: - Operation results

public struct Snapshot: Sendable, Equatable {
  public var rev: Int
  public var entries: [FullEntry]

  public init(rev: Int, entries: [FullEntry]) {
    self.rev = rev
    self.entries = entries
  }
}

public struct SummarySnapshot: Sendable, Equatable {
  public var rev: Int
  public var entries: [EntrySummary]

  public init(rev: Int, entries: [EntrySummary]) {
    self.rev = rev
    self.entries = entries
  }
}

public struct Changes: Sendable, Equatable {
  public var rev: Int
  public var upserts: [FullEntry]
  public var deletedIds: [String]

  public init(rev: Int, upserts: [FullEntry], deletedIds: [String]) {
    self.rev = rev
    self.upserts = upserts
    self.deletedIds = deletedIds
  }
}

/// Entries plus their code, as an import/export payload; mirrors
/// `ExportBundle` in packages/shared/src/types.ts.
public struct ExportBundle: Codable, Sendable, Equatable {
  public var infinmonkey: Int
  public var version: String
  public var exportedAt: Int64
  public var scripts: [FullEntry]
  public var styles: [FullEntry]

  public init(
    infinmonkey: Int = 1,
    version: String,
    exportedAt: Int64,
    scripts: [FullEntry],
    styles: [FullEntry]
  ) {
    self.infinmonkey = infinmonkey
    self.version = version
    self.exportedAt = exportedAt
    self.scripts = scripts
    self.styles = styles
  }

  public var allEntries: [FullEntry] { scripts + styles }
}

public enum ImportMode: String, Sendable, Codable {
  case merge
  case replace
}
