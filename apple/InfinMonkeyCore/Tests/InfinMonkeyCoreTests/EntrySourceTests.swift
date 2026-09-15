import Foundation
import Testing

@testable import InfinMonkeyCore

/// `EntrySource` is a cross-language contract, so its wire shape is pinned here.
///
/// The exact JSON matters: the TypeScript side narrows on `source.type`, and the
/// planned Windows side maps it with `System.Text.Json` polymorphism. Both expect
/// an *internally tagged* union — the discriminator beside the payload — which is
/// not what Swift's synthesized enum coding emits.
@Suite struct EntrySourceTests {

  private func encoded<T: Encodable>(_ value: T) throws -> [String: Any] {
    let data = try JSONEncoder().encode(value)
    return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  private func decoded(_ json: String) throws -> EntrySource {
    try JSONDecoder().decode(EntrySource.self, from: Data(json.utf8))
  }

  @Test func inlineEncodesAsBareDiscriminator() throws {
    let object = try encoded(EntrySource.inline)
    #expect(object.keys.sorted() == ["type"])
    #expect(object["type"] as? String == "inline")
  }

  @Test func devPayloadMembersAreSiblingsOfTheDiscriminator() throws {
    // The whole point: no wrapper object around the payload. A `{"dev":{…}}`
    // shape here means someone let synthesis take over.
    let object = try encoded(EntrySource.dev(.init(url: "u", autoReload: true)))
    #expect(object.keys.sorted() == ["autoReload", "type", "url"])
    #expect(object["type"] as? String == "dev")
    #expect(object["url"] as? String == "u")
    #expect(object["autoReload"] as? Bool == true)
  }

  @Test func decodesBothCasesFromTheWireForm() throws {
    #expect(try decoded(#"{"type":"inline"}"#) == .inline)
    #expect(
      try decoded(#"{"type":"dev","url":"u","autoReload":true}"#)
        == .dev(.init(url: "u", autoReload: true)))
  }

  @Test(arguments: [EntrySource.inline, .dev(.init(url: "https://x/y", autoReload: false))])
  func roundTripIsStable(source: EntrySource) throws {
    let data = try JSONEncoder().encode(source)
    #expect(try JSONDecoder().decode(EntrySource.self, from: data) == source)
  }

  @Test func unknownDiscriminatorIsRejected() throws {
    // A sender inventing a source kind expects behavior we do not have; silently
    // treating it as something else would misplace the entry's code.
    let json = #"{"type":"bundled","url":"u"}"#
    #expect {
      _ = try decoded(json)
    } throws: { error in
      guard let decodingError = error as? DecodingError,
        case .dataCorrupted(let context) = decodingError
      else { return false }
      return context.debugDescription.contains("discriminator")
    }
  }

  @Test func missingDiscriminatorIsRejected() throws {
    #expect(throws: DecodingError.self) {
      _ = try decoded(#"{"url":"u"}"#)
    }
  }

  @Test func missingDevMemberIsRejected() throws {
    // `autoReload` is required by the TypeScript type and every sender provides
    // it, so an absent one is a contract violation rather than a false default.
    #expect(throws: DecodingError.self) { _ = try decoded(#"{"type":"dev","url":"u"}"#) }
    #expect(throws: DecodingError.self) { _ = try decoded(#"{"type":"dev","autoReload":true}"#) }
  }

  @Test func wronglyTypedMemberIsRejected() throws {
    #expect(throws: DecodingError.self) {
      _ = try decoded(#"{"type":"dev","url":1,"autoReload":true}"#)
    }
    #expect(throws: DecodingError.self) {
      _ = try decoded(#"{"type":"dev","url":"u","autoReload":"yes"}"#)
    }
  }

  @Test func ignoresMembersItDoesNotModel() throws {
    // Forward compatibility: a newer extension may add members to a payload, and
    // that must not fail the request.
    let source = try decoded(#"{"type":"dev","url":"u","autoReload":true,"futureMember":9}"#)
    #expect(source == .dev(.init(url: "u", autoReload: true)))
  }

  @Test func sharedFixtureSourceDecodes() throws {
    // Pins the shape against the same fixture the TypeScript tests read.
    let object = try JSONSerialization.jsonObject(
      with: try Data(contentsOf: try fixtureURL("request-createEntry.json")))
    let payload = try #require((object as? [String: Any])?["payload"] as? [String: Any])
    let source = try #require(payload["source"])

    let reencoded = try JSONEncoder().encode(
      JSONDecoder().decode(
        EntrySource.self, from: try JSONSerialization.data(withJSONObject: source)))
    let decodedBack = try JSONDecoder().decode(EntrySource.self, from: reencoded)
    #expect(decodedBack == .inline)
  }

  @Test func sourceSurvivesAWholeEntryRoundTrip() throws {
    // The union sits inside a larger structure that is also hand-coded, so this
    // checks the two compose rather than only testing in isolation.
    let entry = FullEntry(
      record: makeRecord(
        id: "e1", meta: demoMeta(), source: .dev(.init(url: "https://dev/x", autoReload: true))),
      code: "x",
      values: nil)

    let data = try JSONEncoder().encode(WireEntry(full: entry))
    let back = try JSONDecoder().decode(WireEntry.self, from: data)
    #expect(back.source == .dev(.init(url: "https://dev/x", autoReload: true)))
  }
}
