/**
 * Parse @-moz-document scopes in user styles into "CSS chunk + target conditions".
 * Both engines share this path: the background applies chunks conditionally by URL,
 * giving Chromium the same semantics as native Firefox @-moz-document.
 */

interface TargetSpec {
  type: "url" | "url-prefix" | "domain" | "regexp";
  value: string;
}

interface StyleChunk {
  css: string;
  /** null means unconditional (applies on every page while the style is enabled). */
  targets: TargetSpec[] | null;
}

const KEY = "@-moz-document";

export function splitUserStyle(css: string): StyleChunk[] {
  const chunks: StyleChunk[] = [];
  let plain = "";
  let i = 0;
  while (true) {
    const at = css.indexOf(KEY, i);
    if (at < 0) {
      plain += css.slice(i);
      break;
    }
    plain += css.slice(i, at);
    // Selector list: scan up to the first '{' after balanced brackets
    let k = at + KEY.length;
    let paren = 0;
    while (k < css.length && (paren > 0 || css[k] !== "{")) {
      if (css[k] === "(") paren++;
      else if (css[k] === ")") paren--;
      k++;
    }
    // Found the matching '}'
    let depth = 0;
    let e = k;
    for (; e < css.length; e++) {
      const ch = css[e];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (k >= css.length || e >= css.length) {
      // Malformed structure: keep as-is and let the browser ignore it
      plain += css.slice(at);
      break;
    }
    const targets = parseDocTargets(css.slice(at + KEY.length, k));
    const inner = css.slice(k + 1, e);
    if (inner.trim()) chunks.push({ css: inner, targets });
    i = e + 1;
  }
  const out: StyleChunk[] = [];
  if (plain.trim()) out.push({ css: plain, targets: null });
  out.push(...chunks);
  return out;
}

function parseDocTargets(selectorList: string): TargetSpec[] | null {
  const trimmed = selectorList.trim();
  if (!trimmed) return null;
  const parts = splitTopLevel(trimmed, ",");
  const specs: TargetSpec[] = [];
  for (const part of parts) {
    const m = /^\s*(url|url-prefix|domain|regexp)\s*\(\s*(['"]?)([\s\S]*?)\2\s*\)\s*$/.exec(part);
    if (!m) continue;
    specs.push({ type: m[1] as TargetSpec["type"], value: m[3] });
  }
  return specs.length ? specs : null;
}

function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

export function targetsMatch(targets: TargetSpec[] | null, url: string): boolean {
  if (!targets || targets.length === 0) return true;
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    // Non-URLs (e.g. about:blank) can only hit exact regexp/url matches
  }
  return targets.some((t) => {
    switch (t.type) {
      case "url":
        return url === t.value || url.split("#")[0] === t.value.split("#")[0];
      case "url-prefix":
        return url.startsWith(t.value);
      case "domain": {
        const d = t.value.toLowerCase();
        return host === d || host.endsWith("." + d);
      }
      case "regexp":
        try {
          return new RegExp(t.value).test(url);
        } catch {
          return false;
        }
    }
  });
}

/** Human-readable target summary (for UI). */
export function describeTargets(targets: TargetSpec[] | null): string {
  if (!targets || targets.length === 0) return "所有网站";
  return targets.map((t) => `${t.type}: ${t.value}`).join(", ");
}
