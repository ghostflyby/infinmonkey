import Foundation
import os

/// Filesystem layout of the per-file store.
///
/// Layout under `root`:
///   index.json           — document: v, rev, settings, entries, tombstones
///   entries/<id>.user.js — script code (userscript header included)
///   entries/<id>.user.css— style code
///   values/<id>.json     — GM value store per script
///   .lock                — flock target for cross-process writer exclusion
///
/// The layout is deliberately editor-friendly: each entry's code is a plain
/// file whose stem is the entry id; external edits are detected via SHA-256
/// drift and surfaced as `metaStale` (the extension re-parses metadata).
public struct StoreLayout: Sendable {
  public let root: URL

  public init(root: URL) {
    self.root = root
  }

  public var indexURL: URL { root.appendingPathComponent("index.json") }
  public var lockURL: URL { root.appendingPathComponent(".lock") }
  public var entriesDir: URL { root.appendingPathComponent("entries", isDirectory: true) }
  public var valuesDir: URL { root.appendingPathComponent("values", isDirectory: true) }

  public func entryURL(_ record: EntryRecord) -> URL {
    entriesDir.appendingPathComponent(record.fileName)
  }

  public func valuesURL(id: String) -> URL {
    valuesDir.appendingPathComponent("\(id).json")
  }

  public static func codeFileName(id: String, kind: EntryKind) -> String {
    switch kind {
    case .script: return "\(id).user.js"
    case .style: return "\(id).user.css"
    }
  }

  /// Entry kind inferred from a code file extension; nil for foreign files.
  public static func kind(ofFileName name: String) -> EntryKind? {
    if name.hasSuffix(".user.js") { return .script }
    if name.hasSuffix(".user.css") { return .style }
    return nil
  }

  /// Entry id from a code file name (stem before the kind suffix).
  public static func entryId(ofFileName name: String) -> String? {
    for suffix in [".user.js", ".user.css"] where name.hasSuffix(suffix) {
      return String(name.dropLast(suffix.count))
    }
    return nil
  }

  /// Ids are used as file names; keep the charset conservative.
  public static func sanitizeId(_ raw: String) -> String? {
    let allowed = CharacterSet(
      charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")
    let scalars = raw.unicodeScalars.filter { allowed.contains($0) }
    let cleaned = String(String.UnicodeScalarView(scalars))
    return cleaned.isEmpty || cleaned.count > 64 ? nil : cleaned
  }

  /// Resolve the store root inside the app group container. Falls back to
  /// Application Support (used in builds without entitlements, e.g. local
  /// unsigned developer builds) so the rest of the code can stay uniform.
  public static func resolve(appGroupId: String) -> StoreLayout {
    #if APP_GROUP
      if let container = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: appGroupId)
      {
        return StoreLayout(
          root: container.appendingPathComponent("Library/InfinMonkey", isDirectory: true))
      }
    #endif
    let support =
      FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
      ?? FileManager.default.temporaryDirectory
    let root = support.appendingPathComponent("InfinMonkey", isDirectory: true)
    os_log(.info, "InfinMonkeyCore: app group unavailable, using fallback store at %@", root.path)
    return StoreLayout(root: root)
  }
}
