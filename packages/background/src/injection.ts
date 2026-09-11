import browser from "webextension-polyfill";
import { urlMatchesMeta } from "@infinmonkey/shared/matcher";
import { splitUserStyle, targetsMatch } from "@infinmonkey/shared/mozdoc";
import type { PreparedScript, ResourcePayload, ScriptEntry } from "@infinmonkey/shared/types";
import { fetchDevCode, getDB, isDevOrigin } from "./store.ts";

// ---- tab 尽力而为解析：事件页里 tabs.query 可能返回空（Zen 内核缺陷）， ----
// 但 tabs.onUpdated 事件通常仍会送达；用于菜单命令/通知的 tab 定位（非关键路径）。

const tabUrlLog = new Map<number, string[]>();

browser.tabs.onUpdated.addListener(
  (tabId: number, changeInfo: { url?: string }, tab: { url?: string }) => {
    const url = changeInfo.url ?? tab.url;
    if (!url) return;
    const list = tabUrlLog.get(tabId) ?? [];
    if (list[list.length - 1] !== url) {
      list.push(url);
      if (list.length > 8) list.shift();
    }
    tabUrlLog.set(tabId, list);
  },
);

browser.tabs.onRemoved.addListener((tabId: number) => {
  tabUrlLog.delete(tabId);
});

export async function findTabIdByUrl(url: string): Promise<number | null> {
  const bare = url.split("#")[0];
  let best: { tabId: number; at: number } | null = null;
  for (const [tabId, urls] of tabUrlLog) {
    const idx = urls.findIndex((u) => u.split("#")[0] === bare);
    if (idx >= 0 && (!best || idx > 0)) best = { tabId, at: idx };
  }
  if (best) return best.tabId;
  // 日志未命中时直接问 tabs API（部分上下文可用）
  try {
    const tabs = await browser.tabs.query({ url: url.split("#")[0] });
    if (tabs.length === 1 && tabs[0].id != null) return tabs[0].id;
  } catch {
    // ignore
  }
  return null;
}

// ---- 资源抓取（@require / @resource） ----

const resourceMemo = new Map<string, { text: string; mime: string }>();

async function fetchResource(
  script: ScriptEntry,
  url: string,
): Promise<{ text: string; mime: string }> {
  const key = `${script.id}|${url}`;
  const dev = script.source.type === "dev" && isDevOrigin(url);
  if (!dev) {
    const memo = resourceMemo.get(key);
    if (memo) return memo;
  }
  const base = script.source.type === "dev" ? script.source.url : undefined;
  const target = /^https?:\/\//.test(url) ? url : new URL(url, base).href;
  const res = await fetch(target, { cache: "no-store" });
  if (!res.ok) throw new Error(`资源拉取失败 HTTP ${res.status}: ${url}`);
  const text = await res.text();
  const mime = res.headers.get("content-type") ?? "text/plain";
  const out = { text, mime };
  resourceMemo.set(key, out);
  return out;
}

function metaToPlain(s: ScriptEntry): Record<string, unknown> {
  const m = s.meta;
  return JSON.parse(JSON.stringify({
    name: m.name,
    namespace: m.namespace,
    version: m.version,
    description: m.description,
    author: m.author,
    license: m.license,
    "run-at": m.runAt,
    noframes: m.noframes,
    match: m.matches,
    include: m.includes,
    exclude: m.excludes,
    grant: m.grants,
    connect: m.connects,
    require: m.requires,
    resource: Object.fromEntries(m.resources.map((r) => [r.name, r.url])),
    "updateURL": m.updateURL,
    "downloadURL": m.downloadURL,
  }));
}

async function toPrepared(s: ScriptEntry): Promise<PreparedScript> {
  let code = s.code;
  if (s.source.type === "dev") {
    try {
      code = await fetchDevCode(s.source.url);
      s.devCode = code;
      // 异步持久化最新代码，不阻塞注入
      import("./store.ts").then((st) => st.setDevCode(s.id, code)).catch(() => {});
    } catch (e) {
      console.warn("[InfinMonkey] dev 拉取失败，使用缓存:", s.source.url, e);
      code = s.devCode ?? s.code;
    }
  }
  const requires: { url: string; text: string }[] = [];
  for (const ru of s.meta.requires) {
    try {
      const { text } = await fetchResource(s, ru);
      requires.push({ url: ru, text });
    } catch (e) {
      console.warn("[InfinMonkey] @require 拉取失败:", ru, e);
    }
  }
  const resources: ResourcePayload[] = [];
  for (const r of s.meta.resources) {
    try {
      const { text, mime } = await fetchResource(s, r.url);
      resources.push({ name: r.name, url: r.url, mime, text });
    } catch (e) {
      console.warn("[InfinMonkey] @resource 拉取失败:", r.url, e);
    }
  }
  const m = s.meta;
  return {
    id: s.id,
    name: m.name,
    namespace: m.namespace ?? "",
    version: m.version ?? "",
    description: m.description ?? "",
    author: m.author ?? "",
    icon: m.iconURL ?? "",
    runAt: m.runAt,
    noframes: m.noframes,
    grants: m.grants.filter((g) => g !== "none"),
    connects: m.connects,
    code,
    requires,
    resources,
    metaPlain: metaToPlain(s),
    headerRaw: m.headerRaw,
    devUrl: s.source.type === "dev" ? s.source.url : undefined,
    values: { ...s.values },
  };
}

export async function prepareForFrame(url: string, top: boolean): Promise<PreparedScript[]> {
  const db = await getDB();
  const out: PreparedScript[] = [];
  for (const s of db.scripts) {
    if (!s.enabled) continue;
    if (!top && s.meta.noframes) continue;
    if (!urlMatchesMeta(url, s.meta)) continue;
    out.push(await toPrepared(s));
  }
  return out;
}

/** 本页应生效的样式（runner 侧以 <style> 同步）。 */
export async function prepareStyles(url: string): Promise<{ id: string; css: string }[]> {
  const db = await getDB();
  const out: { id: string; css: string }[] = [];
  for (const s of db.styles) {
    if (!s.enabled) continue;
    const parts: string[] = [];
    for (const chunk of splitUserStyle(s.code)) {
      if (targetsMatch(chunk.targets, url)) parts.push(chunk.css);
    }
    if (parts.length) out.push({ id: s.id, css: parts.join("\n") });
  }
  return out;
}
