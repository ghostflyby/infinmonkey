import Foundation
import InfinMonkeyCore

/// Where the shared library lives on this platform.
///
/// This is application-layer knowledge, not storage knowledge: the store is
/// handed a root directory and manages the layout inside it. Locating that root
/// means knowing about app groups, entitlements, and bundle identity, which the
/// storage layer has no business depending on — that is why it lives here rather
/// than in `InfinMonkeyCore`.
///
/// Both the app and the extension use it, so they agree on the container. There
/// is no fallback directory: a build that cannot name its app group cannot share
/// a library with the other processes, so locating the store simply fails and
/// every caller reports the reason.
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

  /// The store root: the app group container. Preferring the container is what
  /// makes the app, the extension, and (later) the native messaging host see the
  /// same library.
  static func layout(bundle: Bundle = .main) throws -> StoreLayout {
    #if APP_GROUP
      let groupID = try appGroupID(bundle: bundle)
      guard
        let container = FileManager.default.containerURL(
          forSecurityApplicationGroupIdentifier: groupID)
      else {
        throw StoreLocationError.noContainer(groupID)
      }
      return StoreLayout(
        root: container.appendingPathComponent("Library/InfinMonkey", isDirectory: true))
    #else
      throw StoreLocationError.appGroupDisabled
    #endif
  }
}

/// The store could not be located. Separate from `StoreError` because this is a
/// build-configuration fault rather than a runtime data fault.
enum StoreLocationError: Error, CustomStringConvertible {
  /// The Info.plist passthrough key carrying the app group id is absent or empty,
  /// so the build setting is not reaching the plist.
  case missingAppGroupKey(String)
  /// The build names a group the runtime does not grant a container for — a
  /// signing or provisioning fault.
  case noContainer(String)
  /// The target was built without the APP_GROUP compilation condition.
  case appGroupDisabled

  var description: String {
    switch self {
    case .missingAppGroupKey(let key):
      return "app group id key '\(key)' missing from Info.plist"
    case .noContainer(let groupID):
      return "app group '\(groupID)' has no container (unsigned build?)"
    case .appGroupDisabled:
      return "built without APP_GROUP, so the shared store cannot be located"
    }
  }
}
