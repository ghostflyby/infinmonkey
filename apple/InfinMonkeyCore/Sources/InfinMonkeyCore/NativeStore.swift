import CryptoKit
import Darwin
import Foundation
import os

/// Authoritative, per-file store for scripts and styles.
///
/// Concurrency has two layers, and both are needed:
/// - this type is an `actor`, so access within one process is serialized;
/// - every operation additionally takes an exclusive `flock` on `.lock`, so the
///   processes that share the store (app, extension, and later a native
///   messaging host) cannot interleave a load-mutate-save cycle.
///
/// Durability: every write goes through a temp file plus rename, so a reader
/// never observes a partially written file and a crash cannot leave a torn
/// index behind.
///
/// The actor holds no cached document: each operation reloads from disk, which
/// is what makes changes made by another process visible on the next call.
public actor NativeStore: EntryStoring {
  /// Immutable, so it needs no isolation — callers can read the paths without
  /// awaiting the actor (tests and diagnostics both do).
  public nonisolated let layout: StoreLayout

  public init(layout: StoreLayout) {
    self.layout = layout
  }

  public init(root: URL) {
    self.init(layout: StoreLayout(root: root))
  }

  // MARK: - Reads

  public func currentRev() throws -> Int {
    try read { $0.rev }
  }

  public func summaries(sinceRev: Int?) throws -> SummarySnapshot {
    try read { doc in
      let records = sinceRev.map { since in doc.entries.filter { $0.rev > since } } ?? doc.entries
      let ordered = records.sorted { ($0.position, $0.id) < ($1.position, $1.id) }
      return SummarySnapshot(rev: doc.rev, entries: ordered.map(EntrySummary.init))
    }
  }

  public func snapshot() throws -> Snapshot {
    try read { doc in
      let ordered = doc.entries.sorted { ($0.position, $0.id) < ($1.position, $1.id) }
      return Snapshot(rev: doc.rev, entries: try ordered.map { try self.load($0) })
    }
  }

  public func entry(id: String) throws -> FullEntry {
    try read { doc in
      guard let record = doc.entries.first(where: { $0.id == id }) else {
        throw StoreError.notFound
      }
      return try self.load(record)
    }
  }

  public func changes(sinceRev: Int) throws -> Changes {
    try read { doc in
      let changed = doc.entries.filter { $0.rev > sinceRev }
        .sorted { ($0.position, $0.id) < ($1.position, $1.id) }
      let deleted = doc.tombstones.filter { $0.rev > sinceRev }.map(\.id)
      return Changes(
        rev: doc.rev, upserts: try changed.map { try self.load($0) }, deletedIds: deleted)
    }
  }

  /// The GM value blob, verbatim. Never parsed here: its shape belongs to the
  /// extension, and the store is only the custodian of the bytes.
  public func values(id: String) throws -> Data? {
    try read { doc in
      guard doc.entries.contains(where: { $0.id == id }) else { throw StoreError.notFound }
      return Self.readValuesBlob(layout: layout, id: id)
    }
  }

  // MARK: - Mutations

  @discardableResult
  public func create(
    kind: EntryKind,
    code: String,
    meta: ScriptMeta,
    source: EntrySource,
    enabled: Bool,
    values: Data?
  ) throws -> FullEntry {
    try mutate { doc in
      let now = Self.nowMs()
      let id = Self.freshId(excluding: Set(doc.entries.map(\.id)))
      var record = EntryRecord(
        id: id,
        kind: kind,
        enabled: enabled,
        position: (doc.entries.map(\.position).max() ?? 0) + 1,
        installedAt: now,
        updatedAt: now,
        rev: 0,
        codeSha: Self.sha256Hex(of: code),
        metaStale: meta.isUnparsed,
        meta: meta,
        source: source)
      doc.stampNextRev(for: &record)
      try Self.atomicWrite(Data(code.utf8), to: layout.codeURL(record))
      if kind == .script {
        try Self.writeValuesBlob(layout: layout, id: id, blob: values ?? Self.emptyJSONObject)
      }
      doc.entries.append(record)
      let stored = kind == .script ? (values ?? Self.emptyJSONObject) : nil
      return (FullEntry(record: record, code: code, values: stored), true)
    }
  }

  @discardableResult
  public func updateCode(id: String, code: String, meta: ScriptMeta?) throws -> FullEntry {
    try mutate { doc in
      guard let index = doc.entries.firstIndex(where: { $0.id == id }) else {
        throw StoreError.notFound
      }
      let previous = doc.entries[index]
      var updated = previous
      let sha = Self.sha256Hex(of: code)
      let codeChanged = sha != previous.codeSha

      if codeChanged {
        try Self.atomicWrite(Data(code.utf8), to: layout.codeURL(previous))
        updated.codeSha = sha
        updated.updatedAt = Self.nowMs()
        // The code moved on, so any previously parsed metadata is no longer
        // known to describe it until the caller supplies freshly parsed meta.
        updated.metaStale = meta == nil
      }
      if let meta {
        updated.meta = meta
        updated.metaStale = meta.isUnparsed
      }

      let changed = codeChanged || meta != nil
      if changed {
        doc.stampNextRev(for: &updated)
        doc.entries[index] = updated
      }
      let values = updated.kind == .script ? Self.readValuesBlob(layout: layout, id: id) : nil
      let storedCode = codeChanged ? code : self.readCode(updated)
      return (FullEntry(record: updated, code: storedCode, values: values), changed)
    }
  }

  @discardableResult
  public func updateMeta(id: String, meta: ScriptMeta) throws -> FullEntry {
    try mutate { doc in
      guard let index = doc.entries.firstIndex(where: { $0.id == id }) else {
        throw StoreError.notFound
      }
      var updated = doc.entries[index]
      updated.meta = meta
      updated.metaStale = meta.isUnparsed
      doc.stampNextRev(for: &updated)
      doc.entries[index] = updated
      let values = updated.kind == .script ? Self.readValuesBlob(layout: layout, id: id) : nil
      return (FullEntry(record: updated, code: self.readCode(updated), values: values), true)
    }
  }

  @discardableResult
  public func setEnabled(id: String, enabled: Bool) throws -> FullEntry {
    try mutate { doc in
      guard let index = doc.entries.firstIndex(where: { $0.id == id }) else {
        throw StoreError.notFound
      }
      var updated = doc.entries[index]
      let changed = updated.enabled != enabled
      if changed {
        updated.enabled = enabled
        updated.updatedAt = Self.nowMs()
        doc.stampNextRev(for: &updated)
        doc.entries[index] = updated
      }
      let values = updated.kind == .script ? Self.readValuesBlob(layout: layout, id: id) : nil
      return (FullEntry(record: updated, code: self.readCode(updated), values: values), changed)
    }
  }

  @discardableResult
  public func put(entry: FullEntry) throws -> FullEntry {
    try mutate { doc in
      // Reject rather than rewrite: the caller's id is its identity, so
      // silently changing it would orphan the entry on the other side.
      guard let id = StoreLayout.sanitizeId(entry.record.id), id == entry.record.id else {
        throw StoreError.badRequest("entry id is not usable as a file name: \(entry.record.id)")
      }
      var record = entry.record
      record.rev = 0
      record.codeSha = Self.sha256Hex(of: entry.code)
      // The mirroring client sends the code it holds; whether its metadata is
      // current is its own statement, so keep the flag it sent.
      try Self.atomicWrite(Data(entry.code.utf8), to: layout.codeURL(record))
      if record.kind == .script {
        try Self.writeValuesBlob(layout: layout, id: id, blob: entry.values ?? Self.emptyJSONObject)
      }
      doc.stampNextRev(for: &record)
      if let index = doc.entries.firstIndex(where: { $0.id == id }) {
        record.position = doc.entries[index].position
        doc.entries[index] = record
      } else {
        record.position = (doc.entries.map(\.position).max() ?? 0) + 1
        doc.entries.append(record)
      }
      let values = record.kind == .script ? (entry.values ?? Self.emptyJSONObject) : nil
      return (FullEntry(record: record, code: entry.code, values: values), true)
    }
  }

  public func reorder(ids: [String]) throws {
    try mutate { doc in
      guard Set(ids).count == ids.count else {
        throw StoreError.badRequest("reorder list contains duplicate ids")
      }
      for id in ids where !doc.entries.contains(where: { $0.id == id }) {
        throw StoreError.notFound
      }
      var next = 1
      for id in ids {
        guard let index = doc.entries.firstIndex(where: { $0.id == id }) else { continue }
        doc.entries[index].position = next
        next += 1
      }
      let listed = Set(ids)
      for index in doc.entries.indices where !listed.contains(doc.entries[index].id) {
        doc.entries[index].position = next
        next += 1
      }
      for index in doc.entries.indices {
        var record = doc.entries[index]
        doc.stampNextRev(for: &record)
        doc.entries[index] = record
      }
      return ((), true)
    }
  }

  @discardableResult
  public func delete(id: String) throws -> Bool {
    try mutate { doc in
      guard let index = doc.entries.firstIndex(where: { $0.id == id }) else {
        return (false, false)
      }
      var record = doc.entries.remove(at: index)
      try? FileManager.default.removeItem(at: layout.codeURL(record))
      try? FileManager.default.removeItem(at: layout.valuesURL(id: id))
      doc.stampNextRev(for: &record)
      doc.tombstones.append(Tombstone(id: record.id, rev: record.rev))
      return (true, true)
    }
  }

  // MARK: - Import / export

  public func exportBundle() throws -> ExportBundle {
    try read { doc in
      let ordered = doc.entries.sorted { ($0.position, $0.id) < ($1.position, $1.id) }
      let entries = try ordered.map { try self.load($0) }
      return ExportBundle(
        version: CoreConstants.storeVersionString,
        exportedAt: Self.nowMs(),
        scripts: entries.filter { $0.record.kind == .script },
        styles: entries.filter { $0.record.kind == .style })
    }
  }

  /// `merge` replaces entries with the same id and appends the rest; `replace`
  /// clears the store first. Ids are preserved so a round trip through export
  /// keeps identities stable.
  @discardableResult
  public func importBundle(_ bundle: ExportBundle, mode: ImportMode) throws -> Int {
    try mutate { doc in
      if mode == .replace {
        for record in doc.entries {
          try? FileManager.default.removeItem(at: layout.codeURL(record))
          try? FileManager.default.removeItem(at: layout.valuesURL(id: record.id))
        }
        doc.entries.removeAll()
      }

      var imported = 0
      let now = Self.nowMs()
      for incoming in bundle.allEntries {
        var record = incoming.record
        if let sanitized = StoreLayout.sanitizeId(record.id) {
          record.id = sanitized
        } else {
          record.id = Self.freshId(excluding: Set(doc.entries.map(\.id)))
        }
        record.rev = 0
        record.codeSha = Self.sha256Hex(of: incoming.code)
        if record.installedAt == 0 { record.installedAt = now }
        if record.updatedAt == 0 { record.updatedAt = now }

        try Self.atomicWrite(Data(incoming.code.utf8), to: layout.codeURL(record))
        if record.kind == .script {
          try Self.writeValuesBlob(
            layout: layout, id: record.id, blob: incoming.values ?? Self.emptyJSONObject)
        }
        doc.stampNextRev(for: &record)
        if let index = doc.entries.firstIndex(where: { $0.id == record.id }) {
          record.position = doc.entries[index].position
          doc.entries[index] = record
        } else {
          record.position = (doc.entries.map(\.position).max() ?? 0) + 1
          doc.entries.append(record)
        }
        imported += 1
      }

      if imported > 0 { Self.normalizePositions(&doc.entries) }
      return (imported, imported > 0)
    }
  }

  // MARK: - Locking and persistence

  /// Loads the document (reconciling it with the files on disk first) and hands
  /// it to `body`. May persist when reconciliation changed something.
  private func read<T>(_ body: (inout IndexDocument) throws -> T) throws -> T {
    let descriptor = acquireFileLock()
    defer { releaseFileLock(descriptor) }
    var doc = try loadDocument()
    return try body(&doc)
  }

  /// Loads, mutates, and persists when the body reports a change. The document
  /// revision is bumped exactly once per persisted mutation.
  private func mutate<T>(_ body: (inout IndexDocument) throws -> (T, Bool)) throws -> T {
    let descriptor = acquireFileLock()
    defer { releaseFileLock(descriptor) }
    var doc = try loadDocument()
    let (result, changed) = try body(&doc)
    if changed {
      doc.rev += 1
      try saveDocument(doc)
    }
    return result
  }

  /// Reconciles the index against the code files before use:
  /// - a record whose code file is gone is dropped and tombstoned;
  /// - a record whose code content drifted is marked as needing a re-parse;
  /// - a code file with no record is adopted as a new entry.
  ///
  /// Returns the document, persisting it first when reconciliation changed it.
  private func loadDocument() throws -> IndexDocument {
    try FileManager.default.createDirectory(
      at: layout.entriesDir, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: layout.valuesDir, withIntermediateDirectories: true)

    var doc = IndexDocument()
    if FileManager.default.fileExists(atPath: layout.indexURL.path) {
      let data = try Data(contentsOf: layout.indexURL)
      do {
        doc = try JSONDecoder().decode(IndexDocument.self, from: data)
      } catch {
        // Refuse to continue on an unreadable index: rebuilding would silently
        // discard metadata that only the index holds.
        throw StoreError.corruptIndex("\(layout.indexURL.path): \(error)")
      }
    }

    var changed = false
    var kept: [EntryRecord] = []
    for var record in doc.entries {
      guard let data = try? Data(contentsOf: layout.codeURL(record)) else {
        doc.stampNextRev(for: &record)
        doc.tombstones.append(Tombstone(id: record.id, rev: record.rev))
        changed = true
        continue
      }
      let sha = Self.sha256Hex(of: data)
      if sha != record.codeSha {
        record.codeSha = sha
        record.metaStale = true
        doc.stampNextRev(for: &record)
        changed = true
      }
      kept.append(record)
    }
    doc.entries = kept

    changed = adoptOrphanCodeFiles(into: &doc) || changed
    changed = doc.pruneTombstones() || changed

    if changed {
      doc.rev += 1
      try saveDocument(doc)
    }
    return doc
  }

  /// Adopts code files that have no index record — how a file dropped into the
  /// store by hand (or written by a mirroring client that crashed mid-write)
  /// becomes a first-class entry.
  private func adoptOrphanCodeFiles(into doc: inout IndexDocument) -> Bool {
    let known = Set(doc.entries.map(\.id))
    let files = (try? FileManager.default.contentsOfDirectory(atPath: layout.entriesDir.path)) ?? []
    var changed = false
    for file in files.sorted() {
      guard let kind = StoreLayout.kind(ofFileName: file),
        let rawId = StoreLayout.entryId(ofFileName: file),
        let id = StoreLayout.sanitizeId(rawId),
        !known.contains(id)
      else { continue }
      let url = layout.entriesDir.appendingPathComponent(file)
      guard let data = try? Data(contentsOf: url) else { continue }
      let modified = Self.fileModificationMs(url) ?? Self.nowMs()
      var record = EntryRecord(
        id: id,
        kind: kind,
        enabled: true,
        position: (doc.entries.map(\.position).max() ?? 0) + 1,
        installedAt: modified,
        updatedAt: modified,
        rev: 0,
        codeSha: Self.sha256Hex(of: data),
        // Nothing has parsed this code yet, so the extension must.
        metaStale: true,
        meta: .unparsed,
        source: .inline)
      doc.stampNextRev(for: &record)
      doc.entries.append(record)
      changed = true
    }
    return changed
  }

  private func saveDocument(_ doc: IndexDocument) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    let data = try encoder.encode(doc)
    try Self.atomicWrite(data + Data([0x0A]), to: layout.indexURL)
  }

  // MARK: - File helpers

  private func acquireFileLock() -> Int32 {
    let descriptor = open(layout.lockURL.path, O_CREAT | O_RDWR, 0o644)
    guard descriptor >= 0 else {
      os_log(.error, "InfinMonkeyCore: cannot open lock file at %@", layout.lockURL.path)
      return -1
    }
    guard flock(descriptor, LOCK_EX) == 0 else {
      os_log(.error, "InfinMonkeyCore: cannot lock %@", layout.lockURL.path)
      close(descriptor)
      return -1
    }
    return descriptor
  }

  private func releaseFileLock(_ descriptor: Int32) {
    guard descriptor >= 0 else { return }
    flock(descriptor, LOCK_UN)
    close(descriptor)
  }

  /// Writes through a temp file plus rename so readers never see a partial file.
  static func atomicWrite(_ data: Data, to url: URL) throws {
    let directory = url.deletingLastPathComponent()
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let temporary = directory.appendingPathComponent(
      ".\(url.lastPathComponent).tmp-\(UUID().uuidString)")
    try data.write(to: temporary, options: .atomic)
    _ = try FileManager.default.replaceItemAt(
      url, withItemAt: temporary, backupItemName: nil, options: [])
  }

  /// An empty JSON object, used when a script has no values yet.
  static let emptyJSONObject = Data("{}".utf8)

  static func readValuesBlob(layout: StoreLayout, id: String) -> Data? {
    try? Data(contentsOf: layout.valuesURL(id: id))
  }

  static func writeValuesBlob(layout: StoreLayout, id: String, blob: Data) throws {
    try atomicWrite(blob + Data([0x0A]), to: layout.valuesURL(id: id))
  }

  func readCode(_ record: EntryRecord) -> String {
    guard let data = try? Data(contentsOf: layout.codeURL(record)) else { return "" }
    return String(data: data, encoding: .utf8) ?? ""
  }

  func load(_ record: EntryRecord) throws -> FullEntry {
    guard FileManager.default.fileExists(atPath: layout.codeURL(record).path) else {
      throw StoreError.notFound
    }
    let values = record.kind == .script ? Self.readValuesBlob(layout: layout, id: record.id) : nil
    return FullEntry(record: record, code: readCode(record), values: values)
  }

  static func normalizePositions(_ entries: inout [EntryRecord]) {
    let order = entries.sorted { ($0.position, $0.id) < ($1.position, $1.id) }
    for (offset, record) in order.enumerated() {
      if let index = entries.firstIndex(where: { $0.id == record.id }) {
        entries[index].position = offset + 1
      }
    }
  }

  /// A fresh id that is usable as a file name and unused in this store.
  static func freshId(excluding taken: Set<String>) -> String {
    for _ in 0..<32 {
      let candidate = UUID().uuidString.lowercased()
      if !taken.contains(candidate) { return candidate }
    }
    return UUID().uuidString.lowercased()
  }

  static func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

  static func fileModificationMs(_ url: URL) -> Int64? {
    let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
    return (attributes?[.modificationDate] as? Date).map { Int64($0.timeIntervalSince1970 * 1000) }
  }

  static func sha256Hex(of string: String) -> String { sha256Hex(of: Data(string.utf8)) }

  static func sha256Hex(of data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }
}
