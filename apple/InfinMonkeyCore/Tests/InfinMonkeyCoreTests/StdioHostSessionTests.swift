import Foundation
import Testing

@testable import InfinMonkeyCore

/// The host loop against a real store and real pipes.
///
/// The framing is the part worth testing end to end: a browser writes a
/// length-prefixed request and reads a length-prefixed response, so anything
/// that only exercises the pieces in isolation would miss a byte-order or
/// partial-read mistake — which is exactly the class of bug that makes a host
/// silently receive nothing.
@Suite("Stdio host session")
struct StdioHostSessionTests {

  /// A store with one script, so responses have content to carry.
  private func seededStore() async throws -> (NativeStore, String) {
    let store = NativeStore(layout: StoreLayout(root: temporaryRoot()))
    let entry = try await store.create(
      kind: .script,
      code: "// ==UserScript==\n// @name host-test\n// ==/UserScript==\n",
      meta: nil,
      source: .inline,
      enabled: true,
      values: NativeStore.emptyJSONObject)
    return (store, entry.record.id)
  }

  /// Runs the session over pipes, feeding `input` and returning what it wrote.
  private func runSession(
    store: any EntryStoring,
    input: Data
  ) async throws -> (out: Data, code: Int32) {
    let inPipe = Pipe()
    let outPipe = Pipe()
    inPipe.fileHandleForWriting.write(input)
    try inPipe.fileHandleForWriting.close()

    let session = StdioHostSession(
      store: store,
      input: inPipe.fileHandleForReading,
      output: outPipe.fileHandleForWriting,
      log: { _ in })

    let code = await session.run()
    try outPipe.fileHandleForWriting.close()
    let out = try outPipe.fileHandleForReading.readToEnd() ?? Data()
    return (out, code)
  }

  /// Decodes a stream of frames into its message bodies.
  private func messages(in stream: Data) -> [Data] {
    var rest = stream
    var out: [Data] = []
    while rest.count >= FrameCodec.prefixBytes {
      guard let declared = FrameCodec.length(from: rest.prefix(FrameCodec.prefixBytes)) else {
        break
      }
      let length = Int(declared)
      let body = rest.dropFirst(FrameCodec.prefixBytes)
      guard body.count >= length else { break }
      out.append(Data(body.prefix(length)))
      rest = Data(body.dropFirst(length))
    }
    return out
  }

  @Test("a hello request comes back as a well-formed response frame")
  func servesOneRequest() async throws {
    let (store, _) = try await seededStore()
    let request = Data(#"{"v":1,"id":"r1","type":"hello","payload":{}}"#.utf8)
    let (out, code) = try await runSession(
      store: store, input: try FrameCodec.encode(request))

    #expect(code == 0)
    let bodies = messages(in: out)
    #expect(bodies.count == 1)
    let response = try #require(bodies.first)
    let decoded = try JSONSerialization.jsonObject(with: response) as? [String: Any]
    #expect(decoded?["id"] as? String == "r1")
    #expect(decoded?["ok"] as? Bool == true)
    #expect(decoded?["v"] as? Int == CoreConstants.protocolVersion)
  }

  @Test("several requests are answered in order on one connection")
  func servesRequestsInOrder() async throws {
    let (store, entryID) = try await seededStore()
    var input = Data()
    for id in ["a", "b", "c"] {
      input.append(
        try FrameCodec.encode(
          Data(#"{"v":1,"id":"\#(id)","type":"listEntries","payload":{}}"#.utf8)))
    }
    let (out, code) = try await runSession(store: store, input: input)

    #expect(code == 0)
    let ids = try messages(in: out).compactMap {
      (try JSONSerialization.jsonObject(with: $0) as? [String: Any])?["id"] as? String
    }
    #expect(ids == ["a", "b", "c"])

    // The listed library is the one that was seeded, so the loop is driving the
    // real store rather than answering from a stub.
    let first = try #require(messages(in: out).first)
    #expect(String(decoding: first, as: UTF8.self).contains(entryID))
  }

  @Test("stdin closing at a frame boundary is a clean exit")
  func cleanExitOnEOF() async throws {
    let (store, _) = try await seededStore()
    let (out, code) = try await runSession(
      store: store, input: try FrameCodec.encode(Data(#"{"v":1,"id":"x","type":"ping"}"#.utf8)))

    #expect(code == 0)
    #expect(messages(in: out).count == 1)
  }

  @Test("a stream ending before any byte is a clean exit with no output")
  func immediateEOF() async throws {
    let (store, _) = try await seededStore()
    let (out, code) = try await runSession(store: store, input: Data())

    #expect(code == 0)
    #expect(out.isEmpty)
  }

  @Test("a body truncated mid-frame fails rather than answering half a message")
  func truncatedBodyFails() async throws {
    let (store, _) = try await seededStore()
    // Declare 100 bytes, supply 10: the browser would only do this by dying, and
    // answering would be worse than reporting it.
    var input = Data()
    var declared = UInt32(100)
    withUnsafeBytes(of: &declared) { input.append(contentsOf: $0) }
    input.append(Data(repeating: 0x20, count: 10))

    let (out, code) = try await runSession(store: store, input: input)
    #expect(code == 1)
    #expect(out.isEmpty)
  }

  @Test("a truncated length prefix fails")
  func truncatedPrefixFails() async throws {
    let (store, _) = try await seededStore()
    let (out, code) = try await runSession(store: store, input: Data([0x01, 0x02]))

    #expect(code == 1)
    #expect(out.isEmpty)
  }

  @Test("an implausible length is refused instead of allocating for it")
  func implausibleLengthIsRefused() async throws {
    let (store, _) = try await seededStore()
    var input = Data()
    var declared = UInt32.max
    withUnsafeBytes(of: &declared) { input.append(contentsOf: $0) }

    let (out, code) = try await runSession(store: store, input: input)
    #expect(code == 1)
    #expect(out.isEmpty)
  }

  @Test("an unknown op is answered with an error frame, not by closing")
  func unknownOpIsAnErrorFrame() async throws {
    let (store, _) = try await seededStore()
    let request = Data(#"{"v":1,"id":"u1","type":"notAnOp","payload":{}}"#.utf8)
    let (out, code) = try await runSession(store: store, input: try FrameCodec.encode(request))

    // The stream stayed healthy: the browser gets a reply it can log, which is
    // what makes a version mismatch diagnosable from the extension side.
    #expect(code == 0)
    let bodies = messages(in: out)
    #expect(bodies.count == 1)
    let decoded =
      try JSONSerialization.jsonObject(with: try #require(bodies.first)) as? [String: Any]
    #expect(decoded?["ok"] as? Bool == false)
    #expect(decoded?["id"] as? String == "u1")
  }
}
