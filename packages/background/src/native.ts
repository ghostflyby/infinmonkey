import browser from "webextension-polyfill";
import {
  isResponseFrame,
  makeRequest,
  type OpMap,
  type ResponseFrame,
  type WireEntry,
} from "@infinmonkey/protocol/wire";
import type { AnyEntry, ScriptEntry, ScriptMeta, StyleEntry } from "@infinmonkey/shared/types";
import { parseMeta } from "@infinmonkey/shared/meta";
import { randomId } from "@infinmonkey/shared/util";
import { isEntryCore, isScriptMeta } from "@infinmonkey/shared/guards";
import {
  findEntry,
  getDB,
  mirrorDelete,
  mirrorUpsert,
  storeEvents,
  type StoreMutation,
} from "./store.ts";

/** The companion app's bundle id; Safari routes by containing app, so this is a formality. */
const NATIVE_APP_ID = "dev.ghostflyby.InfinMonkey";
const PULL_ALARM = "infin-native-pull";
const CALL_TIMEOUT_MS = 8_000;

type SendNative = (extensionId: string, message: unknown) => Promise<unknown>;

const sendNative = (
  browser.runtime as { sendNativeMessage?: SendNative }
).sendNativeMessage?.bind(browser.runtime);

export function hasNativeSupport(): boolean {
  return typeof sendNative === "function";
}

function asFrame(v: unknown): ResponseFrame | null {
  return isResponseFrame(v) ? v : null;
}

async function call<K extends keyof OpMap>(
  op: K,
  payload: OpMap[K]["payload"],
): Promise<OpMap[K]["result"]> {
  if (!sendNative) throw new Error("sendNativeMessage unavailable");
  const req = makeRequest(op, payload);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`native ${String(op)} timeout`)), CALL_TIMEOUT_MS);
  });
  try {
    const frame = asFrame(await Promise.race([sendNative(NATIVE_APP_ID, req), timeout]));
    if (!frame) throw new Error("native: malformed response frame");
    if (!frame.ok) throw new Error(`native ${frame.error.code}: ${frame.error.message}`);
    return frame.result as OpMap[K]["result"];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function toWire(e: AnyEntry): WireEntry {
  const w: WireEntry = {
    id: e.id,
    kind: e.kind,
    enabled: e.enabled,
    position: e.position,
    installedAt: e.installedAt,
    updatedAt: e.updatedAt,
    code: e.code,
    meta: e.meta,
    source: e.source,
  };
  if (e.kind === "script") {
    w.connectGrants = [...e.connectGrants];
    w.values = e.values;
  }
  return w;
}

/**
 * Meta as the store needs it: parsed.
 *
 * The native side reports `null` when nothing has parsed the code (a file
 * imported in the app, or adopted from the store directory) and sets
 * `metaStale` when the code changed underneath the metadata. Parsing belongs to
 * the extension, so this is where both cases are resolved — otherwise an entry
 * would reach the injector with `matches` missing and throw while matching.
 */
function metaFor(w: WireEntry): ScriptMeta {
  // Trust the metadata only when its shape checks out: a malformed object here
  // would reach the injector and throw per frame. Repair by re-parsing instead.
  if (w.meta && !w.metaStale && isScriptMeta(w.meta)) return w.meta;
  return parseMeta(w.code);
}

function fromWire(w: WireEntry): AnyEntry {
  const meta = metaFor(w);
  const source = w.source;
  const base = {
    id: w.id,
    enabled: w.enabled,
    position: w.position,
    code: w.code,
    meta,
    source: w.source ?? { type: "inline" },
    installedAt: w.installedAt,
    updatedAt: w.updatedAt,
  };
  if (w.kind === "script") {
    const script: ScriptEntry = {
      ...base,
      kind: "script",
      connectGrants: w.connectGrants ? [...w.connectGrants] : [],
      values: w.values ?? {},
    };
    if (source.type === "dev") script.devCode = w.code;
    return script;
  }
  const style: StyleEntry = { ...base, kind: "style" };
  return style;
}

/**
 * Mirrors the extension's storage.local library with the companion app:
 * - authoritative mirror + reconnect merge — every local mutation is pushed
 *   via putEntry (write-behind); pulls apply getChanges with updatedAt LWW,
 *   keeping the losing side as a "（冲突副本）" copy when both sides changed;
 * - Safari has no app→extension push (each connectNative message takes the
 *   sendNativeMessage path), so changes are pulled on connect and by alarm.
 */
class NativeSync {
  connected = false;
  private rev = 0;
  private mirroring = false;
  private started = false;
  private syncing = false;
  private dirtyUpserts = new Set<string>();
  private dirtyDeletes = new Set<string>();

  start(): void {
    if (this.started) return;
    this.started = true;
    storeEvents.addEventListener("mutation", (ev) => {
      this.onMutation((ev as CustomEvent).detail as StoreMutation);
    });
    void browser.alarms.create(PULL_ALARM, { periodInMinutes: 1 });
    void this.connect();
  }

  async onAlarm(): Promise<void> {
    if (this.syncing) return;
    if (!this.connected) {
      await this.connect();
      return;
    }
    this.syncing = true;
    try {
      await this.flushDirty();
      await this.pull();
    } catch {
      this.connected = false;
    } finally {
      this.syncing = false;
    }
  }

  async connect(): Promise<boolean> {
    if (!(await this.enabledSetting()) || !sendNative) return false;
    try {
      const hello = await call("hello", {});
      this.connected = true;
      this.rev = hello.rev;
      // Full compare on every (re)connect: the event page loses in-memory rev.
      await this.pull();
      await this.flushDirty();
      return true;
    } catch {
      this.connected = false;
      return false;
    }
  }

  private enabledSetting(): Promise<boolean> {
    return getDB().then((db) => db.settings.storageBackend === "native");
  }

  private async pull(): Promise<void> {
    const { rev, upserts, deletedIds } = await call("getChanges", { sinceRev: 0 });
    this.mirroring = true;
    try {
      // Core-shape check only: entries without parsed metadata are exactly the
      // ones metaFor repairs below, so they must not be dropped here.
      for (const w of upserts.filter((x) => isEntryCore(x))) await this.applyRemote(w);
      for (const id of deletedIds) {
        if (this.dirtyUpserts.has(id)) continue; // pending local edit recreates it
        if (await findEntry(id)) await mirrorDelete(id);
      }
    } finally {
      this.mirroring = false;
    }
    this.rev = rev;
  }

  private async applyRemote(w: WireEntry): Promise<void> {
    const local = await findEntry(w.id);
    if (!local) {
      await mirrorUpsert(fromWire(w));
      return;
    }
    if (local.updatedAt >= w.updatedAt) return; // local wins (equal = no-op)
    if (this.dirtyUpserts.has(w.id)) {
      // Both sides changed: keep the local version as a conflict copy.
      const copy = JSON.parse(JSON.stringify(local)) as AnyEntry;
      copy.id = randomId();
      copy.meta = { ...copy.meta, name: `${copy.meta.name}（冲突副本）` };
      copy.position = 0;
      await mirrorUpsert(copy);
      this.dirtyUpserts.delete(w.id);
    }
    await mirrorUpsert(fromWire(w));
  }

  private onMutation(m: StoreMutation): void {
    if (this.mirroring) return;
    if (!this.connected) {
      if (m.type === "delete") {
        this.dirtyDeletes.add(m.id);
        this.dirtyUpserts.delete(m.id);
      } else {
        this.dirtyUpserts.add(m.entry.id);
      }
      return;
    }
    void this.pushOne(m).catch(() => this.markDirty(m));
  }

  private async pushOne(m: StoreMutation): Promise<void> {
    if (m.type === "delete") {
      await call("deleteEntry", { id: m.id });
      this.dirtyDeletes.delete(m.id);
    } else {
      const entry = (await findEntry(m.entry.id)) ?? m.entry;
      await call("putEntry", { entry: toWire(entry) });
      this.dirtyUpserts.delete(entry.id);
    }
  }

  private async flushDirty(): Promise<void> {
    for (const id of [...this.dirtyDeletes]) {
      try {
        await call("deleteEntry", { id });
        this.dirtyDeletes.delete(id);
      } catch {
        return; // stop on first failure; retry on next tick
      }
    }
    for (const id of [...this.dirtyUpserts]) {
      const entry = await findEntry(id);
      if (!entry) {
        this.dirtyUpserts.delete(id);
        continue;
      }
      try {
        await call("putEntry", { entry: toWire(entry) });
        this.dirtyUpserts.delete(id);
      } catch {
        return;
      }
    }
  }

  private markDirty(m: StoreMutation): void {
    if (m.type === "delete") {
      this.dirtyDeletes.add(m.id);
      this.dirtyUpserts.delete(m.id);
    } else {
      this.dirtyUpserts.add(m.entry.id);
    }
  }

  /** Diagnostics for the options page. */
  status(): { connected: boolean; rev: number; pending: number } {
    return {
      connected: this.connected,
      rev: this.rev,
      pending: this.dirtyUpserts.size + this.dirtyDeletes.size,
    };
  }
}

export const nativeSync = new NativeSync();
export { PULL_ALARM };
