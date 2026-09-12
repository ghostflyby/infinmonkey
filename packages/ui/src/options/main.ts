/** Options page: list / editor / settings. */
import browser from "webextension-polyfill";
import { RUNTIME_NAME, RUNTIME_VERSION } from "@infinmonkey/shared/constants";
import type { ListEntriesResult } from "@infinmonkey/shared/protocol";
import type {
  AnyEntry,
  EntrySource,
  ExportBundle,
  ScriptEntry,
  StyleEntry,
} from "@infinmonkey/shared/types";
import { randomId } from "@infinmonkey/shared/util";
import { NEW_SCRIPT_TEMPLATE, NEW_STYLE_TEMPLATE } from "@infinmonkey/shared/templates";
import { isRecord } from "@infinmonkey/shared/util";
import { debounce, h, msg, toast } from "../dom.ts";

let current: AnyEntry | null = null;
let view: "scripts" | "styles" | "settings" = "scripts";
let editingId: string | null = null;

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T;

// ---- View switching ----

function show(viewName: "list" | "editor" | "settings"): void {
  $("#view-list").hidden = viewName !== "list";
  $("#view-editor").hidden = viewName !== "editor";
  $("#view-settings").hidden = viewName !== "settings";
}

for (const btn of document.querySelectorAll<HTMLButtonElement>("#nav button")) {
  btn.addEventListener("click", () => {
    view = btn.dataset.view as typeof view;
    for (const b of document.querySelectorAll("#nav button")) {
      b.classList.toggle("active", b === btn);
    }
    if (view === "settings") {
      show("settings");
      void loadSettings();
    } else {
      $("#list-title").textContent = view === "scripts" ? "脚本" : "样式";
      show("list");
      void loadList();
    }
  });
}

// ---- List ----

async function loadList(): Promise<void> {
  const res = await msg<ListEntriesResult>({ type: "ListEntries" });
  const list = $("#entry-list");
  list.textContent = "";
  const items: AnyEntry[] = view === "scripts" ? res.scripts : res.styles;
  $("#count-scripts").textContent = String(res.scripts.length);
  $("#count-styles").textContent = String(res.styles.length);
  if (items.length === 0) {
    list.append(
      h(
        "div",
        { class: "empty" },
        `还没有${
          view === "scripts" ? "脚本" : "样式"
        }。点侧栏「＋ 新建」，或用 <code>deno task devserver</code> 起本地映射后从 URL 安装。`,
      ),
    );
    return;
  }
  for (const entry of items) list.append(renderEntry(entry));
}

function renderEntry(entry: AnyEntry): HTMLElement {
  const isScript = entry.kind === "script";
  const src = entry.source;
  const dev = src.type === "dev";
  const disabled = !entry.enabled;
  const row = h(
    "div",
    { class: "entry" },
    h("div", { class: "glyph" }, isScript ? "📜" : "🎨"),
    h(
      "div",
      { class: "info" },
      h(
        "div",
        { class: "name" },
        entry.meta.name,
        dev ? h("span", { class: "badge" }, "DEV") : null,
        disabled ? h("span", { class: "badge off" }, "已禁用") : null,
      ),
      h(
        "div",
        { class: "meta" },
        [
          entry.meta.version ? `v${entry.meta.version}` : null,
          dev ? src.url.replace(/^https?:\/\//, "") : "内置代码",
          isScript ? `授权 ${entry.meta.grants.filter((g) => g !== "none").length} 项` : "样式",
        ].filter(Boolean).join(" · "),
      ),
    ),
    toggle(entry.enabled, async (on) => {
      await msg({ type: "SetEnabled", id: entry.id, enabled: on });
      await loadList();
    }),
    h(
      "div",
      { class: "acts" },
      h("button", { onclick: () => openEditor(entry.id) }, "编辑"),
      h("button", { onclick: () => void checkUpdate(entry.id) }, "更新"),
      h("button", { onclick: () => void removeEntry(entry) }, "删除"),
    ),
  );
  return row;
}

function toggle(on: boolean, change: (v: boolean) => void | Promise<void>): HTMLElement {
  const input = h("input", { type: "checkbox" }) as HTMLInputElement;
  input.checked = on;
  input.addEventListener("change", () => void change(input.checked));
  return h(
    "label",
    { class: "switch" },
    input,
    h("span", { class: "track" }),
    h("span", { class: "knob" }),
  );
}

async function removeEntry(entry: AnyEntry): Promise<void> {
  if (!confirm(`确定删除「${entry.meta.name}」？`)) return;
  await msg({ type: "DeleteEntry", id: entry.id });
  toast("已删除");
  await loadList();
}

async function checkUpdate(id: string): Promise<void> {
  toast("正在检查更新…");
  const res = await msg<{ status: string; message?: string; version?: string }>({
    type: "CheckUpdate",
    id,
  });
  if (res.status === "current") toast("已是最新版本");
  else if (res.status === "available") toast(`发现新版本 v${res.version}，请在安装页确认`);
  else toast(res.message ?? "检查失败", true);
}

// ---- Editor ----

async function openEditor(id: string): Promise<void> {
  const res = await msg<{ entry: AnyEntry | null }>({ type: "GetEntry", id });
  if (!res.entry) return;
  current = res.entry;
  editingId = id;
  fillEditor();
  show("editor");
}

function fillEditor(): void {
  if (!current) return;
  $("#ed-name").textContent = current.meta.name;
  ($("#ed-code") as HTMLTextAreaElement).value = current.code;
  updateChips();
  updateGutter();

  const src = current.source;
  const dev = src.type === "dev";
  (document.querySelector('input[name="ed-src"][value="inline"]') as HTMLInputElement).checked =
    !dev;
  (document.querySelector('input[name="ed-src"][value="dev"]') as HTMLInputElement).checked = dev;
  ($("#ed-dev-url") as HTMLInputElement).value = dev ? src.url : "";
  ($("#ed-auto-reload") as HTMLInputElement).checked = dev ? src.autoReload : true;
  $("#ed-ping-status").textContent = "";
  void refreshConnectGrants();
}

function updateChips(): void {
  if (!current) return;
  const chips = $("#ed-chips");
  chips.textContent = "";
  const m = current.meta;
  const add = (t: string) => chips.append(h("span", { class: "chip" }, t));
  if (m.version) add(`v${m.version}`);
  if (current.kind === "script") {
    add(`@run-at ${m.runAt}`);
    add(`授权 ${m.grants.filter((g) => g !== "none").length}`);
    add(`匹配 ${m.matches.length + m.includes.length} 条`);
    if (m.noframes) add("noframes");
    if (m.requires.length) add(`@require ×${m.requires.length}`);
    if (m.resources.length) add(`@resource ×${m.resources.length}`);
    if (m.connects.length) add(`@connect ×${m.connects.length}`);
  } else {
    add("用户样式");
  }
  const meta = $("#ed-meta");
  meta.textContent = "";
  const targets = m.matches.concat(m.includes).slice(0, 6);
  for (const t of targets) meta.append(h("span", { class: "chip" }, t));
  if (m.description) meta.append(h("span", { class: "chip" }, m.description));
}

function updateGutter(): void {
  const ta = $("#ed-code") as HTMLTextAreaElement;
  const lines = ta.value.split("\n").length;
  const gutter = $("#ed-gutter");
  let text = "";
  for (let i = 1; i <= lines; i++) text += i + "\n";
  gutter.textContent = text;
  gutter.scrollTop = ta.scrollTop;
}

$("#ed-code").addEventListener("input", updateGutter);
$("#ed-code").addEventListener("scroll", () => {
  $("#ed-gutter").scrollTop = ($("#ed-code") as HTMLTextAreaElement).scrollTop;
});

$("#ed-back").addEventListener("click", () => {
  editingId = null;
  show("list");
  void loadList();
});

async function saveEditor(): Promise<void> {
  try {
    if (!editingId || !current) return;
    const code = ($("#ed-code") as HTMLTextAreaElement).value;
    const res = await msg<{ entry: AnyEntry | null }>({ type: "SaveCode", id: editingId, code });
    if (!res.entry) {
      toast("保存失败：条目不存在", true);
      return;
    }
    current = res.entry;
    updateChips();
    toast("已保存");
  } catch (e) {
    toast(`保存失败：${String(e)}`, true);
  }
}
$("#ed-save").addEventListener("click", () => void saveEditor());
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "s" && !$("#view-editor").hidden) {
    e.preventDefault();
    void saveEditor();
  }
});

// Source switching
for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="ed-src"]')) {
  radio.addEventListener("change", async () => {
    if (!editingId) return;
    const mode = radio.value;
    if (mode === "dev") {
      const url = ($("#ed-dev-url") as HTMLInputElement).value.trim();
      if (!/^https?:\/\//.test(url)) {
        toast("请先填写 http(s) 映射 URL", true);
        (document.querySelector('input[name="ed-src"][value="inline"]') as HTMLInputElement)
          .checked = true;
        return;
      }
      await setSource({
        type: "dev",
        url,
        autoReload: ($("#ed-auto-reload") as HTMLInputElement).checked,
      });
    } else {
      await setSource({ type: "inline" });
    }
  });
}
$("#ed-dev-url").addEventListener("change", () => {
  if (($("#ed-dev-url") as HTMLInputElement).value.trim() && editingId) {
    (document.querySelector('input[name="ed-src"][value="dev"]') as HTMLInputElement).checked =
      true;
    radioDevApply();
  }
});
$("#ed-auto-reload").addEventListener("change", radioDevApply);

function radioDevApply(): void {
  const url = ($("#ed-dev-url") as HTMLInputElement).value.trim();
  const devRadio = document.querySelector<HTMLInputElement>('input[name="ed-src"][value="dev"]')!;
  if (devRadio.checked && /^https?:\/\//.test(url)) {
    void setSource({
      type: "dev",
      url,
      autoReload: ($("#ed-auto-reload") as HTMLInputElement).checked,
    });
  }
}

async function setSource(source: EntrySource): Promise<void> {
  if (!editingId) return;
  const res = await msg<{ entry: AnyEntry | null }>({ type: "SetSource", id: editingId, source });
  if (res.entry) {
    current = res.entry;
    toast(source.type === "dev" ? "已映射到本地文件" : "已切换为内置存储");
  }
}

$("#ed-ping").addEventListener("click", async () => {
  const url = ($("#ed-dev-url") as HTMLInputElement).value.trim();
  const status = $("#ed-ping-status");
  status.textContent = "测试中…";
  status.className = "";
  const origin = url ? new URL(url).origin : undefined;
  const res = await msg<{ ok: boolean; message?: string }>({ type: "PingDevServer", origin });
  status.textContent = res.ok ? "✓ 已连接" : `✗ ${res.message ?? "连接失败"}`;
  status.className = res.ok ? "ok" : "err";
});

$("#ed-check-update").addEventListener("click", () => editingId && void checkUpdate(editingId));

$("#ed-delete").addEventListener("click", () => {
  if (!current) return;
  void removeEntry(current).then(() => {
    editingId = null;
    show("list");
    void loadList();
  });
});

async function refreshConnectGrants(): Promise<void> {
  if (!editingId || current?.kind !== "script") {
    $("#ed-connect-grants").textContent = "";
    return;
  }
  const res = await msg<{ grants: string[] }>({ type: "GetConnectGrants", id: editingId });
  const box = $("#ed-connect-grants");
  box.textContent = "";
  if (res.grants.length === 0) {
    box.textContent = "额外跨域授权：无";
    return;
  }
  box.append("额外跨域授权：");
  for (const domain of res.grants) {
    box.append(
      h(
        "span",
        {
          class: "chip",
          title: "点击撤销",
          onclick: async () => {
            await msg({ type: "RevokeConnectGrant", id: editingId!, domain });
            await refreshConnectGrants();
          },
        },
        `${domain} ✕`,
      ),
    );
  }
}

// ---- Create / import / export ----

$("#add-script").addEventListener("click", async () => {
  try {
    const res = await msg<{ entry: ScriptEntry }>({
      type: "CreateEntry",
      kind: "script",
      code: NEW_SCRIPT_TEMPLATE,
      token: randomId(),
    });
    await openEditor(res.entry.id);
    void loadList();
  } catch (e) {
    toast(`创建失败：${String(e)}`, true);
  }
});
$("#add-style").addEventListener("click", async () => {
  try {
    const res = await msg<{ entry: StyleEntry }>({
      type: "CreateEntry",
      kind: "style",
      code: NEW_STYLE_TEMPLATE,
      token: randomId(),
    });
    await openEditor(res.entry.id);
    void loadList();
  } catch (e) {
    toast(`创建失败：${String(e)}`, true);
  }
});

$("#add-url").addEventListener("click", () => {
  const url = prompt("输入 .user.js / .user.css 的 URL：");
  if (!url) return;
  void msg<{ ok: boolean; message?: string }>({ type: "StartInstallFromUrl", url }).then((r) => {
    if (!r.ok) toast(r.message ?? "安装失败", true);
    else toast("已打开安装确认页");
  });
});

$("#btn-import").addEventListener("click", () => ($("#file-input") as HTMLInputElement).click());
$("#btn-import2").addEventListener("click", () => ($("#file-input") as HTMLInputElement).click());
$("#file-input").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  for (const file of input.files ?? []) {
    const text = await file.text();
    if (file.name.endsWith(".json")) {
      try {
        const data = JSON.parse(text) as ExportBundle;
        const r = await msg<{ count: number }>({ type: "ImportAll", data, mode: "merge" });
        toast(`已导入 ${r.count} 个条目`);
      } catch (err) {
        toast(`导入失败: ${String(err)}`, true);
      }
    } else {
      const kind = text.includes("==UserStyle==") ? "style" : "script";
      await msg({ type: "CreateEntry", kind, code: text });
      toast(`已导入 ${file.name}`);
    }
  }
  input.value = "";
  await loadList();
});

async function doExport(): Promise<void> {
  const data = await msg<ExportBundle>({ type: "ExportAll" });
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = h("a", {
    href: url,
    download: `infinmonkey-backup-${new Date().toISOString().slice(0, 10)}.json`,
  });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
$("#btn-export").addEventListener("click", () => void doExport());
$("#btn-export2").addEventListener("click", () => void doExport());

// ---- Settings ----

async function loadSettings(): Promise<void> {
  const settings = await msg<{ devOrigin: string }>({ type: "GetSettings" });
  ($("#set-dev-origin") as HTMLInputElement).value = settings.devOrigin;
  $("#about").textContent = `${RUNTIME_NAME} v${RUNTIME_VERSION} · MV3 运行时 · Firefox ${
    browser.runtime.getBrowserInfo ? "✓" : "✗"
  }`;
}

$("#set-dev-ping").addEventListener("click", async () => {
  const origin = ($("#set-dev-origin") as HTMLInputElement).value.trim().replace(/\/$/, "");
  const status = $("#set-dev-status");
  status.textContent = "测试中…";
  status.className = "";
  const r = await msg<{ ok: boolean; message?: string; info?: { root?: string } }>({
    type: "PingDevServer",
    origin,
  });
  status.textContent = r.ok
    ? `✓ 已连接${r.info?.root ? ` · ${r.info.root}` : ""}`
    : `✗ ${r.message ?? "失败"}`;
  status.className = r.ok ? "ok" : "err";
  if (r.ok) {
    await msg({ type: "SetSettings", patch: { devOrigin: origin } });
    toast("Dev Server 地址已保存");
  }
});

// ---- dev server status indicator ----

browser.runtime.onMessage.addListener((m: unknown) => {
  if (!isRecord(m)) return;
  if (m.type === "devStatus") setDevIndicator(m.connected === true);
  if (m?.type === "entriesChanged" && !$("#view-editor").hidden) {
    // External changes (e.g. dev fetches) during editing must not clobber the editor; only refresh the list silently
    debounce(() => void loadList(), 500)();
  }
  if (m?.type === "entriesChanged" && $("#view-editor").hidden) {
    debounce(() => void loadList(), 300)();
  }
});

function setDevIndicator(on: boolean): void {
  $("#dev-dot").classList.toggle("on", on);
  $("#dev-label").textContent = on ? "dev server 已连接" : "dev server 未连接";
}

void msg<{ ok: boolean }>({ type: "PingDevServer" }).then((r) => setDevIndicator(r.ok)).catch(
  () => {},
);
show("list");
void loadList();

// Debug/automation handles
(window as unknown as { __imDebug: () => unknown }).__imDebug = () => ({
  editingId,
  view,
  editorHidden: $("#view-editor").hidden,
  taLen: ($("#ed-code") as HTMLTextAreaElement).value.length,
  toast: document.getElementById("im-toast")?.textContent ?? "",
});
