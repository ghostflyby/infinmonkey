import browser from "webextension-polyfill";
import { base64ToBytes, bytesToBase64 } from "@infinmonkey/shared/util";
import { isConnectAllowed } from "@infinmonkey/shared/connect";
import { addConnectGrant, findEntry } from "./store.ts";

// ---- GM_xmlhttpRequest ----

const activeXhrs = new Map<string, AbortController>();

export function abortXhr(ctxKey: string): void {
  activeXhrs.get(ctxKey)?.abort(new Error("aborted"));
}

const authWaiters = new Map<string, Array<(ok: boolean) => void>>();
const authWindows = new Map<string, number | undefined>();
const sessionGrants = new Set<string>();

/** Opens a one-time authorization prompt; concurrent requests for the same (script, domain) reuse one prompt's result. */
function requestConnectAuth(scriptId: string, domain: string): Promise<boolean> {
  const key = `${scriptId}:${domain}`;
  const waiters = authWaiters.get(key) ?? [];
  authWaiters.set(key, waiters);
  const promise = new Promise<boolean>((resolve) => waiters.push(resolve));
  if (waiters.length > 1) return promise;
  const url = browser.runtime.getURL(
    `prompt/index.html?script=${encodeURIComponent(scriptId)}&domain=${encodeURIComponent(domain)}`,
  );
  browser.windows.create({ url, type: "popup", width: 460, height: 260 })
    .then((win: browser.Windows.Window | undefined) => authWindows.set(key, win?.id))
    .catch((e: unknown) => {
      console.warn("[InfinMonkey] failed to open auth prompt:", e);
      authWaiters.delete(key);
      waiters.forEach((r) => r(false));
    });
  return promise;
}

export async function resolveConnectAuth(
  scriptId: string,
  domain: string,
  scope: "once" | "always" | "deny",
): Promise<void> {
  const key = `${scriptId}:${domain}`;
  const waiters = authWaiters.get(key);
  authWaiters.delete(key);
  if (scope === "always") await addConnectGrant(scriptId, domain);
  else if (scope === "once") sessionGrants.add(`${scriptId}:${domain.toLowerCase()}`);
  waiters?.forEach((r) => r(scope !== "deny"));
  const winId = authWindows.get(key);
  if (winId != null) {
    authWindows.delete(key);
    browser.windows.remove(winId).catch(() => {});
  }
}

async function connectAllowedOrAsk(scriptId: string, host: string): Promise<boolean> {
  const entry = await findEntry(scriptId);
  const connects = entry?.kind === "script" ? entry.meta.connects : [];
  const grants = entry?.kind === "script" ? entry.connectGrants : [];
  if (isConnectAllowed(connects, grants, host)) return true;
  if (sessionGrants.has(`${scriptId}:${host.toLowerCase()}`)) return true;
  return await requestConnectAuth(scriptId, host);
}

interface XhrArgs {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  data?: unknown;
  responseType?: string;
  timeout?: number;
  anonymous?: boolean;
  redirect?: string;
  binary?: boolean;
}

export async function handleXhr(ctxKey: string, scriptId: string, args: XhrArgs) {
  let url: URL;
  try {
    url = new URL(args.url);
  } catch {
    throw new Error(`GM_xmlhttpRequest: invalid URL "${args.url}" (absolute URL required)`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("GM_xmlhttpRequest: only http/https is supported");
  }
  if (!(await connectAllowedOrAsk(scriptId, url.hostname))) {
    throw new Error(
      `GM_xmlhttpRequest: domain "${url.hostname}" not allowed by @connect (auth prompt shown)`,
    );
  }

  const ctrl = new AbortController();
  activeXhrs.set(ctxKey, ctrl);
  const timer = args.timeout && args.timeout > 0
    ? setTimeout(() => {
      const err = new Error("timeout") as Error & { timeout: boolean };
      err.timeout = true;
      ctrl.abort(err);
    }, args.timeout)
    : null;
  try {
    const init: RequestInit = {
      method: (args.method ?? "GET").toUpperCase(),
      headers: cleanHeaders(args.headers),
      credentials: args.anonymous ? "omit" : "include",
      redirect: args.redirect === "error" ? "error" : "follow",
      signal: ctrl.signal,
    };
    const body = decodeData(args.data);
    if (body != null && init.method !== "GET" && init.method !== "HEAD") init.body = body;
    const res = await fetch(url.href, init);
    if (args.responseType === "arraybuffer") {
      const base64 = bytesToBase64(await res.arrayBuffer());
      return packXhr(res, { base64, text: undefined });
    }
    const text = await res.text();
    return packXhr(res, { text, base64: undefined });
  } catch (e) {
    const err = e as Error & { timeout?: boolean };
    if (err.name === "AbortError" || err.message === "aborted") {
      if (err.timeout) throw err;
      const ab = new Error("aborted") as Error & { aborted: boolean };
      ab.aborted = true;
      throw ab;
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
    activeXhrs.delete(ctxKey);
  }
}

function packXhr(res: Response, body: { text?: string; base64?: string }) {
  return {
    status: res.status,
    statusText: res.statusText,
    headers: [...res.headers.entries()],
    finalUrl: res.url,
    size: Number(res.headers.get("content-length") ?? 0),
    ...body,
  };
}

function cleanHeaders(h?: Record<string, string>): Record<string, string> | undefined {
  if (!h) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function decodeData(d: unknown): BodyInit | null {
  if (d == null) return null;
  if (typeof d === "string") return d;
  if (typeof d === "object" && "__binary" in (d as Record<string, unknown>)) {
    const o = d as { __binary: true; b64: string; mime?: string };
    return new Blob([base64ToBytes(o.b64) as unknown as BlobPart], {
      type: o.mime || "application/octet-stream",
    });
  }
  throw new Error("GM_xmlhttpRequest: unsupported data type (string/binary only)");
}

// ---- GM_download ----

export async function handleDownload(
  scriptId: string,
  args: { url: string; name?: string; saveAs?: boolean; conflictAction?: string },
) {
  let url: URL;
  try {
    url = new URL(args.url);
  } catch {
    throw new Error(`GM_download: invalid URL "${args.url}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("GM_download: only http/https is supported");
  }
  if (!(await connectAllowedOrAsk(scriptId, url.hostname))) {
    throw new Error(
      `GM_download: domain "${url.hostname}" not allowed by @connect (auth prompt shown)`,
    );
  }
  const res = await fetch(url.href, { credentials: "include" });
  if (!res.ok) throw new Error(`GM_download: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const mime = res.headers.get("content-type") ?? "application/octet-stream";
  const dataUrl = `data:${mime};base64,${bytesToBase64(buf)}`;
  const filename = (args.name || decodeURIComponent(url.pathname.split("/").pop() || "download"))
    .replace(
      /[/\\:*?"<>|]/g,
      "_",
    );
  const downloadId = await browser.downloads.download({
    url: dataUrl,
    filename,
    saveAs: !!args.saveAs,
    conflictAction: (args.conflictAction as "uniquify" | "overwrite" | "prompt") ?? "uniquify",
  });
  return { downloadId };
}

// For testing only
