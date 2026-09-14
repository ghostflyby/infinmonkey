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

  public init(store: any EntryStoring, platform: String) {
    self.store = store
    self.platform = platform
  }

  public init(store: any EntryStoring, capabilities: PlatformCapabilities = .current) {
    self.init(store: store, platform: capabilities.wireName)
  }

  // MARK: - Entry points

  /// Handles a message body and returns a message body.
  ///
  /// This is the single entry point every transport converges on: `JSONBody` is
  /// `Sendable`, so a body can cross into this actor from any caller, and it
  /// carries whichever representation the transport had (a parsed graph from
  /// Safari, JSON text from stdio) without re-serializing it.
  public func handle(request body: JSONBody) async -> JSONBody {
    let frame: RequestFrame
    do {
      frame = try RequestFrame(body: body)
    } catch {
      return ResponseFrame.failure(id: "unknown", code: "badRequest", message: "\(error)").body()
    }
    return await respond(to: frame).body()
  }

  /// Convenience for a text transport: JSON in, JSON out.
  public func handle(requestData: Data) async -> Data {
    let request: JSONBody
    do {
      request = try JSONBody(data: requestData, requiringValidJSON: true)
    } catch {
      return ResponseFrame.failure(id: "unknown", code: "badRequest", message: "\(error)")
        .jsonData()
    }
    return await handle(request: request).data
  }

  // MARK: - Dispatch

  private func respond(to frame: RequestFrame) async -> ResponseFrame {
    guard frame.v == CoreConstants.protocolVersion else {
      return .failure(
        id: frame.id, code: "badRequest",
        message:
          "unsupported protocol version \(frame.v); expected \(CoreConstants.protocolVersion)")
    }

    do {
      switch frame.type {
      case "ping":
        return try .success(id: frame.id, result: pong())

      case "hello":
        let payload = try decode(WirePayload.Hello.self, from: frame)
        let snapshot = try await store.summaries(sinceRev: payload.sinceRev)
        return try .success(
          id: frame.id,
          result: WireResult.Hello(
            proto: CoreConstants.protocolVersion,
            app: CoreConstants.appName,
            platform: platform,
            rev: snapshot.rev,
            entries: snapshot.entries.map(WireSummary.init(summary:))))

      case "listEntries":
        let snapshot = try await store.snapshot()
        return try .success(
          id: frame.id,
          result: WireResult.List(
            rev: snapshot.rev, entries: snapshot.entries.map(WireEntry.init(full:))))

      case "getChanges":
        let payload = try decode(WirePayload.SinceRev.self, from: frame)
        let changes = try await store.changes(sinceRev: payload.sinceRev)
        return try .success(
          id: frame.id,
          result: WireResult.Changes(
            rev: changes.rev,
            upserts: changes.upserts.map(WireEntry.init(full:)),
            deletedIds: changes.deletedIds))

      case "createEntry":
        let payload = try decode(WirePayload.CreateEntry.self, from: frame)
        // `values` is opaque, so it is read from the body rather than modeled.
        let created = try await store.create(
          kind: payload.kind,
          code: payload.code,
          meta: payload.meta,
          source: payload.source ?? .inline,
          enabled: payload.enabled ?? true,
          values: try frame.payload.optionalValues(forKey: "values")?.data)
        return try await entryResponse(frame, created)

      case "updateCode":
        let payload = try decode(WirePayload.UpdateCode.self, from: frame)
        let updated = try await store.updateCode(
          id: payload.id, code: payload.code, meta: payload.meta)
        return try await entryResponse(frame, updated)

      case "updateMeta":
        let payload = try decode(WirePayload.UpdateMeta.self, from: frame)
        // Over the wire, metadata comes from the extension's parser.
        let updated = try await store.updateMeta(
          id: payload.id, meta: payload.meta, fromParsing: true)
        return try await entryResponse(frame, updated)

      case "setEnabled":
        let payload = try decode(WirePayload.SetEnabled.self, from: frame)
        let updated = try await store.setEnabled(id: payload.id, enabled: payload.enabled)
        return try await entryResponse(frame, updated)

      case "putEntry":
        let payload = try decode(WirePayload.PutEntry.self, from: frame)
        let stored = try await store.put(entry: payload.entry.fullEntry())
        return try await entryResponse(frame, stored)

      case "reorderEntries":
        let payload = try decode(WirePayload.Reorder.self, from: frame)
        try await store.reorder(ids: payload.ids)
        return try .success(id: frame.id, result: WireResult.Rev(rev: try await store.currentRev()))

      case "deleteEntry":
        let payload = try decode(WirePayload.Id.self, from: frame)
        let deleted = try await store.delete(id: payload.id)
        return try .success(
          id: frame.id,
          result: WireResult.Deleted(rev: try await store.currentRev(), deleted: deleted))

      case "getValues":
        let payload = try decode(WirePayload.Id.self, from: frame)
        let stored = try await store.values(id: payload.id)
        return try .success(
          id: frame.id, result: WireResult.Values(values: JSONBody(data: stored ?? Data())))

      case "exportAll":
        let bundle = try await store.exportBundle()
        return try .success(
          id: frame.id, result: WireResult.Export(bundle: WireBundle(bundle: bundle)))

      case "importAll":
        let payload = try decode(WirePayload.ImportAll.self, from: frame)
        let count = try await store.importBundle(payload.bundle.exportBundle(), mode: payload.mode)
        return try .success(
          id: frame.id,
          result: WireResult.Imported(rev: try await store.currentRev(), count: count))

      default:
        return .failure(id: frame.id, code: "unsupported", message: "unknown op: \(frame.type)")
      }
    } catch let error as StoreError {
      return .failure(id: frame.id, code: Self.code(for: error), message: Self.message(for: error))
    } catch let error as DecodingError {
      return .failure(id: frame.id, code: "badRequest", message: Self.describe(error))
    } catch let error as WireError {
      return .failure(id: frame.id, code: "badRequest", message: "\(error)")
    } catch {
      return .failure(id: frame.id, code: "io", message: String(describing: error))
    }
  }

  // MARK: - Helpers

  private func entryResponse(_ frame: RequestFrame, _ entry: FullEntry) async throws
    -> ResponseFrame
  {
    try .success(
      id: frame.id,
      result: WireResult.Entry(rev: try await store.currentRev(), entry: WireEntry(full: entry)))
  }

  private func pong() -> WireResult.Pong {
    WireResult.Pong(
      proto: CoreConstants.protocolVersion, app: CoreConstants.appName, platform: platform)
  }

  /// Decodes an op payload from the frame body. A payload that does not match
  /// the op's shape is reported as a bad request naming the offending member.
  private func decode<T: Decodable>(_ type: T.Type, from frame: RequestFrame) throws -> T {
    do {
      return try frame.payload.decoded(as: T.self)
    } catch {
      throw StoreError.badRequest("\(frame.type): invalid payload: \(Self.describe(error))")
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

/// Host platform facts the protocol reports.
public struct PlatformCapabilities: Sendable {
  public var wireName: String

  public init(wireName: String) {
    self.wireName = wireName
  }

  public static var current: PlatformCapabilities {
    #if os(macOS)
      PlatformCapabilities(wireName: "macos")
    #elseif os(iOS)
      PlatformCapabilities(wireName: "ios")
    #else
      PlatformCapabilities(wireName: "unknown")
    #endif
  }
}
