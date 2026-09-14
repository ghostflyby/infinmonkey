import Foundation

/// The seam every consumer of the library uses: the app UI, the protocol
/// router, and tests all depend on this protocol rather than the concrete store.
///
/// Operations are `async` because the real implementation is an actor — it is
/// entered from the app's main actor, from the extension handler, and (later)
/// from a stdio host loop, and it must serialize access within the process on
/// top of the cross-process file lock.
public protocol EntryStoring: Sendable {
  /// Store-wide revision; advances with every persisted mutation.
  func currentRev() async throws -> Int

  /// Entry summaries (no code), optionally only those changed after `sinceRev`.
  func summaries(sinceRev: Int?) async throws -> SummarySnapshot

  /// Every entry with its code.
  func snapshot() async throws -> Snapshot

  func entry(id: String) async throws -> FullEntry

  /// Entries changed after `sinceRev`, plus the ids deleted after it.
  func changes(sinceRev: Int) async throws -> Changes

  /// Opaque GM value blob for a script, or `nil` when it has none.
  func values(id: String) async throws -> Data?

  @discardableResult
  func create(
    kind: EntryKind,
    code: String,
    meta: ScriptMeta,
    source: EntrySource,
    enabled: Bool,
    values: Data?
  ) async throws -> FullEntry

  /// Replaces the code; `meta` is supplied when the caller already re-parsed it.
  @discardableResult
  func updateCode(id: String, code: String, meta: ScriptMeta?) async throws -> FullEntry

  @discardableResult
  func updateMeta(id: String, meta: ScriptMeta) async throws -> FullEntry

  @discardableResult
  func setEnabled(id: String, enabled: Bool) async throws -> FullEntry

  /// Upsert from a mirroring client: the entry keeps its id, replacing any
  /// existing entry with the same id.
  @discardableResult
  func put(entry: FullEntry) async throws -> FullEntry

  /// Applies `ids` as the new order; entries not listed keep their relative
  /// order after the listed ones.
  func reorder(ids: [String]) async throws

  /// Returns whether an entry was removed.
  @discardableResult
  func delete(id: String) async throws -> Bool

  func exportBundle() async throws -> ExportBundle

  /// Returns how many entries were imported.
  @discardableResult
  func importBundle(_ bundle: ExportBundle, mode: ImportMode) async throws -> Int
}
