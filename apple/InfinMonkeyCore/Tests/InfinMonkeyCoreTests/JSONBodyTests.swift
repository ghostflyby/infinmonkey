import XCTest

@testable import InfinMonkeyCore

/// The container is the single crossing point for opaque JSON, so its behavior
/// is pinned here: what it preserves, what it normalizes, and what it refuses.
final class JSONBodyTests: XCTestCase {

  private func roundTrip(_ json: String) throws -> String {
    let body = try JSONBody(data: Data(json.utf8), requiringValidJSON: true)
    let reencoded = try JSONEncoder().encode(body)
    return String(data: reencoded, encoding: .utf8) ?? ""
  }

  private func canonical(_ json: String) throws -> String {
    let object = try JSONSerialization.jsonObject(
      with: Data(json.utf8), options: [.fragmentsAllowed])
    let data = try JSONSerialization.data(
      withJSONObject: object, options: [.fragmentsAllowed, .sortedKeys])
    return String(data: data, encoding: .utf8) ?? ""
  }

  func testStructureSurvivesUnchanged() throws {
    let cases = [
      #"{"o":{"x":[1,{"y":true}]},"n":null,"s":"hi"}"#,
      #"{"a":[],"b":{},"c":[[]],"d":""}"#,
      #"{"a":{"b":{"c":{"d":[1,[2,[3]]]}}}}"#,
      #"[1,2,3]"#,
      #"true"#,
      #"{"emoji":"🐒","nl":"a\nb","q":"say \"hi\""}"#,
    ]
    for json in cases {
      XCTAssertEqual(
        try canonical(roundTrip(json)), try canonical(json),
        "round trip must preserve structure for \(json)")
    }
  }

  func testLargeIntegersKeepPrecision() throws {
    // The reason integers are decoded before doubles: as a Double this would
    // come back as 9007199254740992.
    let out = try roundTrip(#"{"big":9007199254740993}"#)
    XCTAssertTrue(out.contains("9007199254740993"), "got \(out)")
  }

  func testNumberSpellingIsNormalizedNotPreserved() throws {
    // Documented behavior, asserted so it cannot change silently: JSON gives
    // 1 and 1.0 the same meaning, and Foundation normalizes on every path.
    XCTAssertEqual(
      try canonical(roundTrip(#"{"a":1.0,"b":1e3}"#)), try canonical(#"{"a":1,"b":1000}"#))
  }

  func testBooleansStayBooleans() throws {
    // A boolean must not come back as the number 1: the CoreFoundation type
    // check is what keeps `as? Bool` on an NSNumber from accepting 1.
    let out = try roundTrip(#"{"t":true,"f":false,"n":1}"#)
    let object = try XCTUnwrap(
      try JSONSerialization.jsonObject(with: Data(out.utf8)) as? [String: Any])
    XCTAssertTrue(object["t"] as? Bool == true)
    XCTAssertTrue(object["f"] as? Bool == false)
    XCTAssertEqual((object["n"] as? NSNumber)?.intValue, 1)
    XCTAssertFalse(
      (object["n"] as? NSNumber).map { CFGetTypeID($0) == CFBooleanGetTypeID() } ?? true)
  }

  func testNestedValuesReachTheStoreIntact() throws {
    // The whole point of the container: an opaque payload of unknown shape must
    // survive a wire round trip member for member.
    let json = #"{"str":"v","num":7,"arr":[1,"two",null],"obj":{"deep":{"deeper":[true]}}}"#
    let body = try JSONBody(data: Data(json.utf8), requiringValidJSON: true)
    let wire = try JSONDecoder().decode(
      WireEntry.self,
      from: JSONEncoder().encode(
        WireEntry(
          full: FullEntry(
            record: makeRecord(id: "e1", meta: demoMeta()), code: "x", values: body.data))))

    let values = try XCTUnwrap(wire.values?.object as? [String: Any])
    XCTAssertEqual(values["str"] as? String, "v")
    XCTAssertEqual((values["num"] as? NSNumber)?.intValue, 7)
    XCTAssertEqual((values["arr"] as? [Any])?.count, 3)
    let deep = try XCTUnwrap(
      ((values["obj"] as? [String: Any])?["deep"] as? [String: Any])?["deeper"] as? [Any])
    XCTAssertEqual((deep.first as? NSNumber)?.boolValue, true)
  }

  func testOpaqueValuesAreNotBase64() throws {
    // Regression: `Data` fields encode as base64 strings, which is why the
    // domain types are not Codable and values travel as a body.
    let body = try JSONBody(data: Data(#"{"k":1}"#.utf8), requiringValidJSON: true)
    let wire = WireEntry(
      full: FullEntry(record: makeRecord(id: "e1", meta: demoMeta()), code: "x", values: body.data))
    let text = try XCTUnwrap(String(data: try JSONEncoder().encode(wire), encoding: .utf8))
    XCTAssertFalse(text.contains("eyJ"), "values must not be base64: \(text)")
    XCTAssertTrue(text.contains(#""values":{"k":1}"#), "values must be a JSON object: \(text)")
  }

  func testEmptyObjectDetection() throws {
    XCTAssertTrue(JSONBody.emptyObject.isEmptyObject)
    XCTAssertEqual(JSONBody.emptyObject.objectKeys, [])
    let populated = try JSONBody(data: Data(#"{"b":1,"a":2}"#.utf8), requiringValidJSON: true)
    XCTAssertFalse(populated.isEmptyObject)
    XCTAssertEqual(populated.objectKeys, ["a", "b"], "keys are sorted for display")
  }

  func testMalformedJSONIsRejectedWhenValidityIsRequired() {
    XCTAssertThrowsError(try JSONBody(data: Data("{ not json".utf8), requiringValidJSON: true))
  }

  func testNonJSONValueIsRejected() {
    XCTAssertThrowsError(try JSONBody(object: ["d": Date()]))
  }

  func testCallerMutationCannotReachInsideTheBody() throws {
    // Backs the `@unchecked Sendable` claim: the graph is frozen on the way in.
    var source: [String: Any] = ["k": "before"]
    let body = try JSONBody(object: source)
    source["k"] = "after"
    let stored = try XCTUnwrap(body.object as? [String: Any])
    XCTAssertEqual(stored["k"] as? String, "before")
  }

  func testEqualityComparesStructureNotOrdering() throws {
    let a = try JSONBody(data: Data(#"{"a":1,"b":2}"#.utf8), requiringValidJSON: true)
    let b = try JSONBody(data: Data(#"{"b":2,"a":1}"#.utf8), requiringValidJSON: true)
    XCTAssertEqual(a, b)
  }
}
