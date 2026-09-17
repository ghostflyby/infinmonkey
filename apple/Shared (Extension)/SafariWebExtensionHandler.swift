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
import os

/// Carries the request context across the async hop.
///
/// `NSExtensionContext` is an Objective-C type the SDK does not mark `Sendable`.
/// A request completes exactly once and this handler holds the sole reference,
/// so handing it to a single task is sound: that task is the only user of the
/// context, and its only use is `completeRequest(returningItems:completionHandler:)`.
private struct RequestContext: @unchecked Sendable {
  let context: NSExtensionContext

  func complete(with response: [String: Any]) {
    let item = NSExtensionItem()
    item.userInfo = [SFExtensionMessageKey: response]
    context.completeRequest(returningItems: [item], completionHandler: nil)
  }
}

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

  /// Unified logging, read through Console.app — an extension process has no
  /// stderr a reader reaches, unlike the host and CLI roles.
  ///
  /// The subsystem is this bundle's identifier, and the categories split the
  /// two things the handler does: locating the store once at startup, and the
  /// per-request bridge work.
  private static let subsystem = Bundle.main.bundleIdentifier ?? "infinmonkey"
  private static let storeLog = Logger(subsystem: subsystem, category: "store")
  private static let bridgeLog = Logger(subsystem: subsystem, category: "bridge")

  /// One router for the process: it is an actor, so concurrent requests
  /// serialize on it, and the store reloads from disk per operation rather than
  /// caching a document other processes can invalidate.
  private static let router = ProtocolRouter(store: SafariWebExtensionHandler.makeStore())

  /// Locates the shared store. The app group identity is expected to exist: a
  /// build without one cannot share a library with the app, so there is no
  /// fallback directory — the router gets a store whose every operation fails
  /// with the reason, and every request surfaces it.
  private static func makeStore() -> any EntryStoring {
    do {
      let layout = try StoreLocation.layout()
      storeLog.info("native store at \(layout.root.path, privacy: .public)")
      return NativeStore(layout: layout)
    } catch {
      storeLog.fault("shared store unavailable: \(String(describing: error), privacy: .public)")
      return UnavailableStore(reason: "\(error)")
    }
  }

  func beginRequest(with context: NSExtensionContext) {
    let request = context.inputItems.first as? NSExtensionItem

    let profile = request?.userInfo?[SFExtensionProfileKey] as? UUID
    let message = request?.userInfo?[SFExtensionMessageKey]

    // Every profile shares the single app group store; per-profile routing would
    // mean per-profile store roots.
    if let profile {
      Self.bridgeLog.debug("native request from profile \(profile.uuidString, privacy: .public)")
    } else {
      Self.bridgeLog.debug("native request without a profile")
    }

    // This boundary arrives as an Objective-C object graph, which is neither
    // Sendable nor typed and so cannot cross into the router's isolation. Wrapping
    // it in a `JSONBody` freezes it and makes it Sendable; the router decodes the
    // frame from that body in one pass.
    let body = (try? JSONBody(object: message as? [String: Any] ?? [:])) ?? .emptyObject
    let requestContext = RequestContext(context: context)

    Task {
      let response = await SafariWebExtensionHandler.router.handle(request: body)
      let reply = response.object as? [String: Any]
      let id = (reply?["id"] as? String) ?? "?"
      let outcome = (reply?["ok"] as? Bool) == true ? "ok" : "error"
      SafariWebExtensionHandler.bridgeLog.debug(
        "completed request \(id, privacy: .public) (\(outcome))")
      // The response crosses back out as a graph for `userInfo`, which is
      // Objective-C typed. This is the boundary's own conversion.
      requestContext.complete(with: reply ?? [:])
    }
  }

}
