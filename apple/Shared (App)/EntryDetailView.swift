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
  @State private var valueKeys: [String] = []
  @State private var hasValues = false
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

      if kind == .script && hasValues {
        Section("GM 数据（\(valueKeys.count)）") {
          ForEach(valueKeys, id: \.self) { key in
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
          Task {
            await model.save(
              id: entryId, code: code, name: name, version: version,
              description: entryDescription)
            dirty = false
          }
        }
        .disabled(!dirty)

        Button("删除", role: .destructive) { confirmDelete = true }
        // After deletion, pop back by showing the empty state: refresh keeps
        // summaries in sync and the detail simply becomes stale.
      }
    }
    .formStyle(.grouped)
    .navigationTitle(name.isEmpty ? "详情" : name)
    .task { await load() }
    .onChange(of: entryId) { _, _ in Task { await load() } }
    .onChange(of: model.rev) { _, _ in
      // Keep metaStale/values fresh after extension-side changes, but never
      // clobber edits that are in flight.
      if !dirty { Task { await load() } }
    }
    .confirmationDialog("确定删除「\(name)」？", isPresented: $confirmDelete, titleVisibility: .visible) {
      Button("删除", role: .destructive) {
        Task { await model.delete(entryId) }
      }
    }
  }

  private func load() async {
    guard let entry = await model.loadEntry(id: entryId) else { return }
    if dirty && loadedId == entryId { return }
    code = entry.code
    name = entry.record.meta.isUnparsed ? "" : entry.record.meta.displayName
    version = entry.record.meta.version ?? ""
    entryDescription = entry.record.meta.description ?? ""
    metaStale = entry.record.metaStale
    kind = entry.record.kind
    // Display only: the store carries GM values as opaque bytes, so the keys
    // are read here purely to show what the script has stored. Unreadable
    // values simply render as absent.
    let parsed = entry.values.flatMap { data -> [String: Any]? in
      (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }
    valueKeys = (parsed?.keys.sorted()) ?? []
    hasValues = !valueKeys.isEmpty
    loadedId = entryId
    dirty = false
  }
}
