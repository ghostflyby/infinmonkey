import Foundation

/// Wire frames exchanged with the extension. Mirrors packages/protocol/src/index.ts.
///
/// ## The conversion path, fixed in one place
///
/// Every transport (Safari's `sendNativeMessage`, a stdio native messaging host,
/// the in-process tests) converges on these two types, and there is exactly one
/// path through them:
///
/// 1. **Envelope** — read as an object graph. A request's `payload` type depends
///    on `type`, so the envelope cannot be decoded before `type` is known, and
///    the two transports *arrive* in different representations (a parsed graph
///    from Safari, JSON text from stdio). Both entry points produce the same
///    `RequestFrame`, and the graph is never serialized just to be re-read.
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

/// One request, with its payload carried opaquely.
public struct RequestFrame: Sendable, Equatable {
  public var v: Int
  public var id: String
  public var type: String
  /// The `payload` member as a JSON body. Decoded into the op's concrete payload
  /// type by the router — the first point that knows which shape to expect.
  public var payload: JSONBody

  public init(v: Int = CoreConstants.protocolVersion, id: String, type: String, payload: JSONBody) {
    self.v = v
    self.id = id
    self.type = type
    self.payload = payload
  }

  /// Builds a frame from a message body: the Safari boundary path, which already
  /// has a parsed graph and no serialization involved.
  public init(body: JSONBody) throws {
    guard let graph = body.object as? [String: Any],
      let v = graph["v"] as? Int,
      let id = graph["id"] as? String,
      let type = graph["type"] as? String
    else {
      throw WireError.malformedEnvelope
    }
    // An op with no arguments may omit `payload` or send `{}`; both mean empty.
    let payload: JSONBody
    if let raw = graph["payload"] {
      payload = try JSONBody(object: raw)
    } else {
      payload = .emptyObject
    }
    self.init(v: v, id: id, type: type, payload: payload)
  }

  /// Builds a frame from JSON text: the stdio host path.
  public init(json data: Data) throws {
    try self.init(body: JSONBody(data: data, requiringValidJSON: true))
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

extension JSONBody {
  /// An opaque member of an object body, for members the native side hands
  /// straight to the store. Returns nil when absent — the member is optional by
  /// contract — and fails loudly when present but not an object, since a
  /// non-object there means the sender and this build disagree about the shape.
  func optionalValues(forKey key: String) throws -> JSONBody? {
    guard let object = object as? [String: Any], let member = object[key] else { return nil }
    guard let memberObject = member as? [String: Any] else {
      throw WireError.malformedEnvelope
    }
    return try JSONBody(object: memberObject)
  }
}

/// Errors raised at the wire boundary, before an operation runs.
public enum WireError: Error, Equatable {
  case malformedEnvelope
  case unsupportedVersion(Int)
  case unknownOp(String)
}

extension WireError: CustomStringConvertible {
  public var description: String {
    switch self {
    case .malformedEnvelope: return "malformed request frame"
    case .unsupportedVersion(let version): return "unsupported protocol version \(version)"
    case .unknownOp(let type): return "unknown op: \(type)"
    }
  }
}
