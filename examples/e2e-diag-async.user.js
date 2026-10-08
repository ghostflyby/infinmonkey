// ==UserScript==
// @name e2e-diag-async
// @namespace infinmonkey.e2e
// @version 1.0.0
// @match http://127.0.0.1:17321/*
// @grant none
// @run-at document-end
// ==/UserScript==

setTimeout(() => {
  throw new Error("diag-async");
}, 30);
