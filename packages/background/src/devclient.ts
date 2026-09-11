import browser from "webextension-polyfill";
import type { ScriptEntry } from "@infinmonkey/shared/types";
import { fetchDevCode, getDB, setDevCode, updateCode } from "./store.ts";

/**
 * 连接 tools/dev_server.ts 的 WebSocket，把本地文件变化转成：
 * - 样式：拉取新代码 → 所有匹配 frame 免刷新重注入；
 * - 脚本：更新 devCode 缓存 →（可选）自动刷新命中该脚本 @match 的标签页。
 */
class DevClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private origin = "";
  connected = false;

  async ensureConnected(origin?: string): Promise<void> {
    const db = await getDB();
    const target = origin ?? db.settings.devOrigin;
    if (this.connected && this.origin === target) return;
    if (this.origin !== target) this.close();
    this.origin = target;
    this.connect();
  }

  private connect(): void {
    if (!/^https?:\/\//.test(this.origin)) return;
    try {
      this.ws = new WebSocket(this.origin.replace(/^http/, "ws") + "/__infin/ws");
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => this.setStatus(true);
    this.ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data as string);
        if (m.type === "changed" && Array.isArray(m.files)) {
          void this.onChanged(m.files as string[]);
        }
      } catch {
        // 忽略非 JSON 帧
      }
    };
    this.ws.onclose = () => {
      this.setStatus(false);
      this.scheduleReconnect();
    };
    this.ws.onerror = () => {
      try {
        this.ws?.close();
      } catch {
        // ignore
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.origin) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 4000);
  }

  private setStatus(c: boolean): void {
    if (c === this.connected) return;
    this.connected = c;
    browser.runtime.sendMessage({ type: "devStatus", connected: c, origin: this.origin }).catch(
      () => {},
    );
  }

  close(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.ws = null;
    this.setStatus(false);
  }

  private async onChanged(files: string[]): Promise<void> {
    const db = await getDB();
    for (const entry of [...db.scripts, ...db.styles]) {
      if (entry.source.type !== "dev") continue;
      let pathname = "";
      try {
        pathname = new URL(entry.source.url).pathname;
      } catch {
        continue;
      }
      if (!files.some((f) => pathname === "/" + f || pathname.endsWith("/" + f))) continue;

      let code: string | null = null;
      try {
        code = await fetchDevCode(entry.source.url);
      } catch (e) {
        console.warn("[InfinMonkey] dev 文件变化拉取失败:", entry.source.url, e);
      }
      if (!code) continue;

      if (entry.kind === "style") {
        // updateCode 会广播 entriesChanged，bridge 收到后重新拉取并同步页面 <style>
        await updateCode(entry.id, code);
      } else {
        await setDevCode(entry.id, code);
        const src = entry.source;
        if (src.type === "dev" && src.autoReload) await reloadMatchingTabs(entry);
      }
    }
  }
}

async function reloadMatchingTabs(entry: ScriptEntry): Promise<void> {
  const src = entry.source;
  if (src.type !== "dev") return;
  const patterns = entry.meta.matches.length > 0 ? entry.meta.matches : ["<all_urls>"];
  let tabs: Array<{ id?: number; url?: string }> = [];
  try {
    tabs = await browser.tabs.query({ url: patterns });
  } catch {
    tabs = await browser.tabs.query({});
  }
  let devPageOrigin = "";
  try {
    devPageOrigin = new URL(src.url).origin + "/";
  } catch {
    // ignore
  }
  for (const t of tabs) {
    if (!t.id || !t.url || !/^https?:/.test(t.url)) continue;
    if (devPageOrigin && t.url.startsWith(devPageOrigin)) continue;
    browser.tabs.reload(t.id).catch(() => {});
  }
}

export const devClient = new DevClient();
