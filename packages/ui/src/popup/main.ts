/** Popup: scripts/styles active on this page + menu commands. */
import browser from "webextension-polyfill";
import type { PopupData } from "@infinmonkey/shared/types";
import { h, msg } from "../dom.ts";

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T;

let activeTabId: number | null = null;

void (async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;
  if (activeTabId == null) return;
  const data = await msg<PopupData>({ type: "GetPopupData", tabId: activeTabId });
  render(data);
})();

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

  const list = $("#scripts");
  list.textContent = "";
  if (data.scripts.length === 0) {
    list.append(h("div", { class: "empty" }, "没有在此页面运行的脚本或样式"));
  }
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
        ),
        popupToggle(s.id, s.enabled),
      ),
    );
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

function popupToggle(id: string, on: boolean): HTMLElement {
  const input = h("input", { type: "checkbox" }) as HTMLInputElement;
  input.checked = on;
  input.addEventListener("change", () => {
    void msg({ type: "SetEnabled", id, enabled: input.checked });
  });
  input.addEventListener("click", (e) => e.stopPropagation());
  return h(
    "label",
    { class: "switch" },
    input,
    h("span", { class: "track" }),
    h("span", { class: "knob" }),
  );
}

$("#open-options").addEventListener("click", () => void browser.runtime.openOptionsPage());
