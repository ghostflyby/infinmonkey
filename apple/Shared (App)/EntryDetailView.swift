import InfinMonkeyCore
import SwiftUI

/// Detail editor for one entry: code editor + metadata summary + GM values.
struct EntryDetailView: View {
  @Environment(StoreModel.self) private var model
  let entryId: String

  @State private var code = ""
  @State private var name = ""
  @State private var version = ""
  @State private var entryDescription = ""
  @State private var loadedId: String?
  @State private var values: [String: String] = [:]
  @State private var metaStale = false
  @State private var kind: EntryKind = .script
  @State private var dirty = false
  @State private var confirmDelete = false

  var body: some View {
    Form {
      Section("元数据") {
        TextField("名称", text: $name)
        TextField("版本", text: $version)
        TextField("描述", text: $entryDescription)
        if metaStale {
          Label("代码文件在外部被修改过，元数据可能过期", systemImage: "exclamationmark.triangle")
            .foregroundStyle(.orange)
            .font(.caption)
        }
      }

      if kind == .script && !values.isEmpty {
        Section("GM 数据（\(values.count)）") {
          ForEach(values.keys.sorted(), id: \.self) { key in
            Text(key)
              .font(.system(.caption, design: .monospaced))
              .lineLimit(1)
          }
        }
      }

      Section("代码") {
        TextEditor(text: $code)
          .font(.system(.body, design: .monospaced))
          .frame(minHeight: 240)
          .onChange(of: code) { _, _ in dirty = true }
      }

      Section {
        Button("保存修改") {
          model.saveMetaSummary(
            id: entryId, name: name, version: version, description: entryDescription)
          model.saveCode(id: entryId, code: code)
          dirty = false
        }
        .disabled(!dirty)

        Button("删除", role: .destructive) { confirmDelete = true }
        // After deletion, pop back by showing the empty state: refresh keeps
        // summaries in sync and the detail simply becomes stale.
      }
    }
    .formStyle(.grouped)
    .navigationTitle(name.isEmpty ? "详情" : name)
    .onAppear(perform: load)
    .onChange(of: entryId) { _, _ in load() }
    .onChange(of: model.rev) { _, _ in
      // Keep metaStale/values fresh after native or extension-side changes,
      // but never clobber in-flight edits.
      if !dirty { load() }
    }
    .confirmationDialog("确定删除「\(name)」？", isPresented: $confirmDelete, titleVisibility: .visible) {
      Button("删除", role: .destructive) {
        model.delete(entryId)
      }
    }
  }

  private func load() {
    guard let entry = model.loadEntry(id: entryId) else { return }
    if dirty && loadedId == entryId { return }
    code = entry.code
    name = entry.record.summary.name
    version = entry.record.summary.version ?? ""
    entryDescription = entry.record.summary.description ?? ""
    metaStale = entry.record.metaStale
    kind = entry.record.kind
    values = entry.values.mapValues { value in
      switch value {
      case let s as String: return s
      case let n as NSNumber: return n.stringValue
      default: return String(describing: value)
      }
    }
    loadedId = entryId
    dirty = false
  }
}
