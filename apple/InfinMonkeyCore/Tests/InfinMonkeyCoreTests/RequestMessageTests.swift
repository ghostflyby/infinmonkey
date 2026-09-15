import Foundation
import Testing

@testable import InfinMonkeyCore

/// Decoding of the request envelope: the discriminator, the absent/`null`
/// payload tolerance, the split between `WireError` (unknown op) and
/// `DecodingError` (wrong payload shape), and the opaque `values` member.
@Suite struct RequestMessageTests {

  @Test func decodesOpAndPayload() throws {
    let data = Data(#"{"v":1,"id":"r1","type":"getValues","payload":{"id":"e1"}}"#.utf8)
    let message = try JSONDecoder().decode(RequestMessage.self, from: data)
    #expect(message.v == 1)
    #expect(message.id == "r1")
    guard case .getValues(let payload) = message.op else {
      Issue.record("expected getValues, got \(String(describing: message.op))")
      return
    }
    #expect(payload.id == "e1")
  }

  @Test func absentOrNullPayloadMeansEmpty() throws {
    let absent = try JSONDecoder().decode(
      RequestMessage.self,
      from: Data(#"{"v":1,"id":"r1","type":"hello"}"#.utf8))
    guard case .hello(let hello) = absent.op else {
      Issue.record("expected hello, got \(String(describing: absent.op))")
      return
    }
    #expect(hello.sinceRev == nil)

    let null = try JSONDecoder().decode(
      RequestMessage.self,
      from: Data(#"{"v":1,"id":"r1","type":"hello","payload":null}"#.utf8))
    guard case .hello = null.op else {
      Issue.record("expected hello, got \(String(describing: null.op))")
      return
    }
  }

  @Test func unknownOpThrowsWireErrorNotDecodingError() {
    // The split matters: the router reports WireError as `unsupported` and a
    // DecodingError as `badRequest`.
    #expect(throws: WireError.unknownOp("teleport")) {
      _ = try JSONDecoder().decode(
        RequestMessage.self,
        from: Data(#"{"v":1,"id":"r1","type":"teleport"}"#.utf8))
    }
  }

  @Test func wrongPayloadShapeThrowsDecodingError() {
    // `sinceRev` must be a number; a string fails the payload, not the envelope.
    #expect(throws: DecodingError.self) {
      _ = try JSONDecoder().decode(
        RequestMessage.self,
        from: Data(#"{"v":1,"id":"r1","type":"getChanges","payload":{"sinceRev":"x"}}"#.utf8))
    }
  }

  @Test func createEntryCarriesOpaqueValues() throws {
    let data = Data(
      #"{"v":1,"id":"r1","type":"createEntry","payload":{"kind":"script","code":"x","values":{"token":"abc","nested":[1,2]}}}"#
        .utf8)
    let message = try JSONDecoder().decode(RequestMessage.self, from: data)
    guard case .createEntry(let payload) = message.op else {
      Issue.record("expected createEntry, got \(String(describing: message.op))")
      return
    }
    #expect(payload.kind == .script)
    let values = try #require(payload.values)
    #expect(
      try JSONSerialization.jsonObject(with: values.data) as? NSDictionary
        == ["token": "abc", "nested": [1, 2]] as NSDictionary)
  }

  @Test func roundTripThroughCodable() throws {
    let message = RequestMessage(
      id: "r1",
      op: .setEnabled(WirePayload.SetEnabled(id: "e1", enabled: false)))
    let decoded = try JSONDecoder().decode(
      RequestMessage.self, from: try JSONEncoder().encode(message))
    #expect(decoded.v == CoreConstants.protocolVersion)
    #expect(decoded.id == "r1")
    guard case .setEnabled(let payload) = decoded.op else {
      Issue.record("expected setEnabled, got \(String(describing: decoded.op))")
      return
    }
    #expect(payload.id == "e1")
    #expect(!payload.enabled)
  }

  @Test func roundTripOfArgumentlessOpWritesEmptyPayload() throws {
    let data = try JSONEncoder().encode(RequestMessage(id: "r1", op: .ping))
    let graph = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    #expect(graph["type"] as? String == "ping")
    #expect(graph["payload"] != nil, "argumentless ops mirror the extension's `{}` payload")
    let decoded = try JSONDecoder().decode(RequestMessage.self, from: data)
    guard case .ping = decoded.op else {
      Issue.record("expected ping, got \(String(describing: decoded.op))")
      return
    }
  }
}
