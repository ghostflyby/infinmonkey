import Foundation

/// Native messaging's stdio framing.
///
/// A frame is a 32-bit unsigned length prefix followed by that many bytes of
/// UTF-8 JSON. The prefix is in the machine's **native byte order**, which is
/// also what the browsers' own examples do (the MDN Python sample unpacks with
/// `=I`), so it must not be normalized to little- or big-endian explicitly:
/// writing a `UInt32` straight to memory is what makes it native.
///
/// Both Firefox and Chrome agree on this byte-for-byte, which is what lets one
/// host binary serve both; only the manifest differs.
public enum FrameCodec {
  public static let prefixBytes = 4

  /// Largest frame the host may send. The browser closes the port above this,
  /// so an oversized response is reported as an error here rather than being
  /// written out to vanish silently on the other side.
  public static let maxOutgoingBytes = 1 * 1024 * 1024

  public enum Failure: Error, Equatable {
    /// stdin ended part-way through a length prefix: a truncated frame, not a
    /// clean close.
    case truncatedPrefix(expected: Int, got: Int)
    /// stdin ended part-way through a frame body.
    case truncatedFrame(expected: Int, got: Int)
    /// A response larger than the browser will accept.
    case oversizedOutgoing(Int)
    /// A length prefix that cannot be a frame.
    case implausibleLength(UInt32)
  }

  /// Prefixes `body` with its length in native byte order.
  public static func encode(_ body: Data) throws -> Data {
    guard body.count <= maxOutgoingBytes else {
      throw Failure.oversizedOutgoing(body.count)
    }
    // No byte-order conversion: storing the value is what produces native order.
    var length = UInt32(body.count)
    var out = Data(capacity: prefixBytes + body.count)
    withUnsafeBytes(of: &length) { out.append(contentsOf: $0) }
    out.append(body)
    return out
  }

  /// The length a prefix declares, in native byte order.
  public static func length(from prefix: Data) -> UInt32? {
    guard prefix.count == prefixBytes else { return nil }
    // `loadUnaligned` makes no alignment assumption, which matters because this
    // takes arbitrary `Data`: a slice of a larger buffer keeps its original
    // offset, and `load(as:)` traps on a misaligned pointer in debug builds.
    // Reading in native order is what makes this the inverse of `encode`.
    return prefix.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
  }
}
