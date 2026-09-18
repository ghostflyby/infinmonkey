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
  ) async throws -> (out: Data, code: Int32, logged: String) {
    let inPipe = Pipe()
    let outPipe = Pipe()
    inPipe.fileHandleForWriting.write(input)
    try inPipe.fileHandleForWriting.close()

    // The log is captured because a truncated frame's *classification* is the
    // only signal a browser forwards to the extension console: exit code 1 and
    // empty stdout are the same whether the prefix or the body was cut short.
    // Lines render as `level: message` so tests can match on both.
    let logPipe = Pipe()
    let session = StdioHostSession(
      store: store,
      input: inPipe.fileHandleForReading,
      output: outPipe.fileHandleForWriting,
      log: { level, message in
        logPipe.fileHandleForWriting.write(Data("\(level.rawValue): \(message)\n".utf8))
      })

    let code = await session.run()
    try outPipe.fileHandleForWriting.close()
    try logPipe.fileHandleForWriting.close()
    let out = try outPipe.fileHandleForReading.readToEnd() ?? Data()
    let logged = String(
      decoding: try logPipe.fileHandleForReading.readToEnd() ?? Data(), as: UTF8.self)
    return (out, code, logged)
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
    let (out, code, _) = try await runSession(
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
    let (out, code, _) = try await runSession(store: store, input: input)

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
    let (out, code, _) = try await runSession(
      store: store, input: try FrameCodec.encode(Data(#"{"v":1,"id":"x","type":"ping"}"#.utf8)))

    #expect(code == 0)
    #expect(messages(in: out).count == 1)
  }

  @Test("a stream ending before any byte is a clean exit with no output")
  func immediateEOF() async throws {
    let (store, _) = try await seededStore()
    let (out, code, _) = try await runSession(store: store, input: Data())

    #expect(code == 0)
    #expect(out.isEmpty)
  }

  @Test("a body truncated mid-frame is reported as a body, not as a prefix")
  func truncatedBodyFails() async throws {
    let (store, _) = try await seededStore()
    // Declare 100 bytes, supply 10: the browser would only do this by dying, and
    // answering would be worse than reporting it. The classification matters
    // because it is the only diagnostic that reaches the extension console.
    for supplied in [1, 10, 99] {
      var input = Data()
      var declared = UInt32(100)
      withUnsafeBytes(of: &declared) { input.append(contentsOf: $0) }
      input.append(Data(repeating: 0x20, count: supplied))

      let (out, code, logged) = try await runSession(store: store, input: input)
      #expect(code == 1)
      #expect(out.isEmpty)
      #expect(
        logged.contains("mid-frame"),
        "a \(supplied)-byte body should be reported as mid-frame, got: \(logged)")
      #expect(
        !logged.contains("length prefix"),
        "a short body must not be blamed on the prefix, got: \(logged)")
    }
  }

  @Test("a truncated length prefix is reported as a prefix")
  func truncatedPrefixFails() async throws {
    let (store, _) = try await seededStore()
    let (out, code, logged) = try await runSession(store: store, input: Data([0x01, 0x02]))

    #expect(code == 1)
    #expect(out.isEmpty)
    #expect(logged.contains("length prefix"), "got: \(logged)")
  }

  @Test("an oversized response is an error frame, and the session survives it")
  func oversizedResponseDoesNotEndTheSession() async throws {
    // `listEntries` returns every entry's code, so a library with a few large
    // scripts exceeds the host's 1 MB frame limit legitimately. Rejecting the
    // write would end the session — one big reply and every later request is
    // dead. The reply must be an error frame carrying the same id instead.
    let store = NativeStore(layout: StoreLayout(root: temporaryRoot()))
    let big = String(repeating: "x", count: 200_000)
    for index in 0..<6 {
      _ = try await store.create(
        kind: .script,
        code: "// ==UserScript==\n// @name big-\(index)\n// ==/UserScript==\n// \(big)\n",
        meta: nil,
        source: .inline,
        enabled: true,
        values: NativeStore.emptyJSONObject)
    }

    var input = Data()
    for id in ["oversized", "after"] {
      input.append(
        try FrameCodec.encode(
          Data(#"{"v":1,"id":"\#(id)","type":"listEntries","payload":{}}"#.utf8)))
    }
    let (out, code, logged) = try await runSession(store: store, input: input)

    #expect(code == 0, "the session should end by clean EOF, not by a failed write")
    // An oversized reply is answered in protocol, so nothing above the session
    // lifecycle's debug lines is logged.
    #expect(!logged.contains("error:"), "got: \(logged)")

    let bodies = messages(in: out)
    #expect(bodies.count == 2, "both requests are answered")
    let firstBody = try #require(bodies.first)
    let first = try #require(
      try JSONSerialization.jsonObject(with: firstBody) as? [String: Any])
    #expect(first["ok"] as? Bool == false)
    #expect(first["id"] as? String == "oversized")
    #expect((first["error"] as? [String: Any])?["code"] as? String == "responseTooLarge")

    // The second request still gets a real answer: that is the point.
    let secondBody = try #require(bodies.dropFirst().first)
    let second = try #require(
      try JSONSerialization.jsonObject(with: secondBody) as? [String: Any])
    #expect(second["id"] as? String == "after")
    #expect(second["ok"] as? Bool == false)
    #expect((second["error"] as? [String: Any])?["code"] as? String == "responseTooLarge")
  }

  @Test("an implausible length is refused instead of allocating for it")
  func implausibleLengthIsRefused() async throws {
    let (store, _) = try await seededStore()
    var input = Data()
    var declared = UInt32.max
    withUnsafeBytes(of: &declared) { input.append(contentsOf: $0) }

    let (out, code, _) = try await runSession(store: store, input: input)
    #expect(code == 1)
    #expect(out.isEmpty)
  }

  @Test("an unknown op is answered with an error frame, not by closing")
  func unknownOpIsAnErrorFrame() async throws {
    let (store, _) = try await seededStore()
    let request = Data(#"{"v":1,"id":"u1","type":"notAnOp","payload":{}}"#.utf8)
    let (out, code, _) = try await runSession(store: store, input: try FrameCodec.encode(request))

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
