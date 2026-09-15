import XCTest

@testable import InfinMonkeyCore

/// Decoding of the request envelope: the discriminator, the absent/`null`
/// payload tolerance, the split between `WireError` (unknown op) and
/// `DecodingError` (wrong payload shape), and the opaque `values` member.
final class RequestMessageTests: XCTestCase {

  func testDecodesOpAndPayload() throws {
    let data = Data(#"{"v":1,"id":"r1","type":"getValues","payload":{"id":"e1"}}"#.utf8)
    let message = try JSONDecoder().decode(RequestMessage.self, from: data)
    XCTAssertEqual(message.v, 1)
    XCTAssertEqual(message.id, "r1")
    guard case .getValues(let payload) = message.op else {
      return XCTFail("expected getValues, got \(message.op)")
    }
    XCTAssertEqual(payload.id, "e1")
  }

  func testAbsentOrNullPayloadMeansEmpty() throws {
    let absent = try JSONDecoder().decode(
      RequestMessage.self,
      from: Data(#"{"v":1,"id":"r1","type":"hello"}"#.utf8))
    guard case .hello(let hello) = absent.op else {
      return XCTFail("expected hello, got \(absent.op)")
    }
    XCTAssertNil(hello.sinceRev)

    let null = try JSONDecoder().decode(
      RequestMessage.self,
      from: Data(#"{"v":1,"id":"r1","type":"hello","payload":null}"#.utf8))
    guard case .hello = null.op else {
      return XCTFail("expected hello, got \(null.op)")
    }
  }

  func testUnknownOpThrowsWireErrorNotDecodingError() {
    // The split matters: the router reports WireError as `unsupported` and a
    // DecodingError as `badRequest`.
    XCTAssertThrowsError(
      try JSONDecoder().decode(
        RequestMessage.self,
        from: Data(#"{"v":1,"id":"r1","type":"teleport"}"#.utf8))
    ) { error in
      guard let wireError = error as? WireError else {
        return XCTFail("expected WireError, got \(error)")
      }
      XCTAssertEqual(wireError, .unknownOp("teleport"))
    }
  }

  func testWrongPayloadShapeThrowsDecodingError() {
    // `sinceRev` must be a number; a string fails the payload, not the envelope.
    XCTAssertThrowsError(
      try JSONDecoder().decode(
        RequestMessage.self,
        from: Data(
          #"{"v":1,"id":"r1","type":"getChanges","payload":{"sinceRev":"x"}}"#.utf8))
    ) { error in
      XCTAssertTrue(error is DecodingError, "expected DecodingError, got \(error)")
    }
  }

  func testCreateEntryCarriesOpaqueValues() throws {
    let data = Data(
      #"{"v":1,"id":"r1","type":"createEntry","payload":{"kind":"script","code":"x","values":{"token":"abc","nested":[1,2]}}}"#
        .utf8)
    let message = try JSONDecoder().decode(RequestMessage.self, from: data)
    guard case .createEntry(let payload) = message.op else {
      return XCTFail("expected createEntry, got \(message.op)")
    }
    XCTAssertEqual(payload.kind, .script)
    let values = try XCTUnwrap(payload.values)
    XCTAssertEqual(
      try JSONSerialization.jsonObject(with: values.data) as? NSDictionary,
      ["token": "abc", "nested": [1, 2]] as NSDictionary)
  }

  func testRoundTripThroughCodable() throws {
    let message = RequestMessage(
      id: "r1",
      op: .setEnabled(WirePayload.SetEnabled(id: "e1", enabled: false)))
    let decoded = try JSONDecoder().decode(
      RequestMessage.self, from: try JSONEncoder().encode(message))
    XCTAssertEqual(decoded.v, CoreConstants.protocolVersion)
    XCTAssertEqual(decoded.id, "r1")
    guard case .setEnabled(let payload) = decoded.op else {
      return XCTFail("expected setEnabled, got \(decoded.op)")
    }
    XCTAssertEqual(payload.id, "e1")
    XCTAssertFalse(payload.enabled)
  }

  func testRoundTripOfArgumentlessOpWritesEmptyPayload() throws {
    let data = try JSONEncoder().encode(RequestMessage(id: "r1", op: .ping))
    let graph = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(graph["type"] as? String, "ping")
    XCTAssertNotNil(graph["payload"], "argumentless ops mirror the extension's `{}` payload")
    let decoded = try JSONDecoder().decode(RequestMessage.self, from: data)
    guard case .ping = decoded.op else {
      return XCTFail("expected ping, got \(decoded.op)")
    }
  }
}
