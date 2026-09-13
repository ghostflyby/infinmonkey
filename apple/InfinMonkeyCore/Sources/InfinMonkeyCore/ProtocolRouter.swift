import Foundation

struct RouterError: Error {
  var code: String
  var message: String

  init(_ code: String, _ message: String) {
    self.code = code
    self.message = message
  }
}

/// JSON envelope router: request frame data in, response frame data out.
/// One method maps 1:1 to the ops declared in packages/protocol (TS).
public final class ProtocolRouter {
  public let store: NativeStore
  public let platform: String

  public init(store: NativeStore, platform: String) {
    self.store = store
    self.platform = platform
  }

  public convenience init(store: NativeStore) {
    #if os(macOS)
      let platform = "macos"
    #elseif os(iOS)
      let platform = "ios"
    #else
      let platform = "unknown"
    #endif
    self.init(store: store, platform: platform)
  }

  /// Handles a raw request payload (the message sent via sendNativeMessage)
  /// and returns the raw response payload. Never throws: failures become
  /// { ok: false, error } frames.
  public func handle(data: Data) -> Data {
    let raw = (try? JSONSerialization.jsonObject(with: data)) ?? nil
    guard let frame = raw as? [String: Any],
      frame["v"] as? Int == CoreConstants.protocolVersion,
      let id = frame["id"] as? String,
      let type = frame["type"] as? String
    else {
      let err = makeErr(id: "unknown", code: "badRequest", message: "malformed request frame")
      return encode(err)
    }

    let payload = frame["payload"] as? [String: Any] ?? [:]
    let result: Result<Any, RouterError>
    switch type {
    case "ping":
      result = .success([
        "proto": CoreConstants.protocolVersion, "app": CoreConstants.appName, "platform": platform,
      ])
    case "hello":
      result = self.hello(payload)
    case "listEntries":
      result = self.listEntries()
    case "getChanges":
      result = self.getChanges(payload)
    case "createEntry":
      result = self.createEntry(payload)
    case "updateCode":
      result = self.updateCode(payload)
    case "putEntry":
      result = self.putEntry(payload)
    case "updateMeta":
      result = self.updateMeta(payload)
    case "setEnabled":
      result = self.setEnabled(payload)
    case "reorderEntries":
      result = self.reorderEntries(payload)
    case "deleteEntry":
      result = self.deleteEntry(payload)
    case "getValues":
      result = self.getValues(payload)
    case "setValue":
      result = self.setValue(payload)
    case "deleteValue":
      result = self.deleteValue(payload)
    case "exportAll":
      result = self.exportAll()
    case "importAll":
      result = self.importAll(payload)
    default:
      result = .failure(RouterError("unsupported", "unknown op: \(type)"))
    }

    switch result {
    case .success(let value):
      return encode(["v": CoreConstants.protocolVersion, "id": id, "ok": true, "result": value])
    case .failure(let e):
      return encode(makeErr(id: id, code: e.code, message: e.message))
    }
  }

  public func handle(message: [String: Any]) -> [String: Any] {
    guard let data = try? JSONSerialization.data(withJSONObject: message) else {
      return makeErr(id: "unknown", code: "badRequest", message: "message is not JSON-encodable")
    }
    guard let out = try? JSONSerialization.jsonObject(with: handle(data: data)),
      let frame = out as? [String: Any]
    else {
      return makeErr(id: "unknown", code: "io", message: "response encoding failed")
    }
    return frame
  }

  // MARK: - Op implementations (payload dicts → Result<Any, (code, message)>)

  private func hello(_ p: [String: Any]) -> Result<Any, RouterError> {
    let since = p["sinceRev"] as? Int
    do {
      let (rev, entries) = try store.hello(sinceRev: since)
      return .success([
        "proto": CoreConstants.protocolVersion,
        "app": CoreConstants.appName,
        "platform": platform,
        "rev": rev,
        "entries": entries.map { $0.toDict() },
      ])
    } catch { return .failure(Self.ioFailure(error)) }
  }

  private func listEntries() -> Result<Any, RouterError> {
    do {
      let (rev, entries) = try store.listEntries()
      return .success(["rev": rev, "entries": entries.map { $0.toDict() }])
    } catch { return .failure(Self.ioFailure(error)) }
  }

  private func getChanges(_ p: [String: Any]) -> Result<Any, RouterError> {
    guard let sinceRev = p["sinceRev"] as? Int else {
      return .failure(RouterError("badRequest", "getChanges requires sinceRev"))
    }
    do {
      let (rev, upserts, deletedIds) = try store.getChanges(sinceRev: sinceRev)
      return .success([
        "rev": rev, "upserts": upserts.map { $0.toDict() }, "deletedIds": deletedIds,
      ])
    } catch { return .failure(Self.ioFailure(error)) }
  }

  private func createEntry(_ p: [String: Any]) -> Result<Any, RouterError> {
    guard let kindRaw = p["kind"] as? String,
      let kind = EntryKind(rawValue: kindRaw),
      let code = p["code"] as? String
    else {
      return .failure(RouterError("badRequest", "createEntry requires kind and code"))
    }
    do {
      let entry = try store.createEntry(
        kind: kind,
        code: code,
        meta: p["meta"] as? [String: Any] ?? [:],
        source: p["source"] as? [String: Any] ?? ["type": "inline"],
        enabled: p["enabled"] as? Bool ?? true,
        values: p["values"] as? [String: Any])
      return .success(["rev": entry.record.rev, "entry": entry.toDict()])
    } catch { return .failure(Self.ioFailure(error)) }
  }

  private func updateCode(_ p: [String: Any]) -> Result<Any, RouterError> {
    guard let id = p["id"] as? String, let code = p["code"] as? String else {
      return .failure(RouterError("badRequest", "updateCode requires id and code"))
    }
    do {
      let entry = try store.updateCode(id: id, code: code, meta: p["meta"] as? [String: Any])
      return .success(["rev": entry.record.rev, "entry": entry.toDict()])
    } catch StoreError.notFound {
      return .failure(RouterError("notFound", "entry not found: \(id)"))
    } catch { return .failure(Self.ioFailure(error)) }
  }

  private func putEntry(_ p: [String: Any]) -> Result<Any, RouterError> {
    guard let entry = p["entry"] as? [String: Any] else {
      return .failure(RouterError("badRequest", "putEntry requires entry"))
    }
    do {
      let full = try store.putEntry(entry: entry)
      return .success(["rev": full.record.rev, "entry": full.toDict()])
    } catch let err as StoreError {
      if case .badRequest(let message) = err { return .failure(RouterError("badRequest", message)) }
      return .failure(Self.ioFailure(err))
    } catch { return .failure(Self.ioFailure(error)) }
  }

  private func updateMeta(_ p: [String: Any]) -> Result<Any, RouterError> {
    guard let id = p["id"] as? String, let meta = p["meta"] as? [String: Any] else {
      return .failure(RouterError("badRequest", "updateMeta requires id and meta"))
    }
    do {
      let entry = try store.updateMeta(id: id, meta: meta)
      return .success(["rev": entry.record.rev, "entry": entry.toDict()])
    } catch StoreError.notFound {
      return .failure(RouterError("notFound", "entry not found: \(id)"))
    } catch { return .failure(Self.ioFailure(error)) }
  }

  private func setEnabled(_ p: [String: Any]) -> Result<Any, RouterError> {
    guard let id = p["id"] as? String, let enabled = p["enabled"] as? Bool else {
      return .failure(RouterError("badRequest", "setEnabled requires id and enabled"))
    }
    do {
      let entry = try store.setEnabled(id: id, enabled: enabled)
      return .success(["rev": entry.record.rev, "entry": entry.toDict()])
    } catch StoreError.notFound {
      return .failure(RouterError("notFound", "entry not found: \(id)"))
    } catch { return .failure(Self.ioFailure(error)) }
  }

  private func reorderEntries(_ p: [String: Any]) -> Result<Any, RouterError> {
    guard let ids = p["ids"] as? [String] else {
      return .failure(RouterError("badRequest", "reorderEntries requires ids"))
    }
    do {
      try store.reorderEntries(ids: ids)
      return .success(["rev": try store.hello(sinceRev: nil).rev])
    } catch StoreError.notFound {
      return .failure(RouterError("notFound", "entry not found"))
    } catch { return .failure(Self.ioFailure(error)) }
  }

  private func deleteEntry(_ p: [String: Any]) -> Result<Any, RouterError> {
    guard let id = p["id"] as? String else {
      return .failure(RouterError("badRequest", "deleteEntry requires id"))
    }
    do {
      let deleted = try store.deleteEntry(id: id)
      return .success(["rev": try store.hello(sinceRev: nil).rev, "deleted": deleted])
    } catch { return .failure(Self.ioFailure(error)) }
  }

  private func getValues(_ p: [String: Any]) -> Result<Any, RouterError> {
    guard let id = p["id"] as? String else {
      return .failure(RouterError("badRequest", "getValues requires id"))
    }
    do {
      return .success(["values": try store.getValues(id: id)])
    } catch StoreError.notFound {
      return .failure(RouterError("notFound", "entry not found: \(id)"))
    } catch { return .failure(Self.ioFailure(error)) }
  }

  private func setValue(_ p: [String: Any]) -> Result<Any, RouterError> {
    guard let id = p["id"] as? String, let key = p["key"] as? String, p.keys.contains("value")
    else {
      return .failure(RouterError("badRequest", "setValue requires id, key and value"))
    }
    do {
      try store.setValue(id: id, key: key, value: Self.jsonSafe(p["value"]))
      return .success(["rev": try store.hello(sinceRev: nil).rev])
    } catch StoreError.notFound {
      return .failure(RouterError("notFound", "entry not found: \(id)"))
    } catch { return .failure(Self.ioFailure(error)) }
  }

  private func deleteValue(_ p: [String: Any]) -> Result<Any, RouterError> {
    guard let id = p["id"] as? String, let key = p["key"] as? String else {
      return .failure(RouterError("badRequest", "deleteValue requires id and key"))
    }
    do {
      let existed = try store.deleteValue(id: id, key: key)
      return .success(["rev": try store.hello(sinceRev: nil).rev, "existed": existed])
    } catch StoreError.notFound {
      return .failure(RouterError("notFound", "entry not found: \(id)"))
    } catch { return .failure(Self.ioFailure(error)) }
  }

  private func exportAll() -> Result<Any, RouterError> {
    do {
      return .success(["bundle": try store.exportAll()])
    } catch { return .failure(Self.ioFailure(error)) }
  }

  private func importAll(_ p: [String: Any]) -> Result<Any, RouterError> {
    guard let bundle = p["bundle"] as? [String: Any],
      let mode = p["mode"] as? String
    else {
      return .failure(RouterError("badRequest", "importAll requires bundle and mode"))
    }
    do {
      let count = try store.importAll(bundle: bundle, mode: mode)
      return .success(["rev": try store.hello(sinceRev: nil).rev, "count": count])
    } catch let err as StoreError {
      if case .badRequest(let message) = err { return .failure(RouterError("badRequest", message)) }
      return .failure(Self.ioFailure(err))
    } catch { return .failure(Self.ioFailure(error)) }
  }

  // MARK: - Helpers

  /// The wire guard mirror of `isWireEntry` in packages/protocol. Contract tests
  /// assert that store output satisfies both.
  public static func isWireEntryShaped(_ f: Any?) -> Bool {
    guard let e = f as? [String: Any],
      let id = e["id"] as? String, !id.isEmpty,
      let kind = e["kind"] as? String, kind == "script" || kind == "style",
      e["enabled"] is Bool,
      e["position"] is Int,
      e["installedAt"] is Int64,
      e["updatedAt"] is Int64,
      e["code"] is String,
      e["meta"] is [String: Any],
      e["source"] is [String: Any]
    else { return false }
    return true
  }

  private static func ioFailure(_ error: Error) -> RouterError {
    if let err = error as? StoreError, case .io(let message) = err {
      return RouterError("io", message)
    }
    return RouterError("io", String(describing: error))
  }

  /// GM values may arrive as Date/Data/etc. through the bridge; only JSON-safe
  /// values may reach the store.
  static func jsonSafe(_ value: Any?) -> Any {
    if let v = value as? NSNull { return v }
    if let v = value as? Bool { return v }
    if let v = value as? Int { return v }
    if let v = value as? Int64 { return v }
    if let v = value as? Double { return v }
    if let v = value as? String { return v }
    if let v = value as? [Any] { return v.map { jsonSafe($0) } }
    if let v = value as? [String: Any] {
      var out: [String: Any] = [:]
      for (k, item) in v { out[k] = jsonSafe(item) }
      return out
    }
    return String(describing: value ?? NSNull())
  }

  private func makeErr(id: String, code: String, message: String) -> [String: Any] {
    [
      "v": CoreConstants.protocolVersion,
      "id": id,
      "ok": false,
      "error": ["code": code, "message": message],
    ]
  }

  private func encode(_ frame: [String: Any]) -> Data {
    guard JSONSerialization.isValidJSONObject(frame),
      let data = try? JSONSerialization.data(withJSONObject: frame, options: [.sortedKeys])
    else {
      let fallback: [String: Any] = [
        "v": CoreConstants.protocolVersion, "id": "unknown", "ok": false,
        "error": ["code": "io", "message": "response encoding failed"],
      ]
      return (try? JSONSerialization.data(withJSONObject: fallback)) ?? Data("{}".utf8)
    }
    return data
  }
}
