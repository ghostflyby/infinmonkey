import Foundation
import Testing

@testable import InfinMonkeyCore

@Suite("Launch mode dispatch")
struct LaunchModeTests {

  @Test("an app launch with no arguments is the GUI")
  func plainLaunchIsGUI() {
    #expect(
      LaunchMode.parse(arguments: ["/Applications/InfinMonkey.app/Contents/MacOS/InfinMonkey"])
        == .gui)
  }

  @Test("flags injected by the system stay in the GUI branch")
  func systemFlagsAreGUI() {
    // macOS and Xcode launch an app with arguments like these; treating them as
    // a subcommand would open the usage text instead of the app.
    let mode = LaunchMode.parse(arguments: [
      "/Applications/InfinMonkey.app/Contents/MacOS/InfinMonkey",
      "-NSDocumentRevisionsDebugMode", "YES",
    ])
    #expect(mode == .gui)
  }

  @Test("Firefox's shape is a manifest path plus the add-on id")
  func firefoxShape() {
    let mode = LaunchMode.parse(arguments: [
      "/path/to/InfinMonkey",
      "/Users/x/Library/Application Support/Mozilla/NativeMessagingHosts/dev.ghostflyby.infinmonkey.json",
      "{3f7d2a91-6b5e-4c8a-9d20-51e8f0b7c642}",
    ])
    #expect(
      mode
        == .nativeHost(
          NativeHostInvocation(
            peer: .firefox(addonID: "{3f7d2a91-6b5e-4c8a-9d20-51e8f0b7c642}"),
            manifestPath:
              "/Users/x/Library/Application Support/Mozilla/NativeMessagingHosts/dev.ghostflyby.infinmonkey.json"
          )))
  }

  @Test("a manifest path without an add-on id yields an empty id, not a missing peer")
  func firefoxWithoutAddonID() {
    // A malformed invocation is still a host launch: the identity check is what
    // rejects it, so the two concerns stay separate.
    let mode = LaunchMode.parse(arguments: ["/path/to/InfinMonkey", "/tmp/host.json"])
    #expect(
      mode
        == .nativeHost(
          NativeHostInvocation(peer: .firefox(addonID: ""), manifestPath: "/tmp/host.json")))
  }

  @Test("Chrome's shape is a bare origin")
  func chromeShape() {
    let mode = LaunchMode.parse(arguments: [
      "/path/to/InfinMonkey", "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
    ])
    #expect(
      mode
        == .nativeHost(
          NativeHostInvocation(
            peer: .chrome(origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"))))
  }

  @Test("a word becomes a management subcommand with its arguments")
  func managementShape() {
    let mode = LaunchMode.parse(arguments: ["/path/to/InfinMonkey", "list", "--json"])
    #expect(mode == .management(subcommand: "list", arguments: ["--json"]))
  }

  @Test("a subcommand with no arguments keeps an empty argument list")
  func managementWithoutArguments() {
    #expect(
      LaunchMode.parse(arguments: ["/path/to/InfinMonkey", "status"])
        == .management(subcommand: "status", arguments: []))
  }
}

@Suite("Accepted peers")
struct AcceptedPeersTests {

  @Test("a configured peer is accepted")
  func acceptsConfiguredPeer() {
    let peers = AcceptedPeers(addonIDs: ["addon@example"], origins: [])
    #expect(peers.allows(.firefox(addonID: "addon@example")))
  }

  @Test("an unconfigured peer is refused")
  func refusesUnknownPeer() {
    let peers = AcceptedPeers(addonIDs: ["addon@example"], origins: [])
    #expect(!peers.allows(.firefox(addonID: "other@example")))
  }

  @Test("an empty configuration accepts nobody")
  func emptyAcceptsNobody() {
    // Fail closed: a build with no peer keys configured must not serve any caller.
    let peers = AcceptedPeers()
    #expect(peers.isEmpty)
    #expect(!peers.allows(.firefox(addonID: "")))
    #expect(!peers.allows(.chrome(origin: "chrome-extension://abc/")))
  }

  @Test("an empty Firefox id never matches a configured add-on")
  func emptyIDDoesNotMatch() {
    // The case that matters: a malformed host invocation passes no add-on id,
    // and it must not be allowed just because the set is non-empty.
    let peers = AcceptedPeers(addonIDs: ["addon@example"])
    #expect(!peers.allows(.firefox(addonID: "")))
  }

  @Test("origins are compared exactly, trailing slash included")
  func originIsExact() {
    let peers = AcceptedPeers(
      addonIDs: [], origins: [PeerIdentity.chromeOrigin(extensionID: "abc")])
    #expect(peers.allows(.chrome(origin: "chrome-extension://abc/")))
    // Chrome always sends the trailing slash as part of the origin; a value
    // without it is a different string and must not be normalized into a match.
    #expect(!peers.allows(.chrome(origin: "chrome-extension://abc")))
  }

  @Test("a Firefox id is not accepted as a Chrome origin")
  func kindsDoNotCross() {
    let peers = AcceptedPeers(addonIDs: ["addon@example"], origins: [])
    #expect(!peers.allows(.chrome(origin: "addon@example")))
  }
}
