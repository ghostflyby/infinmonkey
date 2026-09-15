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
import { fetchWithTimeout, isRecord } from "@infinmonkey/shared/util";
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

const notificationCallbacks = new Map<
  string,
  { nonce: string; tabId: number | null; scriptId: string; callbackId: string }
>();

// Native app mirror: pulls on wake, flushes and merges on the periodic alarm.
browser.alarms.onAlarm.addListener((alarm: { name: string }) => {
  if (alarm.name === PULL_ALARM) void nativeSync.onAlarm();
});
browser.runtime.onInstalled.addListener(() => nativeSync.start());
browser.runtime.onStartup.addListener(() => nativeSync.start());
nativeSync.start();

browser.tabs.onRemoved.addListener((tabId: number) => {
  for (const [id, c] of notificationCallbacks) {
    if (c.tabId === tabId) notificationCallbacks.delete(id);
  }
  for (const [id, c] of menuCommands) {
    if (c.tabId === tabId) menuCommands.delete(id);
  }
});

// ---- Message routing ----

browser.runtime.onMessage.addListener((msg: unknown, sender: browser.Runtime.MessageSender) => {
  return route(msg, sender) as unknown;
});

function route(
  msg: unknown,
  sender: browser.Runtime.MessageSender,
): Promise<unknown> | unknown {
  if (!isRecord(msg) || typeof msg.type !== "string") return undefined;
  switch (msg.type) {
    // ----- Heartbeat (content script keeps the event page alive) -----
    case "ping":
      return { ok: true };
    case "FetchText": {
      const url = String(msg.url ?? "");
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(new Error("bg fetch timeout")), 10000);
      const out = fetch(url, { cache: "no-store", signal: ctrl.signal })
        .then(async (r) => ({
          text: await r.text(),
          mime: r.headers.get("content-type") ?? "text/plain",
        }))
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
        Object.assign(db.settings, msg.patch);
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
    const r = await fetchWithTimeout(target + "/__infin/health", 2000, { cache: "no-store" });
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
  _sender: browser.Runtime.MessageSender,
) {
  // Call context keyed by the bridge nonce (some engines omit tab info in sender)
  const ctxKey = `${msg.nonce ?? "n"}:${msg.scriptId}:${msg.reqId}`;
  const ctx: GmCtx = {
    nonce: String(msg.nonce ?? ""),
    scriptId: msg.scriptId,
    ctxKey,
    tabId: null,
    url: typeof _sender?.url === "string" ? _sender.url : undefined,
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
    if (senderTabOf(ctx) != null) return senderTabOf(ctx);
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
      const t = await browser.tabs.create({
        url: String(args.url),
        active: !!args.active,
        pinned: !!args.pinned,
      });
      return { tabId: t.id };
    }
    case "closeTab":
      await browser.tabs.remove(Number(args.tabId));
      return { ok: true };
    case "getTab":
      return { tab: nonceTabData.get(ctx.nonce) ?? {} };
    case "saveTab":
      nonceTabData.set(ctx.nonce, (args.tab ?? {}) as Record<string, unknown>);
      return { ok: true };
    case "getTabs": {
      const out: Record<string, unknown> = {};
      for (const [nonce, v] of nonceTabData) out[nonce] = v;
      return { tabs: out };
    }
    case "download":
      return await handleDownload(scriptId, args as never);
    default:
      throw new Error(`Unknown GM op: ${op}`);
  }
}

function senderTabOf(ctx: GmCtx): number | null {
  return ctx.tabId;
}

const nonceTabData = new Map<string, Record<string, unknown>>();

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
  const scripts: PopupScriptInfo[] = [];
  for (const e of [...db.scripts, ...db.styles].sort(byPosition)) {
    if (!e.enabled || !urlMatchesMeta(url, e.meta)) continue;
    scripts.push({
      id: e.id,
      kind: e.kind,
      name: e.meta.name,
      version: e.meta.version ?? "",
      enabled: e.enabled,
    });
  }
  const commands = [...menuCommands]
    .filter(([, c]) => c.tabId === tabId)
    .map(([commandId, c]) => ({ commandId, scriptId: c.scriptId, title: c.title }));
  return {
    url,
    scripts,
    commands,
    devConnected: devClient.connected,
    devOrigin: db.settings.devOrigin,
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
    const r = await fetchWithTimeout(url, 10000, { cache: "no-store" });
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
        const { isDevOrigin } = await import("./store.ts");
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

async function checkUpdate(id: string) {
  const entry = await findEntry(id);
  if (!entry) return { status: "error", message: "条目不存在" };
  const url = entry.meta.downloadURL || entry.meta.updateURL ||
    (entry.source.type === "dev" ? entry.source.url : "");
  if (!url) return { status: "error", message: "未配置 @updateURL/@downloadURL，且非 dev 映射" };
  let code: string;
  try {
    const r = await fetchWithTimeout(url, 10000, { cache: "no-store" });
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
  const pendingId = await putPendingInstall({ kind, code, url, replaceId: entry.id });
  await openInstallPage(pendingId);
  return { status: "available", version: remoteMeta.version ?? "" };
}

// ---- Startup ----

void (async () => {
  const db = await getDB();
  if (db.settings.devOrigin) devClient.ensureConnected(db.settings.devOrigin);
})();
