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

  /// Resolves the shared store from the app group configured in the bundle.
  public init(bundle: Bundle = .main) throws {
    let layout = try StoreLayout.resolve(bundle: bundle)
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

  public func exportData() async throws -> Data {
    let bundle = try await store.exportBundle()
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    return try encoder.encode(bundle)
  }

  /// Imports either a bundle (`.json`) or a single script/style file.
  public func importFile(at url: URL) async throws {
    let name = url.lastPathComponent
    let data = try Data(contentsOf: url)

    if name.hasSuffix(".json") {
      do {
        let bundle = try JSONDecoder().decode(ExportBundle.self, from: data)
        _ = try await store.importBundle(bundle, mode: .merge)
        return
      } catch {
        throw StoreError.badRequest("导入文件不是有效的 InfinMonkey 导出：\(error)")
      }
    }

    guard let kind = StoreLayout.kind(ofFileName: name) else {
      throw StoreError.badRequest("无法识别的文件类型：\(name)")
    }
    guard let code = String(data: data, encoding: .utf8) else {
      throw StoreError.badRequest("文件不是 UTF-8 文本：\(name)")
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

/// Stands in when the store cannot be located, so every operation reports the
/// same reason instead of touching the wrong directory.
private struct UnavailableStore: EntryStoring {
  let reason: String

  private func fail<T>() throws -> T {
    throw StoreError.io(reason)
  }

  func currentRev() async throws -> Int { try fail() }
  func summaries(sinceRev: Int?) async throws -> SummarySnapshot { try fail() }
  func snapshot() async throws -> Snapshot { try fail() }
  func entry(id: String) async throws -> FullEntry { try fail() }
  func changes(sinceRev: Int) async throws -> Changes { try fail() }
  func values(id: String) async throws -> Data? { try fail() }
  func create(
    kind: EntryKind, code: String, meta: ScriptMeta?, source: EntrySource, enabled: Bool,
    values: Data?
  ) async throws -> FullEntry { try fail() }
  func updateCode(id: String, code: String, meta: ScriptMeta?) async throws -> FullEntry {
    try fail()
  }
  func updateMeta(id: String, meta: ScriptMeta, fromParsing: Bool) async throws -> FullEntry {
    try fail()
  }
  func setEnabled(id: String, enabled: Bool) async throws -> FullEntry { try fail() }
  func put(entry: FullEntry) async throws -> FullEntry { try fail() }
  func reorder(ids: [String]) async throws { _ = try fail() as Void }
  func delete(id: String) async throws -> Bool { try fail() }
  func exportBundle() async throws -> ExportBundle { try fail() }
  func importBundle(_ bundle: ExportBundle, mode: ImportMode) async throws -> Int { try fail() }
}
