// swift-tools-version:5.10
import PackageDescription

let package = Package(
  name: "InfinMonkeyCore",
  platforms: [.iOS(.v16), .macOS(.v13)],
  products: [
    .library(name: "InfinMonkeyCore", targets: ["InfinMonkeyCore"])
  ],
  targets: [
    .target(name: "InfinMonkeyCore"),
    .testTarget(name: "InfinMonkeyCoreTests", dependencies: ["InfinMonkeyCore"]),
  ]
)
