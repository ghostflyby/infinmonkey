import browser from "webextension-polyfill";
import { DEFAULT_DEV_ORIGIN, RUNTIME_VERSION } from "@infinmonkey/shared/constants";
import { extractHeader, parseMeta } from "@infinmonkey/shared/meta";
import { isEntryCore, isScriptMeta, isStoredEntry } from "@infinmonkey/shared/guards";
import type {
  AnyEntry,
  EntrySource,
  PendingInstall,
  ScriptEntry,
  Settings,
  StyleEntry,
} from "@infinmonkey/shared/types";
import { isRecord, randomId } from "@infinmonkey/shared/util";

interface DB {
  scripts: ScriptEntry[];
  styles: StyleEntry[];
  settings: Settings;
  pending: Record<string, PendingInstall>;
}

export type StoreMutation = { type: "upsert"; entry: AnyEntry } | { type: "delete"; id: string };

/** Fired after every successful local mutation; native.ts mirrors these to the companion app. */
export const storeEvents = new EventTarget();

export function emitStoreMutation(m: StoreMutation): void {
  storeEvents.dispatchEvent(new CustomEvent("mutation", { detail: m }));
}

let cache: DB | null = null;

// Content scripts (the installer writes entries straight to storage.local)
// bypass this module's in-memory cache. Without invalidation the background
// would keep serving a stale DB and write the stale list back over newer
// entries on its next persist(). Any external write to the store keys drops
// the cache; the background's own writes re-read once, which is harmless.
browser.storage.onChanged.addListener((changes: Record<string, unknown>, area: string) => {
  if (area !== "local") return;
  if (changes.scripts || changes.styles || changes.settings || changes.pending) cache = null;
});

/** Keeps well-formed entries, drops the rest; returns how many were dropped. */
function sanitizeEntryList(raw: unknown): { valid: AnyEntry[]; dropped: number } {
  if (!Array.isArray(raw)) return { valid: [], dropped: 0 };
  const valid = raw.filter(isStoredEntry);
  return { valid, dropped: raw.length - valid.length };
}

export async function getDB(): Promise<DB> {
  if (cache) return cache;
  const all = await browser.storage.local.get(["scripts", "styles", "settings", "pending"]);
  const scripts = sanitizeEntryList(all.scripts);
  const styles = sanitizeEntryList(all.styles);
  const dropped = scripts.dropped + styles.dropped;
  if (dropped > 0) {
    // Shape-invalid entries are unusable downstream (injection would throw on
    // them); dropping beats crashing, but it must not happen silently.
    reportError(
      "getDB",
      new Error(`${dropped} malformed entr${dropped === 1 ? "y" : "ies"} dropped from storage`),
    );
  }
  cache = {
    scripts: scripts.valid as ScriptEntry[],
    styles: styles.valid as StyleEntry[],
    settings: {
      devOrigin: DEFAULT_DEV_ORIGIN,
      storageBackend: "local",
      ...(isRecord(all.settings) ? (all.settings as Partial<Settings>) : {}),
    },
    pending: (all.pending as Record<string, PendingInstall>) ?? {},
  };
  return cache;
}

async function persist(db: DB): Promise<void> {
  // Takes the caller's (already-mutated) DB: re-fetching here would silently
  // drop the mutation whenever the cache was invalidated by a concurrent
  // external write between the caller's getDB() and this write. The remaining
  // window - an external write landing inside that span - is inherent to
  // full-table read-modify-write without a transactional storage layer.
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

/** Diagnostics: most recent background pipeline error (read from extension pages during e2e/debugging). */
export async function reportError(where: string, e: unknown): Promise<void> {
  const msg = `[${where}] ${String((e as Error)?.stack ?? e)}`;
  console.error("[InfinMonkey]", msg);
  await browser.storage.local.set({ imLastError: msg }).catch(() => {});
}

export function fetchDevCode(url: string, timeoutMs = 2500): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error("dev server timeout")), timeoutMs);
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
  await persist(db);
  await broadcastEntriesChanged();
  emitStoreMutation({ type: "upsert", entry });
  return entry;
}

/** Finds within an already-fetched DB; mutators use this so persist() can be
 * handed the same object they mutated. */
function findIn(db: DB, id: string): AnyEntry | undefined {
  return db.scripts.find((s) => s.id === id) ?? db.styles.find((s) => s.id === id);
}

export async function findEntry(id: string): Promise<AnyEntry | undefined> {
  return findIn(await getDB(), id);
}

export async function updateCode(id: string, code: string): Promise<AnyEntry | undefined> {
  const db = await getDB();
  const entry = findIn(db, id);
  if (!entry) return undefined;
  // Type guard: if editor state is out of sync, prevent writing style-headed code into a script entry (or vice versa); headerless code passes through
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
  await persist(db);
  await broadcastEntriesChanged();
  emitStoreMutation({ type: "upsert", entry });
  return entry;
}

export async function setEnabled(id: string, enabled: boolean): Promise<AnyEntry | undefined> {
  const db = await getDB();
  const entry = findIn(db, id);
  if (!entry) return undefined;
  entry.enabled = enabled;
  await persist(db);
  await broadcastEntriesChanged();
  emitStoreMutation({ type: "upsert", entry });
  return entry;
}

export async function setSource(id: string, source: EntrySource): Promise<AnyEntry | undefined> {
  const db = await getDB();
  const entry = findIn(db, id);
  if (!entry) return undefined;
  entry.source = source;
  entry.updatedAt = Date.now();
  if (entry.kind === "script") {
    if (source.type === "dev") entry.devCode = entry.code;
    else delete entry.devCode;
  }
  await persist(db);
  await broadcastEntriesChanged();
  emitStoreMutation({ type: "upsert", entry });
  return entry;
}

export async function deleteEntry(id: string): Promise<boolean> {
  const db = await getDB();
  const before = db.scripts.length + db.styles.length;
  db.scripts = db.scripts.filter((s) => s.id !== id);
  db.styles = db.styles.filter((s) => s.id !== id);
  delete db.pending[id];
  if (db.scripts.length + db.styles.length === before) return false;
  await persist(db);
  await broadcastEntriesChanged();
  emitStoreMutation({ type: "delete", id });
  return true;
}

// ---- GM storage APIs ----

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
  const db = await getDB();
  const entry = findIn(db, scriptId);
  if (!entry || entry.kind !== "script") throw new Error("script not found");
  const oldValue = key in entry.values ? entry.values[key] : undefined;
  entry.values[key] = value;
  await persist(db);
  emitStoreMutation({ type: "upsert", entry });
  return { oldValue, newValue: value };
}

export async function deleteValue(
  scriptId: string,
  key: string,
): Promise<{ existed: boolean; oldValue: unknown }> {
  const db = await getDB();
  const entry = findIn(db, scriptId);
  if (!entry || entry.kind !== "script") return { existed: false, oldValue: undefined };
  const existed = key in entry.values;
  const oldValue = entry.values[key];
  if (existed) {
    delete entry.values[key];
    await persist(db);
    emitStoreMutation({ type: "upsert", entry });
  }
  return { existed, oldValue };
}

export async function listValues(scriptId: string): Promise<string[]> {
  const entry = await findEntry(scriptId);
  return entry && entry.kind === "script" ? Object.keys(entry.values) : [];
}

export async function setDevCode(scriptId: string, code: string): Promise<void> {
  const db = await getDB();
  const entry = findIn(db, scriptId);
  if (!entry || entry.kind !== "script") return;
  entry.devCode = code;
  await persist(db);
}

export async function addConnectGrant(scriptId: string, domain: string): Promise<void> {
  const db = await getDB();
  const entry = findIn(db, scriptId);
  if (!entry || entry.kind !== "script") return;
  const d = domain.toLowerCase();
  if (!entry.connectGrants.includes(d)) entry.connectGrants.push(d);
  await persist(db);
  emitStoreMutation({ type: "upsert", entry });
}

export async function revokeConnectGrant(scriptId: string, domain: string): Promise<void> {
  const db = await getDB();
  const entry = findIn(db, scriptId);
  if (!entry || entry.kind !== "script") return;
  entry.connectGrants = entry.connectGrants.filter((d) => d !== domain.toLowerCase());
  await persist(db);
  emitStoreMutation({ type: "upsert", entry });
}

// ---- Pending install queue ----

export async function putPendingInstall(
  p: Omit<PendingInstall, "id" | "createdAt">,
): Promise<string> {
  const db = await getDB();
  const id = randomId();
  db.pending[id] = { ...p, id, createdAt: Date.now() };
  // Clean up leftovers older than 1 day
  for (const [k, v] of Object.entries(db.pending)) {
    if (Date.now() - v.createdAt > 86_400_000) delete db.pending[k];
  }
  await persist(db);
  return id;
}

export async function takePendingInstall(id: string): Promise<PendingInstall | undefined> {
  const db = await getDB();
  const p = db.pending[id];
  if (p) {
    delete db.pending[id];
    await persist(db);
  }
  return p;
}

export async function getPendingInstall(id: string): Promise<PendingInstall | undefined> {
  return (await getDB()).pending[id];
}

// ---- Import / export ----

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
    // Imported files are arbitrary JSON. Core fields are validated (nothing
    // unknown rides along); metadata is repaired by parsing the code when the
    // file carries none, mirroring what the native mirror path does.
    if (!isEntryCore(raw)) continue;
    const meta = isScriptMeta(raw.meta) ? raw.meta : parseMeta(raw.code);
    const entry: AnyEntry = raw.kind === "script"
      ? {
        id: randomId(),
        kind: "script",
        enabled: raw.enabled,
        position: 0,
        code: raw.code,
        meta,
        source: raw.source,
        installedAt: raw.installedAt,
        updatedAt: Date.now(),
        connectGrants: [...raw.connectGrants],
        values: raw.values,
        devCode: raw.source.type === "dev" ? raw.code : undefined,
      }
      : {
        id: randomId(),
        kind: "style",
        enabled: raw.enabled,
        position: 0,
        code: raw.code,
        meta,
        source: raw.source,
        installedAt: raw.installedAt,
        updatedAt: Date.now(),
      };
    if (entry.kind === "script") {
      db.scripts.push(entry);
      entry.position = nextPosition(db.scripts);
    } else {
      db.styles.push(entry);
      entry.position = nextPosition(db.styles);
    }
    count++;
  }
  await persist(db);
  await broadcastEntriesChanged();
  for (const e of [...db.scripts, ...db.styles]) emitStoreMutation({ type: "upsert", entry: e });
  return count;
}

// ---- Mirror helpers (native sync applies remote state without reflection) ----

/** Replace-or-insert an entry exactly as given; no mutation events are emitted. */
export async function mirrorUpsert(entry: AnyEntry): Promise<void> {
  const db = await getDB();
  const list = entry.kind === "script" ? db.scripts : db.styles;
  const idx = list.findIndex((e) => e.id === entry.id);
  if (idx >= 0) list[idx] = entry;
  else {
    (list as AnyEntry[]).push(entry);
    if (entry.position === 0) entry.position = nextPosition(list);
  }
  await persist(db);
  await broadcastEntriesChanged();
}

/** Remove an entry by id; no mutation events are emitted. */
export async function mirrorDelete(id: string): Promise<void> {
  const db = await getDB();
  const before = db.scripts.length + db.styles.length;
  db.scripts = db.scripts.filter((s) => s.id !== id);
  db.styles = db.styles.filter((s) => s.id !== id);
  if (db.scripts.length + db.styles.length === before) return;
  await persist(db);
  await broadcastEntriesChanged();
}
