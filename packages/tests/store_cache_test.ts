/**
 * Background store cache coherence.
 *
 * Regression: content scripts (installer) write entries straight to
 * storage.local while the background keeps an in-memory DB cache. Without
 * cache invalidation on storage.onChanged, every background read (GM call
 * authorization, @connect checks) served the stale snapshot - and the next
 * background persist() wrote the stale entry list back over newer content.
 * Both surfaces are locked in here through a minimal storage mock.
 */
import { parseMeta } from "@infinmonkey/shared/meta";
import type { ScriptEntry } from "@infinmonkey/shared/types";
import { assert } from "@std/assert";

type Listener = (changes: Record<string, unknown>, area: string) => void;

const storeData: Record<string, unknown> = {};
const onChangedListeners: Listener[] = [];
let storageGets = 0;

function fireOnChanged(changes: Record<string, unknown>, area = "local"): void {
  for (const l of [...onChangedListeners]) l(changes, area);
}

const storageLocal = {
  // The polyfill's wrapper invokes these callback-style (it appends a callback
  // and ignores a returned promise), while a bare call expects a promise.
  get(keys: string[] | null, cb?: (out: Record<string, unknown>) => void): unknown {
    storageGets++;
    const out: Record<string, unknown> = {};
    const want = keys ?? Object.keys(storeData);
    for (const k of want) if (k in storeData) out[k] = structuredClone(storeData[k]);
    if (cb) cb(out);
    else return Promise.resolve(out);
  },
  set(objs: Record<string, unknown>, cb?: () => void): unknown {
    const changes: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(objs)) {
      storeData[k] = structuredClone(v);
      changes[k] = { oldValue: undefined, newValue: structuredClone(v) };
    }
    fireOnChanged(changes);
    if (cb) cb();
    else return Promise.resolve();
  },
};

// The polyfill resolves the API object from the global scope at import time,
// so the mock must be installed before the first (dynamic) import of store.ts.
(globalThis as Record<string, unknown>).chrome = {
  runtime: { id: "test-store-cache" },
  storage: {
    local: storageLocal,
    onChanged: { addListener: (fn: Listener) => void onChangedListeners.push(fn) },
  },
};

const { getDB } = await import("@infinmonkey/background/store");

function demoScriptEntry(id: string) {
  const header = [
    "// ==UserScript==",
    "// @name     store-cache-e2e",
    "// @match    https://example.com/*",
    "// @grant    none",
    "// ==/UserScript==",
    "void 0;",
  ].join("\n");
  return {
    id,
    kind: "script" as const,
    enabled: true,
    position: 1,
    code: header,
    meta: parseMeta(header, "store-cache-e2e"),
    source: { type: "inline" as const },
    installedAt: 0,
    updatedAt: 0,
    connectGrants: [] as string[],
    values: {},
  };
}

Deno.test("background store sees entries written by other contexts", async () => {
  // Phase 1: warm the in-memory cache while storage is still empty - this is
  // the state the background settles into right after extension load.
  const empty = await getDB();
  assert(empty.scripts.length === 0, "precondition: storage starts empty");

  // Phase 2: an installer-style direct write from a content script.
  await storageLocal.set({ scripts: [demoScriptEntry("ctx-written-1")] });

  // Phase 3: the background must observe the entry - GM call authorization
  // and @connect checks resolve ids through getDB.
  const after = await getDB();
  assert(
    (after.scripts as ScriptEntry[]).some((s) => s.id === "ctx-written-1"),
    "getDB must invalidate its cache on storage.onChanged",
  );
});

Deno.test("background store drops malformed entries but keeps valid ones", async () => {
  await storageLocal.set({
    scripts: [demoScriptEntry("valid-1"), { id: "broken", kind: "script" }],
  });
  const db = await getDB();
  const scripts = db.scripts as ScriptEntry[];
  assert(scripts.some((s) => s.id === "valid-1"), "valid entry is kept");
  assert(!scripts.some((s) => s.id === "broken"), "malformed entry is dropped");
});

Deno.test("cache invalidation keys: store keys yes, other keys and areas no", async () => {
  // Warm the cache and record its storage-read baseline.
  await storageLocal.set({ settings: { devOrigin: "http://127.0.0.1:9999" } });
  await getDB();
  const baseline = storageGets;

  // A write to a non-store key must keep the cache warm.
  await storageLocal.set({ imLastError: "diagnostic" });
  await getDB();
  assert(storageGets === baseline, "non-store keys must not invalidate the cache");

  // A change event on another storage area must keep the cache warm.
  fireOnChanged({ scripts: { newValue: [] } }, "sync");
  await getDB();
  assert(storageGets === baseline, "non-local area must not invalidate the cache");

  // An external settings write must invalidate and become visible.
  await storageLocal.set({ settings: { devOrigin: "http://127.0.0.1:7777" } });
  const db = await getDB();
  assert(storageGets > baseline, "settings write must invalidate the cache");
  assert(
    (db.settings as { devOrigin?: string }).devOrigin === "http://127.0.0.1:7777",
    "fresh settings are visible after invalidation",
  );
});
