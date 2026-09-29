/**
 * Background router: sender gating and the GM surface hardening.
 *
 * main.ts registers its runtime.onMessage listener at module load, so the
 * whole background is imported here against a chrome mock (same technique as
 * store_cache_test.ts) and the captured listener is exercised directly.
 *
 * The gate under test: content scripts may invoke only FetchText and gmCall;
 * every other op requires an extension-page sender (sender.url on the
 * extension origin - the browser-authoritative field the decision is made
 * on). Missing sender.url fails closed for gated ops.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { parseMeta } from "@infinmonkey/shared/meta";
import type { ScriptEntry } from "@infinmonkey/shared/types";

type Listener = (msg: unknown, sender: Record<string, unknown>) => unknown;

const storeData: Record<string, unknown> = {};
const onChangedListeners: ((c: Record<string, unknown>, area: string) => void)[] = [];
const onMessageListeners: Listener[] = [];
const tabRemovedListeners: ((tabId: number) => void)[] = [];
const alarmListeners: ((alarm: { name: string }) => void)[] = [];
let alarmScheduled: { name: string; periodInMinutes?: number } | undefined;

function fireAlarm(name: string): void {
  for (const fn of alarmListeners) fn({ name });
}
const removedTabIds: number[] = [];
const createdTabProps: Record<string, unknown>[] = [];
/** Tabs.get payload extras (e.g. openerTabId); null = plain {id}. */
let tabGetExtras: Record<string, unknown> | null = null;

function fireOnChanged(changes: Record<string, unknown>, area = "local"): void {
  for (const l of [...onChangedListeners]) l(changes, area);
}

const storageLocal = {
  // Polyfill convention as in store_cache_test.ts: the wrapper appends a
  // callback and ignores a returned promise, a bare call expects a promise.
  get(keys: string[] | null, cb?: (out: Record<string, unknown>) => void): unknown {
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

(globalThis as Record<string, unknown>).chrome = {
  runtime: {
    id: "infin-test",
    getURL: (p: string) => `moz-extension://infin-test/${String(p).replace(/^\//, "")}`,
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    onMessage: { addListener: (fn: Listener) => void onMessageListeners.push(fn) },
    sendMessage: () => new Promise(() => {}),
  },
  storage: {
    local: storageLocal,
    onChanged: {
      addListener: (fn: typeof onChangedListeners[number]) => void onChangedListeners.push(fn),
    },
  },
  alarms: {
    create: (name: string, info: { periodInMinutes?: number }) => {
      alarmScheduled = { name, ...info };
    },
    get: (name: string, cb?: (a: unknown) => void) => {
      const a = alarmScheduled && alarmScheduled.name === name ? alarmScheduled : null;
      if (cb) cb(a);
      else return Promise.resolve(a);
    },
    onAlarm: {
      addListener: (fn: (alarm: { name: string }) => void) => void alarmListeners.push(fn),
    },
  },
  tabs: {
    onUpdated: { addListener: () => {} },
    onRemoved: { addListener: (fn: (tabId: number) => void) => void tabRemovedListeners.push(fn) },
    get: (id: number, cb?: (t: unknown) => void) => {
      const tab = { id, ...(tabGetExtras ?? {}) };
      if (cb) cb(tab);
      else return Promise.resolve(tab);
    },
    create: (props: Record<string, unknown>, cb?: (t: unknown) => void) => {
      createdTabProps.push(props);
      const tab = { id: 4242 };
      if (cb) cb(tab);
      else return Promise.resolve(tab);
    },
    remove: (id: number, cb?: () => void) => {
      removedTabIds.push(id);
      if (cb) cb();
      else return Promise.resolve();
    },
  },
  notifications: { onClicked: { addListener: () => {} } },
};

// devClient's startup connect() runs during module load; the stub never opens
// or errors, so no reconnect timer is left pending for the test sanitizer.
(globalThis as Record<string, unknown>).WebSocket = class {
  onopen: unknown = null;
  onmessage: unknown = null;
  onclose: unknown = null;
  onerror: unknown = null;
  close(): void {}
};

// The polyfill's listener wrapper swallows return values (it returns true to
// hold the message channel open), so tests drive the exported route directly.
const { route, UPDATE_ALARM } = await import("@infinmonkey/background/main");
assert(
  onMessageListeners.length === 1,
  "main.ts must register its runtime.onMessage listener",
);

const realFetch = globalThis.fetch;

function scriptEntry(id: string): unknown {
  const header = [
    "// ==UserScript==",
    `// @name     ${id}`,
    "// @match    https://example.com/*",
    "// @grant    none",
    "// ==/UserScript==",
    "void 0;",
  ].join("\n");
  return {
    id,
    kind: "script",
    enabled: true,
    position: 1,
    code: header,
    meta: parseMeta(header, id),
    source: { type: "inline" },
    installedAt: 0,
    updatedAt: 0,
    connectGrants: [] as string[],
    values: {},
  };
}

/** A content-script sender: page URL, tab resolves (unlike on Zen). */
const contentSender = { url: "https://example.com/page", tab: { id: 7 } };
/** An extension-page sender: extension origin, no tab. */
const pageSender = { url: "moz-extension://infin-test/options/index.html" };

function seedScripts(): void {
  storageLocal.set({ scripts: [scriptEntry("s1"), scriptEntry("s2")] });
}

function gm(
  op: string,
  args: Record<string, unknown>,
  opts?: { scriptId?: string; nonce?: string },
) {
  return {
    type: "gmCall",
    nonce: opts?.nonce ?? "nA",
    scriptId: opts?.scriptId ?? "s1",
    reqId: 1,
    op,
    args,
  };
}

Deno.test("gate: management ops are unreachable from content scripts", async () => {
  seedScripts();
  const ops = [
    "ListEntries",
    "GetEntry",
    "SaveCode",
    "DeleteEntry",
    "ImportAll",
    "ExportAll",
    "SetSettings",
    "ConfirmInstall",
    "ConfirmConnectAuth",
    "GetNativeStatus",
  ];
  for (const type of ops) {
    assertEquals(
      route({ type, id: "s1" }, contentSender),
      undefined,
      `${type} must be denied to a content script`,
    );
  }
  // Fail closed: a gated op with no sender URL at all is also denied.
  assertEquals(route({ type: "ListEntries" }, {}), undefined, "missing sender.url must deny");
  await Promise.resolve();
});

Deno.test("gate: extension pages keep full access, content scripts keep the allowlist", async () => {
  seedScripts();
  // Management op from an extension page goes through.
  const listed = await route({ type: "ListEntries" }, pageSender) as {
    scripts: ScriptEntry[];
    styles: unknown[];
  };
  assertEquals(listed.scripts.length, 2, "extension page reads the library");

  // gmCall from a content script passes the gate (then hits GM authorization:
  // unknown script ids must still be rejected by the authorize layer).
  await assertRejects(
    () => Promise.resolve(route(gm("getValue", { key: "k" }, { scriptId: "nope" }), contentSender)),
    Error,
    "unknown script",
  );
});

Deno.test("FetchText: http(s)-only with a response size cap", async () => {
  seedScripts();
  const fake = (headers: Record<string, string>, text: string) =>
    (globalThis as Record<string, unknown>).fetch = () =>
      Promise.resolve({
        headers: { get: (n: string) => headers[n] ?? null },
        text: () => text,
      });
  try {
    fake({}, "hello");
    assertEquals(
      await route({ type: "FetchText", url: "https://x.test/a" }, contentSender),
      { text: "hello", mime: "text/plain" },
    );

    fake({}, "ignored");
    assertEquals(
      await route({ type: "FetchText", url: "file:///etc/passwd" }, contentSender),
      { error: "only http(s) URLs are supported" },
    );
    assertEquals(
      await route({ type: "FetchText", url: "not a url" }, contentSender),
      { error: "invalid URL" },
    );

    fake({ "content-length": "5000001" }, "ignored");
    assertEquals(
      await route({ type: "FetchText", url: "https://x.test/big" }, contentSender),
      { error: "response too large" },
    );

    // Chunked response (no content-length header): caught after buffering.
    fake({}, "x".repeat(5_000_001));
    assertEquals(
      await route({ type: "FetchText", url: "https://x.test/big2" }, contentSender),
      { error: "response too large" },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("GM_getTab/getTabs: saved data is scoped per script and nonce", async () => {
  seedScripts();
  await route(gm("saveTab", { tab: { mine: 1 } }), contentSender);
  await route(gm("saveTab", { tab: { other: 2 } }, { scriptId: "s2", nonce: "nB" }), contentSender);
  // Two scripts sharing one document (same nonce) must not clobber each other.
  await route(gm("saveTab", { tab: { same: 3 } }, { scriptId: "s2", nonce: "nA" }), contentSender);

  // Same script, own nonce: visible.
  assertEquals(
    await route(gm("getTab", {}, { nonce: "nA" }), contentSender),
    { tab: { mine: 1 } },
  );
  // Same script, another document's nonce: invisible.
  assertEquals(await route(gm("getTab", {}, { nonce: "nB" }), contentSender), { tab: {} });
  // Another script on this document: sees only its own entry.
  assertEquals(
    await route(gm("getTab", {}, { scriptId: "s2", nonce: "nA" }), contentSender),
    { tab: { same: 3 } },
  );
  // getTabs sees only the calling script's entries (keys are opaque strings).
  assertEquals(
    await route(gm("getTabs", {}, { scriptId: "s1" }), contentSender),
    { tabs: { "nA:s1": { mine: 1 } } },
  );
});

Deno.test("tabs.onRemoved evicts GM tab data and script-opened tabs", async () => {
  seedScripts();
  await route(gm("saveTab", { tab: { mine: 1 } }), contentSender);
  await route(gm("openInTab", { url: "https://x.test/t" }), contentSender);

  // The owning tab goes away: its saved data must not linger.
  for (const fn of tabRemovedListeners) fn(7);
  assertEquals(await route(gm("getTab", {}), contentSender), { tab: {} });

  // The opened tab goes away: closing it afterwards must be denied again.
  for (const fn of tabRemovedListeners) fn(4242);
  await assertRejects(
    () => Promise.resolve(route(gm("closeTab", { tabId: 4242 }), contentSender)),
    Error,
    "not opened by this script",
  );
});

Deno.test("GM_closeTab: own tab, script-opened tab, or browser-recorded opener only", async () => {
  seedScripts();
  // Own tab (sender.tab) is allowed...
  assertEquals(await route(gm("closeTab", { tabId: 7 }), contentSender), { ok: true });
  assertEquals(removedTabIds, [7]);
  // ...any other tab is denied while neither registry nor opener knows it.
  await assertRejects(
    () => Promise.resolve(route(gm("closeTab", { tabId: 999 }), contentSender)),
    Error,
    "not opened by this script",
  );
  assertEquals(removedTabIds, [7], "denied close must not reach tabs.remove");

  // Tabless sender (Zen omits sender.tab): nothing resolves "own", deny.
  await assertRejects(
    () => Promise.resolve(route(gm("closeTab", { tabId: 999 }), { url: contentSender.url })),
    Error,
    "not opened by this script",
  );

  // The browser-recorded opener (survives background suspension) authorizes.
  tabGetExtras = { openerTabId: 7 };
  try {
    assertEquals(await route(gm("closeTab", { tabId: 999 }), contentSender), { ok: true });
    assertEquals(removedTabIds, [7, 999]);
    // A tab opened by some other tab is still denied.
    tabGetExtras = { openerTabId: 8 };
    await assertRejects(
      () => Promise.resolve(route(gm("closeTab", { tabId: 999 }), contentSender)),
      Error,
      "not opened by this script",
    );
  } finally {
    tabGetExtras = null;
  }

  // GM_openInTab registers ownership (and records the opener) for later closes.
  assertEquals(await route(gm("openInTab", { url: "https://x.test/t" }), contentSender), {
    tabId: 4242,
  });
  assertEquals(createdTabProps.at(-1)?.openerTabId, 7, "opener must be recorded");
  assertEquals(await route(gm("closeTab", { tabId: 4242 }), contentSender), { ok: true });
  assertEquals(removedTabIds, [7, 999, 4242]);

  // Non-web schemes are pinned off at openInTab.
  await assertRejects(
    () => Promise.resolve(route(gm("openInTab", { url: "javascript:alert(1)" }), contentSender)),
    Error,
    "http(s)",
  );
});

Deno.test("ConfirmConnectAuth: no grant without an outstanding prompt", async () => {
  seedScripts();
  assertEquals(
    await route(
      { type: "ConfirmConnectAuth", scriptId: "s1", domain: "x.test", scope: "always" },
      pageSender,
    ),
    { ok: true },
  );
  const got = await route({ type: "GetEntry", id: "s1" }, pageSender) as {
    entry: ScriptEntry | null;
  };
  assertEquals(got.entry?.connectGrants, [], "a stray resolve must not persist a grant");
});

Deno.test("site controls: master switch and blacklist gate GM calls", async () => {
  seedScripts();
  await storageLocal.set({ settings: { masterEnabled: false } });
  await assertRejects(
    () => Promise.resolve(route(gm("getValue", { key: "k" }), contentSender)),
    Error,
    "disabled on this page",
  );

  // Blacklisting the page's site denies even where the script itself matches.
  await storageLocal.set({
    settings: { masterEnabled: true, siteBlacklist: ["https://example.com/*"] },
  });
  await assertRejects(
    () => Promise.resolve(route(gm("getValue", { key: "k" }), contentSender)),
    Error,
    "disabled on this page",
  );
  // A different site passes the site gate and reaches the scope gate instead.
  await assertRejects(
    () =>
      Promise.resolve(
        route(gm("getValue", { key: "k" }), { url: "https://other.net/p", tab: { id: 7 } }),
      ),
    Error,
    "does not run on this page",
  );
  await storageLocal.set({ settings: {} });
});

Deno.test("SaveCode: kind-mismatched code is refused, not silently kept", async () => {
  seedScripts();
  // A style-headed body must not go into a script entry: the old behavior
  // returned the unmodified entry and the editor showed a false "saved".
  const styleCode = [
    "/* ==UserStyle==",
    "   @name   x",
    "   ==/UserStyle== */",
    "body { color: red; }",
  ].join("\n");
  await assertRejects(
    () => Promise.resolve(route({ type: "SaveCode", id: "s1", code: styleCode }, pageSender)),
    Error,
  );
  // The old bug: the entry came back unmodified while the editor said saved.
  const got = await route({ type: "GetEntry", id: "s1" }, pageSender) as {
    entry: ScriptEntry | null;
  };
  assert(
    got.entry !== null && !got.entry.code.includes("UserStyle"),
    "original script code must be untouched",
  );
});

function updEntry(): unknown {
  const header = [
    "// ==UserScript==",
    "// @name     upd",
    "// @match    https://example.com/*",
    "// @version  1.0",
    "// @updateURL https://upd.test/s.user.js",
    "// @downloadURL https://dl.test/s.user.js",
    "// @grant    none",
    "// ==/UserScript==",
    "void 0;",
  ].join("\n");
  return {
    id: "upd1",
    kind: "script",
    enabled: true,
    position: 1,
    code: header,
    meta: parseMeta(header, "upd"),
    source: { type: "inline" },
    installedAt: 0,
    updatedAt: 0,
    connectGrants: [] as string[],
    values: {},
  };
}

Deno.test("CheckUpdate: checks @updateURL, not @downloadURL (convention order)", async () => {
  await storageLocal.set({ scripts: [updEntry()] });
  const fetched: string[] = [];
  const realFetch = globalThis.fetch;
  (globalThis as Record<string, unknown>).fetch = (url: string | URL) => {
    fetched.push(String(url));
    return Promise.resolve({
      ok: true,
      text: () => Promise.resolve((updEntry() as { code: string }).code.replace("1.0", "2.0")),
    });
  };
  try {
    const r = await route({ type: "CheckUpdate", id: "upd1" }, pageSender) as {
      status: string;
      version?: string;
    };
    assertEquals(r.status, "available");
    assertEquals(r.version, "2.0");
    // Probe the check URL, then fetch the installable body from the download
    // URL (a meta-only @updateURL must never be installed as code).
    assertEquals(fetched, ["https://upd.test/s.user.js", "https://dl.test/s.user.js"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("auto update: applies a newer version, and honors the switch", async () => {
  // Created once at startup with the daily period (a get-guarded create so
  // event-page wakes cannot reset the schedule).
  assertEquals(alarmScheduled, { name: UPDATE_ALARM, periodInMinutes: 1440 });
  const realFetch = globalThis.fetch;
  const fetched: string[] = [];
  const arm = () =>
    (globalThis as Record<string, unknown>).fetch = (url: string | URL) => {
      fetched.push(String(url));
      // The download source serves a distinguishable body so the assertion
      // proves the applied code came from there, not from the probe.
      const code = (updEntry() as { code: string }).code.replace("1.0", "2.0");
      return Promise.resolve({
        ok: true,
        text: () =>
          Promise.resolve(
            String(url).includes("dl.test")
              ? code.replace("void 0;", "/*from-download*/ void 0;")
              : code,
          ),
      });
    };
  try {
    // Off: the alarm is a no-op, not even a fetch.
    await storageLocal.set({ scripts: [updEntry()], settings: { autoUpdate: false } });
    arm();
    fireAlarm(UPDATE_ALARM);
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(fetched, [], "switch off must not fetch");

    // On: the newer remote version is applied in place.
    await storageLocal.set({ scripts: [updEntry()], settings: { autoUpdate: true } });
    fireAlarm(UPDATE_ALARM);
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(fetched, ["https://upd.test/s.user.js", "https://dl.test/s.user.js"]);
    const got = await route({ type: "GetEntry", id: "upd1" }, pageSender) as {
      entry: ScriptEntry | null;
    };
    assert(got.entry?.code.includes("@version  2.0"), "newer version must be applied");
    assert(
      got.entry?.code.includes("/*from-download*/"),
      "the applied body must come from the download source",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
