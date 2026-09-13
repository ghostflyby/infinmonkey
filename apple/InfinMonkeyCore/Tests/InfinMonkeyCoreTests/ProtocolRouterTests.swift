import XCTest

@testable import InfinMonkeyCore

final class ProtocolRouterTests: XCTestCase {

  private var store: NativeStore!
  private var router: ProtocolRouter!

  override func setUpWithError() throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("infinmonkey-router-\(UUID().uuidString)", isDirectory: true)
    store = NativeStore(layout: StoreLayout(root: root))
    router = ProtocolRouter(store: store, platform: "macos")
  }

  private func roundTrip(_ request: [String: Any]) -> [String: Any] {
    router.handle(message: request)
  }

  func testPingHelloHandshake() throws {
    let ping = roundTrip(["v": 1, "id": "p1", "type": "ping", "payload": [:]])
    XCTAssertEqual(ping["ok"] as? Bool, true)
    let result = try XCTUnwrap(ping["result"] as? [String: Any])
    XCTAssertEqual(result["proto"] as? Int, 1)
    XCTAssertEqual(result["platform"] as? String, "macos")

    let hello = roundTrip(["v": 1, "id": "h1", "type": "hello", "payload": [:]])
    XCTAssertEqual(hello["ok"] as? Bool, true)
    let helloResult = try XCTUnwrap(hello["result"] as? [String: Any])
    XCTAssertEqual(helloResult["app"] as? String, "InfinMonkey")
    XCTAssertNotNil(helloResult["entries"] as? [[String: Any]])
  }

  func testCreateListUpdateDeleteFlow() throws {
    let code = "// ==UserScript==\n// @name Demo\n// ==/UserScript==\n"
    let create = roundTrip([
      "v": 1, "id": "c1", "type": "createEntry",
      "payload": [
        "kind": "script", "code": code, "meta": ["name": "Demo"], "source": ["type": "inline"],
      ],
    ])
    XCTAssertEqual(create["ok"] as? Bool, true)
    let created = try XCTUnwrap((create["result"] as? [String: Any])?["entry"] as? [String: Any])
    let id = try XCTUnwrap(created["id"] as? String)
    XCTAssertTrue(ProtocolRouter.isWireEntryShaped(created))

    let list = roundTrip(["v": 1, "id": "l1", "type": "listEntries", "payload": [:]])
    let entries = try XCTUnwrap((list["result"] as? [String: Any])?["entries"] as? [[String: Any]])
    XCTAssertEqual(entries.count, 1)
    XCTAssertTrue(ProtocolRouter.isWireEntryShaped(entries[0]))

    let toggle = roundTrip([
      "v": 1, "id": "t1", "type": "setEnabled", "payload": ["id": id, "enabled": false],
    ])
    XCTAssertEqual(toggle["ok"] as? Bool, true)

    let del = roundTrip(["v": 1, "id": "d1", "type": "deleteEntry", "payload": ["id": id]])
    XCTAssertEqual((del["result"] as? [String: Any])?["deleted"] as? Bool, true)
  }

  func testNotFoundAndBadRequestErrors() throws {
    let missing = roundTrip([
      "v": 1, "id": "n1", "type": "setEnabled", "payload": ["id": "ghost", "enabled": true],
    ])
    XCTAssertEqual(missing["ok"] as? Bool, false)
    let err = try XCTUnwrap(missing["error"] as? [String: Any])
    XCTAssertEqual(err["code"] as? String, "notFound")

    let malformed = roundTrip(["v": 2, "id": "m1", "type": "ping"])
    XCTAssertEqual((malformed["error"] as? [String: Any])?["code"] as? String, "badRequest")

    let unknown = roundTrip(["v": 1, "id": "u1", "type": "teleport", "payload": [:]])
    XCTAssertEqual((unknown["error"] as? [String: Any])?["code"] as? String, "unsupported")
  }

  func testFixtureContract() throws {
    // Fixtures shared with the TS side (packages/tests/fixtures/protocol).
    let testsDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    let fixtures = testsDir.appendingPathComponent("../../../../packages/tests/fixtures/protocol")

    let request = try JSONSerialization.jsonObject(
      with: Data(contentsOf: fixtures.appendingPathComponent("request-createEntry.json")))
    let response = try JSONSerialization.jsonObject(
      with: Data(contentsOf: fixtures.appendingPathComponent("wire-entry.json")))

    let entry = try XCTUnwrap(response as? [String: Any])
    XCTAssertTrue(ProtocolRouter.isWireEntryShaped(entry))

    let frame = try XCTUnwrap(request as? [String: Any])
    XCTAssertEqual(frame["v"] as? Int, CoreConstants.protocolVersion)
    XCTAssertEqual(frame["type"] as? String, "createEntry")
    let payload = try XCTUnwrap(frame["payload"] as? [String: Any])
    let out = roundTrip([
      "v": 1, "id": "fixture-1", "type": "createEntry",
      "payload": [
        "kind": payload["kind"], "code": payload["code"], "meta": payload["meta"],
        "source": payload["source"],
      ],
    ])
    XCTAssertEqual(out["ok"] as? Bool, true)
  }
}
