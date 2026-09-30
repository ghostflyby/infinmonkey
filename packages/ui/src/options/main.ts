/** Options page: list / editor / settings. */
import browser from "webextension-polyfill";
import { type CodeEditorHandle, createCodeEditorWithServices } from "../monaco/services.ts";
import { RUNTIME_NAME, RUNTIME_VERSION } from "@infinmonkey/shared/constants";
import type { ListEntriesResult } from "@infinmonkey/shared/protocol";
import type {
  AnyEntry,
  EntrySource,
  ExportBundle,
  ScriptEntry,
  ScriptErrorRecord,
  StyleEntry,
} from "@infinmonkey/shared/types";
import { NEW_SCRIPT_TEMPLATE, NEW_STYLE_TEMPLATE } from "@infinmonkey/shared/templates";
import { isRecord } from "@infinmonkey/shared/util";
import { debounce, h, msg, toast } from "../dom.ts";

let current: AnyEntry | null = null;
let view: "scripts" | "styles" | "settings" = "scripts";
let editingId: string | null = null;
let codeEditor: CodeEditorHandle | null = null;
/** GM values panel: the key whose inline editor is expanded. */
let expandedValueKey: string | null = null;

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

type ErrorTable = { imErrors?: Record<string, ScriptErrorRecord> };

/** Last fetched list for the current view + its error table; the search box
 * re-filters these client-side without another round trip. */
let lastItems: AnyEntry[] = [];
let lastErrors: ErrorTable["imErrors"];

async function loadErrors(): Promise<ErrorTable["imErrors"]> {
  return (await browser.storage.local.get("imErrors") as ErrorTable).imErrors;
}

async function loadList(): Promise<void> {
  const res = await msg<ListEntriesResult>({ type: "ListEntries" });
  lastErrors = await loadErrors();
  lastItems = view === "scripts" ? res.scripts : res.styles;
  $("#count-scripts").textContent = String(res.scripts.length);
  $("#count-styles").textContent = String(res.styles.length);
  renderList();
}

/** Instant client-side filter: name / version / dev source URL of the current view. */
function matchesSearch(entry: AnyEntry): boolean {
  const q = ($("#search") as HTMLInputElement).value.trim().toLowerCase();
  if (!q) return true;
  const src = entry.source;
  return [
    entry.meta.name,
    entry.meta.version ?? "",
    src.type === "dev" ? src.url : "",
  ].some((field) => field.toLowerCase().includes(q));
}

function renderList(): void {
  const list = $("#entry-list");
  list.textContent = "";
  if (lastItems.length === 0) {
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
  const items = lastItems.filter(matchesSearch);
  if (items.length === 0) {
    list.append(h("div", { class: "empty" }, "没有匹配的条目"));
    return;
  }
  items.forEach((entry, i) =>
    list.append(renderEntry(entry, i, items.length, lastErrors?.[entry.id]))
  );
}

$("#search").addEventListener("input", () => renderList());

/** Renders one row. `index`/`total` are the entry's position in the filtered
 * view; the move buttons disable at the filtered-list edges, which matches
 * moveEntryBy moving within the filtered set. */
function renderEntry(
  entry: AnyEntry,
  index: number,
  total: number,
  error?: ScriptErrorRecord,
): HTMLElement {
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
        error
          ? h("span", {
            class: "badge err",
            title: `${new Date(error.at).toLocaleString()} · ${error.message}`,
          }, "错误")
          : null,
      ),
      h(
        "div",
        { class: "meta" },
        [
          entry.meta.version ? `v${entry.meta.version}` : null,
          dev ? src.url.replace(/^https?:\/\//, "") : "内置代码",
          isScript ? `授权 ${entry.meta.grants.filter((g) => g !== "none").length} 项` : "样式",
          `更新于 ${new Date(entry.updatedAt).toLocaleDateString("zh-CN")}`,
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
      h("button", {
        class: "mv",
        title: "上移",
        disabled: index === 0,
        onclick: () => void moveEntryBy(entry.id, "up"),
      }, "↑"),
      h("button", {
        class: "mv",
        title: "下移",
        disabled: index === total - 1,
        onclick: () => void moveEntryBy(entry.id, "down"),
      }, "↓"),
      h("button", { onclick: () => openEditor(entry.id) }, "编辑"),
      h("button", { onclick: () => void checkUpdate(entry.id) }, "更新"),
      h("button", { onclick: () => void removeEntry(entry) }, "删除"),
    ),
  );
  return row;
}

/** Moves an entry one step within the visible (filtered) list. MoveEntry
 * swaps with the adjacent entry of the full position-sorted list, so under an
 * active search the visible neighbor can sit several positions away: repeat
 * the swap until the entry passes it, keeping the rendered order in sync with
 * the click. Without a filter the distance is always one swap. */
async function moveEntryBy(id: string, dir: "up" | "down"): Promise<void> {
  const filtered = lastItems.filter(matchesSearch);
  const vi = filtered.findIndex((e) => e.id === id);
  let steps = 1;
  if (vi >= 0) {
    const neighbor = dir === "up" ? vi - 1 : vi + 1;
    if (neighbor < 0 || neighbor >= filtered.length) {
      toast("已在列表边缘", true);
      return;
    }
    const fi = lastItems.findIndex((e) => e.id === id);
    const fn = lastItems.findIndex((e) => e.id === filtered[neighbor].id);
    if (fi >= 0 && fn >= 0) steps = Math.max(1, Math.abs(fn - fi));
  }
  let moved = true;
  for (let i = 0; i < steps && moved; i++) {
    const res = await msg<{ ok: boolean }>({ type: "MoveEntry", id, dir });
    moved = !!res.ok;
  }
  if (!moved) toast("已在列表边缘", true);
  await loadList();
}

function setAllEnabledFromHead(enabled: boolean): void {
  const kind = view === "styles" ? "style" : "script";
  void msg<{ count: number }>({ type: "SetAllEnabled", kind, enabled })
    .then(async (r) => {
      toast(`已${enabled ? "启用" : "禁用"} ${r.count} 项`);
      await loadList();
    })
    .catch((e) => toast(`操作失败：${String(e)}`, true));
}
$("#btn-enable-all").addEventListener("click", () => setAllEnabledFromHead(true));
$("#btn-disable-all").addEventListener("click", () => setAllEnabledFromHead(false));

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
  expandedValueKey = null;
  fillEditor();
  void showEditorError(id);
  show("editor");
}

/** Shows the entry's most recent runtime error above the editor; hidden once
 * new code is saved (updateCode clears the record). */
async function showEditorError(id: string): Promise<void> {
  const bar = $("#ed-error");
  const error = (await loadErrors())?.[id];
  // A slower read for a previous entry must not win over the newer one.
  if (id !== editingId) return;
  if (!error) {
    bar.hidden = true;
    return;
  }
  bar.textContent = `最近运行错误（${new Date(error.at).toLocaleString()}）：${error.message}`;
  bar.hidden = false;
}

function fillEditor(): void {
  if (!current) return;
  $("#ed-name").textContent = current.meta.name;
  codeEditor = codeEditor ?? createCodeEditorWithServices($("#ed-editor"), {
    value: current.code,
    language: current.kind === "style" ? "css" : "javascript",
    onSave: () => void saveEditor(),
  });
  codeEditor.setLanguage(current.kind === "style" ? "css" : "javascript");
  codeEditor.setValue(current.code);
  updateChips();

  const src = current.source;
  const dev = src.type === "dev";
  (document.querySelector('input[name="ed-src"][value="inline"]') as HTMLInputElement).checked =
    !dev;
  (document.querySelector('input[name="ed-src"][value="dev"]') as HTMLInputElement).checked = dev;
  ($("#ed-dev-url") as HTMLInputElement).value = dev ? src.url : "";
  ($("#ed-auto-reload") as HTMLInputElement).checked = dev ? src.autoReload : true;
  $("#ed-ping-status").textContent = "";
  void refreshConnectGrants();
  // GM_*Value is a script-only API, so the values panel never shows for styles.
  $("#ed-values").hidden = current.kind !== "script";
  if (current.kind === "script") void refreshEntryValues();
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

$("#ed-back").addEventListener("click", () => {
  editingId = null;
  show("list");
  void loadList();
});

async function saveEditor(): Promise<void> {
  try {
    if (!editingId || !current) return;
    const code = codeEditor?.getValue() ?? "";
    const res = await msg<{ entry: AnyEntry | null }>({ type: "SaveCode", id: editingId, code });
    if (!res.entry) {
      toast("保存失败：条目不存在", true);
      return;
    }
    current = res.entry;
    updateChips();
    $("#ed-error").hidden = true;
    toast("已保存");
  } catch (e) {
    toast(`保存失败：${String(e)}`, true);
  }
}
$("#ed-save").addEventListener("click", () => void saveEditor());
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "s" && !$("#view-editor").hidden) {
    if (e.defaultPrevented) return; // the editor's own keymap already saved
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

// ---- GM values panel (script entries only) ----

async function refreshEntryValues(): Promise<void> {
  if (!editingId || current?.kind !== "script") return;
  const id = editingId;
  const res = await msg<{ values: Record<string, unknown> }>({ type: "GetEntryValues", id });
  // A slower read for a previous entry must not win over the newer one.
  if (id !== editingId) return;
  const box = $("#ed-values-list");
  box.textContent = "";
  const keys = Object.keys(res.values);
  $("#ed-values-count").textContent = keys.length > 0 ? `${keys.length} 项` : "";
  if (keys.length === 0) {
    box.append(
      h("div", { class: "gmkey-empty" }, "暂无存储值（脚本内用 GM_setValue 写入后显示在这里）"),
    );
    return;
  }
  for (const key of keys) box.append(renderValueRow(id, key, res.values[key]));
}

/** JSON text for the values panel. GM values arrive as structured clones, so
 * exotic members (bigint) make stringify throw and undefined makes it return
 * undefined; both fall back to a best-effort string instead of breaking the
 * render. */
function jsonText(v: unknown, indent = 0): string {
  try {
    const s = JSON.stringify(v, null, indent);
    if (s !== undefined) return s;
  } catch {
    // fall through to String()
  }
  return String(v);
}

function renderValueRow(id: string, key: string, value: unknown): HTMLElement {
  const preview = jsonText(value);
  const row = h(
    "div",
    { class: "gmkey" },
    h(
      "button",
      { class: "gmkey-name", title: "点击展开编辑", onclick: () => toggleValueKey(key) },
      key,
    ),
    h("span", { class: "gmkey-preview", title: preview }, preview),
    h(
      "button",
      { class: "gmkey-act danger", onclick: () => void deleteEntryValueKey(id, key) },
      "删除",
    ),
  );
  if (key !== expandedValueKey) return row;
  const ta = h("textarea", {
    class: "gmkey-edit",
    rows: "4",
    spellcheck: "false",
  }) as HTMLTextAreaElement;
  ta.value = jsonText(value, 2);
  const err = h("span", { class: "gmkey-err" });
  row.append(
    h(
      "div",
      { class: "gmkey-editor" },
      ta,
      h(
        "div",
        { class: "gmkey-editor-acts" },
        h("button", {
          class: "gmkey-act primary",
          onclick: () => void saveEntryValue(id, key, ta, err),
        }, "保存"),
        err,
      ),
    ),
  );
  return row;
}

function toggleValueKey(key: string): void {
  expandedValueKey = expandedValueKey === key ? null : key;
  void refreshEntryValues();
}

async function saveEntryValue(
  id: string,
  key: string,
  ta: HTMLTextAreaElement,
  err: HTMLElement,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ta.value);
  } catch (e) {
    // Inline red hint, not a toast: the editor must stay open for correcting.
    err.textContent = `JSON 解析失败：${String((e as Error).message ?? e)}`;
    return;
  }
  try {
    await msg({ type: "SetEntryValue", id, key, value: parsed });
    expandedValueKey = null;
    toast("已保存");
    await refreshEntryValues();
  } catch (e) {
    toast(`保存失败：${String(e)}`, true);
  }
}

async function deleteEntryValueKey(id: string, key: string): Promise<void> {
  try {
    await msg({ type: "DeleteEntryValue", id, key });
    if (expandedValueKey === key) expandedValueKey = null;
    await refreshEntryValues();
  } catch (e) {
    toast(`删除失败：${String(e)}`, true);
  }
}

$("#ed-values-clear").addEventListener("click", async () => {
  if (!editingId || current?.kind !== "script") return;
  if (!confirm(`确定清空「${current.meta.name}」的全部存储值？`)) return;
  try {
    await msg({ type: "ClearEntryValues", id: editingId });
    expandedValueKey = null;
    toast("已清空");
    await refreshEntryValues();
  } catch (e) {
    toast(`清空失败：${String(e)}`, true);
  }
});

// ---- Create / import / export ----

$("#add-script").addEventListener("click", async () => {
  try {
    const res = await msg<{ entry: ScriptEntry }>({
      type: "CreateEntry",
      kind: "script",
      code: NEW_SCRIPT_TEMPLATE,
      token: crypto.randomUUID(),
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
      token: crypto.randomUUID(),
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
  const settings = await msg<{
    devOrigin: string;
    storageBackend: "local" | "native";
    masterEnabled: boolean;
    siteBlacklist: string[];
    autoUpdate: boolean;
  }>({ type: "GetSettings" });
  ($("#set-dev-origin") as HTMLInputElement).value = settings.devOrigin;
  ($("#set-native-enabled") as HTMLInputElement).checked = settings.storageBackend === "native";
  ($("#set-master-enabled") as HTMLInputElement).checked = settings.masterEnabled;
  ($("#set-auto-update") as HTMLInputElement).checked = settings.autoUpdate;
  ($("#set-blacklist") as HTMLTextAreaElement).value = settings.siteBlacklist.join("\n");
  ($("#set-blacklist-status") as HTMLElement).textContent = settings.siteBlacklist.length > 0
    ? `当前 ${settings.siteBlacklist.length} 条`
    : "";
  void refreshNativeStatus();
  $("#about").textContent = `${RUNTIME_NAME} v${RUNTIME_VERSION} · MV3 运行时 · Firefox ${
    browser.runtime.getBrowserInfo ? "✓" : "✗"
  }`;
}

async function refreshNativeStatus(): Promise<void> {
  const status = $("#set-native-status");
  const r = await msg<{ connected: boolean; pending: number; supported: boolean }>({
    type: "GetNativeStatus",
  });
  if (!r.supported) {
    status.textContent = "当前浏览器不支持";
    status.className = "err";
    return;
  }
  status.textContent = r.connected
    ? `✓ 已连接${r.pending > 0 ? ` · ${r.pending} 条待同步` : ""}`
    : "✗ 未连接（应用未运行或未安装）";
  status.className = r.connected ? "ok" : "err";
}

$("#set-native-enabled").addEventListener("change", async (ev) => {
  const enabled = (ev.target as HTMLInputElement).checked;
  await msg({ type: "SetSettings", patch: { storageBackend: enabled ? "native" : "local" } });
  toast(enabled ? "已启用 Native App 同步" : "已关闭 Native App 同步");
  await refreshNativeStatus();
});

$("#set-master-enabled").addEventListener("change", async (ev) => {
  const on = (ev.target as HTMLInputElement).checked;
  await msg({ type: "SetSettings", patch: { masterEnabled: on } });
  toast(on ? "已启用全部站点" : "已停用全部站点");
});

$("#set-auto-update").addEventListener("change", async (ev) => {
  const on = (ev.target as HTMLInputElement).checked;
  await msg({ type: "SetSettings", patch: { autoUpdate: on } });
  toast(on ? "已开启每日自动更新" : "已关闭自动更新");
});

$("#set-blacklist-save").addEventListener("click", async () => {
  const lines = ($("#set-blacklist") as HTMLTextAreaElement).value
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  await msg({ type: "SetSettings", patch: { siteBlacklist: lines } });
  ($("#set-blacklist-status") as HTMLElement).textContent = lines.length > 0
    ? `已保存 ${lines.length} 条`
    : "已清空";
  toast("站点黑名单已保存");
});

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

browser.storage.onChanged.addListener((changes: Record<string, unknown>, area: string) => {
  if (area !== "local" || !("imErrors" in changes)) return;
  // The editor renders its own error bar; only the list needs a refresh.
  if (!$("#view-editor").hidden) return;
  debounce(() => void loadList(), 500)();
});

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
  taLen: (codeEditor?.getValue() ?? "").length,
  toast: document.getElementById("im-toast")?.textContent ?? "",
});
