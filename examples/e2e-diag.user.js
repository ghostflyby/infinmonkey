// ==UserScript==
// @name e2e-diag
// @namespace infinmonkey.e2e
// @version 1.0.0
// @match http://127.0.0.1:17321/*
// @grant none
// @require http://127.0.0.1:17321/e2e-require-lib.js
// @run-at document-end
// ==/UserScript==

document.documentElement.dataset.infinRequire = String(globalThis.__e2eRequireLib ?? "missing");

function probeStack() {
  try {
    null.x;
  } catch (e) {
    return e instanceof Error ? e.stack : String(e);
  }
  return "";
}
document.documentElement.dataset.infinStack = (probeStack() ?? "").slice(0, 500);

throw new Error("diag-sync");
