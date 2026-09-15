import Foundation

/// Failures surfaced by the store. Typed so callers (and the protocol layer)
/// can map them onto wire error codes without string matching.
public enum StoreError: Error, Equatable {
  /// No entry with the requested id.
  case notFound
  /// The caller asked for something structurally impossible (e.g. an id that
  /// cannot be a file name, or an unknown import mode).
  case badRequest(String)
  /// Filesystem or encoding failure.
  case io(String)
  /// `index.json` exists but could not be read as the expected document. The
  /// store refuses to guess rather than rebuild and lose metadata.
  case corruptIndex(String)
}

/// The persisted index: the structured half of the store.
///
/// Code lives in per-entry files and GM values in opaque sidecar files, so
/// neither is part of this document. `v` is the document version, `rev` the
/// store-wide revision the change stream is expressed in.
public struct IndexDocument: Codable, Sendable, Equatable {
  public var v: Int
  public var rev: Int
  public var entries: [EntryRecord]
  public var tombstones: [Tombstone]

  public init(
    v: Int = CoreConstants.storeVersion, rev: Int = 0, entries: [EntryRecord] = [],
    tombstones: [Tombstone] = []
  ) {
    self.v = v
    self.rev = rev
    self.entries = entries
    self.tombstones = tombstones
  }

  /// Stamps a record with the revision the in-flight mutation will persist.
  /// Every record touched by one mutation shares that revision; the document
  /// increments once, when the mutation is saved.
  func stampNextRev(for record: inout EntryRecord) {
    record.rev = rev + 1
  }

  /// Drops tombstones old enough that no client can still be syncing from
  /// before them.
  mutating func pruneTombstones() -> Bool {
    let cutoff = rev - CoreConstants.tombstoneRetention
    guard tombstones.contains(where: { $0.rev < cutoff }) else { return false }
    tombstones.removeAll { $0.rev < cutoff }
    return true
  }
}
