import Foundation
import InfinMonkeyCore
import SwiftUI

// Only macOS has command-line roles, and only macOS links the CLI product — an
// unconditional import would make the iOS target link it too, for an argv it
// never has.
#if os(macOS)
  import InfinMonkeyCLI
#endif

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
    runNativeHost(invocation)
  case .management(let subcommand, let arguments):
    // The subcommand is re-joined with its arguments: parsing belongs to
    // ArgumentParser, and `LaunchMode` only had to recognize that this launch is
    // the command line at all.
    ManagementCLI(service: serviceForThisProcess())
      .runAndExit(arguments: [subcommand] + arguments)
  case .gui:
    break  // fall through to the app
  }

  /// Serves one browser's native messaging session on stdin/stdout, ending the
  /// process with the session's exit code.
  ///
  /// The peer check happens before any frame is read: refusing an unrecognized
  /// caller is the whole point of the browser-supplied identity, and a host that
  /// answered first would already have done the work.
  func runNativeHost(_ invocation: NativeHostInvocation) -> Never {
    let accepted = acceptedPeers()
    guard accepted.allows(invocation.peer) else {
      // The browser forwards host stderr to the extension console, so this is
      // where a refusal is read; the process ends before any frame is served.
      let log = stderrLog(label: "infinmonkey host")
      log(.error, "refusing \(describe(invocation.peer))")
      log(
        .error,
        accepted.isEmpty
          ? "no peers are configured in this build (Info.plist has no accepted ids)"
          : "configured peers: \(describe(accepted))")
      exit(1)
    }
    StdioHostSession(store: storeForThisProcess()).runAndExit()
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
  /// The mapping and its fail-closed rule live in Core (`AcceptedPeers.from`),
  /// so they are covered by tests; this only hands over the plist's values.
  func acceptedPeers(bundle: Bundle = .main) -> AcceptedPeers {
    func value(_ key: String) -> String? {
      bundle.object(forInfoDictionaryKey: key) as? String
    }
    return AcceptedPeers.from(
      firefoxAddonID: value(AcceptedPeers.PlistKey.firefoxAddonID),
      chromeExtensionID: value(AcceptedPeers.PlistKey.chromeExtensionID))
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
