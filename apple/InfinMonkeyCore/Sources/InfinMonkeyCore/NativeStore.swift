import CryptoKit
import Darwin
import Foundation

public enum StoreError: Error, Equatable {
  case notFound
  case badRequest(String)
  case io(String)
}

struct IndexDocument {
  var rev: Int = 0
  var settings: [String: Any] = [:]
  var entries: [EntryRecord] = []
  var tombstones: [Tombstone] = []

  /// Stamps a record with the revision the in-flight mutation will persist.
  /// All records touched by one mutation share the same stamped value;
  /// mutate() performs the single doc-level increment on save.
  mutating func stampNextRev(for record: inout EntryRecord) {
    record.rev = rev + 1
  }
}

/// Per-file authoritative store for scripts/styles, shared by the host app UI
/// and the extension handler (two processes) through an app group container.
///
/// All mutating operations run under an in-process NSLock plus a cross-process
/// flock on `.lock`, and persist via temp-file + rename so a crash never leaves
/// a torn index behind.
public final class NativeStore {
  public let layout: StoreLayout
  private let processLock = NSLock()

  public init(layout: StoreLayout) {
    self.layout = layout
  }

  // MARK: - Reads

  public func hello(sinceRev: Int?) throws -> (rev: Int, entries: [EntrySummary]) {
    try read { doc in
      let entries = sinceRev.map { since in doc.entries.filter { $0.rev > since } } ?? doc.entries
      return (doc.rev, entries.map(EntrySummary.init))
    }
  }

  public func listEntries() throws -> (rev: Int, entries: [FullEntry]) {
    try read { doc in
      let entries = try doc.entries.map { try self.loadFullEntry($0) }
      return (doc.rev, entries)
    }
  }

  public func getEntry(id: String) throws -> FullEntry {
    try read { doc in
      guard let record = doc.entries.first(where: { $0.id == id }) else {
        throw StoreError.notFound
      }
      return try self.loadFullEntry(record)
    }
  }

  public func getChanges(sinceRev: Int) throws -> (
    rev: Int, upserts: [FullEntry], deletedIds: [String]
  ) {
    try read { doc in
      let upserts = try doc.entries.filter { $0.rev > sinceRev }.map { try self.loadFullEntry($0) }
      let deletedIds = doc.tombstones.filter { $0.rev > sinceRev }.map(\.id)
      return (doc.rev, upserts, deletedIds)
    }
  }

  public func getValues(id: String) throws -> [String: Any] {
    try read { doc in
      guard doc.entries.contains(where: { $0.id == id }) else { throw StoreError.notFound }
      return Self.readValues(layout: layout, id: id)
    }
  }

  // MARK: - Entry mutations

  public func createEntry(
    kind: EntryKind,
    code: String,
    meta: [String: Any],
    source: [String: Any],
    enabled: Bool,
    values: [String: Any]?
  ) throws -> FullEntry {
    try mutate { doc in
      let now = Self.nowMs()
      let id = Self.freshId(existing: doc.entries.map(\.id))
      var record = EntryRecord(
        id: id,
        kind: kind,
        fileName: StoreLayout.codeFileName(id: id, kind: kind),
        enabled: enabled,
        position: (doc.entries.map(\.position).max() ?? 0) + 1,
        installedAt: now,
        updatedAt: now,
        rev: 0,
        codeSha: Self.sha256Hex(of: code),
        metaStale: false,
        meta: meta,
        source: source)
      doc.stampNextRev(for: &record)
      try Self.atomicWrite(Data(code.utf8), to: layout.entryURL(record))
      if kind == .script {
        try Self.writeValues(layout: layout, id: id, values: values ?? [:])
      }
      doc.entries.append(record)
      let full = FullEntry(record: record, code: code, values: values ?? [:])
      return (full, true)
    }
  }

  public func updateCode(id: String, code: String, meta: [String: Any]?) throws -> FullEntry {
    try mutate { doc in
      guard let idx = doc.entries.firstIndex(where: { $0.id == id }) else {
        throw StoreError.notFound
      }
      let record = doc.entries[idx]
      let newSha = Self.sha256Hex(of: code)
      let changedFile = newSha != record.codeSha
      var updated = record
      if changedFile {
        try Self.atomicWrite(Data(code.utf8), to: layout.entryURL(record))
        updated.codeSha = newSha
        updated.updatedAt = Self.nowMs()
        updated.metaStale = false
      }
      if let meta = meta { updated.meta = meta }
      if changedFile || meta != nil {
        doc.stampNextRev(for: &updated)
        doc.entries[idx] = updated
      }
      let values = Self.readValues(layout: layout, id: id)
      return (
        FullEntry(
          record: updated, code: changedFile ? code : self.readCode(updated), values: values),
        changedFile || meta != nil
      )
    }
  }

  public func updateMeta(id: String, meta: [String: Any]) throws -> FullEntry {
    try mutate { doc in
      guard let idx = doc.entries.firstIndex(where: { $0.id == id }) else {
        throw StoreError.notFound
      }
      var updated = doc.entries[idx]
      updated.meta = meta
      updated.metaStale = false
      doc.stampNextRev(for: &updated)
      doc.entries[idx] = updated
      let values = Self.readValues(layout: layout, id: id)
      return (FullEntry(record: updated, code: self.readCode(updated), values: values), true)
    }
  }

  public func setEnabled(id: String, enabled: Bool) throws -> FullEntry {
    try mutate { doc in
      guard let idx = doc.entries.firstIndex(where: { $0.id == id }) else {
        throw StoreError.notFound
      }
      var updated = doc.entries[idx]
      guard updated.enabled != enabled else {
        let values = Self.readValues(layout: layout, id: id)
        return (FullEntry(record: updated, code: self.readCode(updated), values: values), false)
      }
      updated.enabled = enabled
      updated.updatedAt = Self.nowMs()
      doc.stampNextRev(for: &updated)
      doc.entries[idx] = updated
      let values = Self.readValues(layout: layout, id: id)
      return (FullEntry(record: updated, code: self.readCode(updated), values: values), true)
    }
  }

  public func reorderEntries(ids: [String]) throws {
    try mutate { doc in
      var next = 1
      for id in ids {
        guard let idx = doc.entries.firstIndex(where: { $0.id == id }) else {
          throw StoreError.notFound
        }
        doc.entries[idx].position = next
        next += 1
      }
      // Entries not listed keep their relative order after the listed ones.
      let listed = Set(ids)
      for idx in doc.entries.indices where !listed.contains(doc.entries[idx].id) {
        doc.entries[idx].position = next
        next += 1
      }
      for idx in doc.entries.indices {
        var r = doc.entries[idx]
        doc.stampNextRev(for: &r)
        doc.entries[idx] = r
      }
      return ((), true)
    }
  }

  public func deleteEntry(id: String) throws -> Bool {
    try mutate { doc in
      guard let idx = doc.entries.firstIndex(where: { $0.id == id }) else {
        return (false, false)
      }
      var record = doc.entries.remove(at: idx)
      try? FileManager.default.removeItem(at: layout.entryURL(record))
      try? FileManager.default.removeItem(at: layout.valuesURL(id: id))
      doc.stampNextRev(for: &record)  // stamp rev before tombstoning
      doc.tombstones.append(Tombstone(id: id, rev: record.rev))
      return (true, true)
    }
  }

  /// Mirror upsert from the extension: full entry, id preserved. Replaces an
  /// existing entry with the same id or appends a new one.
  public func putEntry(entry: [String: Any]) throws -> FullEntry {
    try mutate { doc in
      guard let rawId = entry["id"] as? String,
        let id = StoreLayout.sanitizeId(rawId)
      else {
        throw StoreError.badRequest("putEntry requires a valid entry id")
      }
      guard let kindRaw = entry["kind"] as? String,
        let kind = EntryKind(rawValue: kindRaw)
      else {
        throw StoreError.badRequest("putEntry requires kind script or style")
      }
      let code = entry["code"] as? String ?? ""
      let now = Self.nowMs()
      var record = EntryRecord(
        id: id,
        kind: kind,
        fileName: StoreLayout.codeFileName(id: id, kind: kind),
        enabled: entry["enabled"] as? Bool ?? true,
        position: entry["position"] as? Int ?? (doc.entries.map(\.position).max() ?? 0) + 1,
        installedAt: entry["installedAt"] as? Int64 ?? now,
        updatedAt: entry["updatedAt"] as? Int64 ?? now,
        rev: 0,
        codeSha: Self.sha256Hex(of: code),
        metaStale: false,
        meta: entry["meta"] as? [String: Any] ?? [:],
        source: entry["source"] as? [String: Any] ?? ["type": "inline"],
        connectGrants: entry["connectGrants"] as? [String] ?? [])
      try Self.atomicWrite(Data(code.utf8), to: layout.entryURL(record))
      if kind == .script {
        try Self.writeValues(layout: layout, id: id, values: entry["values"] as? [String: Any] ?? [:])
      }
      doc.stampNextRev(for: &record)
      if let idx = doc.entries.firstIndex(where: { $0.id == id }) {
        doc.entries[idx] = record
      } else {
        doc.entries.append(record)
      }
      Self.normalizePositions(&doc.entries)
      let values = kind == .script ? Self.readValues(layout: layout, id: id) : [:]
      return (FullEntry(record: record, code: code, values: values), true)
    }
  }

  // MARK: - Value mutations

  public func setValue(id: String, key: String, value: Any) throws {
    try mutate { doc in
      guard let idx = doc.entries.firstIndex(where: { $0.id == id }) else {
        throw StoreError.notFound
      }
      var values = Self.readValues(layout: layout, id: id)
      values[key] = value
      try Self.writeValues(layout: layout, id: id, values: values)
      var updated = doc.entries[idx]
      doc.stampNextRev(for: &updated)
      doc.entries[idx] = updated
      return ((), true)
    }
  }

  public func deleteValue(id: String, key: String) throws -> Bool {
    try mutate { doc in
      guard let idx = doc.entries.firstIndex(where: { $0.id == id }) else {
        throw StoreError.notFound
      }
      var values = Self.readValues(layout: layout, id: id)
      guard values.removeValue(forKey: key) != nil else { return (false, false) }
      try Self.writeValues(layout: layout, id: id, values: values)
      var updated = doc.entries[idx]
      doc.stampNextRev(for: &updated)
      doc.entries[idx] = updated
      return (true, true)
    }
  }

  // MARK: - Import / export

  public func exportAll() throws -> [String: Any] {
    try read { doc in
      let entries = try doc.entries.map { try self.loadFullEntry($0) }
      var scripts: [[String: Any]] = []
      var styles: [[String: Any]] = []
      for entry in entries {
        var d = entry.toDict()
        d.removeValue(forKey: "metaStale")  // runtime-only flag; not part of the bundle shape
        if entry.record.kind == .script { scripts.append(d) } else { styles.append(d) }
      }
      return [
        "infinmonkey": 1,
        "version": CoreConstants.storeVersionString,
        "exportedAt": Self.nowMs(),
        "scripts": scripts,
        "styles": styles,
      ] as [String: Any]
    }
  }

  /// Import an ExportBundle. `merge` overwrites entries with the same id and
  /// appends the rest; `replace` wipes the store first. Ids are preserved so a
  /// round-trip through export keeps identities stable.
  @discardableResult
  public func importAll(bundle: [String: Any], mode: String) throws -> Int {
    guard mode == "merge" || mode == "replace" else {
      throw StoreError.badRequest("mode must be merge or replace")
    }
    return try mutate { doc in
      if mode == "replace" {
        for record in doc.entries {
          try? FileManager.default.removeItem(at: layout.entryURL(record))
          try? FileManager.default.removeItem(at: layout.valuesURL(id: record.id))
        }
        doc.entries.removeAll()
      }
      var count = 0
      let now = Self.nowMs()
      for kind in [EntryKind.script, .style] {
        guard
          let list = bundle[kind.rawValue == "script" ? "scripts" : "styles"] as? [[String: Any]]
        else {
          continue
        }
        for raw in list {
          let id =
            StoreLayout.sanitizeId(raw["id"] as? String ?? "")
            ?? Self.freshId(existing: doc.entries.map(\.id))
          let code = raw["code"] as? String ?? ""
          var record = EntryRecord(
            id: id,
            kind: kind,
            fileName: StoreLayout.codeFileName(id: id, kind: kind),
            enabled: raw["enabled"] as? Bool ?? true,
            position: raw["position"] as? Int ?? 0,
            installedAt: raw["installedAt"] as? Int64 ?? now,
            updatedAt: raw["updatedAt"] as? Int64 ?? now,
            rev: 0,
            codeSha: Self.sha256Hex(of: code),
            metaStale: false,
            meta: raw["meta"] as? [String: Any] ?? [:],
            source: raw["source"] as? [String: Any] ?? ["type": "inline"],
            connectGrants: raw["connectGrants"] as? [String] ?? [])
          try Self.atomicWrite(Data(code.utf8), to: layout.entryURL(record))
          if kind == .script {
            try Self.writeValues(
              layout: layout, id: id, values: raw["values"] as? [String: Any] ?? [:])
          }
          if let idx = doc.entries.firstIndex(where: { $0.id == id }) {
            doc.stampNextRev(for: &record)
            doc.entries[idx] = record
          } else {
            doc.stampNextRev(for: &record)
            doc.entries.append(record)
          }
          count += 1
        }
      }
      Self.normalizePositions(&doc.entries)
      return (count, count > 0)
    }
  }

  // MARK: - Locking / persistence core

  /// Read access: loads the document (reconciling external changes first) and
  /// runs `body`. May persist when reconciliation detects drift/adoption.
  private func read<T>(_ body: (inout IndexDocument) throws -> T) throws -> T {
    processLock.lock()
    defer { processLock.unlock() }
    let fd = acquireFileLock()
    defer { releaseFileLock(fd) }
    var doc = try loadDocument()
    return try body(&doc)
  }

  /// Write access: loads, mutates, and persists when the body reports changes.
  /// The document revision is bumped exactly once per persisted mutation.
  private func mutate<T>(_ body: (inout IndexDocument) throws -> (T, Bool)) throws -> T {
    processLock.lock()
    defer { processLock.unlock() }
    let fd = acquireFileLock()
    defer { releaseFileLock(fd) }
    var doc = try loadDocument()
    let (result, changed) = try body(&doc)
    if changed {
      doc.rev += 1
      try saveDocument(doc)
    }
    return result
  }

  /// Reconciles the on-disk state with index.json before use:
  /// - records whose code file vanished are dropped (tombstoned);
  /// - records whose code file content drifted get `metaStale`;
  /// - orphan code files are adopted as new entries.
  /// Returns the document, persisting it first if reconciliation changed it.
  private func loadDocument() throws -> IndexDocument {
    try FileManager.default.createDirectory(
      at: layout.entriesDir, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: layout.valuesDir, withIntermediateDirectories: true)

    var doc = IndexDocument()
    if let data = try? Data(contentsOf: layout.indexURL),
      let raw = try? JSONSerialization.jsonObject(with: data),
      let parsed = Self.parseDocument(raw)
    {
      doc = parsed
    }

    var changed = false
    var kept: [EntryRecord] = []
    for var record in doc.entries {
      let url = layout.entryURL(record)
      guard let data = try? Data(contentsOf: url) else {
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

    let known = Set(doc.entries.map(\.id))
    let files = (try? FileManager.default.contentsOfDirectory(atPath: layout.entriesDir.path)) ?? []
    for file in files.sorted() {
      guard let kind = StoreLayout.kind(ofFileName: file),
        let id = StoreLayout.sanitizeId(StoreLayout.entryId(ofFileName: file) ?? "")
      else { continue }
      guard !known.contains(id) else { continue }
      let url = layout.entriesDir.appendingPathComponent(file)
      guard let data = try? Data(contentsOf: url) else { continue }
      let now = Self.nowMs()
      var record = EntryRecord(
        id: id,
        kind: kind,
        fileName: file,
        enabled: true,
        position: (doc.entries.map(\.position).max() ?? 0) + 1,
        installedAt: Self.fileMtimeMs(url) ?? now,
        updatedAt: Self.fileMtimeMs(url) ?? now,
        rev: 0,
        codeSha: Self.sha256Hex(of: data),
        metaStale: true,  // no parsed meta available until the extension connects
        meta: [:],
        source: ["type": "inline"])
      doc.stampNextRev(for: &record)
      doc.entries.append(record)
      changed = true
    }

    let cutoff = doc.rev - CoreConstants.tombstoneRetention
    if doc.tombstones.contains(where: { $0.rev < cutoff }) {
      doc.tombstones.removeAll { $0.rev < cutoff }
      changed = true
    }

    if changed {
      doc.rev += 1
      try saveDocument(doc)
    }
    return doc
  }

  private func saveDocument(_ doc: IndexDocument) throws {
    let root: [String: Any] = [
      "v": CoreConstants.storeVersion,
      "rev": doc.rev,
      "settings": doc.settings,
      "entries": doc.entries.map { $0.toDict() },
      "tombstones": doc.tombstones.map { ["id": $0.id, "rev": $0.rev] },
    ]
    guard JSONSerialization.isValidJSONObject(root) else {
      throw StoreError.io("index document is not valid JSON")
    }
    let data = try JSONSerialization.data(
      withJSONObject: root, options: [.prettyPrinted, .sortedKeys])
    try Self.atomicWrite(data + Data([0x0A]), to: layout.indexURL)
  }

  private static func parseDocument(_ raw: Any) -> IndexDocument? {
    guard let d = raw as? [String: Any] else { return nil }
    var doc = IndexDocument()
    doc.rev = d["rev"] as? Int ?? 0
    doc.settings = d["settings"] as? [String: Any] ?? [:]
    let entryDicts = d["entries"] as? [[String: Any]] ?? []
    var entries: [EntryRecord] = []
    for e in entryDicts {
      if let record = try? EntryRecord(dict: e) { entries.append(record) }
    }
    doc.entries = entries
    doc.tombstones = (d["tombstones"] as? [[String: Any]] ?? []).compactMap { t in
      guard let id = t["id"] as? String, let rev = t["rev"] as? Int else { return nil }
      return Tombstone(id: id, rev: rev)
    }
    return doc
  }

  // MARK: - File helpers

  private func acquireFileLock() -> Int32 {
    let fd = open(layout.lockURL.path, O_CREAT | O_RDWR, 0o644)
    guard fd >= 0 else { return -1 }
    guard flock(fd, LOCK_EX) == 0 else {
      close(fd)
      return -1
    }
    return fd
  }

  private func releaseFileLock(_ fd: Int32) {
    guard fd >= 0 else { return }
    flock(fd, LOCK_UN)
    close(fd)
  }

  /// Temp file + rename so readers never observe a partial write.
  static func atomicWrite(_ data: Data, to url: URL) throws {
    let dir = url.deletingLastPathComponent()
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let tmp = dir.appendingPathComponent(".\(url.lastPathComponent).tmp-\(UUID().uuidString)")
    try data.write(to: tmp, options: .atomic)
    _ = try FileManager.default.replaceItemAt(
      url, withItemAt: tmp, backupItemName: nil, options: [])
  }

  static func readValues(layout: StoreLayout, id: String) -> [String: Any] {
    guard let data = try? Data(contentsOf: layout.valuesURL(id: id)),
      let raw = try? JSONSerialization.jsonObject(with: data),
      let values = raw as? [String: Any]
    else { return [:] }
    return values
  }

  static func writeValues(layout: StoreLayout, id: String, values: [String: Any]) throws {
    guard JSONSerialization.isValidJSONObject(values) else {
      throw StoreError.io("values for \(id) are not valid JSON")
    }
    let data = try JSONSerialization.data(withJSONObject: values, options: [.sortedKeys])
    try atomicWrite(data, to: layout.valuesURL(id: id))
  }

  func readCode(_ record: EntryRecord) -> String {
    guard let data = try? Data(contentsOf: layout.entryURL(record)) else { return "" }
    return String(data: data, encoding: .utf8) ?? ""
  }

  func loadFullEntry(_ record: EntryRecord) throws -> FullEntry {
    guard FileManager.default.fileExists(atPath: layout.entryURL(record).path) else {
      throw StoreError.notFound
    }
    return FullEntry(
      record: record, code: readCode(record), values: Self.readValues(layout: layout, id: record.id)
    )
  }

  static func normalizePositions(_ entries: inout [EntryRecord]) {
    let order = entries.sorted { ($0.position, $0.id) < ($1.position, $1.id) }
    for (i, record) in order.enumerated() {
      if let idx = entries.firstIndex(where: { $0.id == record.id }) {
        entries[idx].position = i + 1
      }
    }
  }

  static func freshId(existing: [String]) -> String {
    let taken = Set(existing)
    for _ in 0..<16 {
      let candidate = UUID().uuidString.lowercased()
      if !taken.contains(candidate) { return candidate }
    }
    return UUID().uuidString.lowercased() + "-\(Int.random(in: 0..<10_000))"
  }

  static func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

  static func fileMtimeMs(_ url: URL) -> Int64? {
    let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
    return (attrs?[.modificationDate] as? Date).map { Int64($0.timeIntervalSince1970 * 1000) }
  }

  static func sha256Hex(of string: String) -> String { sha256Hex(of: Data(string.utf8)) }

  static func sha256Hex(of data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }
}
