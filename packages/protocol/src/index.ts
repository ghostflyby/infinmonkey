/**
 * Wire protocol between the extension and the native InfinMonkey app.
 *
 * Transport today: Safari `browser.runtime.sendNativeMessage` → SafariWebExtensionHandler
 * (one request frame in, one response frame out; no server push on Safari).
 * Transport later: a persistent `runtime.connectNative` port for a Chrome/Firefox
 * native messaging host — the `changed` push frame is reserved for that case.
 *
 * Frames are plain JSON objects:
 *   request  { v, id, type, payload }
 *   response { v, id, ok: true, result } | { v, id, ok: false, error: { code, message } }
 *
 * The native side stores `meta` and `source` as opaque JSON blobs and never
 * interprets them; the extension owns parsing (packages/shared/meta.ts).
 */

export const PROTOCOL_VERSION = 1;

export type EntryKind = "script" | "style";

export type ErrorCode = "badRequest" | "notFound" | "kindMismatch" | "io" | "unsupported";

export interface RequestFrame {
  v: number;
  id: string;
  type: string;
  payload: unknown;
}

export interface OkFrame {
  v: number;
  id: string;
  ok: true;
  result: unknown;
}

export interface ErrFrame {
  v: number;
  id: string;
  ok: false;
  error: { code: ErrorCode; message: string };
}

export type ResponseFrame = OkFrame | ErrFrame;

/** Full entry as transferred over the wire (superset of the storage-file fields). */
export interface WireEntry {
  id: string;
  kind: EntryKind;
  enabled: boolean;
  position: number;
  installedAt: number;
  updatedAt: number;
  code: string;
  /** Parsed userscript/userstyle metadata; opaque JSON on the native side. */
  meta: unknown;
  /** Entry source descriptor ("inline" | "dev"); opaque JSON on the native side. */
  source: unknown;
  /** Extra @connect grants approved by the user (scripts only). */
  connectGrants?: string[];
  /** GM value store snapshot (scripts only). */
  values?: Record<string, unknown>;
  /** True when the code file changed outside the app and `meta` needs re-parsing. */
  metaStale?: boolean;
}

/** Lightweight entry descriptor for handshakes and list views. */
export interface EntrySummary {
  id: string;
  kind: EntryKind;
  name: string;
  version?: string;
  description?: string;
  enabled: boolean;
  position: number;
  updatedAt: number;
  metaStale: boolean;
}

export interface HelloResult {
  proto: number;
  app: string;
  platform: "macos" | "ios";
  rev: number;
  entries: EntrySummary[];
}

export interface ListResult {
  rev: number;
  entries: WireEntry[];
}

export interface ChangesResult {
  rev: number;
  upserts: WireEntry[];
  deletedIds: string[];
}

export interface EntryResult {
  rev: number;
  entry: WireEntry;
}

export interface ReorderResult {
  rev: number;
}

export interface DeleteResult {
  rev: number;
  deleted: boolean;
}

export interface ValuesResult {
  values: Record<string, unknown>;
}

export interface SetValueResult {
  rev: number;
}

export interface DeleteValueResult {
  rev: number;
  existed: boolean;
}

export interface ExportResult {
  /** ExportBundle shape from @infinmonkey/shared/types; opaque to the native side. */
  bundle: unknown;
}

export interface ImportResult {
  rev: number;
  count: number;
}

export interface PingResult {
  proto: number;
  app: string;
  platform: "macos" | "ios";
}

/** Reserved for persistent-port hosts; Safari never sends it. */
export interface ChangedPush {
  v: number;
  push: "changed";
  rev: number;
}

/** op → payload/result mapping; drives the typed request helper. */
export interface OpMap {
  ping: { payload: Record<string, never>; result: PingResult };
  hello: { payload: { sinceRev?: number }; result: HelloResult };
  listEntries: { payload: Record<string, never>; result: ListResult };
  getChanges: { payload: { sinceRev: number }; result: ChangesResult };
  createEntry: {
    payload: {
      kind: EntryKind;
      code: string;
      meta: unknown;
      source?: unknown;
      enabled?: boolean;
      values?: Record<string, unknown>;
    };
    result: EntryResult;
  };
  updateCode: { payload: { id: string; code: string; meta?: unknown }; result: EntryResult };
  /** Mirror upsert from the extension: full entry, id preserved. */
  putEntry: { payload: { entry: WireEntry }; result: EntryResult };
  updateMeta: { payload: { id: string; meta: unknown }; result: EntryResult };
  setEnabled: { payload: { id: string; enabled: boolean }; result: EntryResult };
  reorderEntries: { payload: { ids: string[] }; result: ReorderResult };
  deleteEntry: { payload: { id: string }; result: DeleteResult };
  getValues: { payload: { id: string }; result: ValuesResult };
  setValue: { payload: { id: string; key: string; value: unknown }; result: SetValueResult };
  deleteValue: { payload: { id: string; key: string }; result: DeleteValueResult };
  exportAll: { payload: Record<string, never>; result: ExportResult };
  importAll: { payload: { bundle: unknown; mode: "merge" | "replace" }; result: ImportResult };
}

export type OpType = keyof OpMap;

export function makeRequest<K extends OpType>(
  type: K,
  payload: OpMap[K]["payload"],
  id = crypto.randomUUID(),
): RequestFrame {
  return { v: PROTOCOL_VERSION, id, type, payload };
}

export function makeOk(id: string, result: unknown): OkFrame {
  return { v: PROTOCOL_VERSION, id, ok: true, result };
}

export function makeErr(id: string, code: ErrorCode, message: string): ErrFrame {
  return { v: PROTOCOL_VERSION, id, ok: false, error: { code, message } };
}

export function isRequestFrame(f: unknown): f is RequestFrame {
  if (typeof f !== "object" || f === null) return false;
  const r = f as Record<string, unknown>;
  return r.v === PROTOCOL_VERSION && typeof r.id === "string" && typeof r.type === "string";
}

export function isResponseFrame(f: unknown): f is ResponseFrame {
  if (typeof f !== "object" || f === null) return false;
  const r = f as Record<string, unknown>;
  if (r.v !== PROTOCOL_VERSION || typeof r.id !== "string") return false;
  if (r.ok === true) return true;
  if (r.ok !== false) return false;
  const e = r.error as Record<string, unknown> | undefined;
  return typeof e === "object" && e !== null && typeof e.code === "string";
}

/** Structural check used on entries received from the native side. */
export function isWireEntry(f: unknown): f is WireEntry {
  if (typeof f !== "object" || f === null) return false;
  const e = f as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    (e.kind === "script" || e.kind === "style") &&
    typeof e.enabled === "boolean" &&
    typeof e.position === "number" &&
    typeof e.installedAt === "number" &&
    typeof e.updatedAt === "number" &&
    typeof e.code === "string" &&
    typeof e.meta === "object" &&
    e.meta !== null &&
    typeof e.source === "object" &&
    e.source !== null
  );
}
