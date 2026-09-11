/**
 * ISOLATED world 桥（自足版）：直接读取扩展 storage（内容脚本可用、可靠），
 * 在内容侧完成脚本匹配与载荷构建，经 postMessage 交给 MAIN world runner
 * （runner 由 manifest 以 world:"MAIN" 直接声明）。GM 特权调用仍经消息
 * 转发给 background。storage.onChanged 时自动重新同步样式。
 */
import browser from "webextension-polyfill";
import { DEFAULT_DEV_ORIGIN, PM_TAG } from "@infinmonkey/shared/constants";
import { matchScripts, prepareScripts } from "@infinmonkey/shared/inject";
import { splitUserStyle, targetsMatch } from "@infinmonkey/shared/mozdoc";
import type { PreparedScript, ScriptEntry, StyleEntry } from "@infinmonkey/shared/types";
import { isRecord } from "@infinmonkey/shared/util";

const BROADCAST = (m: Record<string, unknown>): void =>
  window.postMessage({ [PM_TAG]: true, ...m }, "*");

async function readStore(): Promise<{
  scripts: ScriptEntry[];
  styles: StyleEntry[];
  devOrigin: string;
}> {
  const st = (await browser.storage.local.get(["scripts", "styles", "settings"])) as {
    scripts?: ScriptEntry[];
    styles?: StyleEntry[];
    settings?: { devOrigin?: string };
  };
  return {
    scripts: st.scripts ?? [],
    styles: st.styles ?? [],
    devOrigin: st.settings?.devOrigin ?? DEFAULT_DEV_ORIGIN,
  };
}

async function deliver(): Promise<void> {
  try {
    const { scripts, styles } = await readStore();
    const url = location.href;
    const top = window.top === window;

    const prepared: PreparedScript[] = [];
    for (const s of matchScripts(scripts, url, top)) {
      prepared.push(await prepareScripts([s], url, top, fetchTextWith).then((r) => r[0]));
    }

    const stylePayload: { id: string; css: string }[] = [];
    for (const style of styles) {
      if (!style.enabled) continue;
      const parts: string[] = [];
      for (const chunk of splitUserStyle(style.code)) {
        if (targetsMatch(chunk.targets, url)) parts.push(chunk.css);
      }
      if (parts.length) stylePayload.push({ id: style.id, css: parts.join("\n") });
    }

    BROADCAST({ dir: "load", frameKey: url, scripts: prepared });
    BROADCAST({ dir: "styles", styles: stylePayload });
    // 跨世界调试标记（Firefox 隔离世界的 window 属性页面不可见，dataset 共享 ✓）
    document.documentElement.dataset.infinBridge = JSON.stringify({
      scripts: prepared.length,
      styles: stylePayload.length,
      total: scripts.length,
      firstUrl: scripts[0]?.source.type === "dev" ? scripts[0].source.url : "",
      firstMatches: scripts[0]?.meta.matches ?? [],
    });
  } catch (e) {
    console.warn("[InfinMonkey] deliver failed:", e);
  }
}

/** Content-side fetch; on failure fall back to a background fetch (no CORS limits). */
const fetchTextWith = async (
  url: string,
  timeoutMs = 8000,
): Promise<{ text: string; mime: string }> => {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(new Error("content fetch timeout")), timeoutMs);
    const res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { text: await res.text(), mime: res.headers.get("content-type") ?? "text/plain" };
  } catch {
    // fall through to the background fetch
  }
  const res = await browser.runtime.sendMessage({ type: "FetchText", url }) as
    | { text: string; mime: string }
    | { error: string };
  if (res && !("error" in res)) return res;
  throw new Error("error" in (res as object) ? (res as { error: string }).error : "fetch failed");
};

/** storage.onChanged：样式与条目即时同步（免刷新） */
browser.storage.onChanged.addListener((changes: Record<string, unknown>, area: string) => {
  if (area !== "local") return;
  if (!("styles" in changes)) return;
  void deliver();
});

browser.runtime.onMessage.addListener((msg: unknown) => {
  if (!isRecord(msg)) return;
  if (msg.type === "entriesChanged") {
    void deliver();
    return;
  }
  if (msg.type !== "gmValueChanged" && msg.type !== "gmCallback") return;
  window.postMessage({ [PM_TAG]: true, dir: "gm-event", ...msg }, "*");
});

window.addEventListener("message", (ev: MessageEvent) => {
  if (ev.source !== window) return;
  const d = ev.data;
  if (!isRecord(d) || d[PM_TAG] !== true || d.dir !== "gm" || typeof d.id !== "number") return;
  const id = d.id;
  if (d.op === "setClipboard") {
    const cbArgs = isRecord(d.args) ? d.args : {};
    setClipboard(String(cbArgs.text ?? ""), String(cbArgs.type ?? "text/plain"))
      .then(() => postRes(id, true, { ok: true }))
      .catch((e: unknown) => postRes(id, false, String(e)));
    return;
  }
  browser.runtime
    .sendMessage({
      type: "gmCall",
      scriptId: d.scriptId,
      reqId: d.id,
      op: d.op,
      args: isRecord(d.args) ? d.args : {},
    })
    .then((data: unknown) => postRes(id, true, data))
    .catch((e: unknown) => postRes(id, false, (e as Error)?.message ?? String(e)));
  // GM 调用由调用方在 runner 侧等待，单次发送即可（超时由各 API 语义决定）
});

function postRes(id: number, ok: boolean, data: unknown): void {
  window.postMessage(
    { [PM_TAG]: true, dir: "gm-res", id, ok, ...(ok ? { data } : { error: data }) },
    "*",
  );
}

async function setClipboard(text: string, type: string): Promise<void> {
  if (type.startsWith("text/") && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // 回退到 execCommand
    }
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
  document.documentElement.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  if (!ok) throw new Error("clipboard write failed");
}

void deliver();
