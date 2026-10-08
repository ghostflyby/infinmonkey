/**
 * Line-offset source maps for dev-mapped userscripts.
 *
 * The runner appends `//# sourceMappingURL=<mapUrl>` to dev-mapped scripts,
 * where the map is served by the dev server (`immap` query route). The map is
 * a line-level translation: generated line (compiler-body coordinates, i.e.
 * after the @require prefix) → original line in the served file. DevTools
 * loads it, shows the pristine original as the source, and breakpoints set
 * there resolve into the compiled code.
 *
 * The map carries `sourcesContent`, so the original text travels with the
 * map itself — breakpoints keep working even if the served file drifts
 * between injection and debugging.
 */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64-VLQ encodes one signed number (source map spec §mappings). */
export function vlqEncode(value: number): string {
  let rest = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = "";
  do {
    let digit = rest & 31;
    rest >>>= 5;
    if (rest > 0) digit |= 32;
    out += B64[digit];
  } while (rest > 0);
  return out;
}

export interface LineOffsetSourceMapOptions {
  /** Original file text (embedded as sourcesContent). */
  sourceContent: string;
  /** Absolute URL the original file is served from. */
  sourceUrl: string;
  /** Generated lines consumed by the @require prefix: original line L lives
   * at generated line L + generatedLineOffset (0-based, source-map spec
   * coordinates). */
  generatedLineOffset: number;
  /** Display name of the original file (optional). */
  file?: string;
}

/** Builds a source map v3 JSON string whose only mapping is a line shift:
 * original line L → generated line L + generatedLineOffset, both columns 0.
 * Original lines with no generated counterpart (none today) would simply be
 * unmapped; generated prefix lines carry no segments at all. */
export function buildLineOffsetSourceMap(
  opts: LineOffsetSourceMapOptions,
): string {
  const lineCount = opts.sourceContent.split("\n").length;
  const first = "AAAA"; // genCol 0, source 0, line delta 0, col delta 0
  const next = "AACA"; // genCol 0, source 0, line delta +1, col delta 0
  const mappings = ";".repeat(opts.generatedLineOffset) +
    Array.from({ length: lineCount }, (_, i) => (i === 0 ? first : next)).join(";");
  return JSON.stringify({
    version: 3,
    file: opts.file,
    sources: [opts.sourceUrl],
    sourcesContent: [opts.sourceContent],
    names: [],
    mappings,
  });
}

/** The sourceMappingURL the runner emits for a dev-mapped script: the dev
 * URL tagged with the @require prefix line count, which the dev server turns
 * into the matching line-offset source map. */
export function devMapUrl(devUrl: string, generatedLineOffset: number): string {
  const sep = devUrl.includes("?") ? "&" : "?";
  return `${devUrl}${sep}immap=${generatedLineOffset}`;
}

/** UTF-8-safe base64 (btoa alone mangles non-Latin1 text — userscript
 * comments are frequently Chinese). Chunks the byte array to avoid blowing
 * the call stack on large scripts. */
function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Builds an embedded data:-URL source map for scripts that have no serving
 * origin (written in the extension itself): the map carries sourcesContent,
 * so DevTools shows the pristine original and resolves breakpoints against
 * it — no server involved, and the fetch is DevTools' own, outside page CSP.
 * The source entry is named to match the script's sourceURL directive. */
export function inlineSourceMapUrl(opts: {
  sourceContent: string;
  name: string;
  generatedLineOffset: number;
}): string {
  const file = opts.name.replace(/[\r\n]+/g, " ").trim().slice(0, 200) || "script";
  const map = buildLineOffsetSourceMap({
    sourceContent: opts.sourceContent,
    sourceUrl: `InfinMonkey/${file}${file.endsWith(".user.js") ? "" : ".user.js"}`,
    generatedLineOffset: opts.generatedLineOffset,
    file: `${file}${file.endsWith(".user.js") ? "" : ".user.js"}`,
  });
  return `data:application/json;base64,${utf8ToBase64(map)}`;
}
