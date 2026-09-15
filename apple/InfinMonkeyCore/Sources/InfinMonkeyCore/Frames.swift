import Foundation

/// Wire frames exchanged with the extension. Mirrors packages/protocol/src/index.ts.
///
/// ## The conversion path, fixed in one place
///
/// Every transport (Safari's `sendNativeMessage`, a stdio native messaging host,
/// the in-process tests) converges on these two types, and there is exactly one
/// path through them:
///
/// 1. **Envelope** — `RequestMessage` is `Codable` like the payloads, so a
///    frame decodes in one pass into `v`, `id`, and the operation with its
///    payload already materialized. The transports arrive in different
///    representations (a parsed graph from Safari, JSON text from stdio); both
///    first become a `JSONBody`, and the body decodes as a whole.
/// 2. **Payload and result** — `Codable`, compiler-written, failing fast. The
///    slot is typed when the native side must reason about it, and a `JSONBody`
///    when it must not.
/// 3. **Opaque members** (`values`) — `JSONBody`, which holds the graph itself.
///
/// Nothing below this layer sees `[String: Any]`; `Any` appears only inside
/// `JSONBody`.
///
/// ## Shape
/// ```
/// request  { v, id, type, payload }
/// response { v, id, ok: true, result } | { v, id, ok: false, error: { code, message } }
/// ```

/// One request frame, decoded in one step: `v`, `id`, and the operation with
/// its payload already materialized. The wire discriminator is the `type`
/// string; `payload` is a nested object whose shape the op decides.
struct RequestMessage: Codable, Sendable {
  public var v: Int
  public var id: String
  public var op: Operation

  /// One operation, carrying its payload. Exhaustive by construction: adding an
  /// op to the wire without a case here (or a case without wire handling) fails
  /// to compile.
  enum Operation: Sendable {
    case ping
    case hello(WirePayload.Hello)
    case listEntries
    case getChanges(WirePayload.SinceRev)
    case createEntry(WirePayload.CreateEntry)
    case updateCode(WirePayload.UpdateCode)
    case updateMeta(WirePayload.UpdateMeta)
    case setEnabled(WirePayload.SetEnabled)
    case putEntry(WirePayload.PutEntry)
    case reorderEntries(WirePayload.Reorder)
    case deleteEntry(WirePayload.Id)
    case getValues(WirePayload.Id)
    case exportAll
    case importAll(WirePayload.ImportAll)
  }

  /// The `type` discriminators, in wire spelling.
  private enum OpType: String {
    case ping, hello, listEntries, getChanges, createEntry, updateCode, updateMeta
    case setEnabled, putEntry, reorderEntries, deleteEntry, getValues, exportAll, importAll
  }

  init(v: Int = CoreConstants.protocolVersion, id: String, op: Operation) {
    self.v = v
    self.id = id
    self.op = op
  }

  private enum CodingKeys: String, CodingKey {
    case v, id, type, payload
  }

  /// Decodes the frame in one pass. A payload struct is read from the nested
  /// `payload` object; an absent or `null` payload means `{}`, matching what
  /// the extension sends for ops without arguments. An unknown `type` throws
  /// `WireError` — a wire-level fault the router reports as `unsupported` —
  /// while a payload that does not match its op's shape throws `DecodingError`,
  /// reported as `badRequest`.
  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    self.v = try container.decode(Int.self, forKey: .v)
    self.id = try container.decode(String.self, forKey: .id)
    let type = try container.decode(String.self, forKey: .type)
    switch type {
    case OpType.ping.rawValue: op = .ping
    case OpType.hello.rawValue:
      op = .hello(try Self.payload(WirePayload.Hello.self, in: container))
    case OpType.listEntries.rawValue: op = .listEntries
    case OpType.getChanges.rawValue:
      op = .getChanges(try Self.payload(WirePayload.SinceRev.self, in: container))
    case OpType.createEntry.rawValue:
      op = .createEntry(try Self.payload(WirePayload.CreateEntry.self, in: container))
    case OpType.updateCode.rawValue:
      op = .updateCode(try Self.payload(WirePayload.UpdateCode.self, in: container))
    case OpType.updateMeta.rawValue:
      op = .updateMeta(try Self.payload(WirePayload.UpdateMeta.self, in: container))
    case OpType.setEnabled.rawValue:
      op = .setEnabled(try Self.payload(WirePayload.SetEnabled.self, in: container))
    case OpType.putEntry.rawValue:
      op = .putEntry(try Self.payload(WirePayload.PutEntry.self, in: container))
    case OpType.reorderEntries.rawValue:
      op = .reorderEntries(try Self.payload(WirePayload.Reorder.self, in: container))
    case OpType.deleteEntry.rawValue:
      op = .deleteEntry(try Self.payload(WirePayload.Id.self, in: container))
    case OpType.getValues.rawValue:
      op = .getValues(try Self.payload(WirePayload.Id.self, in: container))
    case OpType.exportAll.rawValue: op = .exportAll
    case OpType.importAll.rawValue:
      op = .importAll(try Self.payload(WirePayload.ImportAll.self, in: container))
    default:
      throw WireError.unknownOp(type)
    }
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(v, forKey: .v)
    try container.encode(id, forKey: .id)
    switch op {
    case .ping:
      try container.encode(OpType.ping.rawValue, forKey: .type)
      try container.encode(JSONBody.emptyObject, forKey: .payload)
    case .hello(let payload):
      try container.encode(OpType.hello.rawValue, forKey: .type)
      try container.encode(payload, forKey: .payload)
    case .listEntries:
      try container.encode(OpType.listEntries.rawValue, forKey: .type)
      try container.encode(JSONBody.emptyObject, forKey: .payload)
    case .getChanges(let payload):
      try container.encode(OpType.getChanges.rawValue, forKey: .type)
      try container.encode(payload, forKey: .payload)
    case .createEntry(let payload):
      try container.encode(OpType.createEntry.rawValue, forKey: .type)
      try container.encode(payload, forKey: .payload)
    case .updateCode(let payload):
      try container.encode(OpType.updateCode.rawValue, forKey: .type)
      try container.encode(payload, forKey: .payload)
    case .updateMeta(let payload):
      try container.encode(OpType.updateMeta.rawValue, forKey: .type)
      try container.encode(payload, forKey: .payload)
    case .setEnabled(let payload):
      try container.encode(OpType.setEnabled.rawValue, forKey: .type)
      try container.encode(payload, forKey: .payload)
    case .putEntry(let payload):
      try container.encode(OpType.putEntry.rawValue, forKey: .type)
      try container.encode(payload, forKey: .payload)
    case .reorderEntries(let payload):
      try container.encode(OpType.reorderEntries.rawValue, forKey: .type)
      try container.encode(payload, forKey: .payload)
    case .deleteEntry(let payload):
      try container.encode(OpType.deleteEntry.rawValue, forKey: .type)
      try container.encode(payload, forKey: .payload)
    case .getValues(let payload):
      try container.encode(OpType.getValues.rawValue, forKey: .type)
      try container.encode(payload, forKey: .payload)
    case .exportAll:
      try container.encode(OpType.exportAll.rawValue, forKey: .type)
      try container.encode(JSONBody.emptyObject, forKey: .payload)
    case .importAll(let payload):
      try container.encode(OpType.importAll.rawValue, forKey: .type)
      try container.encode(payload, forKey: .payload)
    }
  }

  /// Decodes a payload struct, treating an absent or `null` payload as `{}`.
  private static func payload<T: Decodable>(
    _ type: T.Type, in container: KeyedDecodingContainer<CodingKeys>
  ) throws -> T {
    if container.contains(.payload), !(try container.decodeNil(forKey: .payload)) {
      return try container.decode(T.self, forKey: .payload)
    }
    return try JSONDecoder().decode(type, from: Data("{}".utf8))
  }
}

/// One response: a typed result when `ok`, otherwise an error the extension
/// branches on by `code`.
///
/// `Codable` like the payloads, so a typed result rides inside the envelope
/// without hand-assembly.
public struct ResponseFrame: Codable, Sendable, Equatable {
  public var v: Int
  public var id: String
  public var ok: Bool
  public var result: JSONBody?
  public var error: ErrorBody?

  public struct ErrorBody: Codable, Sendable, Equatable {
    public var code: String
    public var message: String

    public init(code: String, message: String) {
      self.code = code
      self.message = message
    }
  }

  /// A successful response carrying a typed result.
  public static func success(id: String, result: some Encodable) throws -> ResponseFrame {
    ResponseFrame(
      v: CoreConstants.protocolVersion,
      id: id,
      ok: true,
      result: try JSONBody(encoding: result),
      error: nil)
  }

  public static func failure(id: String, code: String, message: String) -> ResponseFrame {
    ResponseFrame(
      v: CoreConstants.protocolVersion,
      id: id,
      ok: false,
      result: nil,
      error: ErrorBody(code: code, message: message))
  }

  /// An empty response, for an op with nothing to return.
  public static func ack(id: String) -> ResponseFrame {
    ResponseFrame(
      v: CoreConstants.protocolVersion,
      id: id,
      ok: true,
      result: .emptyObject,
      error: nil)
  }

  /// Serialized form, ready for a text transport.
  public func jsonData() -> Data {
    (try? JSONEncoder().encode(self)) ?? Data(#"{"v":1,"id":"unknown","ok":false}"#.utf8)
  }

  /// The response as a message body, for a transport that speaks parsed JSON.
  /// This is what crosses out of the router: `JSONBody` is `Sendable`, whereas
  /// the graph is not.
  public func body() -> JSONBody {
    (try? JSONBody(encoding: self)) ?? .emptyObject
  }
}

/// Errors raised at the wire boundary, before an operation runs.
public enum WireError: Error, Equatable {
  /// The frame's `type` names no op this build knows.
  case unknownOp(String)
}

extension WireError: CustomStringConvertible {
  public var description: String {
    switch self {
    case .unknownOp(let type): return "unknown op: \(type)"
    }
  }
}
