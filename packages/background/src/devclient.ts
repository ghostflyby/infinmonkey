import browser from "webextension-polyfill";
import type { ScriptEntry } from "@infinmonkey/shared/types";
import { fetchDevCode, getDB, setDevCode, updateCode } from "./store.ts";

/**
 * Connects to the tools/dev_server.ts WebSocket and turns local file changes into:
 * - styles: fetch new code → re-inject into all matching frames without a reload;
 * - scripts: update the devCode cache → (optionally) auto-reload tabs matched by the script's @match.
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
        // Ignore non-JSON frames
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
        console.warn("[InfinMonkey] failed to fetch dev file change:", entry.source.url, e);
      }
      if (!code) continue;

      if (entry.kind === "style") {
        // updateCode broadcasts entriesChanged; the bridge re-fetches and syncs the page <style>
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
