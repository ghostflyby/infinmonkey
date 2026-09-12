import type { RunAt, ScriptMeta } from "./types.ts";

/**
 * Handles both the script (// ==UserScript==) and style (/ * ==UserStyle== * /) header comment forms.
 */
const HEADER_RE =
  /(?:^|\n)[ \t]*(?:\/\/|\/\*)[ \t]*==+(UserScript|UserStyle)==+[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*(?:\/\/[ \t]*)?==+\/\1==+[ \t]*(?:\*\/)?/i;

export function extractHeader(
  code: string,
): { kind: "script" | "style"; block: string; raw: string } | null {
  const m = HEADER_RE.exec(code);
  if (!m) return null;
  return {
    kind: m[1].toLowerCase() === "userstyle" ? "style" : "script",
    block: m[2],
    raw: m[0].trim(),
  };
}

interface HeaderPair {
  key: string;
  locale?: string;
  value: string;
}

/** Parses @key value lines inside the header block, accepting both // and / * * / comment prefixes. */
export function parseHeaderPairs(block: string): HeaderPair[] {
  const out: HeaderPair[] = [];
  for (const line of block.split(/\r?\n/)) {
    const m = /^[ \t]*(?:\/\/|\/\*+|\*)?[ \t]*@([A-Za-z][\w-]*(?::[\w-]+)?)[ \t]*(.*)$/.exec(line);
    if (!m) continue;
    const full = m[1];
    const ci = full.indexOf(":");
    if (ci >= 0) {
      out.push({ key: full.slice(0, ci), locale: full.slice(ci + 1), value: m[2].trim() });
    } else out.push({ key: full, value: m[2].trim() });
  }
  return out;
}

const RUN_ATS: Record<string, RunAt> = {
  "document-start": "document-start",
  "document-end": "document-end",
  "document-idle": "document-idle",
};

function emptyMeta(name = "未命名脚本"): ScriptMeta {
  return {
    name,
    runAt: "document-end",
    noframes: false,
    matches: [],
    includes: [],
    excludes: [],
    grants: [],
    connects: [],
    requires: [],
    resources: [],
    nameLocales: {},
    descriptionLocales: {},
    others: {},
    headerRaw: "",
    headerFound: false,
  };
}

export function parseMeta(code: string, fallbackName?: string): ScriptMeta {
  const meta = emptyMeta(fallbackName ?? "未命名脚本");
  const header = extractHeader(code);
  if (!header) return meta;
  meta.headerRaw = header.raw;
  meta.headerFound = true;
  for (const { key, locale, value } of parseHeaderPairs(header.block)) {
    switch (key) {
      case "name":
        if (locale) meta.nameLocales[locale] = value;
        else meta.name = value;
        break;
      case "description":
        if (locale) meta.descriptionLocales[locale] = value;
        else meta.description = value;
        break;
      case "namespace":
        meta.namespace = value;
        break;
      case "version":
        meta.version = value;
        break;
      case "author":
        meta.author = value;
        break;
      case "homepage":
      case "homepageURL":
        meta.homepageURL = value;
        break;
      case "supportURL":
        meta.supportURL = value;
        break;
      case "icon":
      case "iconURL":
      case "icon64":
      case "icon64URL":
        meta.iconURL ||= value;
        break;
      case "updateURL":
        meta.updateURL = value;
        break;
      case "downloadURL":
        meta.downloadURL = value;
        break;
      case "license":
        meta.license = value;
        break;
      case "run-at":
        meta.runAt = RUN_ATS[value] ?? "document-end";
        break;
      case "noframes":
        meta.noframes = true;
        break;
      case "match":
        meta.matches.push(value);
        break;
      case "include":
        meta.includes.push(value);
        break;
      case "exclude":
        meta.excludes.push(value);
        break;
      case "grant":
        meta.grants.push(value);
        break;
      case "connect":
        meta.connects.push(value);
        break;
      case "require":
        meta.requires.push(value);
        break;
      case "resource": {
        const sp = value.match(/^(\S+)\s+(.+)$/);
        if (sp) meta.resources.push({ name: sp[1], url: sp[2] });
        break;
      }
      default:
        (meta.others[key] ??= []).push(value);
    }
  }
  return meta;
}

export function detectKind(code: string): "script" | "style" {
  return extractHeader(code)?.kind ?? "script";
}
