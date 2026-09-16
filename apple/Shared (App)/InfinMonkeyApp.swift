import SwiftUI

/// The app's scene graph.
///
/// Deliberately **not** `@main`: `main.swift` is the single entry point for both
/// platforms, because macOS needs to dispatch before SwiftUI installs its run
/// loop (a browser launches this same binary as its native messaging host, and
/// a command line tool runs it as `infinmonkey`). Declaring `@main` here as well
/// would be two entry points in one module, which the compiler rejects. The
/// dispatch reaches `InfinMonkeyApp.main()` for the GUI case, so nothing about
/// the app itself changes.
struct InfinMonkeyApp: App {

  @State private var storeModel = StoreModel()

  var body: some Scene {
    WindowGroup("InfinMonkey") {
      ContentView()
        .environment(storeModel)
    }
  }
}
