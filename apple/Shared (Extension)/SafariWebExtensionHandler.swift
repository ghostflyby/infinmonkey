//
//  SafariWebExtensionHandler.swift
//  Shared (Extension)
//
//  Routes browser.runtime.sendNativeMessage frames from the extension into the
//  InfinMonkeyCore library.
//

import Foundation
import InfinMonkeyCore
import SafariServices
import os.log

/// Carries the request context across the async hop.
///
/// `NSExtensionContext` is an Objective-C type the SDK does not mark `Sendable`,
/// but Apple documents `completeRequest(returningItems:completionHandler:)` as
/// callable from any thread. A request can only be completed once and this
/// handler holds the sole reference, so handing it to a single task is safe.
private struct RequestContext: @unchecked Sendable {
  let context: NSExtensionContext

  func complete(with response: [String: Any]) {
    let item = NSExtensionItem()
    if #available(iOS 15.0, macOS 11.0, *) {
      item.userInfo = [SFExtensionMessageKey: response]
    } else {
      item.userInfo = ["message": response]
    }
    context.completeRequest(returningItems: [item], completionHandler: nil)
  }
}

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

  /// One router for the process: it is an actor, so concurrent requests
  /// serialize on it, and the store reloads from disk per operation rather than
  /// caching a document that other processes can invalidate.
  private static let router = ProtocolRouter(store: SafariWebExtensionHandler.makeStore())

  private static func makeStore() -> NativeStore {
    do {
      let layout = try StoreLayout.resolve()
      os_log(.default, "InfinMonkey native store at %@", layout.root.path)
      return NativeStore(layout: layout)
    } catch {
      // A missing app group identity is a build fault. Fall back to a path that
      // is certainly writable so the extension keeps working, and log loudly.
      os_log(.error, "InfinMonkey: app group identity missing (%@)", "\(error)")
      return NativeStore(root: StoreLayout.fallbackRoot())
    }
  }

  func beginRequest(with context: NSExtensionContext) {
    let request = context.inputItems.first as? NSExtensionItem

    let profile: UUID?
    if #available(iOS 17.0, macOS 14.0, *) {
      profile = request?.userInfo?[SFExtensionProfileKey] as? UUID
    } else {
      profile = request?.userInfo?["profile"] as? UUID
    }

    let message: Any?
    if #available(iOS 15.0, macOS 11.0, *) {
      message = request?.userInfo?[SFExtensionMessageKey]
    } else {
      message = request?.userInfo?["message"]
    }

    // Every profile shares the single app group store; per-profile routing
    // would mean per-profile store roots.
    if let profile {
      os_log(.default, "InfinMonkey native request from profile %@", profile.uuidString)
    }

    // This boundary hands over `[AnyHashable: Any]`, which is neither Sendable
    // nor typed. Convert to bytes here — the single place untyped data exists —
    // so everything past this point is typed and Sendable.
    let requestData = Self.jsonData(from: message)
    let requestContext = RequestContext(context: context)

    Task {
      let responseData = await SafariWebExtensionHandler.router.handle(requestData: requestData)
      let response =
        (try? JSONSerialization.jsonObject(with: responseData)) as? [String: Any] ?? [:]
      requestContext.complete(with: response)
    }
  }

  private static func jsonData(from message: Any?) -> Data {
    guard let message = message as? [String: Any], JSONSerialization.isValidJSONObject(message),
      let data = try? JSONSerialization.data(withJSONObject: message)
    else {
      return Data("{}".utf8)
    }
    return data
  }

}
