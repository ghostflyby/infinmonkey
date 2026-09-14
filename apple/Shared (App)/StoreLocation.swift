import Foundation
import InfinMonkeyCore
import os

/// Where the shared library lives on this platform.
///
/// This is application-layer knowledge, not storage knowledge: the store is
/// handed a root directory and manages the layout inside it. Locating that root
/// means knowing about app groups, entitlements, and bundle identity, which the
/// storage layer has no business depending on — that is why it lives here rather
/// than in `InfinMonkeyCore`.
///
/// Both the app and the extension use it, so they agree on the container. A build
/// without entitlements (`CODE_SIGNING_ALLOWED=NO`, unit tests) has no container
/// at all, which the fallback below covers.
enum StoreLocation {
  /// Info.plist key carrying the app group id. The value comes from the
  /// `APP_GROUP_ID` build setting, so it picks up `$(TeamIdentifierPrefix)` when
  /// the build is signed, instead of being frozen into the binary.
  static let appGroupPlistKey = "InfinMonkeyAppGroupID"

  /// The app group id as the signed entitlement sees it.
  ///
  /// A missing key is a build fault and throws: continuing would put this process
  /// in a container the other processes do not share, and the failure would surface
  /// later as mysteriously diverging libraries.
  static func appGroupID(bundle: Bundle = .main) throws -> String {
    guard let value = bundle.object(forInfoDictionaryKey: appGroupPlistKey) as? String,
      !value.isEmpty
    else {
      throw StoreLocationError.missingAppGroupKey(appGroupPlistKey)
    }
    return value
  }

  /// The store root: the app group container when there is one, otherwise a
  /// per-process fallback.
  ///
  /// Preferring the container is what makes the app, the extension, and (later)
  /// the native messaging host see the same library. The fallback exists only so
  /// an unsigned build stays runnable.
  static func layout(bundle: Bundle = .main) throws -> StoreLayout {
    #if APP_GROUP
      let groupID = try appGroupID(bundle: bundle)
      if let container = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: groupID)
      {
        return StoreLayout(
          root: container.appendingPathComponent("Library/InfinMonkey", isDirectory: true))
      }
      os_log(
        .error,
        "InfinMonkey: app group %@ has no container (unsigned build?); using the per-process fallback",
        groupID)
    #else
      os_log(.info, "InfinMonkey: built without APP_GROUP; using the per-process fallback")
    #endif
    return StoreLayout(root: fallbackRoot())
  }

  /// A writable root for builds that have no app group.
  static func fallbackRoot() -> URL {
    let base =
      FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
      ?? FileManager.default.temporaryDirectory
    return base.appendingPathComponent("InfinMonkey", isDirectory: true)
  }
}

/// The store could not be located. Separate from `StoreError` because this is a
/// build-configuration fault rather than a runtime data fault.
enum StoreLocationError: Error, Equatable {
  /// The Info.plist passthrough key carrying the app group id is absent or empty,
  /// so the build setting is not reaching the plist.
  case missingAppGroupKey(String)
}
