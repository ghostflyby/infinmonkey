import Foundation
import Testing

@testable import InfinMonkeyCore

/// Boundary matrix for `StoreLayout.isValidID — the guard between an entry id
/// and the filesystem. Ids become file names under `entries/, so the rules
/// reject anything path-structural (separators, whole-name dots, control
/// characters) while deliberately allowing non-ASCII names: ids are
/// user-visible in the store directory.
///
/// `isValidID validates rather than rewrites, so a hostile id is refused here
/// and by every writer that calls this first.
@Suite struct StoreLayoutSecurityTests {

  @Test(
    "path separators and traversal sequences are rejected",
    arguments: [
      "a/b", "a\\b", "../evil", "../../etc", "/etc/passwd", ".", "..",
    ]
  )
  func rejectsPathStructure(id: String) {
    #expect(!StoreLayout.isValidID(id))
  }

  @Test(
    "colons and control characters are rejected",
    arguments: ["a:b", "a\u{00}b", "a\u{07}b"]
  )
  func rejectsColonsAndControlCharacters(id: String) {
    #expect(!StoreLayout.isValidID(id))
  }

  @Test(
    "legal names survive, including percent-encoding and non-ASCII",
    arguments: [
      "abc-DEF_123",
      "我的脚本",
      "脚本 v2",
      "..%2Fevil", // literal characters: `%` is not a separator, nothing is decoded
    ]
  )
  func acceptsLegalNames(id: String) {
    #expect(StoreLayout.isValidID(id))
  }

  @Test(
    "length boundary: maxIDLength is inclusive",
    arguments: [(127, true), (128, true), (129, false)]
  )
  func lengthBoundary(length: Int, valid: Bool) {
    let raw = String(repeating: "x", count: length)
    #expect(StoreLayout.isValidID(raw) == valid)
  }

  @Test("a hostile id cannot move a code file outside the store")
  func traversalStaysInsideTheStore() throws {
    let layout = StoreLayout(root: temporaryRoot())
    // Whatever the caller asked for, the store derives the path from the record
    // it controls; an id containing separators is refused before a path exists.
    #expect(!StoreLayout.isValidID("../neighbor"))
    let record = makeRecord(id: "safe-id", kind: .script)
    let url = layout.codeURL(record)
    #expect(url.path.hasSuffix("entries/safe-id.user.js"))
    #expect(url.path.contains(layout.root.path))
  }
}
