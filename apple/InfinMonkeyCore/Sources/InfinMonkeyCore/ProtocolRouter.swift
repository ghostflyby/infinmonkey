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

  /// Handles a request given as JSON bytes and returns JSON bytes.
  public func handle(requestData: Data) async -> Data {
    let frame: RequestFrame
    do {
      frame = try RequestFrame(json: requestData)
    } catch {
      return ResponseFrame(
        id: "unknown", code: "badRequest", message: "malformed request frame: \(error)"
      ).jsonData()
    }
    return await respond(to: frame).jsonData()
  }

  // MARK: - Dispatch

  private func respond(to frame: RequestFrame) async -> ResponseFrame {
    guard frame.v == CoreConstants.protocolVersion else {
      return ResponseFrame(
        id: frame.id, code: "badRequest",
        message:
          "unsupported protocol version \(frame.v); expected \(CoreConstants.protocolVersion)"
      )
    }

    do {
      switch frame.type {
      case "ping":
        return try ResponseFrame(id: frame.id, result: pong())

      case "hello":
        let payload = try decodePayload(WirePayload.Hello.self, frame)
        let snapshot = try await store.summaries(sinceRev: payload.sinceRev)
        return try ResponseFrame(
          id: frame.id,
          result: encodeObject([
            "proto": CoreConstants.protocolVersion,
            "app": CoreConstants.appName,
            "platform": platform,
            "rev": snapshot.rev,
            "entries": snapshot.entries.map { WireSummary(summary: $0).jsonObject() },
          ]))

      case "listEntries":
        let snapshot = try await store.snapshot()
        return try ResponseFrame(
          id: frame.id,
          result: encodeObject([
            "rev": snapshot.rev,
            "entries": try snapshot.entries.map { try WireEntry(full: $0).jsonObject() },
          ]))

      case "getChanges":
        let payload = try decodePayload(WirePayload.SinceRev.self, frame)
        let changes = try await store.changes(sinceRev: payload.sinceRev)
        return try ResponseFrame(
          id: frame.id,
          result: encodeObject([
            "rev": changes.rev,
            "upserts": try changes.upserts.map { try WireEntry(full: $0).jsonObject() },
            "deletedIds": changes.deletedIds,
          ]))

      case "createEntry":
        let payload = try decodePayload(WirePayload.CreateEntry.self, frame)
        let created = try await store.create(
          kind: payload.kind,
          code: payload.code,
          meta: payload.meta,
          source: payload.source ?? .inline,
          enabled: payload.enabled ?? true,
          values: JSONCoding.opaqueMember("values", in: frame.payload))
        return try await entryResponse(frame, created)

      case "updateCode":
        let payload = try decodePayload(WirePayload.UpdateCode.self, frame)
        let updated = try await store.updateCode(
          id: payload.id, code: payload.code, meta: payload.meta)
        return try await entryResponse(frame, updated)

      case "updateMeta":
        let payload = try decodePayload(WirePayload.UpdateMeta.self, frame)
        // Over the wire, metadata comes from the extension's parser.
        let updated = try await store.updateMeta(
          id: payload.id, meta: payload.meta, fromParsing: true)
        return try await entryResponse(frame, updated)

      case "setEnabled":
        let payload = try decodePayload(WirePayload.SetEnabled.self, frame)
        let updated = try await store.setEnabled(id: payload.id, enabled: payload.enabled)
        return try await entryResponse(frame, updated)

      case "putEntry":
        let object = try decodePayloadObject(frame)
        let entry = try WireEntry(jsonObject: object["entry"] ?? [:])
        let stored = try await store.put(entry: entry.fullEntry())
        return try await entryResponse(frame, stored)

      case "reorderEntries":
        let payload = try decodePayload(WirePayload.Reorder.self, frame)
        try await store.reorder(ids: payload.ids)
        return try ResponseFrame(
          id: frame.id, result: encodeObject(["rev": try await store.currentRev()]))

      case "deleteEntry":
        let payload = try decodePayload(WirePayload.Id.self, frame)
        let deleted = try await store.delete(id: payload.id)
        return try ResponseFrame(
          id: frame.id,
          result: encodeObject(["rev": try await store.currentRev(), "deleted": deleted]))

      case "getValues":
        let payload = try decodePayload(WirePayload.Id.self, frame)
        let stored = try await store.values(id: payload.id)
        let values = Self.parseOpaque(stored) ?? [String: Any]()
        return try ResponseFrame(
          id: frame.id, result: encodeObject(["values": values]))

      case "exportAll":
        let bundle = try await store.exportBundle()
        return try ResponseFrame(
          id: frame.id,
          result: encodeObject(["bundle": try WireBundle(bundle: bundle).jsonObject()]))

      case "importAll":
        let object = try decodePayloadObject(frame)
        guard let mode = (object["mode"] as? String).flatMap(ImportMode.init(rawValue:)) else {
          return ResponseFrame(
            id: frame.id, code: "badRequest", message: "importAll requires mode merge|replace")
        }
        let bundle = try WireBundle(jsonObject: object["bundle"] ?? [:])
        let count = try await store.importBundle(bundle.exportBundle(), mode: mode)
        return try ResponseFrame(
          id: frame.id,
          result: encodeObject(["rev": try await store.currentRev(), "count": count]))

      default:
        return ResponseFrame(
          id: frame.id, code: "unsupported", message: "unknown op: \(frame.type)")
      }
    } catch let error as StoreError {
      return ResponseFrame(
        id: frame.id, code: Self.code(for: error), message: Self.message(for: error))
    } catch let error as DecodingError {
      return ResponseFrame(id: frame.id, code: "badRequest", message: Self.describe(error))
    } catch let error as WireError {
      return ResponseFrame(id: frame.id, code: "badRequest", message: "\(error)")
    } catch {
      return ResponseFrame(id: frame.id, code: "io", message: String(describing: error))
    }
  }

  // MARK: - Helpers

  private func entryResponse(_ frame: RequestFrame, _ entry: FullEntry) async throws
    -> ResponseFrame
  {
    try ResponseFrame(
      id: frame.id,
      result: encodeObject([
        "rev": try await store.currentRev(),
        "entry": try WireEntry(full: entry).jsonObject(),
      ]))
  }

  private func pong() throws -> Data {
    try encodeObject([
      "proto": CoreConstants.protocolVersion,
      "app": CoreConstants.appName,
      "platform": platform,
    ])
  }

  private func decodePayload<T: Decodable>(_ type: T.Type, _ frame: RequestFrame) throws -> T {
    do {
      return try JSONDecoder().decode(T.self, from: frame.payload)
    } catch {
      throw StoreError.badRequest("\(frame.type): invalid payload: \(Self.describe(error))")
    }
  }

  private func decodePayloadObject(_ frame: RequestFrame) throws -> [String: Any] {
    guard let object = try? JSONSerialization.jsonObject(with: frame.payload),
      let dictionary = object as? [String: Any]
    else {
      throw StoreError.badRequest("\(frame.type): payload is not a JSON object")
    }
    return dictionary
  }

  private func encodeObject(_ object: [String: Any]) throws -> Data {
    guard JSONSerialization.isValidJSONObject(object) else {
      throw StoreError.io("result is not valid JSON")
    }
    return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  }

  private static func parseOpaque(_ data: Data?) -> Any? {
    guard let data, !data.isEmpty else { return nil }
    return try? JSONSerialization.jsonObject(with: data)
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
