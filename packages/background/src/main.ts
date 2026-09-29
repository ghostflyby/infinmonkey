import browser from "webextension-polyfill";
import { RUNTIME_NAME } from "@infinmonkey/shared/constants";
import { detectKind, parseMeta } from "@infinmonkey/shared/meta";
import { urlMatchesMeta } from "@infinmonkey/shared/matcher";
import type {
  AnyEntry,
  EntrySource,
  PendingInstall,
  PopupData,
  PopupScriptInfo,
} from "@infinmonkey/shared/types";
import { compareVersions } from "@infinmonkey/shared/version";
import { authorizeGmCall } from "@infinmonkey/shared/authorize";
import { isDevOrigin, userAllows } from "@infinmonkey/shared/settings";
import { isRecord } from "@infinmonkey/shared/util";
import { devClient } from "./devclient.ts";
import { hasNativeSupport, nativeSync, PULL_ALARM } from "./native.ts";
import { findTabIdByUrl } from "./injection.ts";
import { abortXhr, handleDownload, handleXhr, resolveConnectAuth } from "./network.ts";
import {
  createEntry,
  deleteEntry,
  exportAll,
  findEntry,
  getDB,
  getPendingInstall,
  importAll,
  putPendingInstall,
  revokeConnectGrant,
  setEnabled,
  setSource,
  setValue,
  takePendingInstall,
  updateCode,
} from "./store.ts";

// ---- In-memory state: menu commands / notification callbacks / GM_getTab data ----

interface CommandInfo {
  /** The bridge instance that registered this command. */
  nonce: string;
  /** Best-effort resolved tabId (may be null when the engine limits sender/tab queries). */
  tabId: number | null;
  scriptId: string;
  title: string;
}
const menuCommands = new Map<number, CommandInfo>();
let menuSeq = 1;

/** CreateEntry idempotency token → created entry. */
const createTokens = new Map<string, AnyEntry>();

/** GM_getTab/GM_saveTab data, keyed by the bridge nonce and tagged with the
 * owning script and tab so getTabs can filter per script and onRemoved can
 * evict per tab. */
interface NonceTabData {
  scriptId: string;
  /** Best-effort owning tab; null when the engine could not resolve it. */
  tabId: number | null;
  data: Record<string, unknown>;
}

const nonceTabData = new Map<string, NonceTabData>();

/** Tabs each script opened via openInTab; the closeTab allowlist. In-memory
 * only - closeTab falls back to the browser-recorded openerTabId after the
 * background has been suspended and this map reset. */
const scriptTabs = new Map<string, Set<number>>();

const notificationCallbacks = new Map<
  string,
  { nonce: string; tabId: number | null; scriptId: string; callbackId: string }
>();

// Native app mirror: pulls on wake, flushes and merges on the periodic alarm.
/** Daily silent update pass; exported for route_test.ts. */
export const UPDATE_ALARM = "infin-auto-update";

browser.alarms.onAlarm.addListener((alarm: { name: string }) => {
  if (alarm.name === PULL_ALARM) void nativeSync.onAlarm();
  if (alarm.name === UPDATE_ALARM) void runAutoUpdate();
});
browser.runtime.onInstalled.addListener(() => nativeSync.start());
browser.runtime.onStartup.addListener(() => nativeSync.start());
nativeSync.start();
// Create the update alarm only when absent: an unconditional create resets
// the schedule on every event-page wake, so it could keep never firing.
void (async () => {
  const existing = await browser.alarms.get(UPDATE_ALARM);
  if (!existing) void browser.alarms.create(UPDATE_ALARM, { periodInMinutes: 1440 });
})();

browser.tabs.onRemoved.addListener((tabId: number) => {
  for (const [id, c] of notificationCallbacks) {
    if (c.tabId === tabId) notificationCallbacks.delete(id);
  }
  for (const [id, c] of menuCommands) {
    if (c.tabId === tabId) menuCommands.delete(id);
  }
  for (const [id, e] of nonceTabData) {
    if (e.tabId === tabId) nonceTabData.delete(id);
  }
  for (const set of scriptTabs.values()) set.delete(tabId);
});

// ---- Message routing ----

/**
 * Message types a content script may invoke. Everything else is limited to
 * the extension's own pages (options / popup / install / prompt). Pages reach
 * this router only through our own content scripts today, but gating here
 * keeps a single content-script injection bug from turning into full library
 * read/write - entries carry script code and GM values. sender.url is
 * browser-authoritative: content scripts report the page URL, extension
 * pages report the extension origin, so the two are distinguishable.
 */
const CONTENT_SCRIPT_MESSAGES = new Set(["FetchText", "gmCall"]);

/** Response size cap for FetchText, mirroring startInstallFromUrl. */
const FETCH_TEXT_LIMIT = 5_000_000;

function fromExtensionPage(sender: browser.Runtime.MessageSender): boolean {
  return typeof sender.url === "string" &&
    sender.url.startsWith(browser.runtime.getURL("/"));
}

browser.runtime.onMessage.addListener((msg: unknown, sender: browser.Runtime.MessageSender) => {
  return route(msg, sender) as unknown;
});

/** Exported for route_test.ts; the polyfill's listener wrapper swallows
 * return values, so tests drive this function directly. */
export function route(
  msg: unknown,
  sender: browser.Runtime.MessageSender,
): Promise<unknown> | unknown {
  if (!isRecord(msg) || typeof msg.type !== "string") return undefined;
  // Denied senders get the same silent `undefined` as unknown message types.
  if (!CONTENT_SCRIPT_MESSAGES.has(msg.type) && !fromExtensionPage(sender)) return undefined;
  switch (msg.type) {
    case "FetchText": {
      // @require/@resource fetches are http(s) by definition; rejecting other
      // schemes here keeps a relayed message from probing file: and friends.
      let url: URL;
      try {
        url = new URL(String(msg.url ?? ""));
      } catch {
        return { error: "invalid URL" };
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return { error: "only http(s) URLs are supported" };
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(new Error("bg fetch timeout")), 10000);
      const out = fetch(url.href, { cache: "no-store", signal: ctrl.signal })
        .then(async (r) => {
          const declared = Number(r.headers.get("content-length") ?? 0);
          if (declared > FETCH_TEXT_LIMIT) throw new Error("response too large");
          const text = await r.text();
          if (text.length > FETCH_TEXT_LIMIT) throw new Error("response too large");
          return { text, mime: r.headers.get("content-type") ?? "text/plain" };
        })
        .catch((e: unknown) => ({ error: String((e as Error).message ?? e) }));
      return out.finally(() => clearTimeout(timer));
    }

    // ----- Injection pipeline -----
    case "gmCall":
      return handleGmCall(
        msg as unknown as {
          scriptId: string;
          reqId: number;
          op: string;
          args: Record<string, unknown>;
          nonce?: string;
        },
        sender,
      );

    // ----- popup -----
    case "GetPopupData":
      return handlePopupData(msg.tabId as number);
    case "DispatchCommand": {
      const c = menuCommands.get(msg.commandId as number);
      if (!c) return { ok: false };
      if (c.tabId != null) {
        // Broadcast to all frames of the tab; the runner holding the command responds
        browser.tabs.sendMessage(
          c.tabId,
          {
            type: "gmCallback",
            kind: "command",
            scriptId: c.scriptId,
            callbackId: String(msg.commandId),
          },
        ).catch(() => {});
      }
      return { ok: true };
    }

    // ----- Management pages -----
    case "ListEntries":
      return getDB().then((db) => ({
        scripts: [...db.scripts].sort(byPosition),
        styles: [...db.styles].sort(byPosition),
      }));
    case "GetEntry":
      return findEntry(msg.id as string).then((e) => ({ entry: e ?? null }));
    case "SaveCode":
      return updateCode(msg.id as string, msg.code as string).then((e) => ({ entry: e ?? null }));
    case "SetEnabled":
      return handleSetEnabled(msg.id as string, !!msg.enabled);
    case "CreateEntry": {
      // Idempotency token: avoids duplicate creation when the page side retries the message
      const token = typeof msg.token === "string" ? msg.token : "";
      const existing = token ? createTokens.get(token) : undefined;
      if (existing) return { entry: existing };
      return createEntry(msg.kind as "script" | "style", { code: msg.code as string }).then(
        (entry) => {
          if (token) {
            createTokens.set(token, entry);
            if (createTokens.size > 50) {
              const first = createTokens.keys().next().value;
              if (first) createTokens.delete(first);
            }
          }
          return { entry };
        },
      );
    }
    case "DeleteEntry":
      return handleDeleteEntry(msg.id as string);
    case "SetSource":
      return setSource(msg.id as string, msg.source as EntrySource).then((e) => ({
        entry: e ?? null,
      }));
    case "GetConnectGrants":
      return findEntry(msg.id as string).then((e) => ({
        grants: e?.kind === "script" ? e.connectGrants : [],
      }));
    case "RevokeConnectGrant":
      return revokeConnectGrant(msg.id as string, msg.domain as string).then(() => ({ ok: true }));
    case "PingDevServer":
      return pingDevServer(msg.origin as string | undefined);
    case "CheckUpdate":
      return checkUpdate(msg.id as string);
    case "ExportAll":
      return exportAll();
    case "ImportAll":
      return importAll(msg.data as never, msg.mode === "replace" ? "replace" : "merge").then((
        count,
      ) => ({ count }));
    case "GetNativeStatus":
      return {
        supported: hasNativeSupport(),
        ...nativeSync.status(),
      };
    case "GetSettings":
      return getDB().then((db) => db.settings);
    case "SetSettings":
      return getDB().then(async (db) => {
        // Whitelist + coerce: the patch arrives from popup/options, and
        // unknown or mistyped keys must not ride into storage.
        const patch = isRecord(msg.patch) ? msg.patch : {};
        if (typeof patch.devOrigin === "string") db.settings.devOrigin = patch.devOrigin;
        if (patch.storageBackend === "native" || patch.storageBackend === "local") {
          db.settings.storageBackend = patch.storageBackend;
        }
        if (typeof patch.masterEnabled === "boolean") {
          db.settings.masterEnabled = patch.masterEnabled;
        }
        if (Array.isArray(patch.siteBlacklist)) {
          db.settings.siteBlacklist = patch.siteBlacklist.filter((p): p is string =>
            typeof p === "string"
          );
        }
        if (typeof patch.autoUpdate === "boolean") db.settings.autoUpdate = patch.autoUpdate;
        await browser.storage.local.set({ settings: db.settings });
        if (db.settings.devOrigin) devClient.ensureConnected(db.settings.devOrigin);
        return db.settings;
      });

    // ----- Install flow -----
    case "StartInstallFromText":
      return startInstallFromText(
        msg.code as string,
        msg.url as string | undefined,
        sender.tab?.id,
      );
    case "StartInstallFromUrl":
      return startInstallFromUrl(msg.url as string, sender.tab?.id);
    case "OpenOptions":
      return browser.runtime.openOptionsPage().then(() => ({ ok: true }));
    case "GetPendingInstall":
      return getPendingInstall(msg.pendingId as string).then(async (p) => {
        if (!p) return { pending: null };
        const entry = p.replaceId ? await findEntry(p.replaceId) : null;
        return { pending: p, entry: entry ?? null };
      });
    case "ConfirmInstall":
      return confirmInstall(msg.pendingId as string, msg.decision as "install" | "cancel");

    // ----- @connect authorization -----
    case "ConfirmConnectAuth":
      return resolveConnectAuth(
        msg.scriptId as string,
        msg.domain as string,
        msg.scope as "once" | "always" | "deny",
      ).then(
        () => ({ ok: true }),
      );

    default:
      return undefined;
  }
}

const byPosition = (a: { position: number }, b: { position: number }) => a.position - b.position;

async function handleSetEnabled(id: string, enabled: boolean) {
  const entry = await setEnabled(id, enabled);
  return { entry: entry ?? null };
}

async function handleDeleteEntry(id: string) {
  const ok = await deleteEntry(id);
  return { ok };
}

async function pingDevServer(origin?: string) {
  const db = await getDB();
  const target = (origin ?? db.settings.devOrigin).replace(/\/$/, "");
  try {
    const r = await fetch(target + "/__infin/health", {
      cache: "no-store",
      signal: AbortSignal.timeout(2000),
    });
    if (!r.ok) return { ok: false, message: `HTTP ${r.status}` };
    const info = await r.json().catch(() => ({}));
    devClient.ensureConnected(target);
    return { ok: true, info };
  } catch (e) {
    return { ok: false, message: String((e as Error).message ?? e) };
  }
}

// ---- GM calls ----

async function handleGmCall(
  msg: {
    scriptId: string;
    reqId: number;
    op: string;
    args: Record<string, unknown>;
    nonce?: string;
  },
  sender: browser.Runtime.MessageSender,
) {
  // Site gate first: a disabled manager denies GM calls regardless of script
  // state, otherwise "off" would only be cosmetic against forged frames.
  const url = typeof sender?.url === "string" ? sender.url : undefined;
  const db = await getDB();
  if (!userAllows(url, db.settings)) {
    throw new Error("GM call denied: the manager is disabled on this page");
  }
  // Permission gate: the calling page must be inside the script's own scope.
  // Only browser-provided sender fields participate - a forged relayed message
  // can claim any page URL, but it cannot claim the sender's.
  const entry = await findEntry(msg.scriptId);
  if (!entry || entry.kind !== "script") {
    throw new Error("GM call denied: unknown script");
  }
  const auth = authorizeGmCall(entry, url);
  if (!auth.ok) {
    throw new Error(`GM call denied: ${auth.reason}`);
  }
  // Call context keyed by the bridge nonce (unique per document)
  const nonce = String(msg.nonce ?? "");
  const ctxKey = `${nonce}:${msg.scriptId}:${msg.reqId}`;
  const ctx: GmCtx = {
    nonce,
    scriptId: msg.scriptId,
    ctxKey,
    tabId: sender.tab?.id ?? null,
    url,
  };
  return await gmDispatch(msg.op, msg.args, ctx);
}

interface GmCtx {
  /** Bridge instance id (unique per document). */
  nonce: string;
  scriptId: string;
  ctxKey: string;
  /** Best-effort resolved tabId (sender.tab or URL log); may be null. */
  tabId: number | null;
  url?: string;
}

async function gmDispatch(op: string, args: Record<string, unknown>, ctx: GmCtx): Promise<unknown> {
  const { scriptId } = ctx;
  async function tabIdBestEffort(): Promise<number | null> {
    if (ctx.tabId != null) return ctx.tabId;
    // Zen omits sender.tab for content-script messages; fall back to a URL log.
    ctx.tabId = ctx.url ? await findTabIdByUrl(ctx.url) : null;
    return ctx.tabId;
  }
  switch (op) {
    case "getValue": {
      const { getValue } = await import("./store.ts");
      return await getValue(scriptId, args.key as string);
    }
    case "setValue": {
      const r = await setValue(scriptId, args.key as string, args.value);
      broadcastValueChanged(ctx, args.key as string, r.oldValue, r.newValue);
      return { ok: true };
    }
    case "deleteValue": {
      const { deleteValue } = await import("./store.ts");
      const r = await deleteValue(scriptId, args.key as string);
      if (r.existed) broadcastValueChanged(ctx, args.key as string, r.oldValue, undefined);
      return { ok: true };
    }
    case "listValues": {
      const { listValues } = await import("./store.ts");
      return { keys: await listValues(scriptId) };
    }
    case "xmlHttpRequest":
      return await handleXhr(ctx.ctxKey, scriptId, args as never);
    case "abortXhr":
      abortXhr(ctx.ctxKey);
      return { ok: true };
    case "registerMenuCommand": {
      const commandId = menuSeq++;
      menuCommands.set(commandId, {
        nonce: ctx.nonce,
        tabId: await tabIdBestEffort(),
        scriptId,
        title: String(args.title ?? "命令"),
      });
      return { commandId };
    }
    case "unregisterMenuCommand":
      menuCommands.delete(Number(args.commandId));
      return { ok: true };
    case "notification": {
      const created = await browser.notifications.create({
        type: "basic",
        iconUrl: browser.runtime.getURL("icons/icon-128.png"),
        title: String(args.title ?? RUNTIME_NAME),
        message: String(args.text ?? ""),
      });
      if (typeof args.callbackId === "string" && args.callbackId) {
        notificationCallbacks.set(created, {
          nonce: ctx.nonce,
          tabId: await tabIdBestEffort(),
          scriptId,
          callbackId: args.callbackId,
        });
      }
      return { id: created };
    }
    case "openInTab": {
      const target = String(args.url ?? "");
      // Engine handling of non-web schemes in tabs.create varies; GM_openInTab
      // is for web pages, so pin it to http(s) explicitly.
      if (!/^https?:\/\//i.test(target)) {
        throw new Error("GM_openInTab: only http(s) URLs are supported");
      }
      const own = await tabIdBestEffort();
      const t = await browser.tabs.create({
        url: target,
        active: !!args.active,
        pinned: !!args.pinned,
        // Browser-authoritative ownership record: unlike scriptTabs it
        // survives background suspension, giving closeTab a durable check.
        ...(own != null ? { openerTabId: own } : {}),
      });
      if (t.id != null) {
        const opened = scriptTabs.get(ctx.scriptId) ?? new Set<number>();
        opened.add(t.id);
        scriptTabs.set(ctx.scriptId, opened);
      }
      return { tabId: t.id };
    }
    case "closeTab": {
      // A page can forge gmCall frames for any script matching its URL, so an
      // unvalidated tabId would let it close arbitrary tabs. Allow only the
      // calling page's own tab and tabs this script opened via openInTab.
      const target = Number(args.tabId);
      if (!Number.isInteger(target)) {
        throw new Error("GM_closeTab: integer tabId required");
      }
      const own = await tabIdBestEffort();
      let allowed = target === own || !!scriptTabs.get(ctx.scriptId)?.has(target);
      if (!allowed && own != null) {
        // scriptTabs dies with the background on suspension; the opener
        // recorded at tabs.create time survives, so consult it before denying.
        const tab = await browser.tabs.get(target).catch(() => null);
        allowed = tab?.openerTabId != null && tab.openerTabId === own;
      }
      if (!allowed) throw new Error("GM_closeTab: tab not opened by this script");
      scriptTabs.get(ctx.scriptId)?.delete(target);
      await browser.tabs.remove(target);
      return { ok: true };
    }
    case "getTab": {
      const e = nonceTabData.get(`${ctx.nonce}:${ctx.scriptId}`);
      return { tab: e?.data ?? {} };
    }
    case "saveTab": {
      // Keyed per (document, script): two scripts on one page must not
      // clobber each other's saved data.
      nonceTabData.set(`${ctx.nonce}:${ctx.scriptId}`, {
        scriptId: ctx.scriptId,
        tabId: await tabIdBestEffort(),
        data: (args.tab ?? {}) as Record<string, unknown>,
      });
      return { ok: true };
    }
    case "getTabs": {
      // Per-script view: the GM gate is scoped by page URL, so without this
      // filter one script's saved tab data would be readable by any other
      // script running on the same page.
      const out: Record<string, unknown> = {};
      for (const [nonce, e] of nonceTabData) {
        if (e.scriptId === ctx.scriptId) out[nonce] = e.data;
      }
      return { tabs: out };
    }
    case "download":
      return await handleDownload(scriptId, args as never);
    default:
      throw new Error(`Unknown GM op: ${op}`);
  }
}

function broadcastValueChanged(
  ctx: GmCtx,
  key: string,
  oldValue: unknown,
  newValue: unknown,
): void {
  browser.runtime.sendMessage({
    type: "gmValueChanged",
    scriptId: ctx.scriptId,
    key,
    oldValue,
    newValue,
    senderKey: ctx.nonce,
  }).catch(() => {});
}

browser.notifications.onClicked.addListener((nid: string) => {
  const c = notificationCallbacks.get(nid);
  notificationCallbacks.delete(nid);
  if (!c) return;
  if (c.tabId != null) {
    browser.tabs.update(c.tabId, { active: true }).catch(() => {});
    browser.tabs.sendMessage(
      c.tabId,
      { type: "gmCallback", kind: "notification", scriptId: c.scriptId, callbackId: c.callbackId },
    ).catch(() => {});
  }
});

// ---- popup ----

async function handlePopupData(tabId: number): Promise<PopupData> {
  const db = await getDB();
  let url = "";
  try {
    const tab = await browser.tabs.get(tabId);
    url = tab.url ?? "";
  } catch {
    // ignore
  }
  const allowed = userAllows(url || undefined, db.settings);
  const scriptErrors = allowed
    ? (await browser.storage.local.get("imErrors") as {
      imErrors?: Record<string, { message: string }>;
    }).imErrors
    : undefined;
  const scripts: PopupScriptInfo[] = [];
  if (allowed) {
    for (const e of [...db.scripts, ...db.styles].sort(byPosition)) {
      if (!e.enabled || !urlMatchesMeta(url, e.meta)) continue;
      scripts.push({
        id: e.id,
        kind: e.kind,
        name: e.meta.name,
        version: e.meta.version ?? "",
        enabled: e.enabled,
        error: scriptErrors?.[e.id]?.message,
      });
    }
  }
  const commands = !allowed ? [] : [...menuCommands]
    .filter(([, c]) => c.tabId === tabId)
    .map(([commandId, c]) => ({ commandId, scriptId: c.scriptId, title: c.title }));
  return {
    url,
    scripts,
    commands,
    devConnected: devClient.connected,
    devOrigin: db.settings.devOrigin,
    masterEnabled: db.settings.masterEnabled,
    siteBlocked: !allowed,
  };
}

// ---- Install flow ----

async function openInstallPage(pendingId: string, openerTabId?: number): Promise<void> {
  await browser.tabs.create({
    url: browser.runtime.getURL(`install/index.html?id=${encodeURIComponent(pendingId)}`),
    ...(openerTabId != null ? { openerTabId } : {}),
  });
}

async function startInstallFromText(code: string, url?: string, openerTabId?: number) {
  const kind = detectKind(code);
  const pendingId = await putPendingInstall({ kind, code, url });
  await openInstallPage(pendingId, openerTabId);
  return { ok: true };
}

async function startInstallFromUrl(url: string, openerTabId?: number) {
  if (!/^https?:\/\//.test(url)) return { ok: false, message: "仅支持 http(s) URL" };
  let code: string;
  try {
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return { ok: false, message: `HTTP ${r.status}` };
    code = await r.text();
    if (code.length > 5_000_000) return { ok: false, message: "文件过大（>5MB）" };
  } catch (e) {
    return { ok: false, message: String((e as Error).message ?? e) };
  }
  const kind = detectKind(code);
  const pendingId = await putPendingInstall({ kind, code, url });
  await openInstallPage(pendingId, openerTabId);
  return { ok: true };
}

async function confirmInstall(pendingId: string, decision: "install" | "cancel") {
  const pending: PendingInstall | undefined = await takePendingInstall(pendingId);
  if (!pending || decision === "cancel") return { entryId: null, canceled: true };
  let entry: AnyEntry | undefined;
  if (pending.replaceId) {
    const existing = await findEntry(pending.replaceId);
    if (existing) {
      entry = await updateCode(existing.id, pending.code);
      if (entry && pending.url) {
        const db = await getDB();
        if (isDevOrigin(pending.url, db.settings)) {
          entry = await setSource(entry.id, { type: "dev", url: pending.url, autoReload: true });
        }
      }
    }
  }
  // Dedupe: same dev URL or identical code → update the entry instead of installing a copy
  if (!entry) {
    const db = await getDB();
    const dup = [...db.scripts, ...db.styles].find((e) =>
      e.kind === pending.kind &&
      ((pending.url && e.source.type === "dev" && e.source.url === pending.url) ||
        e.code === pending.code)
    );
    if (dup) {
      entry = await updateCode(dup.id, pending.code);
    }
  }
  if (!entry) entry = await createEntry(pending.kind, { code: pending.code, url: pending.url });
  return { entryId: entry.id, canceled: false };
}

// ---- Check for updates (manual) ----

/** Where an entry updates from. Convention (Tampermonkey/Violentmonkey):
 * @updateURL is checked for a newer @version, @downloadURL is where new code
 * is fetched from; each falls back to the other, then to the dev mapping. */
function updateTargets(entry: AnyEntry): { checkUrl: string; downloadUrl: string } | null {
  const devUrl = entry.source.type === "dev" ? entry.source.url : "";
  const checkUrl = entry.meta.updateURL || entry.meta.downloadURL || devUrl;
  if (!checkUrl) return null;
  return {
    checkUrl,
    downloadUrl: entry.meta.downloadURL || entry.meta.updateURL || devUrl,
  };
}

async function checkUpdate(id: string) {
  const entry = await findEntry(id);
  if (!entry) return { status: "error", message: "条目不存在" };
  const targets = updateTargets(entry);
  if (!targets) {
    return { status: "error", message: "未配置 @updateURL/@downloadURL，且非 dev 映射" };
  }
  let code: string;
  try {
    const r = await fetch(targets.checkUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return { status: "error", message: `HTTP ${r.status}` };
    code = await r.text();
  } catch (e) {
    return { status: "error", message: String((e as Error).message ?? e) };
  }
  const kind = detectKind(code);
  if (kind !== entry.kind) {
    return { status: "error", message: `远端类型不匹配（${kind} ≠ ${entry.kind}）` };
  }
  const remoteMeta = parseMeta(code);
  const cmp = compareVersions(remoteMeta.version ?? "0", entry.meta.version ?? "0");
  if (cmp <= 0) return { status: "current", version: entry.meta.version ?? "" };
  // Newer on the check URL. The installable body comes from the download
  // source: @updateURL often serves a meta-only file, so installing the
  // probe body verbatim would clobber working code.
  if (targets.downloadUrl !== targets.checkUrl) {
    try {
      const r = await fetch(targets.downloadUrl, {
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) return { status: "error", message: `HTTP ${r.status}` };
      code = await r.text();
    } catch (e) {
      return { status: "error", message: String((e as Error).message ?? e) };
    }
    const dlKind = detectKind(code);
    if (dlKind !== entry.kind) {
      return { status: "error", message: `远端类型不匹配（${dlKind} ≠ ${entry.kind}）` };
    }
  }
  const pendingId = await putPendingInstall({
    kind,
    code,
    url: targets.downloadUrl,
    replaceId: entry.id,
  });
  await openInstallPage(pendingId);
  return { status: "available", version: remoteMeta.version ?? "" };
}

/** Fetches an entry's update source; returns the new code when the check URL
 * carries a newer @version of the same kind, else null. The installable body
 * comes from the download source (see checkUpdate); every failure mode
 * collapses to null so one bad entry cannot abort the daily pass. */
async function fetchNewerVersion(
  entry: AnyEntry,
  targets: { checkUrl: string; downloadUrl: string },
): Promise<string | null> {
  try {
    const r = await fetch(targets.checkUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    const probe = await r.text();
    if (probe === entry.code || detectKind(probe) !== entry.kind) return null;
    const meta = parseMeta(probe);
    if (!meta.version || compareVersions(meta.version, entry.meta.version ?? "0") <= 0) {
      return null;
    }
    if (targets.downloadUrl === targets.checkUrl) return probe;
    const dl = await fetch(targets.downloadUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!dl.ok) return null;
    const body = await dl.text();
    return detectKind(body) === entry.kind ? body : null;
  } catch {
    return null;
  }
}

/** Daily silent pass: apply newer remote @version values in place (values
 * survive; pages re-inject via entriesChanged; the write-behind mirror picks
 * the mutation up). Manual CheckUpdate stays on the confirm-page flow, and a
 * failing entry is skipped rather than aborting the pass. */
async function runAutoUpdate(): Promise<void> {
  const db = await getDB();
  if (!db.settings.autoUpdate) return;
  for (const entry of [...db.scripts, ...db.styles]) {
    const targets = updateTargets(entry);
    if (!targets) continue;
    try {
      const code = await fetchNewerVersion(entry, targets);
      if (code !== null) await updateCode(entry.id, code);
    } catch {
      // One failing entry must not abort the pass.
    }
  }
}

// ---- Startup ----

void (async () => {
  const db = await getDB();
  if (db.settings.devOrigin) devClient.ensureConnected(db.settings.devOrigin);
})();
