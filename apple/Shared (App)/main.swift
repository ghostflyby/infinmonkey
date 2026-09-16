import Foundation
import InfinMonkeyCore
import SwiftUI

// The one entry point of the app binary, shared by both platforms.
//
// It is `main.swift` rather than `@main` so the process can decide what it is
// before SwiftUI installs an application run loop. macOS has three roles for the
// same binary and no flag can separate them: a browser launches the host by
// spawning the executable named in its manifest's `path` (no shell, no extra
// arguments of ours), so the role has to be read from the arguments the browser
// itself supplies. iOS has one role, so it goes straight to the app.

#if os(macOS)

  switch LaunchMode.parse(arguments: CommandLine.arguments) {
  case .nativeHost(let invocation):
    exit(runNativeHost(invocation))
  case .management(let subcommand, let arguments):
    exit(runManagement(subcommand: subcommand, arguments: arguments))
  case .gui:
    break  // fall through to the app
  }

  /// Serves one browser's native messaging session on stdin/stdout.
  ///
  /// The peer check happens before any frame is read: refusing an unrecognized
  /// caller is the whole point of the browser-supplied identity, and a host that
  /// answers first would have already done the work.
  func runNativeHost(_ invocation: NativeHostInvocation) -> Int32 {
    let accepted = acceptedPeers()
    guard accepted.allows(invocation.peer) else {
      FileHandle.standardError.write(
        Data(
          """
          infinmonkey host: refusing \(describe(invocation.peer))
          \(accepted.isEmpty
            ? "no peers are configured in this build (Info.plist has no accepted ids)"
            : "configured peers: \(describe(accepted))")
          """.utf8))
      return 1
    }
    return StdioHostSession(store: storeForThisProcess()).runBlocking()
  }

  /// Runs a management subcommand.
  func runManagement(subcommand: String, arguments: [String]) -> Int32 {
    ManagementCLI(service: serviceForThisProcess())
      .runBlocking(subcommand: subcommand, arguments: arguments)
  }

  /// The store, as this process can reach it.
  ///
  /// Resolution failure is not fatal: a store that cannot be located still has
  /// to report *why*, and that report is what the app shows and what a host
  /// turns into error frames. An unsigned developer build takes this path by
  /// design, since it embeds no app group entitlement.
  func storeForThisProcess() -> any EntryStoring {
    do {
      return NativeStore(layout: try StoreLocation.layout())
    } catch {
      return UnavailableStore(reason: "\(error)")
    }
  }

  /// The library service, carrying the location failure rather than throwing it,
  /// so `infinmonkey status` can state the reason.
  func serviceForThisProcess() -> LibraryService {
    do {
      return LibraryService(layout: try StoreLocation.layout())
    } catch {
      return .unavailable(error: "\(error)")
    }
  }

  /// The peers this build serves, from the Info.plist passthrough keys.
  ///
  /// Read from the bundle (not compiled in) for the same reason the app group id
  /// is: the values describe the installed extension, and a literal would go
  /// stale the moment either side's identity is bumped. Blank values are
  /// dropped, so a key that is present but unset accepts nobody — this is a gate,
  /// so an unconfigured build must fail closed rather than open.
  func acceptedPeers(bundle: Bundle = .main) -> AcceptedPeers {
    var peers = AcceptedPeers()
    if let addonID = string(forKey: "InfinMonkeyFirefoxAddonID", in: bundle) {
      peers.addonIDs.insert(addonID)
    }
    if let extensionID = string(forKey: "InfinMonkeyChromeExtensionID", in: bundle) {
      peers.origins.insert(PeerIdentity.chromeOrigin(extensionID: extensionID))
    }
    return peers
  }

  func string(forKey key: String, in bundle: Bundle) -> String? {
    guard let value = bundle.object(forInfoDictionaryKey: key) as? String,
      !value.trimmingCharacters(in: .whitespaces).isEmpty
    else { return nil }
    return value
  }

  func describe(_ peer: PeerIdentity) -> String {
    switch peer {
    case .firefox(let addonID): return "add-on '\(addonID)'"
    case .chrome(let origin): return "origin '\(origin)'"
    }
  }

  func describe(_ peers: AcceptedPeers) -> String {
    let addons = peers.addonIDs.sorted().map { "add-on \($0)" }
    let origins = peers.origins.sorted().map { "origin \($0)" }
    return (addons + origins).joined(separator: ", ")
  }

#endif

InfinMonkeyApp.main()
