import Foundation

/// Wire frames exchanged with the extension. Mirrors packages/protocol/src/index.ts.
///
/// The boundary mixes both Foundation paths deliberately: `JSONSerialization`
/// splits the envelope (its shape is fixed and the payload's type depends on
/// `type`, so it cannot be decoded before `type` is known), then `JSONDecoder`
/// builds the concrete payload type. Past that point everything is typed.

/// One decoded request.
public struct RequestFrame: Sendable, Equatable {
  public var v: Int
  public var id: String
  public var type: String
  /// The `payload` object, still as JSON. Decoded into the op's concrete type
  /// by the router, which is the first point that knows what shape to expect.
  public var payload: Data

  public init(v: Int = CoreConstants.protocolVersion, id: String, type: String, payload: Data) {
    self.v = v
    self.id = id
    self.type = type
    self.payload = payload
  }
}

extension RequestFrame {
  /// Decodes a request from its JSON bytes. Throws when the envelope itself is
  /// wrong — the caller turns that into a `badRequest` response.
  public init(json data: Data) throws {
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      let v = object["v"] as? Int,
      let id = object["id"] as? String,
      let type = object["type"] as? String
    else {
      throw WireError.malformedEnvelope
    }
    let payload = object["payload"] ?? [String: Any]()
    guard JSONSerialization.isValidJSONObject(payload) else {
      throw WireError.malformedEnvelope
    }
    self.init(
      v: v, id: id, type: type,
      payload: try JSONSerialization.data(withJSONObject: payload))
  }
}

/// One response. `result` carries the op's concrete result as JSON when `ok`,
/// and `error` is set when it is not.
public struct ResponseFrame: Sendable, Equatable {
  public var v: Int
  public var id: String
  public var ok: Bool
  public var result: Data?
  public var error: ErrorBody?

  public struct ErrorBody: Sendable, Equatable {
    public var code: String
    public var message: String

    public init(code: String, message: String) {
      self.code = code
      self.message = message
    }
  }

  public init(id: String, result: Data) {
    self.v = CoreConstants.protocolVersion
    self.id = id
    self.ok = true
    self.result = result
    self.error = nil
  }

  public init(id: String, code: String, message: String) {
    self.v = CoreConstants.protocolVersion
    self.id = id
    self.ok = false
    self.result = nil
    self.error = ErrorBody(code: code, message: message)
  }

  /// Serialized form, ready for the transport.
  public func jsonData() -> Data {
    var object: [String: Any] = ["v": v, "id": id, "ok": ok]
    if ok, let result,
      let decoded = try? JSONSerialization.jsonObject(with: result)
    {
      object["result"] = decoded
    }
    if let error {
      object["error"] = ["code": error.code, "message": error.message]
    }
    guard JSONSerialization.isValidJSONObject(object),
      let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    else {
      return Data(#"{"v":1,"id":"unknown","ok":false}"#.utf8)
    }
    return data
  }

  /// A form the Safari app extension boundary can place in `userInfo`.
  public func dictionary() -> [String: Any] {
    (try? JSONSerialization.jsonObject(with: jsonData())) as? [String: Any] ?? ["ok": false]
  }
}

/// Errors raised at the wire boundary, before the operation runs.
public enum WireError: Error, Equatable {
  case malformedEnvelope
  case unsupportedVersion(Int)
  case unknownOp(String)
}
