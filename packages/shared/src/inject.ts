/**
 * Injection preparation usable from any context that can read extension storage.
 *
 * The isolated bridge reads `storage.local` directly and builds script payloads
 * content-side. This keeps injection working even when the background event page
 * is suspended or its messaging misbehaves (observed on some Firefox-based
 * kernels). GM_* calls still go through background messaging.
 */
import { urlMatchesMeta } from "./matcher.ts";
import type { PreparedScript, ResourcePayload, ScriptEntry } from "./types.ts";

export interface TextFetchResult {
  text: string;
  mime: string;
}

export type TextFetcher = (
  url: string,
  timeoutMs?: number,
) => Promise<{ text: string; mime: string }>;

export function matchScripts(
  scripts: ScriptEntry[],
  url: string,
  top: boolean,
): ScriptEntry[] {
  return scripts.filter((s) =>
    s.enabled && (top || !s.meta.noframes) && urlMatchesMeta(url, s.meta)
  );
}

function metaToPlain(s: ScriptEntry): Record<string, unknown> {
  const m = s.meta;
  return JSON.parse(JSON.stringify({
    name: m.name,
    namespace: m.namespace,
    version: m.version,
    description: m.description,
    author: m.author,
    license: m.license,
    "run-at": m.runAt,
    noframes: m.noframes,
    match: m.matches,
    include: m.includes,
    exclude: m.excludes,
    grant: m.grants,
    connect: m.connects,
    require: m.requires,
    resource: Object.fromEntries(m.resources.map((r) => [r.name, r.url])),
    "updateURL": m.updateURL,
    "downloadURL": m.downloadURL,
  }));
}

async function toPrepared(
  s: ScriptEntry,
  fetchText: TextFetcher,
): Promise<PreparedScript> {
  let code = s.code;
  if (s.source.type === "dev") {
    try {
      // Dev-mapped sources hit the local dev server: use a tighter timeout (fall back to cached code; injection must not hang on the network)
      code = (await fetchText(s.source.url, 3000)).text;
      s.devCode = code;
    } catch (e) {
      console.warn("[InfinMonkey] dev fetch failed, using cached code:", s.source.url, e);
      code = s.devCode ?? s.code;
    }
  }
  const requires: { url: string; text: string }[] = [];
  for (const ru of s.meta.requires) {
    try {
      requires.push({ url: ru, text: (await fetchText(ru)).text });
    } catch (e) {
      console.warn("[InfinMonkey] @require fetch failed:", ru, e);
    }
  }
  const resources: ResourcePayload[] = [];
  for (const r of s.meta.resources) {
    try {
      const { text, mime } = await fetchText(r.url);
      resources.push({ name: r.name, url: r.url, mime, text });
    } catch (e) {
      console.warn("[InfinMonkey] @resource fetch failed:", r.url, e);
    }
  }
  const m = s.meta;
  return {
    id: s.id,
    name: m.name,
    namespace: m.namespace ?? "",
    version: m.version ?? "",
    description: m.description ?? "",
    author: m.author ?? "",
    icon: m.iconURL ?? "",
    runAt: m.runAt,
    noframes: m.noframes,
    grants: m.grants.filter((g) => g !== "none"),
    connects: m.connects,
    code,
    requires,
    resources,
    metaPlain: metaToPlain(s),
    headerRaw: m.headerRaw,
    devUrl: s.source.type === "dev" ? s.source.url : undefined,
    values: { ...s.values },
  };
}

export async function prepareScripts(
  scripts: ScriptEntry[],
  url: string,
  top: boolean,
  fetchText: TextFetcher,
): Promise<PreparedScript[]> {
  const out: PreparedScript[] = [];
  for (const s of scripts) {
    if (!s.enabled) continue;
    if (!top && s.meta.noframes) continue;
    if (!urlMatchesMeta(url, s.meta)) continue;
    out.push(await toPrepared(s, fetchText));
  }
  return out;
}
