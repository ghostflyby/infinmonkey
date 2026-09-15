import type { AnyEntry, EntrySource, RunAt, ScriptMeta } from "./types.ts";
import { isRecord } from "./util.ts";

/**
 * Runtime guards for data that crosses a trust boundary.
 *
 * Three such boundaries exist on the extension side: reads back from
 * `storage.local` (`getDB`, the installer), entries imported from a JSON file,
 * and entries mirrored from the native app. Everything downstream — injection,
 * matching, the options editor — assumes these shapes, so malformed data must
 * be stopped here rather than surfacing as a TypeError per frame.
 *
 * Tolerance rules, applied uniformly:
 * - extra keys are ignored (a newer writer may add fields);
 * - a missing *optional* field is absent, exactly as the type says;
 * - a field present with the wrong type makes the whole value invalid — no
 *   silent substitution, which is what "fail fast at the boundary" means here.
 */

const RUN_ATS: readonly RunAt[] = ["document-start", "document-end", "document-idle"];

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

export function isEntrySource(v: unknown): v is EntrySource {
  if (!isRecord(v)) return false;
  if (v.type === "inline") return true;
  return v.type === "dev" && typeof v.url === "string" && typeof v.autoReload === "boolean";
}

export function isScriptMeta(v: unknown): v is ScriptMeta {
  if (!isRecord(v)) return false;
  if (typeof v.name !== "string") return false;
  if (typeof v.noframes !== "boolean" || typeof v.headerFound !== "boolean") return false;
  if (typeof v.headerRaw !== "string") return false;
  if (!RUN_ATS.includes(v.runAt as RunAt)) return false;
  for (
    const key of ["matches", "includes", "excludes", "grants", "connects", "requires"] as const
  ) {
    if (!isStringArray(v[key])) return false;
  }
  if (!isResourceRefArray(v.resources)) return false;
  for (const key of ["nameLocales", "descriptionLocales"] as const) {
    if (!isRecord(v[key])) return false;
  }
  return isRecord(v.others) && Object.values(v.others).every(isStringArray);
}

function isResourceRefArray(v: unknown): v is { name: string; url: string }[] {
  return (
    Array.isArray(v) &&
    v.every((r) => isRecord(r) && typeof r.name === "string" && typeof r.url === "string")
  );
}

/**
 * Everything about an entry except `meta`: the fields any producer (extension,
 * import file, native app) must get right for the injector to work at all.
 * Metadata is deliberately excluded — it has its own repair path (parse the
 * code), while these fields have none.
 */
export function isEntryCore(v: unknown): boolean {
  if (!isRecord(v)) return false;
  if (typeof v.id !== "string" || v.id === "") return false;
  if (v.kind !== "script" && v.kind !== "style") return false;
  if (typeof v.enabled !== "boolean") return false;
  if (typeof v.position !== "number") return false;
  if (typeof v.code !== "string") return false;
  if (typeof v.installedAt !== "number" || typeof v.updatedAt !== "number") return false;
  return isEntrySource(v.source);
}

/**
 * An entry as persisted in `storage.local`: core fields plus metadata that has
 * actually been parsed. Entries without parsed metadata are repaired on the
 * way in (see `metaFor`) and never written back blank, so a blank `meta` here
 * means the record is not usable as-is.
 */
export function isStoredEntry(v: unknown): v is AnyEntry {
  if (!isRecord(v) || !isEntryCore(v)) return false;
  // Script-only fields are part of the stored shape too.
  if (v.kind === "script") {
    if (!isStringArray(v.connectGrants)) return false;
    if (!isRecord(v.values)) return false;
    if (v.devCode !== undefined && typeof v.devCode !== "string") return false;
  }
  return isScriptMeta(v.meta);
}
