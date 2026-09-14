import Foundation

/// A JSON body carried as a `JSONSerialization` object graph.
///
/// This is the one container for every part of a message whose shape the native
/// side does not model: op payloads, op results, and the GM value store. It is
/// opaque by construction — the graph is private, and callers get it back only
/// by asking for a concrete type through the coder, or by handing the graph to a
/// transport that speaks that representation (the Safari app extension
/// boundary).
///
/// ## Why a container instead of `Data`
///
/// `Data` does not survive `Codable`: encoding a `Data` field emits a base64
/// *string*, so an opaque payload would reach the extension as
/// `"eyJrIjoxfQ=="` instead of an object. Swift has no "raw JSON fragment"
/// support, so a value tree is required as a codec — and reading a tree back out
/// means re-encoding it. Keeping the `JSONSerialization` graph directly avoids
/// both problems: it *is* the representation the boundary already speaks, so a
/// hop that only moves opaque data costs no conversion at all.
///
/// ## Sendable
///
/// `Any` is not `Sendable`, so this is `@unchecked`. What makes that sound:
///
/// - the store is only ever a graph that passed `JSONSerialization`, which
///   yields **immutable** `NSDictionary`/`NSArray`/`NSString`/`NSNumber`;
/// - `init(object:)` accepts a caller's graph, so it freezes it first (see
///   `freeze`), which removes the one way a mutable container could get in;
/// - nothing here mutates the graph or vends a mutable reference: `object` hands
///   it out read-only, and the store keeps bytes rather than graphs.
///
/// Together those mean the value cannot change after construction, which is what
/// `Sendable` requires.
public struct JSONBody: Codable, @unchecked Sendable {
  /// The JSON graph. Private so the container's shape cannot be depended on;
  /// reach it through `decoded(as:)` or `object`.
  private let storage: Any

  /// Wraps an existing graph, rejecting anything that is not legal JSON.
  ///
  /// This is the zero-cost path for a transport that already has a parsed graph
  /// (the Safari boundary), and the validation is what backs the `@unchecked`
  /// `Sendable` claim.
  public init(object: Any) throws {
    guard JSONSerialization.isValidJSONObject(object) else {
      throw JSONBodyError.notJSON(object)
    }
    self.storage = JSONBody.freeze(object)
  }

  /// Wraps a typed value by encoding it: the composition path, so a typed result
  /// can ride inside an opaque slot without hand-assembly.
  public init(encoding value: some Encodable) throws {
    let data = try JSONEncoder().encode(value)
    self.storage = JSONBody.freeze(
      try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]))
  }

  /// An empty JSON object, for slots that are present but hold nothing.
  public static var emptyObject: JSONBody {
    // `[String: Any]()` is valid JSON by construction, so this cannot throw.
    JSONBody(unchecked: [String: Any]())
  }

  /// Wraps JSON text or an object graph held as bytes — the form the store keeps
  /// opaque payloads in.
  ///
  /// A body that is not valid JSON is replaced by an empty object rather than
  /// throwing: the store is the custodian of these bytes and cannot repair them,
  /// and an unparseable blob is reported by the codec when someone tries to read
  /// it as a type. Failing here would turn a corrupt value file into a failed
  /// read of the whole entry.
  public init(data: Data) {
    if let object = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) {
      self.storage = object
    } else {
      self.storage = [String: Any]()
    }
  }

  /// Parses JSON text. With `requiringValidJSON`, text that is not JSON throws
  /// instead of becoming an empty body — the frame path needs to reject a
  /// malformed message, while the store's byte path must tolerate a corrupt blob.
  public init(data: Data, requiringValidJSON: Bool) throws {
    guard let object = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    else {
      throw JSONBodyError.notJSON(data)
    }
    self.storage = object
  }

  /// The body as JSON text. Used when handing an opaque member back to the
  /// store, which keeps bytes.
  public var data: Data {
    (try? JSONBody.data(from: storage)) ?? Data("{}".utf8)
  }

  /// Escape hatch used only where validity was established by construction.
  private init(unchecked storage: Any) {
    self.storage = storage
  }

  /// The graph, for a transport that consumes this representation. Treat it as
  /// read-only: mutating it would break the `Sendable` invariant.
  public var object: Any { storage }

  /// Decodes the body into a concrete type. Fails fast — a body that does not
  /// match the expected shape is an error, not a partially filled value.
  public func decoded<T: Decodable>(as type: T.Type) throws -> T {
    try JSONDecoder().decode(type, from: JSONBody.data(from: storage))
  }

  /// True when the body is an empty object, the spelling of "nothing here".
  public var isEmptyObject: Bool {
    (storage as? [String: Any])?.isEmpty ?? false
  }

  /// Keys of an object body, sorted; empty for any other shape. For display.
  public var objectKeys: [String] {
    (storage as? [String: Any]).map { $0.keys.sorted() } ?? []
  }

  // MARK: - Codable

  public init(from decoder: Decoder) throws {
    self.storage = try JSONBody.decode(from: decoder)
  }

  public func encode(to encoder: Encoder) throws {
    try JSONBody.encode(storage, to: encoder)
  }

  // MARK: - Graph <-> coder

  /// Walks a decoder into a graph. Dynamic keyed/unkeyed containers are the only
  /// way to accept JSON of unknown shape, and `JSONDecoder`'s own scalar decodes
  /// are strict — `true` never decodes as `Int` — which is why the scalar order
  /// below is safe.
  private static func decode(from decoder: Decoder) throws -> Any {
    if let keyed = try? decoder.container(keyedBy: DynamicKey.self) {
      var object: [String: Any] = [:]
      for key in keyed.allKeys {
        object[key.stringValue] = try decode(from: try keyed.superDecoder(forKey: key))
      }
      return object
    }
    if var unkeyed = try? decoder.unkeyedContainer() {
      var array: [Any] = []
      while !unkeyed.isAtEnd {
        array.append(try decode(from: try unkeyed.superDecoder()))
      }
      return array
    }
    let single = try decoder.singleValueContainer()
    if single.decodeNil() { return NSNull() }
    if let value = try? single.decode(Bool.self) { return value }
    if let value = try? single.decode(Int.self) { return value }
    if let value = try? single.decode(Double.self) { return value }
    if let value = try? single.decode(String.self) { return value }
    throw JSONBodyError.unsupportedValue
  }

  private static func encode(_ value: Any, to encoder: Encoder) throws {
    switch value {
    case let object as [String: Any]:
      var keyed = encoder.container(keyedBy: DynamicKey.self)
      for (key, member) in object {
        try keyed.encode(JSONBody(unchecked: member), forKey: DynamicKey(stringValue: key))
      }
    case let array as [Any]:
      var unkeyed = encoder.unkeyedContainer()
      for member in array { try unkeyed.encode(JSONBody(unchecked: member)) }
    case is NSNull:
      var single = encoder.singleValueContainer()
      try single.encodeNil()
    case let number as NSNumber:
      var single = encoder.singleValueContainer()
      // A number in a JSON graph must keep its JSON kind. `as? Bool` alone would
      // accept 1, so ask the CoreFoundation type, then the storage class.
      if CFGetTypeID(number) == CFBooleanGetTypeID() {
        try single.encode(number.boolValue)
      } else if isIntegral(number) {
        try single.encode(number.int64Value)
      } else {
        try single.encode(number.doubleValue)
      }
    case let value as String:
      var single = encoder.singleValueContainer()
      try single.encode(value)
    case let value as Bool:
      var single = encoder.singleValueContainer()
      try single.encode(value)
    case let value as Int:
      var single = encoder.singleValueContainer()
      try single.encode(value)
    case let value as Double:
      var single = encoder.singleValueContainer()
      try single.encode(value)
    default:
      throw JSONBodyError.notJSON(value)
    }
  }

  /// Returns an immutable copy of a validated graph.
  ///
  /// A caller may hand over a `var` dictionary; the round trip through
  /// Foundation replaces every mutable container with its immutable counterpart,
  /// so a later mutation by that caller cannot reach inside this value. The cost
  /// is one pass, paid only on the boundary path that supplies a graph.
  private static func freeze(_ object: Any) -> Any {
    guard
      let data = try? JSONSerialization.data(
        withJSONObject: object, options: [.fragmentsAllowed]),
      let frozen = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    else {
      // Cannot happen for a value that passed validity, but never hand out the
      // caller's graph as a fallback: an empty object is the safe answer.
      return [String: Any]()
    }
    return frozen
  }

  private static func isIntegral(_ number: NSNumber) -> Bool {
    let type = String(cString: number.objCType)
    return !(type == "f" || type == "d")
  }

  private static func data(from storage: Any) throws -> Data {
    try JSONSerialization.data(withJSONObject: storage, options: [.fragmentsAllowed])
  }

  /// Dynamic key for containers whose keys are not known at compile time.
  private struct DynamicKey: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }

    init(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
  }
}

extension JSONBody: Equatable {
  /// Structural equality over the graph. Number spelling is not compared
  /// (`1.0` and `1` are the same JSON number), so this compares canonical JSON.
  public static func == (lhs: JSONBody, rhs: JSONBody) -> Bool {
    guard let left = try? data(from: lhs.storage), let right = try? data(from: rhs.storage) else {
      return false
    }
    guard
      let leftObject = try? JSONSerialization.jsonObject(with: left, options: [.fragmentsAllowed]),
      let rightObject = try? JSONSerialization.jsonObject(with: right, options: [.fragmentsAllowed])
    else { return false }
    let options: JSONSerialization.WritingOptions = [.fragmentsAllowed, .sortedKeys]
    guard
      let leftCanonical = try? JSONSerialization.data(withJSONObject: leftObject, options: options),
      let rightCanonical = try? JSONSerialization.data(
        withJSONObject: rightObject, options: options)
    else { return false }
    return leftCanonical == rightCanonical
  }
}

public enum JSONBodyError: Error, Equatable {
  /// The value is not representable as JSON.
  case notJSON(Any)
  /// A decoded JSON value had a shape no JSON can have.
  case unsupportedValue

  public static func == (lhs: JSONBodyError, rhs: JSONBodyError) -> Bool {
    switch (lhs, rhs) {
    case (.notJSON, .notJSON): return true
    case (.unsupportedValue, .unsupportedValue): return true
    default: return false
    }
  }
}
