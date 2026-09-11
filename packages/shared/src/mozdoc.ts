/**
 * 解析用户样式中的 @-moz-document 作用域，产出「CSS 块 + 目标条件」。
 * 两种浏览器的注入引擎统一走这里：background 按 URL 条件逐块 insertCSS，
 * 因此 Chromium 上也能获得与 Firefox 原生 @-moz-document 相同的语义。
 */

interface TargetSpec {
  type: "url" | "url-prefix" | "domain" | "regexp";
  value: string;
}

interface StyleChunk {
  css: string;
  /** null 表示无条件（对启用该样式的所有页面生效）。 */
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
    // 选择器列表：扫描到配平括号后的第一个 '{'
    let k = at + KEY.length;
    let paren = 0;
    while (k < css.length && (paren > 0 || css[k] !== "{")) {
      if (css[k] === "(") paren++;
      else if (css[k] === ")") paren--;
      k++;
    }
    // 找到配对的 '}'
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
      // 结构不完整：原样保留，交由浏览器忽略
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
    // 非 URL（如 about:blank）只可能命中 regexp/url 精确匹配
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

/** 样式的可读目标摘要（UI 用）。 */
export function describeTargets(targets: TargetSpec[] | null): string {
  if (!targets || targets.length === 0) return "所有网站";
  return targets.map((t) => `${t.type}: ${t.value}`).join(", ");
}
