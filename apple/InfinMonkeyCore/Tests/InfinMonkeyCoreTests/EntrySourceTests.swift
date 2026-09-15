import XCTest

@testable import InfinMonkeyCore

/// `EntrySource` is a cross-language contract, so its wire shape is pinned here.
///
/// The exact JSON matters: the TypeScript side narrows on `source.type`, and the
/// planned Windows side maps it with `System.Text.Json` polymorphism. Both expect
/// an *internally tagged* union — the discriminator beside the payload — which is
/// not what Swift's synthesized enum coding emits.
final class EntrySourceTests: XCTestCase {

  private func encoded<T: Encodable>(_ value: T) throws -> [String: Any] {
    let data = try JSONEncoder().encode(value)
    return try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  private func decoded(_ json: String) throws -> EntrySource {
    try JSONDecoder().decode(EntrySource.self, from: Data(json.utf8))
  }

  func testInlineEncodesAsBareDiscriminator() throws {
    let object = try encoded(EntrySource.inline)
    XCTAssertEqual(object.keys.sorted(), ["type"])
    XCTAssertEqual(object["type"] as? String, "inline")
  }

  func testDevPayloadMembersAreSiblingsOfTheDiscriminator() throws {
    // The whole point: no wrapper object around the payload. A `{"dev":{…}}`
    // shape here means someone let synthesis take over.
    let object = try encoded(EntrySource.dev(.init(url: "u", autoReload: true)))
    XCTAssertEqual(object.keys.sorted(), ["autoReload", "type", "url"])
    XCTAssertEqual(object["type"] as? String, "dev")
    XCTAssertEqual(object["url"] as? String, "u")
    XCTAssertEqual(object["autoReload"] as? Bool, true)
  }

  func testDecodesBothCasesFromTheWireForm() throws {
    XCTAssertEqual(try decoded(#"{"type":"inline"}"#), .inline)
    XCTAssertEqual(
      try decoded(#"{"type":"dev","url":"u","autoReload":true}"#),
      .dev(.init(url: "u", autoReload: true)))
  }

  func testRoundTripIsStable() throws {
    for source in [EntrySource.inline, .dev(.init(url: "https://x/y", autoReload: false))] {
      let data = try JSONEncoder().encode(source)
      XCTAssertEqual(try JSONDecoder().decode(EntrySource.self, from: data), source)
    }
  }

  func testUnknownDiscriminatorIsRejected() throws {
    // A sender inventing a source kind expects behavior we do not have; silently
    // treating it as something else would misplace the entry's code.
    let json = #"{"type":"bundled","url":"u"}"#
    do {
      _ = try decoded(json)
      XCTFail("expected an unknown discriminator to be rejected")
    } catch let error as DecodingError {
      guard case .dataCorrupted(let context) = error else {
        return XCTFail("unexpected decoding error: \(error)")
      }
      XCTAssertTrue(context.debugDescription.contains("discriminator"))
    }
  }

  func testMissingDiscriminatorIsRejected() throws {
    XCTAssertThrowsError(try decoded(#"{"url":"u"}"#))
  }

  func testMissingDevMemberIsRejected() throws {
    // `autoReload` is required by the TypeScript type and every sender provides
    // it, so an absent one is a contract violation rather than a false default.
    XCTAssertThrowsError(try decoded(#"{"type":"dev","url":"u"}"#))
    XCTAssertThrowsError(try decoded(#"{"type":"dev","autoReload":true}"#))
  }

  func testWronglyTypedMemberIsRejected() throws {
    XCTAssertThrowsError(try decoded(#"{"type":"dev","url":1,"autoReload":true}"#))
    XCTAssertThrowsError(try decoded(#"{"type":"dev","url":"u","autoReload":"yes"}"#))
  }

  func testIgnoresMembersItDoesNotModel() throws {
    // Forward compatibility: a newer extension may add members to a payload, and
    // that must not fail the request.
    let source = try decoded(#"{"type":"dev","url":"u","autoReload":true,"futureMember":9}"#)
    XCTAssertEqual(source, .dev(.init(url: "u", autoReload: true)))
  }

  func testSharedFixtureSourceDecodes() throws {
    // Pins the shape against the same fixture the TypeScript tests read.
    let object = try JSONSerialization.jsonObject(
      with: try Data(contentsOf: try fixtureURL("request-createEntry.json")))
    let payload = try XCTUnwrap((object as? [String: Any])?["payload"] as? [String: Any])
    let source = try XCTUnwrap(payload["source"])

    let reencoded = try JSONEncoder().encode(
      JSONDecoder().decode(
        EntrySource.self, from: try JSONSerialization.data(withJSONObject: source)))
    let decodedBack = try JSONDecoder().decode(EntrySource.self, from: reencoded)
    XCTAssertEqual(decodedBack, .inline)
  }

  func testSourceSurvivesAWholeEntryRoundTrip() throws {
    // The union sits inside a larger structure that is also hand-coded, so this
    // checks the two compose rather than only testing in isolation.
    let entry = FullEntry(
      record: makeRecord(
        id: "e1", meta: demoMeta(), source: .dev(.init(url: "https://dev/x", autoReload: true))),
      code: "x",
      values: nil)

    let data = try JSONEncoder().encode(WireEntry(full: entry))
    let back = try JSONDecoder().decode(WireEntry.self, from: data)
    XCTAssertEqual(back.source, .dev(.init(url: "https://dev/x", autoReload: true)))
  }
}
