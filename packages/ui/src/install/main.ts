/** 安装确认页：展示元数据 + 代码预览，确认写入。 */
import { RUNTIME_NAME } from "@infinmonkey/shared/constants";
import browser from "webextension-polyfill";
import type { AnyEntry, PendingInstall, ScriptEntry, StyleEntry } from "@infinmonkey/shared/types";
import { detectKind, parseMeta } from "@infinmonkey/shared/meta";
import { h, msg } from "../dom.ts";

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T;

interface PendingView {
  pending: PendingInstall | null;
  entry?: AnyEntry | null;
}

void (async () => {
  const id = new URLSearchParams(location.search).get("id") ?? "";
  const res = await msg<PendingView>({ type: "GetPendingInstall", pendingId: id });
  const app = $("#app");
  app.textContent = "";
  if (!res.pending) {
    app.append(h("div", { class: "empty" }, "安装请求不存在或已处理。"));
    return;
  }
  render(app, id, res.pending, res.entry ?? null);
})();

function render(
  app: HTMLElement,
  pendingId: string,
  p: PendingInstall,
  replacing: AnyEntry | null,
): void {
  const isScript = p.kind === "script";
  const meta = parseMetaForView(p.code);
  const dev = p.url ? isLocalDev(p.url) : false;

  const grid = h("dl", { class: "grid" });
  const row = (k: string, v: Node | string) => grid.append(h("dt", {}, k), h("dd", {}, v));
  row("类型", isScript ? "用户脚本" : "用户样式");
  if (meta.version) row("版本", meta.version);
  if (meta.author) row("作者", meta.author);
  if (meta.description) row("描述", meta.description);
  if (isScript) {
    row("运行时机", meta.runAt ?? "document-end");
    row("匹配", meta.targets.length ? meta.targets.join(", ") : "（无 @match/@include，默认全站）");
    row("授权", meta.grants.length ? meta.grants.join(", ") : "无（@grant none）");
    if (meta.requires) row("@require", meta.requires.join(", "));
    if (meta.connects) row("@connect", meta.connects.join(", "));
  } else {
    row("作用目标", meta.targets.length ? meta.targets.join(", ") : "所有网站");
  }
  if (p.url) row("来源", p.url);
  if (dev) row("本地映射", "✓ 将自动从 dev server 实时加载");
  if (replacing) row("更新", `将替换已安装的「${replacing.meta.name}」（保留数据）`);

  const preview = h(
    "pre",
    {},
    p.code.split("\n").slice(0, 120).join("\n") + (p.code.split("\n").length > 120 ? "\n…" : ""),
  );

  const warn = isScript && meta.grants.length > 0
    ? h(
      "div",
      { class: "warn" },
      "此脚本申请了特权 API（跨域请求 / 存储 / 剪贴板等）。只安装你信任来源的脚本。",
    )
    : null;

  const installBtn = h("button", { class: "primary" }, replacing ? "更新" : "安装");
  const cancelBtn = h("button", { onclick: () => void done(pendingId, "cancel") }, "取消");
  installBtn.addEventListener("click", () => void done(pendingId, "install"));

  app.append(
    h(
      "div",
      { class: "card" },
      h(
        "div",
        { class: "head" },
        h("div", { class: "glyph" }, isScript ? "📜" : "🎨"),
        h(
          "div",
          {},
          h("h1", {}, meta.name ?? "未命名"),
          h("div", { class: "sub" }, `安装到 ${RUNTIME_NAME}`),
        ),
      ),
      warn,
      grid,
      h("details", { open: true }, h("summary", {}, "代码预览（前 120 行）"), preview),
      h(
        "div",
        { class: "btns" },
        cancelBtn,
        installBtn,
        h("button", { onclick: () => void msg({ type: "OpenOptions" }) }, "管理面板"),
      ),
    ),
  );
}

function isLocalDev(url: string): boolean {
  // dev server 默认监听回环地址；展示用判定，最终来源由 background 写入
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url);
}

async function done(pendingId: string, decision: "install" | "cancel"): Promise<void> {
  await msg({ type: "ConfirmInstall", pendingId, decision });
  if (decision === "install") window.opener?.postMessage({ __infinInstalled: true }, "*");
  document.body.textContent = decision === "install" ? "已安装，可以关闭此页面。" : "已取消。";
  window.close();
}
/** 复用 background 的解析器不可行（页面打包独立），这里做轻量展示用解析。 */
function parseMetaForView(code: string) {
  const targets: string[] = [];
  const grants: string[] = [];
  const requires: string[] = [];
  const connects: string[] = [];
  let name = "";
  let version = "";
  let author = "";
  let description = "";
  let runAt = "";
  let inBlock = false;
  for (const line0 of code.split("\n").slice(0, 300)) {
    const line = line0.trim();
    if (/^(?:\/\/|\/\*)?\s*==+\s*(?:UserScript|UserStyle)\s*==+/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && /==+\s*\/\s*(?:UserScript|UserStyle)\s*==+/.test(line)) break;
    if (!inBlock) continue;
    const m = /^(?:\/\/|\/\*+|\*)?\s*@([\w-]+)(?::[\w-]+)?\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, value] = m;
    switch (key) {
      case "name":
        name ||= value;
        break;
      case "version":
        version ||= value;
        break;
      case "author":
        author ||= value;
        break;
      case "description":
        description ||= value;
        break;
      case "run-at":
        runAt = value;
        break;
      case "match":
      case "include":
      case "url-prefix":
      case "domain":
        targets.push(value);
        break;
      case "grant":
        grants.push(value);
        break;
      case "require":
        requires.push(value);
        break;
      case "connect":
        connects.push(value);
        break;
      default:
        break;
    }
  }
  // @-moz-document 目标
  for (const m of code.matchAll(/@-moz-document[^{]*/g)) {
    for (const t of m[0].matchAll(/\b(domain|url|url-prefix|regexp)\s*\(([^)]*)\)/g)) {
      targets.push(`${t[1]}: ${t[2].replace(/['"]/g, "").trim()}`);
    }
  }
  return { name, version, author, description, runAt, targets, grants, requires, connects };
}

// ---- opener 中继：供 opener 标签页（dev server 视图）以 postMessage 驱动确认 ----
if (window.opener) {
  const post = (m: Record<string, unknown>): void => window.opener?.postMessage(m, "*");
  post({ __infinE2EReady: true });
  window.addEventListener("message", (ev: MessageEvent) => {
    const d = ev.data as Record<string, unknown> | null;
    if (!d || typeof d !== "object" || d.__infinE2E !== true) return;
    if (d.__infinReadApp) {
      post({ __infinE2E: true, app: document.getElementById("app")?.textContent ?? "" });
    }
    if (d.__infinClickConfirm) {
      const btn = document.querySelector("button.primary") as HTMLButtonElement | null;
      btn?.click();
    }
  });
}

// ---- opener postMessage 中继 ----
// dev server 视图（opener 标签页）可通过 postMessage 驱动本页：
//   { __infinE2E: true, __infinReadApp: true }            → 回传页面文本
//   { __infinE2E: true, __infinClickConfirm: true }       → 点击确认安装
//   { __infinE2E: true, __infinClickManage: true }        → 打开管理面板
// 并回传 { __infinE2EReady: true } / { __infinInstalled: true }。
if (window.opener) {
  const post = (m: Record<string, unknown>): void => window.opener?.postMessage(m, "*");
  post({ __infinE2EReady: true, app: document.getElementById("app")?.textContent ?? "" });
  window.addEventListener("message", (ev: MessageEvent) => {
    const d = ev.data as Record<string, unknown> | null;
    if (!d || typeof d !== "object" || d.__infinE2E !== true) return;
    if (d.__infinReadApp) {
      post({ __infinE2E: true, app: document.getElementById("app")?.textContent ?? "" });
    }
    if (d.__infinClickConfirm) {
      (document.querySelector("button.primary") as HTMLButtonElement | null)?.click();
    }
    if (d.__infinClickManage) {
      void msg({ type: "OpenOptions" });
    }
  });
}
