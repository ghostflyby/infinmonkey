/** Popup: scripts/styles active on this page + menu commands. */
import browser from "webextension-polyfill";
import type { PopupData } from "@infinmonkey/shared/types";
import { h, msg } from "../dom.ts";

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T;

let activeTabId: number | null = null;

void (async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;
  await refresh();
})();

async function refresh(): Promise<void> {
  if (activeTabId == null) return;
  try {
    const data = await msg<PopupData>({ type: "GetPopupData", tabId: activeTabId });
    render(data);
  } catch (e) {
    const list = $("#scripts");
    list.textContent = "";
    list.append(
      h("div", { class: "empty" }, `加载失败：${String((e as Error)?.message ?? e)}`),
    );
  }
}

function render(data: PopupData): void {
  try {
    $("#site-url").textContent = data.url || "（此页面不可访问）";
  } catch {
    /* ignore */
  }
  $("#dev-dot").classList.toggle("on", data.devConnected);
  $("#dev-dot").title = data.devConnected
    ? `dev server 已连接：${data.devOrigin}`
    : "dev server 未连接";
  renderSiteControls(data);

  const list = $("#scripts");
  list.textContent = "";
  if (!data.masterEnabled) {
    list.append(h("div", { class: "empty" }, "总开关已关闭：所有站点停止注入，GM 调用一并拒绝"));
  } else if (data.siteBlocked) {
    list.append(h("div", { class: "empty" }, "此站点已停用：不注入，不响应 GM 调用"));
  } else if (data.scripts.length === 0) {
    list.append(h("div", { class: "empty" }, "没有在此页面运行的脚本或样式"));
  }
  if (!data.siteBlocked) {
    for (const s of data.scripts) {
      list.append(
        h(
          "div",
          { class: "row", title: "点击在管理面板中编辑" },
          h("div", { class: "glyph" }, s.kind === "script" ? "📜" : "🎨"),
          h(
            "div",
            { class: "name" },
            s.name,
            " ",
            s.version ? h("span", { class: "ver" }, `v${s.version}`) : null,
            s.error ? h("span", { class: "err-dot", title: s.error }) : null,
          ),
          popupToggle(s.id, s.enabled),
        ),
      );
    }
  }

  const cmdSection = $("#cmd-section");
  const cmds = $("#commands");
  cmds.textContent = "";
  cmdSection.hidden = data.commands.length === 0;
  for (const c of data.commands) {
    cmds.append(
      h("button", {
        class: "cmd-btn",
        onclick: () => void msg({ type: "DispatchCommand", commandId: c.commandId }),
      }, c.title),
    );
  }
}

function renderSiteControls(data: PopupData): void {
  $("#site-section").hidden = false;
  $("#master-switch").replaceChildren(
    switchToggle(
      data.masterEnabled,
      (on) => void msg({ type: "SetSettings", patch: { masterEnabled: on } }).then(refresh),
    ),
  );
  const siteToggle = switchToggle(!data.siteBlocked, (allow) => {
    void toggleSite(data.url, allow).then(refresh);
  });
  // Without a URL (or with the master off) there is nothing to toggle per site.
  // Non-web pages (about:*/chrome://*) have no meaningful host pattern.
  (siteToggle.querySelector("input") as HTMLInputElement).disabled = !data.masterEnabled ||
    !/^https?:/i.test(data.url);
  $("#site-switch").replaceChildren(siteToggle);
}

/** Site switch = add/remove a host-wide pattern for this page's origin. */
async function toggleSite(url: string, allow: boolean): Promise<void> {
  const pattern = `*://${new URL(url).host}/*`;
  const { siteBlacklist } = await msg<{ siteBlacklist: string[] }>({ type: "GetSettings" });
  const next = allow
    ? siteBlacklist.filter((p) => p !== pattern)
    : siteBlacklist.includes(pattern)
    ? siteBlacklist
    : [...siteBlacklist, pattern];
  await msg({ type: "SetSettings", patch: { siteBlacklist: next } });
}

/** Shared switch control; callers attach behavior in onChange. */
function switchToggle(on: boolean, onChange: (on: boolean) => void): HTMLElement {
  const input = h("input", { type: "checkbox" }) as HTMLInputElement;
  input.checked = on;
  input.addEventListener("change", () => onChange(input.checked));
  return h(
    "label",
    { class: "switch" },
    input,
    h("span", { class: "track" }),
    h("span", { class: "knob" }),
  );
}

function popupToggle(id: string, on: boolean): HTMLElement {
  const el = switchToggle(on, (enabled) => void msg({ type: "SetEnabled", id, enabled }));
  el.addEventListener("click", (e) => e.stopPropagation());
  return el;
}

$("#open-options").addEventListener("click", () => void browser.runtime.openOptionsPage());
