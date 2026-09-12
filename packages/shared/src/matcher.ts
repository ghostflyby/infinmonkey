import type { ScriptMeta } from "./types.ts";

/** Chrome match pattern → RegExp (full match against the URL minus its #hash). */
export function matchPatternToRegExp(pattern: string): RegExp | null {
  const p = pattern.trim();
  if (!p) return null;
  if (p === "<all_urls>") return /^[\w+-]+:/;
  const m = /^(\*|http|https|ws|wss|ftp|data|file):\/\/(\*|(?:\*\.)?[^/*]+)?(\/.*)$/.exec(p);
  if (!m) return null;
  const [, scheme, host = "", path] = m;
  let re = "";
  re += scheme === "*" ? "https?" : scheme;
  re += "://";
  if (scheme !== "file") {
    if (host === "*") re += "[^/]*";
    else if (host.startsWith("*.")) re += "(?:[^/]*\\.)?" + escapeRe(host.slice(2));
    else if (host) re += escapeRe(host);
  } else if (host) {
    re += escapeRe(host);
  }
  // path: glob conversion; be lenient about query strings when no wildcard is present.
  let pathRe = globBody(path);
  if (!path.includes("*") && !path.includes("?")) pathRe += "(?:\\?.*)?";
  re += pathRe;
  try {
    return new RegExp("^" + re + "$");
  } catch {
    return null;
  }
}

/** @include/@exclude: glob or /regex/ form, unanchored (classic GM semantics, tested against the whole URL). */
export function globToRegExp(glob: string): RegExp | null {
  const g = glob.trim();
  if (!g) return null;
  if (g.length > 2 && g.startsWith("/") && g.endsWith("/")) {
    try {
      return new RegExp(g.slice(1, -1));
    } catch {
      return null;
    }
  }
  try {
    return new RegExp(globBody(g));
  } catch {
    return null;
  }
}

function globBody(g: string): string {
  // Handle "*." first: per userscript manager convention, *.example.com also matches the bare domain example.com.
  const STAR_DOT = "\x00";
  const s = g.split("*.").join(STAR_DOT);
  let out = "";
  for (const ch of s) {
    if (ch === STAR_DOT) out += "(?:[^/]*\\.)?";
    else if (ch === "*") out += ".*";
    else if (ch === "?") out += ".?";
    else out += escapeRe(ch);
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether a URL hits an entry (@match/@include hit and not blocked by @exclude; when both are empty, matches everywhere — GM legacy semantics). */
export function urlMatchesMeta(
  url: string,
  meta: Pick<ScriptMeta, "matches" | "includes" | "excludes">,
): boolean {
  const href = url.split("#")[0];
  const positives: RegExp[] = [];
  for (const p of meta.matches) {
    const r = matchPatternToRegExp(p);
    if (r) positives.push(r);
  }
  for (const p of meta.includes) {
    const r = globToRegExp(p);
    if (r) positives.push(r);
  }
  if (positives.length === 0) {
    // No declarations at all: only enabled on web protocols by default, to avoid running on extension pages and the like.
    return /^(https?|file|ftp):/.test(href);
  }
  if (!positives.some((r) => r.test(href))) return false;
  for (const p of meta.excludes) {
    const r = globToRegExp(p);
    if (r?.test(href)) return false;
  }
  return true;
}
