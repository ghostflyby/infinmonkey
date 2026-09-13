import InfinMonkeyCore
import SwiftUI
import UniformTypeIdentifiers

struct ContentView: View {
  @Environment(StoreModel.self) private var model
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    @Bindable var model = model
    return NavigationSplitView {
      EntryListView()
        .navigationSplitViewColumnWidth(min: 260, ideal: 300)
    } detail: {
      Text("选择一个脚本或样式查看详情")
        .foregroundStyle(.secondary)
    }
    .toolbar { toolbarContent }
    .fileImporter(
      isPresented: $model.importPresented,
      allowedContentTypes: StoreModel.importTypes
    ) { result in
      if case .success(let url) = result { model.importFile(at: url) }
    }
    .fileExporter(
      isPresented: $model.exportPresented,
      document: model.exportBundle(),
      contentType: .json,
      defaultFilename: "infinmonkey-export.json"
    ) { _ in }
    .onChange(of: scenePhase) { _, phase in
      // The extension may have changed the store while we were backgrounded.
      if phase == .active { model.refresh() }
    }
    .onAppear { model.refresh() }
  }

  @ToolbarContentBuilder private var toolbarContent: some ToolbarContent {
    ToolbarItemGroup {
      Menu {
        Button("新建脚本") { model.create(kind: .script) }
        Button("新建样式") { model.create(kind: .style) }
      } label: {
        Label("新建", systemImage: "plus")
      }
      Button {
        model.importPresented = true
      } label: {
        Label("导入", systemImage: "square.and.arrow.down")
      }
      Button {
        model.exportPresented = true
      } label: {
        Label("导出", systemImage: "square.and.arrow.up")
      }
      Button {
        model.refresh()
      } label: {
        Label("刷新", systemImage: "arrow.clockwise")
      }
    }
  }
}

struct EntryListView: View {
  @Environment(StoreModel.self) private var model

  var body: some View {
    List {
      ForEach(model.summaries, id: \.id) { entry in
        NavigationLink(value: entry.id) {
          EntryRow(summary: entry)
        }
        .contextMenu {
          Button("删除", role: .destructive) { model.delete(entry.id) }
        }
      }
    }
    .listStyle(.sidebar)
    .overlay {
      if model.summaries.isEmpty {
        ContentUnavailableView(
          "暂无脚本或样式",
          systemImage: "puzzlepiece.extension",
          description: Text("用「新建」添加，或在浏览器里安装")
        )
      }
    }
    .navigationDestination(for: String.self) { id in
      EntryDetailView(entryId: id)
    }
  }
}

struct EntryRow: View {
  @Environment(StoreModel.self) private var model
  let summary: EntrySummary

  var body: some View {
    HStack {
      Image(systemName: summary.kind == .script ? "doc.text" : "paintbrush")
        .foregroundStyle(.tint)
        .frame(width: 24)
      VStack(alignment: .leading) {
        Text(summary.summary.name)
          .fontWeight(.medium)
        if let version = summary.summary.version {
          Text("v" + version)
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
      Spacer()
      if summary.metaStale {
        Text("已在外部修改")
          .font(.caption2)
          .foregroundStyle(.orange)
      }
      Toggle(
        "",
        isOn: Binding(
          get: { summary.enabled },
          set: { model.setEnabled(summary.id, $0) }
        )
      )
      .toggleStyle(.switch)
      .labelsHidden()
    }
  }
}

#Preview {
  ContentView()
}
