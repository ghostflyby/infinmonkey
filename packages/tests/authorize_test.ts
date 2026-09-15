import { assertEquals } from "@std/assert";
import { authorizeGmCall, type GmAuthorization } from "@infinmonkey/shared/authorize";
import type { AnyEntry, ScriptMeta } from "@infinmonkey/shared/types";

function meta(overrides: Partial<ScriptMeta> = {}): ScriptMeta {
  return {
    name: "Demo",
    runAt: "document-end",
    noframes: false,
    matches: ["https://example.com/*"],
    includes: [],
    excludes: [],
    grants: ["GM_getValue"],
    connects: [],
    requires: [],
    resources: [],
    nameLocales: {},
    descriptionLocales: {},
    others: {},
    headerRaw: "",
    headerFound: true,
    ...overrides,
  };
}

function entry(overrides: Partial<AnyEntry> = {}): AnyEntry {
  return {
    id: "e1",
    kind: "script",
    enabled: true,
    position: 1,
    code: "",
    meta: meta(),
    source: { type: "inline" },
    installedAt: 0,
    updatedAt: 0,
    connectGrants: [],
    values: {},
    ...overrides,
  } as AnyEntry;
}

// The permission matrix is the matcher matrix applied as an authorization
// decision: a page must be inside the script's own declared scope for its GM
// APIs to be callable, and an uncompilable declaration restricts.
const CASES: [string, AnyEntry, string | undefined, GmAuthorization][] = [
  ["same-page URL", entry(), "https://example.com/page", { ok: true }],
  ["path with query", entry(), "https://example.com/p?x=1", { ok: true }],
  ["URL with fragment", entry(), "https://example.com/p#section", { ok: true }],
  ["cross-host URL", entry(), "https://evil.test/", {
    ok: false,
    code: "urlMismatch",
    reason: "script does not run on this page",
  }],
  ["subdomain of exact-host pattern", entry(), "https://sub.example.com/", {
    ok: false,
    code: "urlMismatch",
    reason: "script does not run on this page",
  }],
  ["lookalike host", entry(), "https://exampleXcom/", {
    ok: false,
    code: "urlMismatch",
    reason: "script does not run on this page",
  }],
  ["excluded URL", entry({ meta: meta({ excludes: ["*bank*"] }) }), "https://my-bank.test/", {
    ok: false,
    code: "urlMismatch",
    reason: "script does not run on this page",
  }],
  ["bare @match restricts", entry({ meta: meta({ matches: [""] }) }), "https://example.com/", {
    ok: false,
    code: "urlMismatch",
    reason: "script does not run on this page",
  }],
  [
    "include-only scope",
    entry({ meta: meta({ matches: [], includes: ["*.wiki*"] }) }),
    "https://zh.wikipedia.org/x",
    { ok: true },
  ],
  ["unknown calling URL fails closed", entry(), undefined, {
    ok: false,
    code: "urlUnknown",
    reason: "calling page URL is unknown",
  }],
  ["disabled script denies even on-scope", entry({ enabled: false }), "https://example.com/", {
    ok: false,
    code: "disabled",
    reason: "script is disabled",
  }],
];

for (const [desc, ent, url, expected] of CASES) {
  Deno.test(`GM authorization: ${desc} → ${expected.ok ? "allow" : `deny(${expected.ok === false ? expected.code : ""})`}`, () => {
    assertEquals(authorizeGmCall(ent, url), expected);
  });
}

Deno.test("GM authorization: style entries never carry GM calls", () => {
  const style: AnyEntry = {
    id: "s1",
    kind: "style",
    enabled: true,
    position: 1,
    code: "body{}",
    meta: meta(),
    source: { type: "inline" },
    installedAt: 0,
    updatedAt: 0,
  };
  const auth = authorizeGmCall(style, "https://example.com/");
  assertEquals(auth, { ok: false, code: "notScript", reason: "not a userscript" });
});

Deno.test("GM authorization: an uncompilable @include restricts", () => {
  // Bare @include records [""] - uncompilable, so the declaration restricts
  // instead of widening, composed with the matcher's conservative semantics.
  const ent = entry({ meta: meta({ matches: [], includes: [""] }) });
  const auth = authorizeGmCall(ent, "https://evil.test/");
  assertEquals(auth, {
    ok: false,
    code: "urlMismatch",
    reason: "script does not run on this page",
  });
});
