//
//  SafariWebExtensionHandler.swift
//  Shared (Extension)
//
//  Routes browser.runtime.sendNativeMessage frames from the extension to the
//  InfinMonkeyCore store (packages/protocol wire format).
//

import InfinMonkeyCore
import SafariServices
import os.log

let storeAppGroupId = "group.dev.ghostflyby.InfinMonkey"

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

  private lazy var router: ProtocolRouter = {
    let layout = StoreLayout.resolve(appGroupId: storeAppGroupId)
    os_log(.default, "InfinMonkey native store at %@", layout.root.path)
    return ProtocolRouter(store: NativeStore(layout: layout))
  }()

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

    // Per-profile routing would need per-profile store roots; today every
    // profile shares the single app group store.
    let response: [String: Any]
    if let frame = message as? [String: Any] {
      response = router.handle(message: frame)
    } else {
      response = router.handle(message: [:])
    }
    if let profile {
      os_log(.default, "InfinMonkey native request from profile %@ handled", profile.uuidString)
    }

    let responseItem = NSExtensionItem()
    if #available(iOS 15.0, macOS 11.0, *) {
      responseItem.userInfo = [SFExtensionMessageKey: response]
    } else {
      responseItem.userInfo = ["message": response]
    }

    context.completeRequest(returningItems: [responseItem], completionHandler: nil)
  }

}
