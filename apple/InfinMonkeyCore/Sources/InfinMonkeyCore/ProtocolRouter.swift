import Foundation

/// Dispatches protocol frames to the library.
///
/// Depends on `EntryStoring`, not the concrete store, so the dispatch table,
/// payload decoding, and error mapping are all testable against a fake — no
/// file system required to exercise protocol behavior.
///
/// `handle` returns a response for every input: its caller is a transport that
/// can only relay a reply, so failures become error frames rather than throws.
public actor ProtocolRouter {
  private let store: any EntryStoring
  private let platform: String

  /// - Parameter platform: defaults to the platform this build runs on.
  public init(store: any EntryStoring, platform: String = PlatformName.current) {
    self.store = store
    self.platform = platform
  }

  // MARK: - Entry points

  /// Handles a message body and returns a message body.
  ///
  /// This is the single entry point every transport converges on: `JSONBody` is
  /// `Sendable`, so a body can cross into this actor from any caller, and it
  /// carries whichever representation the transport had (a parsed graph from
  /// Safari, JSON text from stdio). One decode pass turns it into a
  /// `RequestMessage`.
  public func handle(request body: JSONBody) async -> JSONBody {
    let message: RequestMessage
    do {
      message = try body.decoded(as: RequestMessage.self)
    } catch let error as WireError {
      let envelope = Self.envelope(of: body)
      return ResponseFrame.failure(
        id: envelope.id ?? "unknown", code: Self.code(for: error), message: "\(error)"
      ).body()
    } catch {
      let envelope = Self.envelope(of: body)
      let described = Self.describe(error)
      // Name the op when the frame carried one: a bad payload is reported
      // against the request that brought it.
      let text = envelope.type.map { "\($0): \(described)" } ?? described
      return ResponseFrame.failure(
        id: envelope.id ?? "unknown", code: "badRequest", message: text
      ).body()
    }
    return await respond(to: message).body()
  }

  /// Convenience for a text transport: JSON in, JSON out.
  public func handle(requestData: Data) async -> Data {
    let request: JSONBody
    do {
      request = try JSONBody(data: requestData, requiringValidJSON: true)
    } catch {
      return ResponseFrame.failure(
        id: "unknown", code: "badRequest", message: "request body is not valid JSON"
      ).jsonData()
    }
    return await handle(request: request).data
  }

  // MARK: - Dispatch

  private func respond(to message: RequestMessage) async -> ResponseFrame {
    // Runs after the decode, so precedence is: undecodable frame > wrong
    // version > dispatch. A frame that names no known op never reaches here.
    guard message.v == CoreConstants.protocolVersion else {
      return .failure(
        id: message.id, code: "badRequest",
        message:
          "unsupported protocol version \(message.v); expected \(CoreConstants.protocolVersion)")
    }

    do {
      switch message.op {
      case .ping:
        return try .success(id: message.id, result: pong())

      case .hello(let payload):
        let snapshot = try await store.summaries(sinceRev: payload.sinceRev)
        return try .success(
          id: message.id,
          result: WireResult.Hello(
            proto: CoreConstants.protocolVersion,
            app: CoreConstants.appName,
            platform: platform,
            rev: snapshot.rev,
            entries: snapshot.entries.map(WireSummary.init(summary:))))

      case .listEntries:
        let snapshot = try await store.snapshot()
        return try .success(
          id: message.id,
          result: WireResult.List(
            rev: snapshot.rev, entries: snapshot.entries.map(WireEntry.init(full:))))

      case .getChanges(let payload):
        let changes = try await store.changes(sinceRev: payload.sinceRev)
        return try .success(
          id: message.id,
          result: WireResult.Changes(
            rev: changes.rev,
            upserts: changes.upserts.map(WireEntry.init(full:)),
            deletedIds: changes.deletedIds))

      case .createEntry(let payload):
        let created = try await store.create(
          kind: payload.kind,
          code: payload.code,
          meta: payload.meta,
          source: payload.source ?? .inline,
          enabled: payload.enabled ?? true,
          values: payload.values?.data)
        return try await entryResponse(message.id, created)

      case .updateCode(let payload):
        let updated = try await store.updateCode(
          id: payload.id, code: payload.code, meta: payload.meta)
        return try await entryResponse(message.id, updated)

      case .updateMeta(let payload):
        // Over the wire, metadata comes from the extension's parser.
        let updated = try await store.updateMeta(
          id: payload.id, meta: payload.meta, fromParsing: true)
        return try await entryResponse(message.id, updated)

      case .setEnabled(let payload):
        let updated = try await store.setEnabled(id: payload.id, enabled: payload.enabled)
        return try await entryResponse(message.id, updated)

      case .putEntry(let payload):
        let stored = try await store.put(entry: payload.entry.fullEntry())
        return try await entryResponse(message.id, stored)

      case .reorderEntries(let payload):
        try await store.reorder(ids: payload.ids)
        return try .success(
          id: message.id, result: WireResult.Rev(rev: try await store.currentRev()))

      case .deleteEntry(let payload):
        let deleted = try await store.delete(id: payload.id)
        return try .success(
          id: message.id,
          result: WireResult.Deleted(rev: try await store.currentRev(), deleted: deleted))

      case .getValues(let payload):
        let stored = try await store.values(id: payload.id)
        return try .success(
          id: message.id, result: WireResult.Values(values: JSONBody(data: stored ?? Data())))

      case .exportAll:
        let bundle = try await store.exportBundle()
        return try .success(
          id: message.id, result: WireResult.Export(bundle: WireBundle(bundle: bundle)))

      case .importAll(let payload):
        let count = try await store.importBundle(payload.bundle.exportBundle(), mode: payload.mode)
        return try .success(
          id: message.id,
          result: WireResult.Imported(rev: try await store.currentRev(), count: count))
      }
    } catch let error as StoreError {
      return .failure(
        id: message.id, code: Self.code(for: error), message: Self.message(for: error))
    } catch {
      return .failure(id: message.id, code: "io", message: String(describing: error))
    }
  }

  // MARK: - Helpers

  /// The envelope members readable even when the rest of a frame fails to
  /// decode: `id` and `type` are decoded before the op, so an error reply can
  /// still echo the request it belongs to. A body that is not a frame at all
  /// decodes to empty members.
  private struct PartialEnvelope: Codable {
    var id: String?
    var type: String?
  }

  private static func envelope(of body: JSONBody) -> PartialEnvelope {
    (try? body.decoded(as: PartialEnvelope.self)) ?? PartialEnvelope()
  }

  private func entryResponse(_ id: String, _ entry: FullEntry) async throws -> ResponseFrame {
    try .success(
      id: id,
      result: WireResult.Entry(rev: try await store.currentRev(), entry: WireEntry(full: entry)))
  }

  private func pong() -> WireResult.Pong {
    WireResult.Pong(
      proto: CoreConstants.protocolVersion, app: CoreConstants.appName, platform: platform)
  }

  private static func code(for error: WireError) -> String {
    switch error {
    case .unknownOp: return "unsupported"
    }
  }

  private static func code(for error: StoreError) -> String {
    switch error {
    case .notFound: return "notFound"
    case .badRequest: return "badRequest"
    case .io, .corruptIndex: return "io"
    }
  }

  private static func message(for error: StoreError) -> String {
    switch error {
    case .notFound: return "entry not found"
    case .badRequest(let message): return message
    case .io(let message): return message
    case .corruptIndex(let message): return message
    }
  }

  /// A short description of a decoding failure: enough to diagnose, no payload echo.
  static func describe(_ error: Error) -> String {
    guard let error = error as? DecodingError else { return String(describing: error) }
    switch error {
    case .keyNotFound(let key, _):
      return "missing key '\(key.stringValue)'"
    case .typeMismatch(_, let context):
      return "wrong type at \(path(context.codingPath))"
    case .valueNotFound(_, let context):
      return "missing value at \(path(context.codingPath))"
    case .dataCorrupted(let context):
      return "invalid value at \(path(context.codingPath)): \(context.debugDescription)"
    @unknown default:
      return String(describing: error)
    }
  }

  private static func path(_ codingPath: [CodingKey]) -> String {
    codingPath.isEmpty ? "<root>" : codingPath.map(\.stringValue).joined(separator: ".")
  }
}

/// Names of the platforms the protocol can report.
public enum PlatformName {
  /// The platform this build runs on, as reported in `hello` and `ping`.
  ///
  /// A compile-time fact, so it is a conditional constant rather than an
  /// injectable value; tests that need a different one pass it to the router.
  public static var current: String {
    #if os(macOS)
      return "macos"
    #elseif os(iOS)
      return "ios"
    #else
      return "unknown"
    #endif
  }
}
