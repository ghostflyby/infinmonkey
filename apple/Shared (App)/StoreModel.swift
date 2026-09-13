import InfinMonkeyCore
import SwiftUI
import UniformTypeIdentifiers

let storeAppGroupId = "group.dev.ghostflyby.InfinMonkey"

/// App-side facade over the shared per-file store. The app and the extension
/// handler are separate processes; every user action re-reads state so the UI
/// always reflects the latest on-disk store.
@Observable
final class StoreModel {
  var summaries: [EntrySummary] = []
  var rev = 0
  var lastError: String?
  var storagePath = ""
  var importPresented = false
  var exportPresented = false

  private let store: NativeStore

  init() {
    let layout = StoreLayout.resolve(appGroupId: storeAppGroupId)
    self.store = NativeStore(layout: layout)
    self.storagePath = layout.root.path
  }

  func refresh() {
    do {
      let result = try store.hello(sinceRev: nil)
      summaries = result.entries.sorted { $0.position < $1.position }
      rev = result.rev
      lastError = nil
    } catch {
      lastError = String(describing: error)
    }
  }

  func summary(id: String) -> EntrySummary? {
    summaries.first { $0.id == id }
  }

  func loadEntry(id: String) -> FullEntry? {
    try? store.getEntry(id: id)
  }

  func setEnabled(_ id: String, _ enabled: Bool) {
    _ = try? store.setEnabled(id: id, enabled: enabled)
    refresh()
  }

  func delete(_ id: String) {
    _ = try? store.deleteEntry(id: id)
    refresh()
  }

  func saveCode(id: String, code: String) {
    _ = try? store.updateCode(id: id, code: code, meta: nil)
    refresh()
  }

  func saveMetaSummary(id: String, name: String, version: String, description: String) {
    guard let entry = loadEntry(id: id) else { return }
    var meta = entry.record.meta
    meta["name"] = name
    if version.isEmpty { meta.removeValue(forKey: "version") } else { meta["version"] = version }
    if description.isEmpty {
      meta.removeValue(forKey: "description")
    } else {
      meta["description"] = description
    }
    _ = try? store.updateMeta(id: id, meta: meta)
    refresh()
  }

  func create(kind: EntryKind) {
    let code = kind == .script ? StoreModel.scriptScaffold : StoreModel.styleScaffold
    let meta: [String: Any] = ["name": kind == .script ? "新脚本" : "新样式"]
    _ = try? store.createEntry(
      kind: kind, code: code, meta: meta, source: ["type": "inline"], enabled: true,
      values: kind == .script ? [:] : nil)
    refresh()
  }

  func importFile(at url: URL) {
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    guard let data = try? Data(contentsOf: url) else {
      lastError = "无法读取导入文件"
      return
    }
    let name = url.lastPathComponent
    if name.hasSuffix(".json"), let bundle = try? JSONSerialization.jsonObject(with: data),
      let dict = bundle as? [String: Any]
    {
      _ = try? store.importAll(bundle: dict, mode: "merge")
    } else if let kind = StoreLayout.kind(ofFileName: name),
      let code = String(data: data, encoding: .utf8)
    {
      _ = try? store.createEntry(
        kind: kind, code: code, meta: [:], source: ["type": "inline"], enabled: true,
        values: kind == .script ? [:] : nil)
    } else {
      lastError = "无法识别的文件类型：" + name
    }
    refresh()
  }

  func exportBundle() -> ExportDocument {
    let bundle = (try? store.exportAll()) ?? [:]
    let pretty =
      (try? JSONSerialization.data(withJSONObject: bundle, options: [.prettyPrinted, .sortedKeys]))
      ?? Data()
    return ExportDocument(json: pretty)
  }

  // MARK: - Scaffolds

  static let scriptScaffold = """
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

  static let styleScaffold = """
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

extension StoreModel {
  /// .css as a static UTType member is macOS 15+; resolve by extension instead.
  static var importTypes: [UTType] {
    [.json, .javaScript, UTType(filenameExtension: "css") ?? .data]
  }
}

/// FileDocument wrapper for the export bundle.
struct ExportDocument: FileDocument {
  static var readableContentTypes: [UTType] { [.json] }

  var json: Data

  init(json: Data) {
    self.json = json
  }

  init(configuration: ReadConfiguration) throws {
    json = configuration.file.regularFileContents ?? Data()
  }

  func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
    FileWrapper(regularFileWithContents: json)
  }
}
