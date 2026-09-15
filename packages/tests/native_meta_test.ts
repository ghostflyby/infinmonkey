import { assert, assertEquals } from "@std/assert";
import { parseMeta } from "@infinmonkey/shared/meta";
import { urlMatchesMeta } from "@infinmonkey/shared/matcher";

/**
 * Regression for a crash the native bridge could trigger.
 *
 * The native side reports `meta: null` when nothing has parsed an entry's code
 * (a file imported in the app, or adopted from the store directory) and sets
 * `metaStale` when the code changed underneath its metadata. Passing either
 * through unparsed reaches the injector with `matches` missing, and matching a
 * URL then throws instead of injecting the script.
 */

const CODE = `// ==UserScript==
// @name Demo
// @match https://example.com/*
// ==/UserScript==
console.log(1);
`;

Deno.test("unparsed metadata throws when matched (the shape of the bug)", () => {
  // Documents why the bridge must re-parse: this is what a null meta degrades to.
  assertThrows(() => urlMatchesMeta("https://example.com/", {} as never));
});

Deno.test("parsing the code yields usable metadata", () => {
  const meta = parseMeta(CODE);
  assertEquals(meta.name, "Demo");
  assertEquals(meta.matches, ["https://example.com/*"]);
  assert(urlMatchesMeta("https://example.com/page", meta));
  assert(!urlMatchesMeta("https://other.test/", meta));
});

Deno.test("code without @match parses to an empty list rather than missing members", () => {
  // The default path: an entry with no match rules still has every member the
  // matcher iterates, so matching cannot throw.
  const meta = parseMeta("console.log(2);");
  assertEquals(meta.matches, []);
  assertEquals(meta.includes, []);
  assertEquals(meta.excludes, []);
  assert(urlMatchesMeta("https://example.com/", meta));
});

function assertThrows(fn: () => void): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw, "expected the call to throw");
}
