import { assert, assertEquals } from "@std/assert";
import { detectKind, extractHeader, parseHeaderPairs, parseMeta } from "@infinmonkey/shared/meta";

Deno.test("parseMeta: full script header", () => {
  // xx-XX is a synthetic placeholder tag: locale-suffix parsing is language-agnostic.
  const code = `// ==UserScript==
// @name         Test Script
// @name:xx-XX   Placeholder Name
// @namespace    https://example.com/ns
// @version      1.2.3
// @description  A test
// @description:xx-XX Placeholder description
// @author       someone
// @match        https://example.com/*
// @match        https://*.example.org/foo*
// @include      /regex-include/
// @exclude      https://example.com/admin*
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      api.example.com
// @connect      *.cdn.example.net
// @require      https://cdn.example.com/lib.js
// @resource     mycss https://example.com/x.css
// @run-at       document-start
// @noframes
// @unknownFlag  hello
// ==/UserScript==
console.log('hi');`;
  const m = parseMeta(code, "fallback");
  assertEquals(m.name, "Test Script");
  assertEquals(m.nameLocales["xx-XX"], "Placeholder Name");
  assertEquals(m.version, "1.2.3");
  assertEquals(m.description, "A test");
  assertEquals(m.descriptionLocales["xx-XX"], "Placeholder description");
  assertEquals(m.runAt, "document-start");
  assert(m.noframes);
  assertEquals(m.matches, ["https://example.com/*", "https://*.example.org/foo*"]);
  assertEquals(m.includes, ["/regex-include/"]);
  assertEquals(m.excludes, ["https://example.com/admin*"]);
  assertEquals(m.grants, ["GM_getValue", "GM_xmlhttpRequest"]);
  assertEquals(m.connects, ["api.example.com", "*.cdn.example.net"]);
  assertEquals(m.requires, ["https://cdn.example.com/lib.js"]);
  assertEquals(m.resources, [{ name: "mycss", url: "https://example.com/x.css" }]);
  assertEquals(m.others["unknownFlag"], ["hello"]);
  assert(m.headerFound);
});

Deno.test("parseMeta: UserStyle header (block comment form)", () => {
  const code = `/* ==UserStyle==
@name         Dark Mode
@namespace    infinmonkey
@version      2.0.0
@author       me
@license      MIT
==/UserStyle== */

@-moz-document domain("example.com") {
  body { background: #000; }
}`;
  const m = parseMeta(code);
  assertEquals(detectKind(code), "style");
  assertEquals(m.name, "Dark Mode");
  assertEquals(m.version, "2.0.0");
  assertEquals(m.license, "MIT");
  assert(m.headerFound);
});

Deno.test("parseMeta: no header and empty grant none", () => {
  const noHeader = parseMeta("alert(1)");
  assert(!noHeader.headerFound);
  assertEquals(noHeader.runAt, "document-end");

  const g = parseMeta(`// ==UserScript==\n// @grant none\n// ==/UserScript==\n`);
  assertEquals(g.grants, ["none"]);
});

Deno.test("extractHeader kind detection", () => {
  assertEquals(extractHeader("// ==UserScript==\n// @name a\n// ==/UserScript==")?.kind, "script");
  assertEquals(extractHeader("/* ==UserStyle==\n@name a\n==/UserStyle== */")?.kind, "style");
  assertEquals(extractHeader("nothing"), null);
});

Deno.test("parseHeaderPairs: block comment asterisk prefix", () => {
  const pairs = parseHeaderPairs("@name X\n* @version 1.0\n  @flag");
  assertEquals(pairs.length, 3);
  assertEquals(pairs[0], { key: "name", value: "X" });
  assertEquals(pairs[1], { key: "version", value: "1.0" });
  assertEquals(pairs[2], { key: "flag", value: "" });
});
