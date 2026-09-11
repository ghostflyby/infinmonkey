/**
 * ISOLATED world 桥：document_start 时向 background 请求本 frame 的脚本与样式载荷，
 * 经 postMessage 交给 MAIN world runner（runner 由 manifest 以 world:"MAIN" 直接声明，
 * 不依赖 background 注入）。同时转发 GM 特权调用与后台事件。
 */
import browser from "webextension-polyfill";
import { PM_TAG } from "@infinmonkey/shared/constants";
import type { FrameScripts } from "@infinmonkey/shared/protocol";
import { isRecord } from "@infinmonkey/shared/util";

/**
 * 心跳：实测 Zen/Firefox MV3 的事件页在闲置挂起后，对「扩展页面」发起的
 * 消息唤醒不可靠（内容脚本消息则可靠）。有任意标签页存在时以 20s 心跳
 * 维持 background 存活，规避该缺陷。
 */
setInterval(() => {
  browser.runtime.sendMessage({ type: "ping" }).catch(() => {});
}, 20_000);

void (async () => {
  try {
    await requestAndDeliver();
  } catch {
    // 扩展正在重载等情况
  }
})();

/** 注入关键路径：带重试的消息（内核会间歇性丢消息）。 */
async function bgSend<T>(req: Record<string, unknown>, retries = 4, timeoutMs = 5000): Promise<T> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return (await Promise.race([
        browser.runtime.sendMessage(req) as Promise<T>,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("bg 超时")), timeoutMs)
        ),
      ])) as T;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw lastErr ?? new Error("bg 通信失败");
}

async function requestAndDeliver(): Promise<void> {
  const res = (await bgSend({
    type: "GetScriptsForFrame",
    url: location.href,
    top: window.top === window,
  })) as FrameScripts | null;
  if (!res) return;
  window.postMessage(
    { [PM_TAG]: true, dir: "load", frameKey: res.frameKey, scripts: res.scripts },
    "*",
  );
  window.postMessage({ [PM_TAG]: true, dir: "styles", styles: res.styles }, "*");
}

// 条目变化（增删改/开关/样式保存/dev 推送）→ 只同步样式；脚本变更下次导航生效
browser.runtime.onMessage.addListener((msg: unknown) => {
  if (!isRecord(msg)) return;
  if (msg.type === "entriesChanged") {
    void requestAndDeliver();
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
  if (!ok) throw new Error("剪贴板写入失败");
}
