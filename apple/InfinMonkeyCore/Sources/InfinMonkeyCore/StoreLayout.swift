import Foundation

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

  /// Whether `id` can be used as a file name in the store.
  ///
  /// This validates rather than rewrites: an id is an entry's identity, shared
  /// with the extension, so silently repairing one would orphan the entry on the
  /// other side. Callers that can invent a replacement do so explicitly.
  ///
  /// The rules describe what a file name must satisfy rather than an ASCII
  /// whitelist. Ids come from `crypto.randomUUID()` today, but the store is a
  /// user-visible directory, so a name chosen by a user or a future client
  /// should survive.
  public static func isValidID(_ id: String) -> Bool {
    guard !id.isEmpty, id.count <= maxIDLength else { return false }
    // Path structure: no separators, and neither `.` nor `..` as a whole name.
    guard !id.contains("/"), !id.contains("\\"), id != ".", id != ".." else { return false }
    // A colon is legal in a POSIX name but the Finder shows it as a separator,
    // which makes the entry look like a file it is not.
    guard !id.contains(":") else { return false }
    // NUL terminates a C path, and control characters are unusable in a name.
    for scalar in id.unicodeScalars {
      if scalar == "\0" { return false }
      if scalar.properties.generalCategory == .control { return false }
    }
    return true
  }

  /// Upper bound on an id: generous for a UUID, bounded for a readable name.
  static let maxIDLength = 128
}
