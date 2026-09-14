import Foundation
import os

/// The store could not be located. Kept separate from `StoreError` because this
/// is a build-configuration fault, not a runtime data fault.
public enum StoreLocationError: Error, Equatable {
  /// The Info.plist passthrough key carrying the app group id is absent or
  /// empty. The build setting is not reaching the plist.
  case missingAppGroupKey(String)
}

/// Filesystem layout of the per-file store.
///
/// Under `root`:
/// ```
/// index.json             structured document: entries, rev, tombstones
/// entries/<id>.user.js   script code (userscript header included)
/// entries/<id>.user.css  style code
/// values/<id>.json       GM values — opaque JSON, never interpreted here
/// .lock                  flock target for cross-process exclusion
/// ```
///
/// Code lives in a plain file per entry so the store is usable from an editor:
/// a file dropped in is adopted, and an external edit is detected through the
/// content hash rather than through a watcher.
public struct StoreLayout: Sendable, Equatable {
  public let root: URL

  public init(root: URL) {
    self.root = root
  }

  public var indexURL: URL { root.appendingPathComponent("index.json") }
  public var lockURL: URL { root.appendingPathComponent(".lock") }
  public var entriesDir: URL { root.appendingPathComponent("entries", isDirectory: true) }
  public var valuesDir: URL { root.appendingPathComponent("values", isDirectory: true) }

  /// Where an entry's code file lives.
  public func codeURL(_ record: EntryRecord) -> URL {
    entriesDir.appendingPathComponent(record.fileName)
  }

  /// Where an entry's GM values live. Only scripts have values; styles never
  /// write this path, and it is harmless to remove when absent.
  public func valuesURL(id: String) -> URL {
    valuesDir.appendingPathComponent("\(id).json")
  }

  public static func codeFileName(id: String, kind: EntryKind) -> String {
    switch kind {
    case .script: return "\(id).user.js"
    case .style: return "\(id).user.css"
    }
  }

  /// The entry kind a file name implies, or nil for foreign files.
  public static func kind(ofFileName name: String) -> EntryKind? {
    if name.hasSuffix(".user.js") { return .script }
    if name.hasSuffix(".user.css") { return .style }
    return nil
  }

  /// The entry id a code file name encodes.
  public static func entryId(ofFileName name: String) -> String? {
    for suffix in [".user.js", ".user.css"] where name.hasSuffix(suffix) {
      return String(name.dropLast(suffix.count))
    }
    return nil
  }

  /// Ids become file names, so the charset stays conservative. Returns nil when
  /// nothing usable remains.
  public static func sanitizeId(_ raw: String) -> String? {
    let allowed = CharacterSet(
      charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")
    let cleaned = String(
      String.UnicodeScalarView(raw.unicodeScalars.filter { allowed.contains($0) }))
    return cleaned.isEmpty || cleaned.count > 64 ? nil : cleaned
  }
}

// MARK: - Location

extension StoreLayout {
  /// Info.plist key carrying the app group id. The value comes from the
  /// `APP_GROUP_ID` build setting, so it picks up `$(TeamIdentifierPrefix)`
  /// when the build is signed instead of being frozen into the binary.
  public static let appGroupPlistKey = "InfinMonkeyAppGroupID"

  /// The app group id as the signed entitlement sees it.
  ///
  /// A missing key is a build fault and throws: continuing would put this
  /// process in a container the other processes do not share, and the failure
  /// would show up later as mysteriously diverging libraries.
  public static func appGroupID(bundle: Bundle = .main) throws -> String {
    guard let value = bundle.object(forInfoDictionaryKey: appGroupPlistKey) as? String,
      !value.isEmpty
    else {
      throw StoreLocationError.missingAppGroupKey(appGroupPlistKey)
    }
    return value
  }

  /// Resolves the store root.
  ///
  /// Prefers the app group container so every process sharing the library sees
  /// the same files. When no container is available — a build without
  /// entitlements, which is how `CODE_SIGNING_ALLOWED=NO` builds and unit tests
  /// run — it falls back to Application Support so the code stays uniform and
  /// exercisable. Callers that must not run split-brained should use the
  /// container-failure signal rather than relying on the fallback.
  public static func resolve(bundle: Bundle = .main) throws -> StoreLayout {
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
        "InfinMonkeyCore: app group %@ has no container (unsigned build?); using the per-process fallback store",
        groupID)
    #else
      os_log(
        .info, "InfinMonkeyCore: built without APP_GROUP; using the per-process fallback store")
    #endif
    return StoreLayout(root: fallbackRoot())
  }

  public static func fallbackRoot() -> URL {
    let base =
      FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
      ?? FileManager.default.temporaryDirectory
    return base.appendingPathComponent("InfinMonkey", isDirectory: true)
  }
}
