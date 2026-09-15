/**
 * MAIN world runtime: injected by the background via scripting.executeScript({world:'MAIN'}).
 * Receives script payloads handed over by the bridge, evaluates them in the page context, and bridges
 * GM privileged ops back to the ISOLATED content script via postMessage. This file runs in the page context —
 * it must not import any extension API.
 */
import { PM_TAG, RUNTIME_NAME, RUNTIME_VERSION } from "@infinmonkey/shared/constants";
import type { PreparedScript } from "@infinmonkey/shared/types";
import { base64ToBytes, bytesToBase64, isRecord } from "@infinmonkey/shared/util";
import { decodeDeliveryPayload, PAYLOAD_ELEMENT_ID } from "@infinmonkey/shared/payload";

interface RunnerGlobal {
  __infinRunnerReady?: boolean;
  __infinTTPolicy?: unknown;
}
const g = globalThis as typeof globalThis & RunnerGlobal;

if (!g.__infinRunnerReady) {
  g.__infinRunnerReady = true;
  main();
}

function main(): void {
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  const menuFns = new Map<string, () => void>();
  const callbacks = new Map<string, (nid?: string) => void>();
  const valueListeners = new Map<
    number,
    { key: string | null; fn: (k: string, ov: unknown, nv: unknown, remote: boolean) => void }
  >();
  const styleEls = new Map<string, HTMLStyleElement>();
  /** GM storage snapshot per script (kept in sync via valueChanged events). */
  const scriptStores = new Map<string, Record<string, unknown>>();
  const scriptOfListener = new Map<number, string>();
  let seq = 0;
  let listenerSeq = 0;
  let frameKey = "";
  const executed = new Set<string>();

  function req(scriptId: string, op: string, args?: Record<string, unknown>): Promise<unknown> {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      window.postMessage({ [PM_TAG]: true, dir: "gm", scriptId, id, op, args }, "*");
    });
  }

  // Deterministic handoff: the payload is consumed by initial scan and by a
  // MutationObserver, so both write-before-observe and observe-before-write
  // orders are covered. No listener-registration timing involved.
  const consumedPayloads = new Set<string>();
  function consumePayloadElement(): void {
    const el = document.getElementById(PAYLOAD_ELEMENT_ID);
    const text = el?.textContent ?? "";
    if (!text || consumedPayloads.has(text)) return;
    const payload = decodeDeliveryPayload(text);
    if (!payload) return;
    consumedPayloads.add(text);
    frameKey = payload.frameKey;
    loadScripts(payload.scripts);
    syncStyles(payload.styles);
  }

  const observer = new MutationObserver(() => consumePayloadElement());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  consumePayloadElement();

  // MutationObserver can be unreliable in headless Firefox content scripts
  // (observed on CI). A short-interval poll guarantees discovery regardless.
  const payloadPoll = setInterval(() => {
    consumePayloadElement();
    if (consumedPayloads.size > 0) clearInterval(payloadPoll);
  }, 100);

  window.addEventListener("message", (ev: MessageEvent) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!isRecord(d) || d[PM_TAG] !== true) return;
    if (d.dir === "gm-res") {
      const p = pending.get(Number(d.id));
      if (!p) return;
      pending.delete(Number(d.id));
      if (d.ok) p.resolve(d.data);
      else {p.reject(
          Object.assign(
            new Error(String(d.error ?? "Unknown error")),
            typeof d.errorExt === "object" ? d.errorExt : {},
          ),
        );}
      return;
    }
    if (d.dir === "gm-event") {
      if (d.type === "gmValueChanged") {
        const store = scriptStores.get(String(d.scriptId));
        if (store) {
          if (d.newValue === undefined) delete store[String(d.key)];
          else store[String(d.key)] = d.newValue;
        }
        for (const [lid, l] of valueListeners) {
          if (l.key !== null && l.key !== d.key) continue;
          if (scriptOfListener.get(lid) !== String(d.scriptId)) continue;
          try {
            l.fn(String(d.key), d.oldValue, d.newValue, String(d.senderKey) !== frameKey);
          } catch (e) {
            console.error("[InfinMonkey] valueChangeListener threw:", e);
          }
        }
      } else if (d.type === "gmCallback") {
        const cb = d.kind === "command"
          ? menuFns.get(String(d.callbackId))
          : callbacks.get(String(d.callbackId));
        try {
          cb?.(typeof d.notificationId === "string" ? d.notificationId : undefined);
        } catch (e) {
          console.error("[InfinMonkey] callback threw:", e);
        }
      }
    }
  });

  /** Style sync: add/change/remove decided by diffing data; takes effect without reload. */
  function syncStyles(list: { id: string; css: string }[]): void {
    const keep = new Set(list.map((s) => s.id));
    for (const [id, el] of styleEls) {
      if (!keep.has(id)) {
        el.remove();
        styleEls.delete(id);
      }
    }
    for (const { id, css } of list) {
      let el = styleEls.get(id);
      if (!el) {
        el = document.createElement("style");
        el.dataset.infinStyle = id;
        (document.head || document.documentElement)?.appendChild(el);
        styleEls.set(id, el);
      }
      if (el.textContent !== css) el.textContent = css;
    }
  }

  function loadScripts(scripts: PreparedScript[]): void {
    for (const s of scripts) {
      if (executed.has(s.id)) continue;
      executed.add(s.id);
      scheduleRun(s.runAt, () => executeScript(s));
    }
  }

  function scheduleRun(runAt: string, fn: () => void): void {
    const rs = document.readyState;
    if (runAt === "document-start" || rs === "complete") {
      fn();
      return;
    }
    if (runAt === "document-end") {
      if (rs !== "loading") fn();
      else document.addEventListener("DOMContentLoaded", () => fn(), { once: true });
      return;
    }
    // document-idle
    const go = () => {
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(() => fn(), { timeout: 1500 });
      } else setTimeout(fn, 0);
    };
    if (rs === "interactive") go();
    else window.addEventListener("load", go, { once: true });
  }

  function executeScript(s: PreparedScript): void {
    const sb = makeSandbox(s);
    const fn = createEvalFunction(sb.params, s.code);
    if (!fn) return;
    try {
      fn.call(window, ...sb.args);
      console.debug(
        `%c[InfinMonkey]%c ${s.name}${s.devUrl ? " (dev)" : ""} started`,
        "color:#e91e63;font-weight:bold",
        "",
      );
    } catch (e) {
      console.error(`[InfinMonkey] runtime error: ${s.name}`, e);
    }
  }

  /** Trusted Types fallback: try to create a default policy so that new Function works. */
  function createEvalFunction(
    params: string[],
    code: string,
  ): ((...a: unknown[]) => unknown) | null {
    const tt = (window as unknown as {
      trustedTypes?: {
        createPolicy: (n: string, p: object) => { createScript: (s: string) => string };
      };
    }).trustedTypes;
    if (tt && !g.__infinTTPolicy) {
      try {
        g.__infinTTPolicy = tt.createPolicy("infinmonkey", { createScript: (x: string) => x });
      } catch {
        // The page restricts the policy allowlist; cannot create one
      }
    }
    const pol = g.__infinTTPolicy as { createScript: (s: string) => string } | undefined;
    try {
      const body = pol ? pol.createScript(code) : code;
      return new Function(...params, body) as (...a: unknown[]) => unknown;
    } catch (e) {
      console.error("[InfinMonkey] compile failed (possibly blocked by page Trusted Types):", e);
      return null;
    }
  }

  function serializeData(data: unknown): unknown {
    if (data == null) return null;
    if (typeof data === "string") return data;
    if (data instanceof URLSearchParams) return data.toString();
    if (typeof FormData !== "undefined" && data instanceof FormData) {
      const sp = new URLSearchParams();
      for (const [k, v] of data.entries()) sp.append(k, typeof v === "string" ? v : "");
      return sp.toString();
    }
    if (typeof ArrayBuffer !== "undefined" && data instanceof ArrayBuffer) {
      return { __binary: true, b64: bytesToBase64(data), mime: "application/octet-stream" };
    }
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      return blobToBinary(data);
    }
    if (typeof data === "object") {
      // Plain object → form-encoded (matches TM behavior)
      const sp = new URLSearchParams();
      for (const [k, v] of Object.entries(data as Record<string, unknown>)) sp.append(k, String(v));
      return sp.toString();
    }
    return String(data);
  }

  function blobToBinary(b: Blob): Promise<unknown> | unknown {
    if (typeof File === "undefined" || !(b instanceof Blob)) return String(b);
    return new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => {
        const buf = (fr.result as ArrayBuffer) ?? new ArrayBuffer(0);
        resolve({
          __binary: true,
          b64: bytesToBase64(buf),
          mime: b.type || "application/octet-stream",
        });
      };
      fr.onerror = () =>
        resolve({ __binary: true, b64: "", mime: b.type || "application/octet-stream" });
      fr.readAsArrayBuffer(b);
    });
  }

  function makeSandbox(s: PreparedScript): { params: string[]; args: unknown[] } {
    const grantNames = new Set(s.grants.filter((x) => x && x !== "none"));

    const GM_info: Record<string, unknown> = {
      uuid: s.id,
      scriptMetaStr: s.headerRaw,
      scriptHandler: RUNTIME_NAME,
      version: RUNTIME_VERSION,
      script: s.metaPlain,
    };

    // The GM_*Value family follows the TM/VM convention of synchronous APIs: use the local snapshot preloaded with the payload;
    // writes update the snapshot and sync to extension storage asynchronously; the GM.* dotted APIs provide async forms.
    const valueStore: Record<string, unknown> = { ...(s.values ?? {}) };
    scriptStores.set(s.id, valueStore);

    const getValue = (key: string, def?: unknown) => (key in valueStore ? valueStore[key] : def);
    const setValue = (key: string, value: unknown) => {
      valueStore[key] = value;
      void req(s.id, "setValue", { key, value });
    };
    const deleteValue = (key: string) => {
      delete valueStore[key];
      void req(s.id, "deleteValue", { key });
    };
    const listValues = () => Object.keys(valueStore);

    const addValueChangeListener = (
      key: string,
      fn: (k: string, ov: unknown, nv: unknown, remote: boolean) => void,
    ): number => {
      const id = ++listenerSeq;
      valueListeners.set(id, { key: key ?? null, fn });
      scriptOfListener.set(id, s.id);
      return id;
    };
    const removeValueChangeListener = (id: number): void => {
      valueListeners.delete(id);
    };

    const resourceByName = (name: string) => s.resources.find((r) => r.name === name);
    const getResourceText = (name: string): string | undefined => resourceByName(name)?.text;
    const getResourceURL = (name: string): string | undefined => {
      const r = resourceByName(name);
      if (!r) return undefined;
      return URL.createObjectURL(new Blob([r.text], { type: r.mime || "text/plain" }));
    };

    const addStyle = (css: string): HTMLStyleElement | undefined => {
      const el = document.createElement("style");
      el.textContent = css;
      (document.head || document.documentElement)?.appendChild(el);
      return el;
    };

    const registerMenuCommand = (title: string, fn: () => void, opts?: unknown) => {
      const accessKey = typeof opts === "object" && opts
        ? (opts as { accessKey?: string }).accessKey
        : opts;
      return req(s.id, "registerMenuCommand", {
        title,
        accessKey: accessKey == null ? undefined : String(accessKey),
      })
        .then((r) => {
          const id = String((r as { commandId: number }).commandId);
          menuFns.set(id, fn);
          return (r as { commandId: number }).commandId;
        });
    };
    const unregisterMenuCommand = (commandId: number) => {
      menuFns.delete(String(commandId));
      return req(s.id, "unregisterMenuCommand", { commandId });
    };

    const setClipboard = (data: string, info?: unknown) =>
      req(s.id, "setClipboard", {
        text: String(data),
        type: typeof info === "object" && info
          ? String((info as { type?: string }).type ?? "text/plain")
          : typeof info === "string"
          ? info
          : "text/plain",
      });

    const notification = (details: Record<string, unknown>, ondone?: (nid?: string) => void) => {
      let callbackId: string | undefined;
      const cb = typeof ondone === "function"
        ? ondone
        : typeof details?.ondone === "function"
        ? details.ondone as (nid?: string) => void
        : undefined;
      if (cb) {
        callbackId = `n${++seq}`;
        callbacks.set(callbackId, cb);
      }
      return req(s.id, "notification", {
        title: details?.title,
        text: details?.text ?? details?.message,
        image: details?.image ?? details?.icon,
        highlight: details?.highlight,
        silent: details?.silent,
        timeout: details?.timeout,
        callbackId,
      });
    };

    const openInTab = (url: string, opts?: unknown) => {
      const o = (typeof opts === "object" && opts ? opts : { inBackground: !!opts }) as Record<
        string,
        unknown
      >;
      return req(s.id, "openInTab", {
        url,
        active: o.active != null ? !!o.active : !(o.inBackground ?? false),
        pinned: !!o.pinned,
        insert: !!o.insert,
        container: o.container,
      }).then((r) => {
        const tabId = (r as { tabId: number }).tabId;
        return {
          tabId,
          closed: false,
          onclose: null as null,
          close: () => req(s.id, "closeTab", { tabId }),
        };
      });
    };

    const getTab = (cb: (obj: Record<string, unknown>) => void) =>
      req(s.id, "getTab").then((r) => cb?.((r as { tab: Record<string, unknown> }).tab));
    const saveTab = (obj: Record<string, unknown>) => req(s.id, "saveTab", { tab: obj });
    const getTabs = (cb: (tabs: Record<string, unknown>) => void) =>
      req(s.id, "getTabs").then((r) => cb?.((r as { tabs: Record<string, unknown> }).tabs));

    const download = (a: unknown, b?: string) => {
      const details = typeof a === "string" ? { url: a, name: b } : a as Record<string, unknown>;
      return req(s.id, "download", details as Record<string, unknown>);
    };

    interface GmXhrResponse {
      readyState: number;
      status: number;
      statusText: string;
      responseHeaders: string;
      finalUrl: string;
      response: unknown;
      responseText?: string;
      responseXML: null;
    }

    type GmXhrError = Error & { error: string; aborted?: boolean; timeout?: boolean };

    interface GmXhrDetails {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      data?: unknown;
      responseType?: "text" | "json" | "arraybuffer";
      timeout?: number;
      anonymous?: boolean;
      redirect?: string;
      onloadstart?: (resp: GmXhrResponse) => void;
      onprogress?: (
        e: GmXhrResponse & {
          lengthComputable: boolean;
          loaded: number;
          total: number;
          partial: boolean;
        },
      ) => void;
      onload?: (resp: GmXhrResponse) => void;
      onerror?: (e: GmXhrError) => void;
      onabort?: (e: GmXhrError) => void;
      ontimeout?: (e: GmXhrError) => void;
      onloadend?: (r: unknown) => void;
    }

    const xmlHttpRequest = (details: GmXhrDetails) => {
      const callId = ++seq;
      const abort = () =>
        window.postMessage({
          [PM_TAG]: true,
          dir: "gm",
          scriptId: s.id,
          id: callId,
          op: "abortXhr",
          args: {},
        }, "*");
      const responseType = typeof details.responseType === "string" ? details.responseType : "text";
      const dataPromise = Promise.resolve(serializeData(details.data));
      dataPromise.then((data) => {
        const p = new Promise((resolve, reject) => {
          pending.set(callId, { resolve, reject });
          window.postMessage({
            [PM_TAG]: true,
            dir: "gm",
            scriptId: s.id,
            id: callId,
            op: "xmlHttpRequest",
            args: {
              url: details.url,
              method: details.method ?? "GET",
              headers: details.headers ?? {},
              data,
              responseType,
              timeout: details.timeout,
              anonymous: details.anonymous,
              redirect: details.redirect,
            },
          }, "*");
        });
        p.then((r0) => {
          const r = r0 as {
            status: number;
            statusText: string;
            headers: [string, string][];
            finalUrl: string;
            text?: string;
            base64?: string;
            size?: number;
          };
          let response: unknown;
          if (responseType === "arraybuffer") response = base64ToBytes(r.base64 ?? "").buffer;
          else if (responseType === "json") {
            try {
              response = JSON.parse(r.text ?? "");
            } catch {
              response = null;
            }
          } else response = r.text;
          const resp: GmXhrResponse = {
            readyState: 4,
            status: r.status,
            statusText: r.statusText,
            responseHeaders: (r.headers ?? []).map(([k, v]) => `${k}: ${v}`).join("\r\n"),
            finalUrl: r.finalUrl,
            response,
            responseText: responseType === "arraybuffer" ? undefined : r.text,
            responseXML: null,
          };
          try {
            details.onloadstart?.(resp);
            details.onprogress?.({
              ...resp,
              lengthComputable: true,
              loaded: r.size ?? 0,
              total: r.size ?? 0,
              partial: false,
            });
            details.onload?.(resp);
          } finally {
            details.onloadend?.(resp);
          }
        }).catch((e0: unknown) => {
          const e = e0 instanceof Error ? e0 : new Error(String(e0));
          const err = e as GmXhrError;
          err.error = err.message;
          let cb = details.onerror;
          if (err.aborted || err.message === "aborted") cb = details.onabort;
          else if (err.timeout) cb = details.ontimeout;
          try {
            cb?.(err);
          } finally {
            details.onloadend?.(err);
          }
        });
      });
      return { abort };
    };

    // ---- Assemble arguments (injected per the @grant allowlist) ----
    const impls: Array<[string, unknown]> = [
      ["GM_addValueChangeListener", addValueChangeListener],
      ["GM_removeValueChangeListener", removeValueChangeListener],
      ["GM_setValue", setValue],
      ["GM_getValue", getValue],
      ["GM_deleteValue", deleteValue],
      ["GM_listValues", listValues],
      ["GM_getResourceText", getResourceText],
      ["GM_getResourceURL", getResourceURL],
      ["GM_addStyle", addStyle],
      ["GM_registerMenuCommand", registerMenuCommand],
      ["GM_unregisterMenuCommand", unregisterMenuCommand],
      ["GM_setClipboard", setClipboard],
      ["GM_notification", notification],
      ["GM_openInTab", openInTab],
      ["GM_getTab", getTab],
      ["GM_saveTab", saveTab],
      ["GM_getTabs", getTabs],
      ["GM_download", download],
      ["GM_xmlhttpRequest", xmlHttpRequest],
    ];

    const gmDot: Record<string, unknown> = {
      info: GM_info,
      // GM4 dotted APIs provide async forms
      getValue: (k: string, d?: unknown) => Promise.resolve(getValue(k, d)),
      setValue: (k: string, v: unknown) => Promise.resolve(setValue(k, v)),
      deleteValue: (k: string) => Promise.resolve(deleteValue(k)),
      listValues: () => Promise.resolve(listValues()),
      addValueChangeListener,
      removeValueChangeListener,
      getResourceText,
      getResourceURL,
      addStyle,
      registerMenuCommand,
      unregisterMenuCommand,
      setClipboard,
      notification,
      openInTab,
      getTab,
      saveTab,
      getTabs,
      download,
      xmlHttpRequest,
    };

    const params: string[] = [];
    const args: unknown[] = [];
    const add = (name: string, val: unknown) => {
      params.push(name);
      args.push(val);
    };
    for (const [name, impl] of impls) {
      if (grantNames.has(name)) add(name, impl);
    }
    let hasDot = false;
    for (const gname of grantNames) {
      if (gname.startsWith("GM.")) {
        hasDot = true;
        const short = gname.slice(3);
        if (short !== "info" && !(short in gmDot)) {
          console.warn(`[InfinMonkey] unknown grant: ${gname}`);
        }
      }
    }
    if (hasDot) add("GM", gmDot);
    if (grantNames.has("unsafeWindow")) add("unsafeWindow", window);
    add("GM_info", GM_info);
    return { params, args };
  }
}
