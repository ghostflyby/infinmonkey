import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import {
  isEntryCore,
  isEntrySource,
  isScriptMeta,
  isStoredEntry,
} from "@infinmonkey/shared/guards";
import type { AnyEntry, ScriptMeta } from "@infinmonkey/shared/types";

function validMeta(overrides: Partial<ScriptMeta> = {}): ScriptMeta {
  return {
    name: "Demo",
    runAt: "document-end",
    noframes: false,
    matches: ["https://example.org/*"],
    includes: [],
    excludes: [],
    grants: ["none"],
    connects: [],
    requires: [],
    resources: [],
    nameLocales: {},
    descriptionLocales: {},
    others: {},
    headerRaw: "// ==UserScript==",
    headerFound: true,
    ...overrides,
  };
}

function validScriptEntry(overrides: Record<string, unknown> = {}): AnyEntry {
  return {
    id: "abc123",
    kind: "script",
    enabled: true,
    position: 1,
    code: "console.log(1);",
    meta: validMeta(),
    source: { type: "inline" },
    installedAt: 1730000000000,
    updatedAt: 1730000000000,
    connectGrants: [],
    values: {},
    ...overrides,
  } as AnyEntry;
}

Deno.test("isScriptMeta accepts a full parsed result", () => {
  const meta = validMeta();
  assert(isScriptMeta(meta));
});

Deno.test("isScriptMeta tolerates extra keys from a newer writer", () => {
  const meta = { ...validMeta(), someFutureField: { nested: [1, 2] } } as unknown;
  assert(isScriptMeta(meta));
});

Deno.test("isScriptMeta rejects wrong field types", () => {
  assertEquals(isScriptMeta(validMeta({ matches: "https://x/*" as unknown as string[] })), false);
  assertEquals(
    isScriptMeta(validMeta({ runAt: "whenever" as unknown as ScriptMeta["runAt"] })),
    false,
  );
  assertEquals(isScriptMeta(validMeta({ noframes: "yes" as unknown as boolean })), false);
});

Deno.test("isScriptMeta rejects missing required collections", () => {
  const meta = validMeta();
  delete (meta as unknown as Record<string, unknown>).matches;
  assertEquals(isScriptMeta(meta), false);
});

Deno.test("isScriptMeta rejects non-object resources", () => {
  assertEquals(isScriptMeta(validMeta({ resources: ["style.css"] as unknown as never })), false);
});

Deno.test("isEntrySource accepts inline and dev, rejects unknown types", () => {
  assert(isEntrySource({ type: "inline" }));
  assert(isEntrySource({ type: "dev", url: "http://localhost/x.user.js", autoReload: true }));
  assertEquals(isEntrySource({ type: "weird" }), false);
  assertEquals(isEntrySource({ type: "dev" }), false, "dev requires url");
});

Deno.test("isEntryCore rejects malformed core fields", () => {
  const entry = validScriptEntry();
  for (const key of ["id", "enabled", "position", "code", "installedAt", "updatedAt", "source"]) {
    const broken = { ...entry } as Record<string, unknown>;
    delete broken[key];
    assertEquals(isEntryCore(broken), false, `missing ${key} must fail`);
  }
  const wrongCode = { ...entry, code: 42 } as unknown;
  assertEquals(isEntryCore(wrongCode), false);
  const badSource = { ...entry, source: { type: "dev" } } as unknown;
  assertEquals(isEntryCore(badSource), false);
});

Deno.test("isEntryCore tolerates an empty-string match pattern", () => {
  // This is the parser's current output for a bare `@match`: the guard models
  // the type, not the match-policy fix, so it must not conflate the two.
  const entry = validScriptEntry({ meta: validMeta({ matches: [""] }) });
  assert(isEntryCore(entry));
});

Deno.test("isStoredEntry requires parsed metadata", () => {
  const parsed = validScriptEntry();
  assert(isStoredEntry(parsed));

  const unparsed = validScriptEntry({ meta: null });
  assertEquals(isStoredEntry(unparsed), false, "blank meta is not a parse result");

  const garbageMeta = validScriptEntry({ meta: { name: 42 } as unknown as ScriptMeta });
  assertEquals(isStoredEntry(garbageMeta), false);
});

Deno.test("isStoredEntry requires script-only fields on scripts", () => {
  const noValues = validScriptEntry();
  delete (noValues as unknown as Record<string, unknown>).values;
  assertEquals(isStoredEntry(noValues), false);

  const style: AnyEntry = {
    id: "s1",
    kind: "style",
    enabled: true,
    position: 1,
    code: "body{}",
    meta: validMeta(),
    source: { type: "inline" },
    installedAt: 0,
    updatedAt: 0,
  };
  assert(isStoredEntry(style), "styles carry no values file");
});

Deno.test("empty id fails even when every other field is valid", () => {
  assertEquals(isEntryCore(validScriptEntry({ id: "" })), false);
});

Deno.test("isStoredEntry never throws on exotic shapes", () => {
  // Guards are predicates: any input, including prototype-less and host-object
  // shapes, gets a boolean answer rather than an exception.
  assertEquals(isStoredEntry(Object.create(null)), false);
  assertEquals(isStoredEntry(undefined), false);
  assertEquals(isStoredEntry(42), false);
  assertEquals(isEntrySource("inline"), false);
  assertStrictEquals(isScriptMeta(validMeta()), true);
});
