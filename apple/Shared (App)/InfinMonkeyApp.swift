import SwiftUI

@main
struct InfinMonkeyApp: App {

  var body: some Scene {
    WindowGroup("InfinMonkey") {
      ContentView()
    }
  }
}

struct ContentView: View {

  var body: some View {
    VStack(spacing: 12) {
      Image(systemName: "puzzlepiece.extension.fill")
        .font(.system(size: 56))
        .foregroundStyle(.tint)
      Text("InfinMonkey")
        .font(.largeTitle.bold())
      Text("脚本管理界面开发中")
        .foregroundStyle(.secondary)
    }
    .padding(40)
  }
}
