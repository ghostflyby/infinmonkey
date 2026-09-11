import type { ScriptMeta } from "./types.ts";

/** Chrome match pattern → 正则（对去掉 #hash 后的 URL 全匹配）。 */
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
  // path：glob 转换；未含通配时宽容处理查询串与结尾斜杠。
  let pathRe = globBody(path);
  if (!path.includes("*") && !path.includes("?")) pathRe += "(?:\\?.*)?";
  re += pathRe;
  try {
    return new RegExp("^" + re + "$");
  } catch {
    return null;
  }
}

/** @include/@exclude：glob 或 /regex/ 形式，非锚定（GM 传统语义，对整个 URL 做 test）。 */
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
  // 先处理 "*."：按用户脚本管理器惯例，*.example.com 同时匹配裸域 example.com。
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

/** 判断 URL 是否命中某条目（@match / @include 命中且不被 @exclude 拦下；两者皆空时默认全站，GM 传统语义）。 */
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
    // 无任何声明：仅对网页协议默认生效，避免在扩展页等环境误跑。
    return /^(https?|file|ftp):/.test(href);
  }
  if (!positives.some((r) => r.test(href))) return false;
  for (const p of meta.excludes) {
    const r = globToRegExp(p);
    if (r?.test(href)) return false;
  }
  return true;
}
