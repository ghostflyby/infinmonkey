import Foundation

/// When the injected code runs; mirrors `RunAt` in packages/shared/src/types.ts.
public enum RunAt: String, Codable, Sendable, CaseIterable {
  case documentStart = "document-start"
  case documentEnd = "document-end"
  case documentIdle = "document-idle"
}

/// `@resource` entry; mirrors `ResourceRef` in packages/shared/src/types.ts.
public struct ResourceRef: Codable, Sendable, Equatable {
  public let name: String
  public let url: String

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
/// default) and strict about *malformed* ones: a stated field with the wrong
/// type is an error.
///
/// "Not parsed yet" is represented by the *absence* of this value (`ScriptMeta?`),
/// not by a flag inside it. An empty `{}` decodes to `nil` — no real parse result
/// is ever empty, because `parseMeta()` always emits every field — and `nil`
/// encodes back to `{}`, keeping the wire shape (which requires an object).
public struct ScriptMeta: Codable, Sendable, Equatable {
  public let name: String
  public let namespace: String?
  public let version: String?
  public let description: String?
  public let author: String?
  public let homepageURL: String?
  public let supportURL: String?
  public let iconURL: String?
  public let updateURL: String?
  public let downloadURL: String?
  public let license: String?
  public let runAt: RunAt
  public let noframes: Bool
  public let matches: [String]
  public let includes: [String]
  public let excludes: [String]
  public let grants: [String]
  public let connects: [String]
  public let requires: [String]
  public let resources: [ResourceRef]
  public let nameLocales: [String: String]
  public let descriptionLocales: [String: String]
  public let others: [String: [String]]
  public let headerRaw: String
  public let headerFound: Bool

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
    headerFound: Bool = false
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
  }

  /// The edited summary, for the three fields the app's UI owns.
  ///
  /// Everything else is carried over untouched: `@match` rules, grants, and
  /// unrecognized directives are parse output, and the app cannot recompute
  /// them. An empty string clears a field.
  public func withSummary(name: String, version: String, description: String) -> ScriptMeta {
    ScriptMeta(
      name: name,
      namespace: namespace,
      version: version.isEmpty ? nil : version,
      description: description.isEmpty ? nil : description,
      author: author,
      homepageURL: homepageURL,
      supportURL: supportURL,
      iconURL: iconURL,
      updateURL: updateURL,
      downloadURL: downloadURL,
      license: license,
      runAt: runAt,
      noframes: noframes,
      matches: matches,
      includes: includes,
      excludes: excludes,
      grants: grants,
      connects: connects,
      requires: requires,
      resources: resources,
      nameLocales: nameLocales,
      descriptionLocales: descriptionLocales,
      others: others,
      headerRaw: headerRaw,
      headerFound: headerFound)
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
      headerFound: try container.decodeIfPresent(Bool.self, forKey: .headerFound) ?? false)
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
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
