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
    // "none" takes precedence (GM semantics): a script that declares it gets no
    // GM APIs even if other @grant lines name some. Empty grant names (a bare
    // `@grant line) grant nothing either.
    grants: m.grants.includes("none") ? [] : m.grants.filter((g) => g !== ""),
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

/** Splices fetched @require bodies ahead of the userscript code (GM
 * semantics: remote code shares the script's scope and runs first, in
 * declaration order). Each block is closed by a lone `;` on its own line —
 * an EmptyStatement that ASI can never merge across, whatever either block
 * ends with — which also keeps the prefix's line count deterministic.
 * `userLineOffset` is the exact number of lines before the first line of the
 * user code, counted from the constructed prefix itself (never by
 * re-splitting the assembled body): stack traces from the compiled function
 * shift by exactly this amount. Line breaks are counted the way the engine
 * counts them — `\r\n` is one break, and lone `\r`, U+2028 and U+2029 are
 * each one break — so the count stays exact for minified remote code that
 * legitimately uses the exotic terminators. The require text itself is kept
 * byte-for-byte: normalizing terminators would rewrite string and template
 * literal values. With no requires the body is the user code unchanged and
 * the offset is 0. */
export function buildUserScriptBody(
  s: Pick<PreparedScript, "code" | "requires">,
): { body: string; userLineOffset: number } {
  let prefix = "";
  for (const r of s.requires) {
    const text = r.text.endsWith("\n") ? r.text : r.text + "\n";
    prefix += text + "\n;\n";
  }
  const userLineOffset = (prefix.match(/\r\n|[\n\r\u2028\u2029]/g) ?? []).length;
  return { body: prefix + s.code, userLineOffset };
}

/** The DevTools file name a compiled userscript is filed under: the
 * sanitized script name plus the .user.js suffix (unless already present).
 * Shared by appendSourceDirectives (which writes the directive) and
 * findUserFrame (which matches the stack frames it produces), so the two can
 * never drift apart. */
export function sourceUrlFileName(name: string): string {
  const safe = (value: string) => value.replace(/[\r\n]+/g, " ").trim().slice(0, 200);
  const file = safe(name) || "script";
  return `${file}${file.endsWith(".user.js") ? "" : ".user.js"}`;
}

/** Escapes a literal into a RegExp source fragment (the sanitized file name
 * can contain any of `. ( ) [ ]` etc. after newline stripping). */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Engine-reported position of a sourceURL frame plus where the match sits
 * in the stack string: stack strings list the innermost frame first, so an
 * earlier index is a more inner frame. */
interface FrameMatch {
  line: number;
  col: number;
  index: number;
}

function findUserFrameMatch(stack: string, name: string): FrameMatch | null {
  const m = new RegExp(`InfinMonkey/${escapeRegExp(sourceUrlFileName(name))}:(\\d+):(\\d+)`)
    .exec(stack);
  return m ? { line: Number(m[1]), col: Number(m[2]), index: m.index } : null;
}

/** Locates the first stack frame attributed to a compiled userscript in
 * `stack`: the engine names the anonymous `new Function` frames
 * `InfinMonkey/<file>:line:col` thanks to the sourceURL directive, and the
 * innermost (first) matching frame is the throw site. Returns the
 * engine-reported line/column — still shifted by the function wrapper and
 * the @require prefix — or null when no frame names this script. */
export function findUserFrame(
  stack: string,
  name: string,
): { line: number; col: number } | null {
  const m = findUserFrameMatch(stack, name);
  return m ? { line: m.line, col: m.col } : null;
}

/** Attributes an error stack to the userscript that owns its innermost
 * sourceURL frame. The innermost frame is the throw site, and when scripts
 * call into each other (B runs a callback through A's helper) A's outer
 * frame names A too — so candidates are compared by frame position in the
 * stack, never by the order the scripts were loaded in. Returns the winning
 * script with the raw engine-reported line/column (still shifted by the
 * function wrapper and the @require prefix — the caller maps them), or null
 * when no candidate has a frame in the stack. */
export function innermostAttributedFrame<S extends { name: string }>(
  stack: string,
  scripts: readonly S[],
): { script: S; line: number; col: number } | null {
  let best: { script: S; match: FrameMatch } | null = null;
  for (const script of scripts) {
    const match = findUserFrameMatch(stack, script.name);
    if (!match) continue;
    if (best && best.match.index <= match.index) continue;
    best = { script, match };
  }
  return best ? { script: best.script, line: best.match.line, col: best.match.col } : null;
}

/** Appends DevTools source-mapping directives to userscript code before it is
 * compiled with `new Function` in the MAIN-world runner. `//# sourceURL`
 * turns the anonymous compiled function into a named, persistent entry in
 * the DevTools Sources panel with readable stack frames; for dev-mapped
 * scripts (whose code is byte-identical to the served origin file) the
 * `//# sourceMappingURL` additionally lets DevTools fetch the original file,
 * so breakpoints land on the real source. Both directives are line comments,
 * so the only escape is a newline: names and URLs are sanitized onto a
 * single line and the block always starts on a fresh line of its own. */
export function appendSourceDirectives(
  code: string,
  name: string,
  devUrl?: string,
): string {
  const safe = (value: string) => value.replace(/[\r\n]+/g, " ").trim().slice(0, 200);
  let out = code.endsWith("\n") ? code : code + "\n";
  out += `//# sourceURL=InfinMonkey/${sourceUrlFileName(name)}`;
  if (devUrl) out += `\n//# sourceMappingURL=${safe(devUrl)}`;
  return out;
}
