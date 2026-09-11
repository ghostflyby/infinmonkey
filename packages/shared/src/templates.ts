export const NEW_SCRIPT_TEMPLATE = `// ==UserScript==
// @name         新脚本
// @namespace    infinmonkey
// @version      0.1.0
// @description  使用 InfinMonkey 创建
// @match        *://*/*
// @grant        GM_info
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-end
// ==/UserScript==

(function () {
  console.log('[InfinMonkey] 已运行:', GM_info.script.name);
})();
`;

export const NEW_STYLE_TEMPLATE = `/* ==UserStyle==
@name         新样式
@namespace    infinmonkey
@version      1.0.0
@description  使用 InfinMonkey 创建
@author       InfinMonkey
==/UserStyle== */

@-moz-document domain("example.com") {
  body {
    background: #1b1b1f;
    color: #e8e8ea;
  }
}
`;
