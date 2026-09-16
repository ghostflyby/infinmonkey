import Foundation
import os

/// Library operations, expressed in domain terms.
///
/// This is the layer both the app UI and (through `ProtocolRouter`) the
/// extension talk to. It owns the behavior that is not storage mechanics and
/// not UI: scaffolds, merging an edited metadata summary into an entry, and
/// deciding what an imported file means. That keeps `NativeStore` about files
/// and revisions, and keeps the view model free of policy.
public struct LibraryService: Sendable {
  private let store: any EntryStoring

  /// Where the store lives, for display in the UI.
  public let storagePath: String
  /// Set when the library could not be located at all; operations then fail.
  public let locationError: String?

  public init(store: any EntryStoring, storagePath: String, locationError: String? = nil) {
    self.store = store
    self.storagePath = storagePath
    self.locationError = locationError
  }

  /// Builds a service over a store, for a caller that has already decided where
  /// the store lives. Locating it — app group containers, bundle identity — is
  /// platform knowledge and stays outside this package.
  public init(layout: StoreLayout) {
    self.init(store: NativeStore(layout: layout), storagePath: layout.root.path)
  }

  /// A service whose operations all fail with `message`; used when the store
  /// cannot be located so the UI can still present the reason.
  public static func unavailable(error message: String) -> LibraryService {
    LibraryService(
      store: UnavailableStore(reason: message), storagePath: "", locationError: message)
  }

  // MARK: - Reads

  public func summaries() async throws -> SummarySnapshot {
    try await store.summaries(sinceRev: nil)
  }

  public func entry(id: String) async throws -> FullEntry {
    try await store.entry(id: id)
  }

  // MARK: - Mutations

  @discardableResult
  public func setEnabled(id: String, enabled: Bool) async throws -> FullEntry {
    try await store.setEnabled(id: id, enabled: enabled)
  }

  @discardableResult
  public func delete(id: String) async throws -> Bool {
    try await store.delete(id: id)
  }

  /// Saves code; when the entry's stored metadata is stale, the freshly written
  /// code invalidates it entirely.
  @discardableResult
  public func saveCode(id: String, code: String) async throws -> FullEntry {
    try await store.updateCode(id: id, code: code, meta: nil)
  }

  /// Applies an edited metadata summary.
  ///
  /// An entry with no parsed metadata yet (the extension owns parsing) gets a
  /// summary built from the edit. It stays stale: typing a name does not tell us
  /// the `@match` rules, so the extension must still parse the code.
  @discardableResult
  public func saveMetadata(
    id: String,
    name: String,
    version: String,
    description: String
  ) async throws -> FullEntry {
    let existing = try await store.entry(id: id)
    let summary = (existing.record.meta ?? ScriptMeta())
      .withSummary(name: name, version: version, description: description)
    return try await store.updateMeta(id: id, meta: summary, fromParsing: false)
  }

  /// Stores metadata produced by parsing the code, which is authoritative and
  /// therefore clears the "needs parsing" signal.
  @discardableResult
  public func saveParsedMetadata(id: String, meta: ScriptMeta) async throws -> FullEntry {
    try await store.updateMeta(id: id, meta: meta, fromParsing: true)
  }

  @discardableResult
  public func create(kind: EntryKind) async throws -> FullEntry {
    try await store.create(
      kind: kind,
      code: Self.scaffold(for: kind),
      meta: Self.scaffoldMeta(for: kind),
      source: .inline,
      enabled: true,
      values: kind == .script ? NativeStore.emptyJSONObject : nil)
  }

  // MARK: - Import / export

  /// The export file. Serialized through the wire projection so opaque values
  /// stay JSON objects (encoding the domain type directly would emit base64).
  public func exportData() async throws -> Data {
    let bundle = try await store.exportBundle()
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    return try encoder.encode(WireBundle(bundle: bundle))
  }

  /// Imports either a bundle (`.json`) or a single script/style file.
  public func importFile(at url: URL, mode: ImportMode = .merge) async throws {
    try await importData(
      try Data(contentsOf: url), fileName: url.lastPathComponent, mode: mode)
  }

  /// Imports a bundle or a single script/style file that is already in memory.
  ///
  /// `fileName` decides what the bytes mean, exactly as `importFile(at:)` uses
  /// the path: a `.json` name is a bundle, a `.user.js`/`.user.css` name is one
  /// entry. It is a parameter because the two callers differ in what they know
  /// — a file import has a URL, while an import from stdin (the only channel a
  /// sandboxed CLI can read) has nothing but what the caller says.
  public func importData(
    _ data: Data, fileName: String, mode: ImportMode = .merge
  ) async throws {
    if fileName.hasSuffix(".json") {
      let bundle: WireBundle
      do {
        bundle = try JSONDecoder().decode(WireBundle.self, from: data)
      } catch {
        throw ImportError.invalidBundle(underlying: error)
      }
      // Outside the catch above: a store failure here is an io error, not a
      // verdict on the file.
      _ = try await store.importBundle(bundle.exportBundle(), mode: mode)
      return
    }

    guard let kind = StoreLayout.kind(ofFileName: fileName) else {
      throw ImportError.unrecognizedFileType(fileName)
    }
    guard let code = String(data: data, encoding: .utf8) else {
      throw ImportError.notUTF8(fileName)
    }
    // No metadata: only the extension parses userscript headers, and it does so
    // on its next connection.
    _ = try await store.create(
      kind: kind,
      code: code,
      meta: nil,
      source: .inline,
      enabled: true,
      values: kind == .script ? NativeStore.emptyJSONObject : nil)
  }

  // MARK: - Scaffolds

  public static func scaffold(for kind: EntryKind) -> String {
    switch kind {
    case .script:
      return """
        // ==UserScript==
        // @name 新脚本
        // @namespace infinmonkey
        // @version 0.1.0
        // @description 由 InfinMonkey 创建
        // @match https://example.org/*
        // @grant none
        // ==/UserScript==

        (function () {
          'use strict';
        })();
        """
    case .style:
      return """
        /* ==UserStyle==
        @name 新样式
        @namespace infinmonkey
        @version 0.1.0
        @description 由 InfinMonkey 创建
        ==/UserStyle== */

        body {
          /* your styles here */
        }
        """
    }
  }

  /// Metadata for a fresh scaffold. This is not a guess: it describes the code
  /// `scaffold(for:)` writes, header and `@match` rule included.
  static func scaffoldMeta(for kind: EntryKind) -> ScriptMeta {
    ScriptMeta(
      name: kind == .script ? "新脚本" : "新样式",
      namespace: "infinmonkey",
      version: "0.1.0",
      description: "由 InfinMonkey 创建",
      matches: kind == .script ? ["https://example.org/*"] : [],
      headerFound: true)
  }
}

/// Failures of `importFile`. Typed with payloads so the UI renders its own
/// wording; the underlying error stays reachable for diagnostics.
public enum ImportError: Error {
  /// A `.json` file that is not a valid InfinMonkey export bundle.
  case invalidBundle(underlying: any Error)
  /// A file whose extension the importer does not know.
  case unrecognizedFileType(String)
  /// A file that is not UTF-8 text.
  case notUTF8(String)
}

/// Stands in when the store cannot be located (a missing app group identity),
/// so every operation reports the same reason instead of touching the wrong
/// directory. Both the app UI and the extension's router run on one of these
/// until the build fault is fixed.
public struct UnavailableStore: EntryStoring {
  public let reason: String

  public init(reason: String) {
    self.reason = reason
  }

  private func fail<T>() throws -> T {
    throw StoreError.io(reason)
  }

  public func currentRev() async throws -> Int { try fail() }
  public func summaries(sinceRev: Int?) async throws -> SummarySnapshot { try fail() }
  public func snapshot() async throws -> Snapshot { try fail() }
  public func entry(id: String) async throws -> FullEntry { try fail() }
  public func changes(sinceRev: Int) async throws -> Changes { try fail() }
  public func values(id: String) async throws -> Data? { try fail() }
  public func create(
    kind: EntryKind, code: String, meta: ScriptMeta?, source: EntrySource, enabled: Bool,
    values: Data?
  ) async throws -> FullEntry { try fail() }
  public func updateCode(id: String, code: String, meta: ScriptMeta?) async throws -> FullEntry {
    try fail()
  }
  public func updateMeta(id: String, meta: ScriptMeta, fromParsing: Bool) async throws -> FullEntry
  {
    try fail()
  }
  public func setEnabled(id: String, enabled: Bool) async throws -> FullEntry { try fail() }
  public func put(entry: FullEntry) async throws -> FullEntry { try fail() }
  public func reorder(ids: [String]) async throws { _ = try fail() as Void }
  public func delete(id: String) async throws -> Bool { try fail() }
  public func exportBundle() async throws -> ExportBundle { try fail() }
  public func importBundle(_ bundle: ExportBundle, mode: ImportMode) async throws -> Int {
    try fail()
  }
}
