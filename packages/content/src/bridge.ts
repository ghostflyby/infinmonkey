/**
 * ISOLATED world bridge (self-contained): reads extension storage directly (available and reliable in content scripts),
 * does script matching and payload building on the content side, and hands the payload to the MAIN world runner
 * (the runner is declared world:"MAIN" directly in the manifest). GM privileged calls are still forwarded
 * to the background via messages. Styles are re-synced automatically on storage.onChanged.
 */
import browser from "webextension-polyfill";
import { PM_TAG } from "@infinmonkey/shared/constants";
import { matchScripts, prepareScripts } from "@infinmonkey/shared/inject";
import { splitUserStyle, targetsMatch } from "@infinmonkey/shared/mozdoc";
import { userAllows } from "@infinmonkey/shared/settings";
import type {
  PreparedScript,
  ScriptEntry,
  ScriptErrorRecord,
  StyleEntry,
} from "@infinmonkey/shared/types";
import { isRecord, withRetry, withTimeout } from "@infinmonkey/shared/util";
import {
  DeliveryPayload,
  encodeDeliveryPayload,
  PAYLOAD_ATTR,
  PAYLOAD_ELEMENT_ID,
} from "@infinmonkey/shared/payload";

/** WORKAROUND (Firefox MV3): storage.local.get from a content script at
 * document_start can hang while the extension is still starting up. Timeout
 * and retry once; a second hang surfaces as a delivery error instead of
 * silently losing the whole injection. */
const STORAGE_READ_TIMEOUT_MS = 5_000;
const STORAGE_READ_RETRY_DELAY_MS = 500;

/**
 * Per-document identity attached to every GM call: the background keys call
 * context and GM_getTab data by it. The page observes the postMessage traffic
 * but cannot substitute another document's value - the bridge attaches its
 * own nonce and never forwards one from the frame. crypto.randomUUID is
 * secure-context-only and content scripts follow the page's context, hence
 * the fallback for plain-http pages.
 */
const BRIDGE_NONCE = typeof crypto.randomUUID === "function"
  ? crypto.randomUUID()
  : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function readStoreGuarded(): Promise<{
  scripts: ScriptEntry[];
  styles: StyleEntry[];
  settings: { devOrigin?: string; masterEnabled?: boolean; siteBlacklist?: string[] };
}> {
  const read = async (): Promise<{
    scripts?: ScriptEntry[];
    styles?: StyleEntry[];
    settings?: { devOrigin?: string; masterEnabled?: boolean; siteBlacklist?: string[] };
  }> => {
    const st = (await withTimeout(
      browser.storage.local.get(["scripts", "styles", "settings"]) as Promise<
        Record<string, unknown>
      >,
      STORAGE_READ_TIMEOUT_MS,
      "storage.local.get",
    )) as {
      scripts?: ScriptEntry[];
      styles?: StyleEntry[];
      settings?: { devOrigin?: string; masterEnabled?: boolean; siteBlacklist?: string[] };
    };
    // Normalize: storage.local.get returns only keys that exist, so a fresh
    // store omits `styles`/`settings` entirely.
    return {
      scripts: st.scripts ?? [],
      styles: st.styles ?? [],
      settings: st.settings ?? {},
    };
  };
  return withRetry(read, 2, STORAGE_READ_RETRY_DELAY_MS) as Promise<{
    scripts: ScriptEntry[];
    styles: StyleEntry[];
    settings: { devOrigin?: string; masterEnabled?: boolean; siteBlacklist?: string[] };
  }>;
}

async function deliver(): Promise<void> {
  const mark = (t: string) => {
    document.documentElement.dataset.infinBridge = t;
  };
  mark("start");
  try {
    const { scripts, styles, settings } = await readStoreGuarded();
    const url = location.href;
    const top = window.top === window;

    // Site controls short-circuit before matching: nothing injects, and the
    // carriers are overwritten with an empty payload so the runner cannot
    // re-consume a previous delivery.
    if (!userAllows(url, settings)) {
      writeCarriers(
        encodeDeliveryPayload({
          frameKey: url,
          bridgeNonce: BRIDGE_NONCE,
          scripts: [],
          styles: [],
        }),
      );
      mark("disabled");
      return;
    }

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

    // Deterministic handoff: the payload travels via two redundant inert
    // carriers the runner discovers by initial scan, MutationObserver, or a
    // short poll - never over the shared message bus, whose listener
    // registration is a timing dependency. The attribute is the primary
    // channel (proven readable cross-world in headless); the element is a
    // fallback for engines that limit attribute size.
    const payload: DeliveryPayload = {
      frameKey: url,
      bridgeNonce: BRIDGE_NONCE,
      scripts: prepared,
      styles: stylePayload,
    };
    writeCarriers(encodeDeliveryPayload(payload));
    // Cross-world debug marker (in Firefox the page cannot see isolated-world window properties; dataset is shared ✓)
    document.documentElement.dataset.infinBridge = JSON.stringify({
      scripts: prepared.length,
      styles: stylePayload.length,
      total: scripts.length,
      firstUrl: scripts[0]?.source.type === "dev" ? scripts[0].source.url : "",
      firstMatches: scripts[0]?.meta.matches ?? [],
    });
  } catch (e) {
    console.warn("[InfinMonkey] deliver failed:", e);
    mark("ERR: " + (e instanceof Error ? `${e.name}: ${e.message}` : String(e)));
  }
}

function writeCarriers(encoded: string): void {
  let carrier = document.getElementById(PAYLOAD_ELEMENT_ID);
  if (!carrier) {
    // Unknown type keeps the element inert; content scripts write it, the
    // MAIN-world runner reads it.
    carrier = document.createElement("script");
    carrier.id = PAYLOAD_ELEMENT_ID;
    (carrier as HTMLScriptElement).type = "application/x-infinmonkey-payload";
    document.documentElement.appendChild(carrier);
  }
  carrier.textContent = encoded;
  document.documentElement.setAttribute(PAYLOAD_ATTR, encoded);
}

/** Content-side fetch; on failure fall back to a background fetch (no CORS limits). */
const fetchTextWith = async (
  url: string,
  timeoutMs = 8000,
): Promise<{ text: string; mime: string }> => {
  // Fetching http resources from an https page is always blocked by mixed content (observed to hang until timeout rather than fail fast),
  // so skip the doomed content-side fetch and go straight to the background; content-side fetch is also subject to page CORS, the background path is not
  const mixedContent = location.protocol === "https:" && url.startsWith("http://");
  if (!mixedContent) {
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
  }
  const res = await browser.runtime.sendMessage({ type: "FetchText", url }) as
    | { text: string; mime: string }
    | { error: string };
  if (res && !("error" in res)) return res;
  throw new Error("error" in (res as object) ? (res as { error: string }).error : "fetch failed");
};

/** storage.onChanged: sync styles and entries immediately (no reload); site
 * controls changes re-evaluate the gate the same way. */
browser.storage.onChanged.addListener((changes: Record<string, unknown>, area: string) => {
  if (area !== "local") return;
  if (!("styles" in changes) && !("settings" in changes)) return;
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

// Runner-reported script failures persist to `imErrors` (management UI only).
// The frame is page-forgeable by design: fields are truncated and the record
// never leaves this extension's storage.
window.addEventListener("message", (ev: MessageEvent) => {
  if (ev.source !== window) return;
  const d = ev.data;
  if (!isRecord(d) || d[PM_TAG] !== true) return;
  if (d.dir === "script-error") {
    void recordScriptError(
      String(d.scriptId ?? ""),
      String(d.message ?? ""),
      typeof d.line === "number" ? d.line : undefined,
      typeof d.col === "number" ? d.col : undefined,
    );
    return;
  }
  if (d.dir !== "gm" || typeof d.id !== "number") return;
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
      nonce: BRIDGE_NONCE,
      scriptId: d.scriptId,
      reqId: d.id,
      op: d.op,
      args: isRecord(d.args) ? d.args : {},
    })
    .then((data: unknown) => postRes(id, true, data))
    .catch((e: unknown) => postRes(id, false, (e as Error)?.message ?? String(e)));
  // The caller awaits the GM call on the runner side, so a single send suffices (timeouts follow each API's semantics)
});

const SCRIPT_ERROR_LIMIT = 100;
const SCRIPT_ERROR_REPEAT_MS = 30_000;

/** Per-document throttle state: identical messages within the window are
 * collapsed (scripts often throw in a loop). */
const lastScriptError = new Map<string, { message: string; at: number }>();

async function recordScriptError(
  scriptId: string,
  rawMessage: string,
  line?: number,
  col?: number,
): Promise<void> {
  const message = rawMessage.slice(0, 500);
  if (!scriptId || !message) return;
  const prev = lastScriptError.get(scriptId);
  if (prev && prev.message === message && Date.now() - prev.at < SCRIPT_ERROR_REPEAT_MS) return;
  try {
    const st = (await browser.storage.local.get("imErrors")) as {
      imErrors?: Record<string, ScriptErrorRecord>;
    };
    const errors = st.imErrors ?? {};
    errors[scriptId] = {
      message,
      at: Date.now(),
      url: location.href.slice(0, 500),
      // Position fields exist only when the runner mapped the throw to a
      // userscript line; the record stays shaped for the management UI.
      ...(typeof line === "number" ? { line, col: typeof col === "number" ? col : 1 } : {}),
    };
    const ids = Object.keys(errors);
    if (ids.length > SCRIPT_ERROR_LIMIT) {
      const oldest = ids.sort((a, b) => errors[a].at - errors[b].at)
        .slice(0, ids.length - SCRIPT_ERROR_LIMIT);
      for (const id of oldest) delete errors[id];
    }
    await browser.storage.local.set({ imErrors: errors });
    // Throttle state is set only after the record persisted, so a failed
    // write does not suppress retries for the next 30s.
    lastScriptError.set(scriptId, { message, at: Date.now() });
  } catch (e) {
    console.warn("[InfinMonkey] failed to record script error:", e);
  }
}

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
      // Fall back to execCommand
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
