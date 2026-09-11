// ==UserScript==
// @name         InfinMonkey 演示脚本
// @namespace    infinmonkey.demo
// @version      0.2.0
// @description  冒烟演示：DOM 注入 / 存储 / 菜单命令 / 剪贴板 / 跨域请求 / 样式
// @author       infinmonkey
// @match        https://example.com/*
// @match        https://example.org/*
// @match        http://127.0.0.1:17321/*
// @grant        GM_info
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_addStyle
// @connect      httpbin.org
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-end
// ==/UserScript==

(function () {
  const KEY = "demo_visits";

  GM_addStyle(`
    #infin-demo {
      position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;
      background: #232329; color: #e8e8ea; border: 1px solid #3a3a42;
      border-radius: 10px; padding: 12px 14px; font: 13px/1.5 system-ui, sans-serif;
      box-shadow: 0 6px 24px rgba(0,0,0,.35); min-width: 220px;
    }
    #infin-demo b { color: #e91e63; }
    #infin-demo .row { margin-top: 6px; display: flex; gap: 6px; flex-wrap: wrap; }
    #infin-demo button {
      all: unset; cursor: pointer; padding: 4px 10px; border-radius: 6px;
      background: #33333c; font-size: 12px;
    }
    #infin-demo button:hover { background: #3d3d47; }
    #infin-demo .out { color: #9a9aa5; font-size: 11.5px; margin-top: 6px; min-height: 14px; }
  `);

  const visits = (typeof GM_getValue === "function" ? GM_getValue(KEY, 0) : 0) + 1;
  if (typeof GM_setValue === "function") GM_setValue(KEY, visits);

  const box = document.createElement("div");
  box.id = "infin-demo";
  const out = document.createElement("div");
  out.className = "out";
  const log = (t) => (out.textContent = t);

  const say = document.createElement("div");
  say.innerHTML = `<b>${GM_info.script.name}</b> v${GM_info.script.version} · 第 ${visits} 次运行`;
  if (GM_info.scriptHandler) say.title = `${GM_info.scriptHandler} ${GM_info.version}`;

  const mk = (text, fn) => {
    const b = document.createElement("button");
    b.textContent = text;
    b.addEventListener("click", fn);
    return b;
  };

  box.append(
    say,
    mk("复制文本", () => {
      GM_setClipboard("Hello from InfinMonkey!");
      log("✓ 已写入剪贴板");
    }),
    mk("跨域请求", () => {
      GM_xmlhttpRequest({
        method: "GET",
        url: "https://httpbin.org/get",
        timeout: 10000,
        onload: (r) => log(`✓ HTTP ${r.status}，长度 ${r.responseText.length}`),
        onerror: (e) => log("✗ 请求失败: " + e.error),
        ontimeout: () => log("✗ 超时"),
      });
      log("请求中…");
    }),
    mk("通知", () => {
      GM_notification(
        { title: "InfinMonkey", text: "演示通知（点击回到页面）" },
        () => log("✓ 通知被点击"),
      );
      log("✓ 已发送通知");
    }),
    out,
  );
  document.body?.appendChild(box);

  GM_registerMenuCommand("🎉 重置计数", () => {
    GM_setValue(KEY, 0);
    log("已重置，刷新页面生效");
  });
  GM_registerMenuCommand("📢 菜单命令演示", () => log("✓ 菜单命令被点击"));

  console.log("[InfinMonkey demo] unsafeWindow check:", typeof unsafeWindow !== "undefined");
})();
