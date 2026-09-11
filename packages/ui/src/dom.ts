/** 轻量 DOM 工具与消息封装（扩展页面共用）。 */
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
      // "onclick" → "click" 等映射
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
 * 带「超时 + 重试」的消息发送：部分内核（实测 Zen MV3 事件页）会间歇性
 * 丢弃/挂起 runtime 消息，这里通过重试兜底。
 */
export async function msg<T = unknown>(req: BgRequest, retries = 4, timeoutMs = 5000): Promise<T> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const p = browser.runtime.sendMessage(req) as Promise<T>;
      const raced = await Promise.race([
        p,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("消息超时")), timeoutMs)
        ),
      ]);
      return raced;
    } catch (e) {
      lastErr = e;
      // 真正的业务错误（如条目不存在）不重试：背景页直接以 reject 传输的可能性低，
      // 但为简单起见仅对超时类错误重试。
      if (!String((e as Error)?.message ?? e).includes("消息超时")) throw e;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw lastErr ?? new Error("消息发送失败");
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
