import Foundation

/// Who is on the other end of a native messaging connection.
///
/// The browser supplies this on the host's command line and it cannot be forged
/// from the extension side: Firefox passes the add-on id as declared in
/// `browser_specific_settings`, Chrome the extension's origin. The host is the
/// most privileged process in the system, so a peer it does not recognize is
/// refused rather than served.
public enum PeerIdentity: Sendable, Equatable {
  case firefox(addonID: String)
  case chrome(origin: String)

  /// The origin spelling Chrome uses on the command line and in a host
  /// manifest's `allowed_origins` — built here so the expected value cannot be
  /// misspelled by hand (the trailing slash is part of the origin).
  public static func chromeOrigin(extensionID: String) -> String {
    "chrome-extension://\(extensionID)/"
  }
}

/// The peers this build is willing to serve.
public struct AcceptedPeers: Sendable, Equatable {
  public var addonIDs: Set<String>
  public var origins: Set<String>

  public init(addonIDs: Set<String> = [], origins: Set<String> = []) {
    self.addonIDs = addonIDs
    self.origins = origins
  }

  /// Whether `identity` is one of the peers this build accepts.
  ///
  /// Comparison is exact: these strings are the browser's claim about who is
  /// calling, and a near miss is a build-configuration fault to fix rather than
  /// something to normalize away. An empty set therefore accepts nobody.
  public func allows(_ identity: PeerIdentity) -> Bool {
    switch identity {
    case .firefox(let addonID): return addonIDs.contains(addonID)
    case .chrome(let origin): return origins.contains(origin)
    }
  }

  public var isEmpty: Bool { addonIDs.isEmpty && origins.isEmpty }
}

/// A native messaging invocation, as the browser hands it to the host.
public struct NativeHostInvocation: Sendable, Equatable {
  public var peer: PeerIdentity
  /// Firefox passes the manifest path first; Chrome passes no manifest.
  public var manifestPath: String?

  public init(peer: PeerIdentity, manifestPath: String? = nil) {
    self.peer = peer
    self.manifestPath = manifestPath
  }
}

/// What this process was asked to do, decided from its command line.
public enum LaunchMode: Sendable, Equatable {
  /// The normal launch: an app, or an extension's message arriving at the appex.
  case gui
  /// A browser started us as its native messaging host.
  case nativeHost(NativeHostInvocation)
  /// A developer ran a management subcommand.
  case management(subcommand: String, arguments: [String])
}

extension LaunchMode {
  /// Reads the mode out of a process's arguments (`arguments[0]` is the
  /// executable, which only the browsers' calling convention is read from).
  ///
  /// The rule set is deliberately small, because the host cannot be told apart
  /// by a flag: a host manifest's `path` is spawned directly (no shell), and the
  /// only arguments are the ones the browser adds itself — so the mode has to be
  /// recognized from those.
  ///
  /// | arguments after the executable | mode |
  /// |---|---|
  /// | `<…>.json` `[addon-id]` | Firefox host |
  /// | `chrome-extension://<id>/` | Chrome host |
  /// | `<subcommand> [args…]` | management |
  /// | nothing, or a `-flag` | GUI |
  ///
  /// A dash-prefixed first argument means GUI because that is what macOS and
  /// Xcode inject into an ordinary launch; anything else is a subcommand
  /// attempt, so a typo reports usage instead of silently opening a window.
  public static func parse(arguments: [String]) -> LaunchMode {
    guard arguments.count > 1 else { return .gui }
    let first = arguments[1]

    if first.hasSuffix(".json") {
      // Firefox: [manifest-path, addon-id] (addons.mozilla.org documents both).
      let addonID = arguments.count > 2 ? arguments[2] : ""
      return .nativeHost(
        NativeHostInvocation(peer: .firefox(addonID: addonID), manifestPath: first))
    }
    if first.hasPrefix("chrome-extension://") {
      return .nativeHost(NativeHostInvocation(peer: .chrome(origin: first)))
    }
    if first.hasPrefix("-") { return .gui }

    return .management(subcommand: first, arguments: Array(arguments.dropFirst(2)))
  }
}
