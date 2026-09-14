//
//  SafariWebExtensionHandler.swift
//  Shared (Extension)
//
//  Routes browser.runtime.sendNativeMessage messages from the extension into the
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
/// callable from any thread. A request completes once and this handler holds the
/// sole reference, so handing it to a single task is safe.
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
  /// caching a document other processes can invalidate.
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

    // Every profile shares the single app group store; per-profile routing would
    // mean per-profile store roots.
    if let profile {
      os_log(.default, "InfinMonkey native request from profile %@", profile.uuidString)
    }

    // This boundary arrives as an Objective-C object graph, which is neither
    // Sendable nor typed and so cannot cross into the router's isolation. Wrapping
    // it in a `JSONBody` freezes it and makes it Sendable; the router then reads
    // the envelope from the graph in place — nothing is serialized to get in, and
    // only the members that need a concrete type are converted.
    let body = (try? JSONBody(object: message as? [String: Any] ?? [:])) ?? .emptyObject
    let requestContext = RequestContext(context: context)

    Task {
      let response = await SafariWebExtensionHandler.router.handle(request: body)
      // The response crosses back out as a graph for `userInfo`, which is
      // Objective-C typed. This is the boundary's own conversion.
      requestContext.complete(with: response.object as? [String: Any] ?? [:])
    }
  }

}
