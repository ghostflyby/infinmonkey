import Foundation
import Testing

@testable import InfinMonkeyCore

/// The container is the single crossing point for opaque JSON, so its behavior
/// is pinned here: what it preserves, what it normalizes, and what it refuses.
@Suite struct JSONBodyTests {

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

  @Test(
    arguments: [
      #"{"o":{"x":[1,{"y":true}]},"n":null,"s":"hi"}"#,
      #"{"a":[],"b":{},"c":[[]],"d":""}"#,
      #"{"a":{"b":{"c":{"d":[1,[2,[3]]]}}}}"#,
      #"[1,2,3]"#,
      #"true"#,
      #"{"emoji":"🐒","nl":"a\nb","q":"say \"hi\""}"#,
    ]
  )
  func structureSurvivesUnchanged(json: String) throws {
    #expect(
      try canonical(roundTrip(json)) == canonical(json),
      "round trip must preserve structure for \(json)")
  }

  @Test func largeIntegersKeepPrecision() throws {
    // The reason integers are decoded before doubles: as a Double this would
    // come back as 9007199254740992.
    let out = try roundTrip(#"{"big":9007199254740993}"#)
    #expect(out.contains("9007199254740993"), "got \(out)")
  }

  @Test func numberSpellingIsNormalizedNotPreserved() throws {
    // Documented behavior, asserted so it cannot change silently: JSON gives
    // 1 and 1.0 the same meaning, and Foundation normalizes on every path.
    #expect(
      try canonical(roundTrip(#"{"a":1.0,"b":1e3}"#)) == canonical(#"{"a":1,"b":1000}"#))
  }

  @Test func booleansStayBooleans() throws {
    // A boolean must not come back as the number 1: the CoreFoundation type
    // check is what keeps `as? Bool` on an NSNumber from accepting 1.
    let out = try roundTrip(#"{"t":true,"f":false,"n":1}"#)
    let object = try #require(
      try JSONSerialization.jsonObject(with: Data(out.utf8)) as? [String: Any])
    #expect(object["t"] as? Bool == true)
    #expect(object["f"] as? Bool == false)
    #expect((object["n"] as? NSNumber)?.intValue == 1)
    #expect(!((object["n"] as? NSNumber).map { CFGetTypeID($0) == CFBooleanGetTypeID() } ?? true))
  }

  @Test func nestedValuesReachTheStoreIntact() throws {
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

    let values = try #require(wire.values?.object as? [String: Any])
    #expect(values["str"] as? String == "v")
    #expect((values["num"] as? NSNumber)?.intValue == 7)
    #expect((values["arr"] as? [Any])?.count == 3)
    let deep = try #require(
      ((values["obj"] as? [String: Any])?["deep"] as? [String: Any])?["deeper"] as? [Any])
    #expect((deep.first as? NSNumber)?.boolValue == true)
  }

  @Test func opaqueValuesAreNotBase64() throws {
    // Regression: `Data` fields encode as base64 strings, which is why the
    // domain types are not Codable and values travel as a body.
    let body = try JSONBody(data: Data(#"{"k":1}"#.utf8), requiringValidJSON: true)
    let wire = WireEntry(
      full: FullEntry(record: makeRecord(id: "e1", meta: demoMeta()), code: "x", values: body.data))
    let text = try #require(String(data: try JSONEncoder().encode(wire), encoding: .utf8))
    #expect(!text.contains("eyJ"), "values must not be base64: \(text)")
    #expect(text.contains(#""values":{"k":1}"#), "values must be a JSON object: \(text)")
  }

  @Test func emptyObjectDetection() throws {
    #expect(JSONBody.emptyObject.isEmptyObject)
    #expect(JSONBody.emptyObject.objectKeys == [])
    let populated = try JSONBody(data: Data(#"{"b":1,"a":2}"#.utf8), requiringValidJSON: true)
    #expect(!populated.isEmptyObject)
    #expect(populated.objectKeys == ["a", "b"], "keys are sorted for display")
  }

  @Test func malformedJSONIsRejectedWhenValidityIsRequired() {
    #expect(throws: (any Error).self) {
      _ = try JSONBody(data: Data("{ not json".utf8), requiringValidJSON: true)
    }
  }

  @Test func nonJSONValueIsRejected() {
    #expect(throws: (any Error).self) {
      _ = try JSONBody(object: ["d": Date()])
    }
  }

  @Test func callerMutationCannotReachInsideTheBody() throws {
    // Backs the `@unchecked Sendable` claim: the graph is frozen on the way in.
    var source: [String: Any] = ["k": "before"]
    let body = try JSONBody(object: source)
    source["k"] = "after"
    let stored = try #require(body.object as? [String: Any])
    #expect(stored["k"] as? String == "before")
  }

  @Test func equalityComparesStructureNotOrdering() throws {
    let a = try JSONBody(data: Data(#"{"a":1,"b":2}"#.utf8), requiringValidJSON: true)
    let b = try JSONBody(data: Data(#"{"b":2,"a":1}"#.utf8), requiringValidJSON: true)
    #expect(a == b)
  }
}
