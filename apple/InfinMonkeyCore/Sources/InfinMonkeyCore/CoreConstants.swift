import Foundation

/// Values shared across the native side and pinned by contract tests against
/// the TypeScript implementation.
public enum CoreConstants {
  /// Wire protocol version; matches `PROTOCOL_VERSION` in packages/protocol.
  public static let protocolVersion = 1
  public static let appName = "InfinMonkey"
  /// Version of the on-disk index document.
  public static let storeVersion = 1
  /// Version string written into export bundles; mirrors the extension's
  /// `RUNTIME_VERSION`.
  public static let storeVersionString = "0.1.0"
  /// How many revisions a tombstone is kept for before pruning. A client that
  /// has been away longer than this cannot use the change stream and must
  /// request a full snapshot.
  public static let tombstoneRetention = 1_000
}
