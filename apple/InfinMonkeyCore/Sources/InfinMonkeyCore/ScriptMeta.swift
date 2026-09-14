import Foundation

/// When the injected code runs; mirrors `RunAt` in packages/shared/src/types.ts.
public enum RunAt: String, Codable, Sendable, CaseIterable {
  case documentStart = "document-start"
  case documentEnd = "document-end"
  case documentIdle = "document-idle"
}

/// `@resource` entry; mirrors `ResourceRef` in packages/shared/src/types.ts.
public struct ResourceRef: Codable, Sendable, Equatable {
  public var name: String
  public var url: String

  public init(name: String, url: String) {
    self.name = name
    self.url = url
  }
}

/// Parsed userscript/userstyle metadata.
///
/// This mirrors `ScriptMeta` in packages/shared/src/types.ts field for field so
/// the two platforms cannot drift: the encoding produced here is exactly what
/// the extension's `parseMeta()` produces.
///
/// Decoding is lenient about *absent* fields (they take their documented
/// default) but strict about *malformed* ones, so an empty `{}` — the
/// extension's marker for "not parsed yet" — decodes to `isUnparsed` instead of
/// throwing. A stated field with the wrong type is an error.
public struct ScriptMeta: Codable, Sendable, Equatable {
  public var name: String
  public var namespace: String?
  public var version: String?
  public var description: String?
  public var author: String?
  public var homepageURL: String?
  public var supportURL: String?
  public var iconURL: String?
  public var updateURL: String?
  public var downloadURL: String?
  public var license: String?
  public var runAt: RunAt
  public var noframes: Bool
  public var matches: [String]
  public var includes: [String]
  public var excludes: [String]
  public var grants: [String]
  public var connects: [String]
  public var requires: [String]
  public var resources: [ResourceRef]
  public var nameLocales: [String: String]
  public var descriptionLocales: [String: String]
  public var others: [String: [String]]
  public var headerRaw: String
  public var headerFound: Bool

  /// True when the source JSON object was empty: the extension has not parsed
  /// this entry yet. Not a wire field — it is derived from the object itself,
  /// and setting it only matters when re-serializing after an edit.
  public var isUnparsed: Bool

  public init(
    name: String = "",
    namespace: String? = nil,
    version: String? = nil,
    description: String? = nil,
    author: String? = nil,
    homepageURL: String? = nil,
    supportURL: String? = nil,
    iconURL: String? = nil,
    updateURL: String? = nil,
    downloadURL: String? = nil,
    license: String? = nil,
    runAt: RunAt = .documentEnd,
    noframes: Bool = false,
    matches: [String] = [],
    includes: [String] = [],
    excludes: [String] = [],
    grants: [String] = [],
    connects: [String] = [],
    requires: [String] = [],
    resources: [ResourceRef] = [],
    nameLocales: [String: String] = [:],
    descriptionLocales: [String: String] = [:],
    others: [String: [String]] = [:],
    headerRaw: String = "",
    headerFound: Bool = false,
    isUnparsed: Bool = false
  ) {
    self.name = name
    self.namespace = namespace
    self.version = version
    self.description = description
    self.author = author
    self.homepageURL = homepageURL
    self.supportURL = supportURL
    self.iconURL = iconURL
    self.updateURL = updateURL
    self.downloadURL = downloadURL
    self.license = license
    self.runAt = runAt
    self.noframes = noframes
    self.matches = matches
    self.includes = includes
    self.excludes = excludes
    self.grants = grants
    self.connects = connects
    self.requires = requires
    self.resources = resources
    self.nameLocales = nameLocales
    self.descriptionLocales = descriptionLocales
    self.others = others
    self.headerRaw = headerRaw
    self.headerFound = headerFound
    self.isUnparsed = isUnparsed
  }

  /// The `{}` marker: "no metadata yet, the extension must parse the code".
  public static let unparsed = ScriptMeta(isUnparsed: true)

  /// Name to show when the entry has no usable `@name` yet.
  public var displayName: String {
    name.isEmpty ? "未命名" : name
  }

  private enum CodingKeys: String, CodingKey {
    case name, namespace, version, description, author
    case homepageURL, supportURL, iconURL, updateURL, downloadURL, license
    case runAt, noframes
    case matches, includes, excludes, grants, connects, requires, resources
    case nameLocales, descriptionLocales, others
    case headerRaw, headerFound
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    self.init(
      name: try container.decodeIfPresent(String.self, forKey: .name) ?? "",
      namespace: try container.decodeIfPresent(String.self, forKey: .namespace),
      version: try container.decodeIfPresent(String.self, forKey: .version),
      description: try container.decodeIfPresent(String.self, forKey: .description),
      author: try container.decodeIfPresent(String.self, forKey: .author),
      homepageURL: try container.decodeIfPresent(String.self, forKey: .homepageURL),
      supportURL: try container.decodeIfPresent(String.self, forKey: .supportURL),
      iconURL: try container.decodeIfPresent(String.self, forKey: .iconURL),
      updateURL: try container.decodeIfPresent(String.self, forKey: .updateURL),
      downloadURL: try container.decodeIfPresent(String.self, forKey: .downloadURL),
      license: try container.decodeIfPresent(String.self, forKey: .license),
      runAt: try container.decodeIfPresent(RunAt.self, forKey: .runAt) ?? .documentEnd,
      noframes: try container.decodeIfPresent(Bool.self, forKey: .noframes) ?? false,
      matches: try container.decodeIfPresent([String].self, forKey: .matches) ?? [],
      includes: try container.decodeIfPresent([String].self, forKey: .includes) ?? [],
      excludes: try container.decodeIfPresent([String].self, forKey: .excludes) ?? [],
      grants: try container.decodeIfPresent([String].self, forKey: .grants) ?? [],
      connects: try container.decodeIfPresent([String].self, forKey: .connects) ?? [],
      requires: try container.decodeIfPresent([String].self, forKey: .requires) ?? [],
      resources: try container.decodeIfPresent([ResourceRef].self, forKey: .resources) ?? [],
      nameLocales: try container.decodeIfPresent([String: String].self, forKey: .nameLocales)
        ?? [:],
      descriptionLocales: try container.decodeIfPresent(
        [String: String].self, forKey: .descriptionLocales)
        ?? [:],
      others: try container.decodeIfPresent([String: [String]].self, forKey: .others) ?? [:],
      headerRaw: try container.decodeIfPresent(String.self, forKey: .headerRaw) ?? "",
      headerFound: try container.decodeIfPresent(Bool.self, forKey: .headerFound) ?? false,
      isUnparsed: container.allKeys.isEmpty)
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    // An unparsed entry stays `{}` so the extension keeps treating it as its own
    // to parse; anything else round-trips the full field set.
    guard !isUnparsed else { return }
    try container.encode(name, forKey: .name)
    try container.encodeIfPresent(namespace, forKey: .namespace)
    try container.encodeIfPresent(version, forKey: .version)
    try container.encodeIfPresent(description, forKey: .description)
    try container.encodeIfPresent(author, forKey: .author)
    try container.encodeIfPresent(homepageURL, forKey: .homepageURL)
    try container.encodeIfPresent(supportURL, forKey: .supportURL)
    try container.encodeIfPresent(iconURL, forKey: .iconURL)
    try container.encodeIfPresent(updateURL, forKey: .updateURL)
    try container.encodeIfPresent(downloadURL, forKey: .downloadURL)
    try container.encodeIfPresent(license, forKey: .license)
    try container.encode(runAt, forKey: .runAt)
    try container.encode(noframes, forKey: .noframes)
    try container.encode(matches, forKey: .matches)
    try container.encode(includes, forKey: .includes)
    try container.encode(excludes, forKey: .excludes)
    try container.encode(grants, forKey: .grants)
    try container.encode(connects, forKey: .connects)
    try container.encode(requires, forKey: .requires)
    try container.encode(resources, forKey: .resources)
    try container.encode(nameLocales, forKey: .nameLocales)
    try container.encode(descriptionLocales, forKey: .descriptionLocales)
    try container.encode(others, forKey: .others)
    try container.encode(headerRaw, forKey: .headerRaw)
    try container.encode(headerFound, forKey: .headerFound)
  }
}
