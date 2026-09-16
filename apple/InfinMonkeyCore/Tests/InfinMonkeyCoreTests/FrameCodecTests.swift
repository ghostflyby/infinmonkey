import Foundation
import Testing

@testable import InfinMonkeyCore

@Suite("Frame codec")
struct FrameCodecTests {

  @Test("a frame is a native-order length prefix followed by the body")
  func encodePrefixesBody() throws {
    let body = Data(#"{"v":1}"#.utf8)
    let frame = try FrameCodec.encode(body)

    #expect(frame.count == FrameCodec.prefixBytes + body.count)
    let declared = FrameCodec.length(from: frame.prefix(FrameCodec.prefixBytes))
    #expect(declared == UInt32(body.count))
    #expect(frame.dropFirst(FrameCodec.prefixBytes) == body)
  }

  @Test("the prefix round-trips in native byte order")
  func prefixIsNativeOrder() throws {
    // The browsers' own examples write the length as a machine word (MDN's
    // Python sample unpacks with `=I`), so the bytes must be whatever this
    // machine's UInt32 layout is — asserting against `withUnsafeBytes` keeps the
    // test honest on either endianness rather than pinning little-endian.
    let body = Data(repeating: 0x41, count: 300)
    let frame = try FrameCodec.encode(body)

    var expected = UInt32(300)
    let expectedBytes = withUnsafeBytes(of: &expected) { Data($0) }
    #expect(frame.prefix(FrameCodec.prefixBytes) == expectedBytes)
  }

  @Test("an empty body is a legal frame")
  func emptyBodyRoundTrips() throws {
    let frame = try FrameCodec.encode(Data())
    #expect(frame.count == FrameCodec.prefixBytes)
    #expect(FrameCodec.length(from: frame) == 0)
  }

  @Test("a body at the limit is allowed and one past it is refused")
  func enforcesOutgoingLimit() throws {
    let atLimit = Data(repeating: 0x41, count: FrameCodec.maxOutgoingBytes)
    #expect(throws: Never.self) { _ = try FrameCodec.encode(atLimit) }

    let overLimit = Data(repeating: 0x41, count: FrameCodec.maxOutgoingBytes + 1)
    #expect(throws: FrameCodec.Failure.oversizedOutgoing(overLimit.count)) {
      _ = try FrameCodec.encode(overLimit)
    }
  }

  @Test("a short prefix is not a length")
  func shortPrefixIsNil() {
    #expect(FrameCodec.length(from: Data([0x01, 0x02, 0x03])) == nil)
    #expect(FrameCodec.length(from: Data()) == nil)
  }

  @Test("a prefix at an unaligned offset still reads")
  func unalignedPrefixReads() throws {
    // A `Data` slice shares storage with its parent and keeps the parent's
    // indices, so a prefix that follows an odd number of bytes lands on an
    // unaligned address. Reading that with an alignment-assuming load traps in
    // debug builds — the configuration a developer actually runs. `subdata`
    // would not exercise this: it copies into fresh, aligned storage.
    let body = Data(#"{"v":1}"#.utf8)
    let frame = try FrameCodec.encode(body)

    // Every padding length 1...3 puts the prefix at a different misalignment.
    for padding in 1...3 {
      var padded = Data(repeating: 0xFF, count: padding)
      padded.append(frame)
      let start = padded.startIndex + padding
      let slice = padded[start..<(start + FrameCodec.prefixBytes)]
      #expect(
        FrameCodec.length(from: slice) == UInt32(body.count),
        "a prefix after \(padding) padding byte(s) must still decode")
    }
  }
}
