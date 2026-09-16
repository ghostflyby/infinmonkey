import Foundation

/// The stdio native messaging host loop.
///
/// Frames arrive on stdin and responses leave on stdout; the protocol router
/// turns one into the other. stdout carries frames and nothing else, so every
/// diagnostic goes to stderr instead — both browsers forward the host's stderr
/// to the extension's console, which is where a host failure is meant to be
/// read.
///
/// Blocking reads are deliberate: this process exists to answer frames in
/// order, and the browsers write a request then wait for its response.
public struct StdioHostSession: Sendable {
  /// Where diagnostics go. Injected so tests can capture them.
  public typealias Log = @Sendable (String) -> Void

  /// Largest frame accepted from the browser.
  ///
  /// Matches the binding limit both browsers impose in this direction — Chromium
  /// through `kMaxMessageBytes` in its message-port mojom, and Chrome's own
  /// documentation ("the message sent to the native messaging host is 64 MiB").
  /// Firefox would allow up to 4 GB, so this is the stricter of the two: a
  /// garbage length prefix cannot ask for more memory than a conforming caller
  /// could ever need.
  public static let maxIncomingBytes = 64 * 1024 * 1024

  private let input: FileHandle
  private let output: FileHandle
  private let router: ProtocolRouter
  private let log: Log

  public init(
    router: ProtocolRouter,
    input: FileHandle = .standardInput,
    output: FileHandle = .standardOutput,
    log: @escaping Log = { FileHandle.standardError.write(Data(($0 + "\n").utf8)) }
  ) {
    self.router = router
    self.input = input
    self.output = output
    self.log = log
  }

  /// Convenience over the store, which is what the entry point has.
  ///
  /// The router is told this transport's frame limit so an oversized reply comes
  /// back as an error frame rather than as a write that ends the session.
  public init(
    store: any EntryStoring,
    platform: String = PlatformName.current,
    input: FileHandle = .standardInput,
    output: FileHandle = .standardOutput,
    log: @escaping Log = { FileHandle.standardError.write(Data(($0 + "\n").utf8)) }
  ) {
    self.init(
      router: ProtocolRouter(
        store: store, platform: platform,
        maxResponseBytes: FrameCodec.maxOutgoingBytes),
      input: input, output: output, log: log)
  }

  /// Serves frames until stdin closes. Returns the process exit code: `0` for a
  /// clean close, non-zero when the stream is unusable — a truncated frame or a
  /// response the browser would reject.
  public func run() async -> Int32 {
    while true {
      let body: Data
      do {
        // nil is EOF at a frame boundary: the browser closed the port normally.
        guard let frame = try readFrame() else { return 0 }
        body = frame
      } catch {
        log("InfinMonkey host: \(Self.describe(error))")
        return 1
      }

      let response = await router.handle(requestData: body)

      do {
        try writeFrame(response)
      } catch {
        log("InfinMonkey host: \(Self.describe(error))")
        return 1
      }
    }
  }

  /// Entry for `main.swift`: runs to completion and ends the process with the
  /// session's exit code. See `runToCompletionAndExit` for why this does not simply return.
  public func runAndExit() -> Never {
    runToCompletionAndExit { await self.run() }
  }

  // MARK: - Framing

  private func readFrame() throws -> Data? {
    guard let prefix = try readExactly(FrameCodec.prefixBytes, part: .prefix) else { return nil }
    guard let declared = FrameCodec.length(from: prefix) else {
      throw FrameCodec.Failure.truncatedPrefix(
        expected: FrameCodec.prefixBytes, got: prefix.count)
    }
    let length = Int(declared)
    guard length <= Self.maxIncomingBytes else {
      throw FrameCodec.Failure.implausibleLength(declared)
    }
    guard length > 0 else { return Data() }
    // The prefix was read, so a body is owed: the stream ending here is a
    // truncation, not a clean close.
    guard let body = try readExactly(length, part: .body) else {
      throw FrameCodec.Failure.truncatedFrame(expected: length, got: 0)
    }
    return body
  }

  private func writeFrame(_ body: Data) throws {
    try output.write(contentsOf: FrameCodec.encode(body))
  }

  /// Which part of a frame a read is filling, so a short read is reported
  /// against the right one. Both are fatal, but the message is the only signal a
  /// browser forwards to the extension console, and "inside a length prefix"
  /// sends the reader looking at the wrong bytes.
  private enum FramePart {
    case prefix
    case body

    func failure(expected: Int, got: Int) -> FrameCodec.Failure {
      switch self {
      case .prefix: return .truncatedPrefix(expected: expected, got: got)
      case .body: return .truncatedFrame(expected: expected, got: got)
      }
    }
  }

  /// Reads exactly `count` bytes.
  ///
  /// Returns nil only when the stream ended before *any* byte was read — a clean
  /// close, which is only meaningful while starting a frame (`part: .prefix`);
  /// a caller reading a body turns nil into a truncation. A stream that ends
  /// mid-read throws.
  ///
  /// `FileHandle.read(upToCount:)` may return fewer bytes than asked for, so
  /// this loops: a pipe hands over what it has, not what the caller wanted.
  private func readExactly(_ count: Int, part: FramePart) throws -> Data? {
    var buffer = Data()
    while buffer.count < count {
      guard let chunk = try input.read(upToCount: count - buffer.count), !chunk.isEmpty else {
        if buffer.isEmpty { return nil }
        throw part.failure(expected: count, got: buffer.count)
      }
      buffer.append(chunk)
    }
    return buffer
  }

  private static func describe(_ error: Error) -> String {
    guard let failure = error as? FrameCodec.Failure else { return String(describing: error) }
    switch failure {
    case .truncatedPrefix(let expected, let got):
      return "stdin ended inside a length prefix (wanted \(expected) bytes, got \(got))"
    case .truncatedFrame(let expected, let got):
      return "stdin ended mid-frame (wanted \(expected) bytes, got \(got))"
    case .oversizedOutgoing(let bytes):
      return "response of \(bytes) bytes exceeds the \(FrameCodec.maxOutgoingBytes)-byte limit"
    case .implausibleLength(let declared):
      return "frame length \(declared) exceeds the \(maxIncomingBytes)-byte limit"
    }
  }
}
