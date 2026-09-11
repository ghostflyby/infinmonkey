import browser from "webextension-polyfill";
import { DEFAULT_DEV_ORIGIN, RUNTIME_VERSION } from "@infinmonkey/shared/constants";
import { extractHeader, parseMeta } from "@infinmonkey/shared/meta";
import type {
  AnyEntry,
  EntrySource,
  PendingInstall,
  ScriptEntry,
  Settings,
  StyleEntry,
} from "@infinmonkey/shared/types";
import { randomId } from "@infinmonkey/shared/util";

interface DB {
  scripts: ScriptEntry[];
  styles: StyleEntry[];
  settings: Settings;
  pending: Record<string, PendingInstall>;
}

let cache: DB | null = null;

export async function getDB(): Promise<DB> {
  if (cache) return cache;
  const all = await browser.storage.local.get(["scripts", "styles", "settings", "pending"]);
  cache = {
    scripts: (all.scripts as ScriptEntry[]) ?? [],
    styles: (all.styles as StyleEntry[]) ?? [],
    settings: { devOrigin: DEFAULT_DEV_ORIGIN, ...(all.settings as Partial<Settings> | undefined) },
    pending: (all.pending as Record<string, PendingInstall>) ?? {},
  };
  return cache;
}

async function persist(): Promise<void> {
  const db = await getDB();
  await browser.storage.local.set({
    scripts: db.scripts,
    styles: db.styles,
    settings: db.settings,
    pending: db.pending,
  });
}

function broadcastEntriesChanged(): void {
  browser.runtime.sendMessage({ type: "entriesChanged" }).catch(() => {});
}

/** 诊断用：最近一次后台链路错误（e2e/排查时从扩展页读取）。 */
export async function reportError(where: string, e: unknown): Promise<void> {
  const msg = `[${where}] ${String((e as Error)?.stack ?? e)}`;
  console.error("[InfinMonkey]", msg);
  await browser.storage.local.set({ imLastError: msg }).catch(() => {});
}

export function fetchDevCode(url: string, timeoutMs = 2500): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error("dev server 超时")), timeoutMs);
  return fetch(url, { cache: "no-store", signal: ctrl.signal })
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    })
    .finally(() => clearTimeout(t));
}

export function isDevOrigin(url: string, settings?: Settings): boolean {
  const origin = settings?.devOrigin ?? DEFAULT_DEV_ORIGIN;
  return url.startsWith(origin + "/");
}

function nextPosition(entries: { position: number }[]): number {
  return entries.reduce((m, e) => Math.max(m, e.position), 0) + 1;
}

export async function createEntry(
  kind: "script" | "style",
  opts: { code: string; url?: string; enabled?: boolean },
): Promise<ScriptEntry | StyleEntry> {
  const db = await getDB();
  const now = Date.now();
  const fallbackName = opts.url
    ? decodeURIComponent(opts.url.split("/").pop() || "") || undefined
    : undefined;
  const meta = parseMeta(opts.code, fallbackName);
  const dev = !!opts.url && isDevOrigin(opts.url, db.settings);
  const source: EntrySource = dev
    ? { type: "dev", url: opts.url!, autoReload: true }
    : { type: "inline" };
  const base = {
    id: randomId(),
    enabled: opts.enabled ?? true,
    code: opts.code,
    meta,
    source,
    installedAt: now,
    updatedAt: now,
  };
  let entry: ScriptEntry | StyleEntry;
  if (kind === "script") {
    const script: ScriptEntry = {
      ...base,
      kind: "script",
      connectGrants: [],
      values: {},
      position: 0,
    };
    if (dev) script.devCode = opts.code;
    db.scripts.push(script);
    script.position = nextPosition(db.scripts);
    entry = script;
  } else {
    const style: StyleEntry = { ...base, kind: "style", position: 0 };
    db.styles.push(style);
    style.position = nextPosition(db.styles);
    entry = style;
  }
  await persist();
  await broadcastEntriesChanged();
  return entry;
}

export async function findEntry(id: string): Promise<AnyEntry | undefined> {
  const db = await getDB();
  return db.scripts.find((s) => s.id === id) ?? db.styles.find((s) => s.id === id);
}

export async function updateCode(id: string, code: string): Promise<AnyEntry | undefined> {
  const entry = await findEntry(id);
  if (!entry) return undefined;
  // 类型守卫：编辑器状态错乱时，防止把带样式头的代码写进脚本条目（或反之）；无头代码放行
  const header = extractHeader(code);
  if (header && header.kind !== entry.kind) {
    await reportError("updateCode:kind-mismatch", `${entry.kind} ← ${header.kind}`);
    return entry;
  }
  const fallbackName = entry.source.type === "dev"
    ? decodeURIComponent(new URL(entry.source.url).pathname.split("/").pop() || "")
    : undefined;
  entry.code = code;
  entry.meta = parseMeta(code, fallbackName);
  entry.updatedAt = Date.now();
  if (entry.kind === "script" && entry.source.type === "dev") entry.devCode = code;
  await persist();
  await broadcastEntriesChanged();
  return entry;
}

export async function setEnabled(id: string, enabled: boolean): Promise<AnyEntry | undefined> {
  const entry = await findEntry(id);
  if (!entry) return undefined;
  entry.enabled = enabled;
  await persist();
  await broadcastEntriesChanged();
  return entry;
}

export async function setSource(id: string, source: EntrySource): Promise<AnyEntry | undefined> {
  const entry = await findEntry(id);
  if (!entry) return undefined;
  entry.source = source;
  entry.updatedAt = Date.now();
  if (entry.kind === "script") {
    if (source.type === "dev") entry.devCode = entry.code;
    else delete entry.devCode;
  }
  await persist();
  await broadcastEntriesChanged();
  return entry;
}

export async function deleteEntry(id: string): Promise<boolean> {
  const db = await getDB();
  const before = db.scripts.length + db.styles.length;
  db.scripts = db.scripts.filter((s) => s.id !== id);
  db.styles = db.styles.filter((s) => s.id !== id);
  delete db.pending[id];
  if (db.scripts.length + db.styles.length === before) return false;
  await persist();
  await broadcastEntriesChanged();
  return true;
}

// ---- GM 存储族 ----

export async function getValue(
  scriptId: string,
  key: string,
): Promise<{ found: boolean; value?: unknown }> {
  const entry = await findEntry(scriptId);
  if (!entry || entry.kind !== "script" || !(key in entry.values)) return { found: false };
  return { found: true, value: entry.values[key] };
}

export async function setValue(
  scriptId: string,
  key: string,
  value: unknown,
): Promise<{ oldValue: unknown; newValue: unknown }> {
  const entry = await findEntry(scriptId);
  if (!entry || entry.kind !== "script") throw new Error("脚本不存在");
  const oldValue = key in entry.values ? entry.values[key] : undefined;
  entry.values[key] = value;
  await persist();
  return { oldValue, newValue: value };
}

export async function deleteValue(
  scriptId: string,
  key: string,
): Promise<{ existed: boolean; oldValue: unknown }> {
  const entry = await findEntry(scriptId);
  if (!entry || entry.kind !== "script") return { existed: false, oldValue: undefined };
  const existed = key in entry.values;
  const oldValue = entry.values[key];
  if (existed) {
    delete entry.values[key];
    await persist();
  }
  return { existed, oldValue };
}

export async function listValues(scriptId: string): Promise<string[]> {
  const entry = await findEntry(scriptId);
  return entry && entry.kind === "script" ? Object.keys(entry.values) : [];
}

export async function setDevCode(scriptId: string, code: string): Promise<void> {
  const entry = await findEntry(scriptId);
  if (!entry || entry.kind !== "script") return;
  entry.devCode = code;
  await persist();
}

export async function addConnectGrant(scriptId: string, domain: string): Promise<void> {
  const entry = await findEntry(scriptId);
  if (!entry || entry.kind !== "script") return;
  const d = domain.toLowerCase();
  if (!entry.connectGrants.includes(d)) entry.connectGrants.push(d);
  await persist();
}

export async function revokeConnectGrant(scriptId: string, domain: string): Promise<void> {
  const entry = await findEntry(scriptId);
  if (!entry || entry.kind !== "script") return;
  entry.connectGrants = entry.connectGrants.filter((d) => d !== domain.toLowerCase());
  await persist();
}

// ---- 安装队列 ----

export async function putPendingInstall(
  p: Omit<PendingInstall, "id" | "createdAt">,
): Promise<string> {
  const db = await getDB();
  const id = randomId();
  db.pending[id] = { ...p, id, createdAt: Date.now() };
  // 清理超过 1 天的残留
  for (const [k, v] of Object.entries(db.pending)) {
    if (Date.now() - v.createdAt > 86_400_000) delete db.pending[k];
  }
  await persist();
  return id;
}

export async function takePendingInstall(id: string): Promise<PendingInstall | undefined> {
  const db = await getDB();
  const p = db.pending[id];
  if (p) {
    delete db.pending[id];
    await persist();
  }
  return p;
}

export async function getPendingInstall(id: string): Promise<PendingInstall | undefined> {
  return (await getDB()).pending[id];
}

// ---- 导入 / 导出 ----

export async function exportAll() {
  const db = await getDB();
  return {
    infinmonkey: 1 as const,
    version: RUNTIME_VERSION,
    exportedAt: Date.now(),
    scripts: db.scripts,
    styles: db.styles,
  };
}

export async function importAll(
  data: { scripts?: ScriptEntry[]; styles?: StyleEntry[] },
  mode: "merge" | "replace",
): Promise<number> {
  const db = await getDB();
  let count = 0;
  if (mode === "replace") {
    db.scripts = [];
    db.styles = [];
  }
  for (const raw of [...(data.scripts ?? []), ...(data.styles ?? [])]) {
    const kind = raw.kind === "style" ? "style" : "script";
    const entry = {
      ...raw,
      id: randomId(),
      position: 0,
      updatedAt: Date.now(),
    } as AnyEntry;
    if (kind === "script") {
      db.scripts.push(entry as ScriptEntry);
      (entry as ScriptEntry).position = nextPosition(db.scripts);
    } else {
      db.styles.push(entry as StyleEntry);
      (entry as StyleEntry).position = nextPosition(db.styles);
    }
    count++;
  }
  await persist();
  await broadcastEntriesChanged();
  return count;
}
