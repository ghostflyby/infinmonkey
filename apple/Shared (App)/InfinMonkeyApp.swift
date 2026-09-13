import SwiftUI

@main
struct InfinMonkeyApp: App {

  @State private var storeModel = StoreModel()

  var body: some Scene {
    WindowGroup("InfinMonkey") {
      ContentView()
        .environment(storeModel)
    }
  }
}
