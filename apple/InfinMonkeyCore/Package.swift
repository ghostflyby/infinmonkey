// swift-tools-version:6.0
import PackageDescription

// The package builds in Swift 6 language mode for strict concurrency checking.
//
// Note the deliberate difference from the app targets: those build with
// `-default-isolation=MainActor` because they are UI, while this package is a
// library and stays nonisolated by default. Isolation here is explicit — actors
// own their state, and value types are `Sendable` — rather than inherited from a
// default that would wrongly pin library code to the main actor.
let package = Package(
  name: "InfinMonkeyCore",
  // Matches the app targets (the only consumer). `@Observable` in the UI is what
  // sets the floor there; keeping these equal avoids a package that claims to
  // support platforms nothing can actually run on.
  platforms: [.iOS(.v17), .macOS(.v14)],
  products: [
    .library(name: "InfinMonkeyCore", targets: ["InfinMonkeyCore"])
  ],
  dependencies: [
    // Command line parsing, help, and usage errors for the management CLI. It is
    // a dependency of the target rather than of everything: only the CLI types
    // import it, so the store, the router, and the frame layer stay free of it.
    .package(url: "https://github.com/apple/swift-argument-parser", from: "1.5.0")
  ],
  targets: [
    .target(
      name: "InfinMonkeyCore",
      dependencies: [.product(name: "ArgumentParser", package: "swift-argument-parser")],
      swiftSettings: [.swiftLanguageMode(.v6)]),
    .testTarget(
      name: "InfinMonkeyCoreTests",
      dependencies: ["InfinMonkeyCore"],
      swiftSettings: [.swiftLanguageMode(.v6)]),
  ]
)
