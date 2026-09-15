/**
 * Permission and security boundaries, parameterized.
 *
 * Every table here pins an invariant that must hold regardless of how a value
 * came to be — a typo in a script header, a hostile import file, or a native
 * app speaking an older protocol. Naming convention per case: the declared
 * metadata, the URL it is evaluated against, and the required decision.
 *
 * Invariants enforced (by the matcher fix in the same commit):
 * 1. An uncompilable declaration restricts; it never widens. ("I wrote a broken
 *    @match" must not become "run on every site".)
 * 2. @exclude applies in every branch, including the no-declaration legacy one.
 * 3. An empty value (bare `@grant) grants nothing.
 * 4. `none` takes precedence over any other @grant line.
 */

import { assert, assertEquals } from "@std/assert";
import { globToRegExp, matchPatternToRegExp, urlMatchesMeta } from "@infinmonkey/shared/matcher";
import { parseMeta } from "@infinmonkey/shared/meta";
import { prepareScripts } from "@infinmonkey/shared/inject";
import { isConnectAllowed } from "@infinmonkey/shared/connect";
import type { ScriptEntry } from "@infinmonkey/shared/types";

// ---------------------------------------------------------------------------
// 1. Chrome match-pattern compilation boundaries
// ---------------------------------------------------------------------------

const PATTERN_CASES: [string, string, boolean][] = [
  // Exact host: the dot is escaped, so lookalike hosts must not match.
  ["https://example.com/*", "https://example.com/a", true],
  ["https://example.com/*", "https://exampleXcom/a", false],
  // Exact host does not extend to subdomains.
  ["https://example.com/*", "https://sub.example.com/a", false],
  // Scheme-asterisk covers its listed schemes only.
  ["*://secure.test/*", "https://secure.test/x", true],
  ["*://secure.test/*", "http://secure.test/x", true],
  ["*://secure.test/*", "ftp://secure.test/x", false],
  // Wildcard subdomain also covers the bare domain (userscript convention).
  ["*://*.example.org/*", "https://a.b.example.org/x", true],
  ["*://*.example.org/*", "https://example.org/x", true],
  ["*://*.example.org/*", "https://example.orgx/", false],
  // Ports are part of the host in our patterns: pinned, not ignored.
  ["http://localhost:8080/*", "http://localhost:8080/x", true],
  ["http://localhost:8080/*", "http://localhost/x", false],
  // <all_urls> covers web and file.
  ["<all_urls>", "https://a.b/", true],
  ["<all_urls>", "file:///x", true],
  // Hosts with a port in the pattern compile and match exactly that port.
  ["http://localhost:8080/x", "http://localhost:8080/x", true],
];

for (const [pattern, url, expected] of PATTERN_CASES) {
  Deno.test(`match pattern boundary: ${pattern} vs ${url} → ${expected}`, () => {
    const re = matchPatternToRegExp(pattern);
    assert(re !== null, `pattern must compile: ${pattern}`);
    assertEquals(re.test(url), expected);
  });
}

const INVALID_PATTERNS: string[] = [
  "", // bare `@match produces this; must not compile
  " ",
  "https://example.com", // grammar requires a path
  "foo://example.com/*", // scheme outside the allowlist
  "<all_urls", // not the <all_urls> sentinel, and no scheme
];

for (const pattern of INVALID_PATTERNS) {
  Deno.test(`match pattern boundary: ${pattern} does not compile`, () => {
    assertEquals(matchPatternToRegExp(pattern), null);
  });
}

// ---------------------------------------------------------------------------
// 2. Glob (@include/@exclude) compilation boundaries
// ---------------------------------------------------------------------------

const GLOB_CASES: [string, string, boolean][] = [
  ["*", "https://anything.test/a", true],
  ["*.example.com/*", "https://www.example.com/a", true],
  ["*.example.com/*", "https://example.com/", true],
  ["*.example.com/*", "https://example.org/", false],
];

for (const [glob, url, expected] of GLOB_CASES) {
  Deno.test(`glob boundary: ${glob} vs ${url} → ${expected}`, () => {
    const re = globToRegExp(glob);
    assert(re !== null, `glob must compile: ${glob}`);
    assertEquals(re.test(url), expected);
  });
}

const INVALID_GLOBS: string[] = ["", " ", "/bad[(/"];

for (const glob of INVALID_GLOBS) {
  const label = JSON.stringify(glob.trim());
  Deno.test(`glob boundary: ${label} does not compile`, () => {
    assertEquals(globToRegExp(glob), null);
  });
}

Deno.test("glob boundary: /regex/ form is case-insensitive (GM semantics)", () => {
  const re = globToRegExp("/EXAMPLE\\.ORG/");
  assert(re !== null);
  assert(re.test("https://example.org/x"));
});

// ---------------------------------------------------------------------------
// 3. Injection decision (urlMatchesMeta) — the scope-of-execution boundary
// ---------------------------------------------------------------------------

type Meta = { matches: string[]; includes: string[]; excludes: string[] };

const INJECTION_CASES: [string, Meta, string, boolean][] = [
  // Invariant 1: an uncompilable declaration restricts, never widens.
  [
    "bare @match only → no injection anywhere",
    { matches: [""], includes: [], excludes: [] },
    "https://evil.test/page",
    false,
  ],
  [
    "bare @include only → no injection anywhere",
    { matches: [], includes: [""], excludes: [] },
    "https://evil.test/page",
    false,
  ],
  [
    "uncompilable scheme declaration → no injection",
    { matches: ["foo://bar/*"], includes: [], excludes: [] },
    "https://evil.test/page",
    false,
  ],
  // A valid declaration is unaffected by an accompanying empty member.
  [
    "valid + bare members → valid scope only",
    { matches: ["https://ok.test/*", ""], includes: [], excludes: [] },
    "https://evil.test/",
    false,
  ],
  // Invariant 2: @exclude applies in every branch.
  [
    "bare @match + @exclude → exclude honored",
    { matches: [""], includes: [], excludes: ["*bank*"] },
    "https://my-bank.test/",
    false,
  ],
  [
    "no declarations + @exclude → exclude honored",
    { matches: [], includes: [], excludes: ["*bank*"] },
    "https://my-bank.test/",
    false,
  ],
  [
    "no declarations + @exclude → other sites still inject",
    { matches: [], includes: [], excludes: ["*bank*"] },
    "https://harmless.test/",
    true,
  ],
  [
    "exclude beats a matching include",
    { matches: [], includes: ["https://x.test/*"], excludes: ["https://x.test/secret*"] },
    "https://x.test/secret",
    false,
  ],
  // The legacy fallback stays limited to web protocols.
  [
    "no declarations → web only",
    { matches: [], includes: [], excludes: [] },
    "https://example.org/",
    true,
  ],
  [
    "no declarations → extension scheme excluded",
    { matches: [], includes: [], excludes: [] },
    "moz-extension://abc/x",
    false,
  ],
  // Ordinary positive/negative behavior.
  [
    "valid scope → matched site injects",
    { matches: ["https://ok.test/*"], includes: [], excludes: [] },
    "https://ok.test/p",
    true,
  ],
  [
    "valid scope → cross-host does not inject",
    { matches: ["https://ok.test/*"], includes: [], excludes: [] },
    "https://evil.test/",
    false,
  ],
  // URL fragments are stripped before matching.
  [
    "fragment stripped before matching",
    { matches: ["https://ok.test/*"], includes: [], excludes: [] },
    "https://ok.test/p#section",
    true,
  ],
];

for (const [desc, meta, url, expected] of INJECTION_CASES) {
  Deno.test(`injection scope: ${desc} [${url} → ${expected}]`, () => {
    assertEquals(urlMatchesMeta(url, meta), expected);
  });
}

// ---------------------------------------------------------------------------
// 4. @connect authorization (cross-origin request boundary)
// ---------------------------------------------------------------------------

const CONNECT_CASES: [string, string[], string[], string, boolean][] = [
  // Nothing declared and no grants: denied (loopbacks aside).
  ["no grants, public host", [], [], "example.com", false],
  // `* declares everything.
  ["wildcard connect", ["*"], [], "anything.test", true],
  // Exact host.
  ["exact host", ["example.com"], [], "example.com", true],
  ["exact host denies others", ["example.com"], [], "evil.test", false],
  ["exact host denies subdomains", ["example.com"], [], "sub.example.com", false],
  // Leading dot: strict mode strips it and matches the bare domain only
  // (subdomain coverage is spelled `*.example.com).
  ["leading dot covers bare domain", [".example.com"], [], "example.com", true],
  ["leading dot denies subdomains", [".example.com"], [], "sub.example.com", false],
  // Wildcard subdomain.
  ["wildcard subdomain", ["*.example.com"], [], "a.example.com", true],
  ["wildcard subdomain covers bare domain", ["*.example.com"], [], "example.com", true],
  ["wildcard subdomain denies lookalike", ["*.example.com"], [], "example.com.evil.test", false],
  // Case and surrounding whitespace are normalized.
  ["case-insensitive", ["EXAMPLE.com"], [], "example.com", true],
  ["whitespace trimmed", [" example.com "], [], "example.com", true],
  // An empty value grants nothing (a bare `@connect line).
  ["empty value grants nothing", [""], [], "example.com", false],
  // Loopbacks are always allowed, with or without declarations.
  ["loopback allowed without grants", [], [], "localhost", true],
  ["ipv4 loopback allowed", [], [], "127.0.0.1", true],
  ["ipv6 loopback allowed", [], [], "[::1]", true],
  // Permanent user grants merge with @connect.
  ["user grant authorizes host", [], ["api.example.org"], "api.example.org", true],
];

for (const [desc, connects, grants, host, expected] of CONNECT_CASES) {
  Deno.test(`@connect boundary: ${desc} [${host} → ${expected}]`, () => {
    assertEquals(isConnectAllowed(connects, grants, host), expected);
  });
}

// ---------------------------------------------------------------------------
// 5. Permission-relevant metadata recording (parseMeta)
// ---------------------------------------------------------------------------

const META_RECORDING_CASES: [string, string, (m: ReturnType<typeof parseMeta>) => void][] = [
  [
    "@noframes present sets the flag",
    "// ==UserScript==\n// @noframes\n// ==/UserScript==",
    (m) => {
      assertEquals(m.noframes, true);
    },
  ],
  [
    "bare @grant records an empty member verbatim",
    "// ==UserScript==\n// @grant\n// ==/UserScript==",
    (m) => {
      assertEquals(m.grants, [""]);
    },
  ],
  [
    "@grant none is recorded for downstream precedence",
    "// ==UserScript==\n// @grant none\n// ==/UserScript==",
    (m) => {
      assertEquals(m.grants, ["none"]);
    },
  ],
  [
    "bare @match records an empty member verbatim",
    "// ==UserScript==\n// @match\n// ==/UserScript==",
    (m) => {
      assertEquals(m.matches, [""]);
    },
  ],
  [
    "locale-suffixed @name lands in nameLocales",
    "// ==UserScript==\n// @name:fr Bonjour\n// ==/UserScript==",
    (m) => {
      assertEquals(m.nameLocales.fr, "Bonjour");
    },
  ],
  [
    "unrecognized keys are parked in `others`, not dropped",
    "// ==UserScript==\n// @somewhere over\n// ==/UserScript==",
    (m) => {
      assertEquals(m.others.somewhere, ["over"]);
    },
  ],
];

for (const [desc, code, check] of META_RECORDING_CASES) {
  Deno.test(`metadata recording: ${desc}`, () => {
    check(parseMeta(code));
  });
}

// ---------------------------------------------------------------------------
// 6. Grant semantics at prepare time (what the sandbox will actually provide)
// ---------------------------------------------------------------------------

function scriptWithGrants(grants: string[]): ScriptEntry {
  const meta = parseMeta("// ==UserScript==\n// @name G\n// ==/UserScript==");
  return {
    id: "g1",
    kind: "script",
    enabled: true,
    position: 1,
    code: "",
    meta: { ...meta, matches: ["https://x.test/*"], grants },
    source: { type: "inline" },
    installedAt: 0,
    updatedAt: 0,
    connectGrants: [],
    values: {},
  };
}

const NO_NETWORK: Parameters<typeof prepareScripts>[3] = () =>
  Promise.reject(new Error("no network in test"));

const GRANT_CASES: [string, string[], string[]][] = [
  ["none wins over other lines", ["none", "GM_xmlhttpRequest"], []],
  ["bare @grant (empty member) grants nothing", [""], []],
  ["named grants survive", ["GM_getValue", "GM_setValue"], ["GM_getValue", "GM_setValue"]],
  ["none alone grants nothing", ["none"], []],
];

for (const [desc, grants, expected] of GRANT_CASES) {
  Deno.test(`grant semantics: ${desc}`, async () => {
    const prepared = await prepareScripts(
      [scriptWithGrants(grants)],
      "https://x.test/",
      true,
      NO_NETWORK,
    );
    const first = prepared[0];
    assertEquals(first?.grants ?? null, expected);
  });
}

// noframes + iframe: a noframes script is skipped in frames even when matched.
Deno.test("injection scope: noframes script skipped in iframes", async () => {
  const script = scriptWithGrants(["none"]);
  script.meta = { ...script.meta, noframes: true };
  const prepared = await prepareScripts([script], "https://x.test/", false, NO_NETWORK);
  assertEquals(prepared.length, 0);
});
