/** Lightweight DOM helpers and messaging wrapper (shared by extension pages). */
import browser from "webextension-polyfill";
import type { BgRequest } from "@infinmonkey/shared/protocol";

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | ((e: Event) => void)> = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === "function") {
      // "onclick" → "click" style mappings
      el.addEventListener(k.startsWith("on") ? k.slice(2) : k, v as EventListener);
    } else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c == null) continue;
    el.append(c instanceof Node ? c : document.createTextNode(c));
  }
  return el;
}

/**
 * Message sending with timeout + retry: some engines (observed on the Zen MV3 event page) intermittently
 * drop or hang runtime messages; retrying works around that.
 */
export async function msg<T = unknown>(req: BgRequest, retries = 4, timeoutMs = 5000): Promise<T> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const p = browser.runtime.sendMessage(req) as Promise<T>;
      const raced = await Promise.race([
        p,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Message timed out")), timeoutMs)
        ),
      ]);
      return raced;
    } catch (e) {
      lastErr = e;
      // Real business errors (e.g. entry not found) are not retried: the background is unlikely to transfer them as a reject,
      // but for simplicity only timeout-type errors are retried.
      if (!String((e as Error)?.message ?? e).includes("Message timed out")) throw e;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw lastErr ?? new Error("Failed to send message");
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function toast(text: string, error = false): void {
  let el = document.getElementById("im-toast");
  if (!el) {
    el = h("div", { id: "im-toast" });
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.className = error ? "error show" : "show";
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el!.classList.remove("show"), 2600);
}

export function debounce<A extends unknown[]>(
  fn: (...a: A) => void,
  ms: number,
): (...a: A) => void {
  let t: ReturnType<typeof setTimeout> | null = null;
  return (...a: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}
