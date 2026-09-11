// ==UserScript==
// @name         E2E 验证脚本
// @namespace    infinmonkey.e2e
// @version      1.0.0
// @description  端到端验证：注入 / 存储 / xhr / 剪贴板 / 菜单 / dev 映射热更新
// @match        https://example.com/*
// @match        http://127.0.0.1:17321/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @connect      127.0.0.1
// @connect      localhost
// @connect      example.org
// @run-at       document-end
// ==/UserScript==

(function () {
  GM_addStyle(
    "#infin-demo,#infin-e2e-out{position:fixed;top:8px;right:8px;z-index:99999;background:#232329;color:#e8e8ea;padding:10px 14px;border-radius:8px;font:13px system-ui}" +
      "#infin-demo button{margin-left:6px}",
  );

  const box = document.createElement("div");
  box.id = "infin-demo";
  const visits = GM_getValue("visits", 0) + 1;
  GM_setValue("visits", visits);
  box.textContent = "MARKER-A visits=" + visits;

  const mk = (id, label) => {
    const b = document.createElement("button");
    b.id = id;
    b.textContent = label;
    box.appendChild(b);
    return b;
  };

  const out = document.createElement("div");
  out.id = "infin-e2e-out";

  mk("infin-btn-xhr", "xhr").addEventListener("click", () => {
    GM_xmlhttpRequest({
      url: "http://127.0.0.1:17321/__infin/health",
      timeout: 8000,
      onload: (r) => (out.textContent = "xhr-ok:" + r.status),
      onerror: (e) => (out.textContent = "xhr-err:" + e.error),
    });
  });
  mk("infin-btn-remote", "remote").addEventListener("click", () => {
    GM_xmlhttpRequest({
      url: "http://example.net/",
      timeout: 8000,
      onload: (r) => (out.textContent = "remote-ok:" + r.status),
      onerror: (e) => (out.textContent = "remote-err:" + e.error),
    });
  });
  mk("infin-btn-clip", "clip").addEventListener("click", () => {
    GM_setClipboard("e2e-clipboard")
      .then(() => (out.textContent = "clip-ok"))
      .catch((e) => (out.textContent = "clip-err:" + (e.message || e)));
  });

  GM_registerMenuCommand("E2E 菜单命令", () => {
    const c = document.createElement("div");
    c.id = "infin-cmd-hit";
    c.textContent = "cmd-hit";
    document.body.appendChild(c);
  });

  document.body.appendChild(box);
  document.body.appendChild(out);
})();
