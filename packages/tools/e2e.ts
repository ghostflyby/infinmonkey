/**
 * InfinMonkey E2E: geckodriver drives Zen (Firefox kernel).
 * Prerequisites: deno task build:firefox; deno task devserver (port 17321).
 */
import { dirname, fromFileUrl, join } from "@std/path";

const ROOT = join(dirname(fromFileUrl(import.meta.url)), "..", "..");
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = "http://127.0.0.1:" + PORT;
const ZEN = "/Applications/Zen.app/Contents/MacOS/zen";
const PROFILE = join(ROOT, ".webext/e2e-profile");
const ADDON = join(ROOT, "dist/firefox");
const SHOTS = join(ROOT, ".e2e");
const DEV = "http://127.0.0.1:17321";

let sid = "";
let passed = 0;
let failed = 0;
const fails: string[] = [];

function ok(cond: boolean, name: string, detail = ""): void {
  if (cond) {
    passed++;
    console.log("  OK " + name);
  } else {
    failed++;
    fails.push(name + " " + detail);
    console.log("  FAIL " + name + " " + detail);
  }
}

async function wd(method: string, path: string, body?: unknown): Promise<unknown> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, init);
  const j = await res.json().catch(() => ({}));
  if (res.status >= 400) throw new Error(method + " " + path + " " + res.status);
  return (j.value ?? j);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function nav(url: string): Promise<void> {
  await wd("POST", "/session/" + sid + "/url", { url });
}
async function js(script: string): Promise<unknown> {
  return await wd("POST", "/session/" + sid + "/execute/sync", { script, args: [] });
}
async function tabHandles(): Promise<string[]> {
  const r = await wd("GET", "/session/" + sid + "/window/handles");
  return r as string[];
}
async function switchTab(h: string): Promise<void> {
  await wd("POST", "/session/" + sid + "/window", { handle: h });
}
async function screenshot(tag: string): Promise<void> {
  try {
    const b64 = await wd("GET", "/session/" + sid + "/screenshot");
    await Deno.writeTextFile(join(SHOTS, tag + ".png"), b64 as string);
    console.log("  shot: " + tag + ".png");
  } catch { /* ignore */ }
}

// ---- main ----
await Deno.mkdir(SHOTS, { recursive: true });
await Deno.mkdir(PROFILE, { recursive: true });

console.log("[e2e] geckodriver…");
const proc = new Deno.Command("geckodriver", {
  args: ["--port", String(PORT), "--allow-origins", BASE],
  stdout: "null",
  stderr: "null",
}).spawn();
await sleep(3000);

try {
  console.log("[e2e] session…");
  const sess = await wd("POST", "/session", {
    capabilities: {
      alwaysMatch: {
        browserName: "firefox",
        "moz:firefoxOptions": { binary: ZEN, args: ["-headless", "-profile", PROFILE] },
      },
    },
  });
  sid = (sess as { sessionId: string }).sessionId;

  console.log("[e2e] addon install…");
  await wd("POST", "/session/" + sid + "/moz/addon/install", {
    path: ADDON,
    temporary: true,
  });

  // ---- 1. Banner install ----
  console.log("[e2e] 1. banner install…");
  await nav(DEV + "/demo-e2e.user.js");
  const bannerDl = Date.now() + 10000;
  while (Date.now() < bannerDl) {
    try {
      await wd("POST", "/session/" + sid + "/execute/sync", {
        script: "return !!document.querySelector('div[style*=2147483647]')",
        args: [],
      });
      break;
    } catch {
      await sleep(300);
    }
  }
  await screenshot("01-banner");

  // Click install (shadow DOM, open mode)
  await wd("POST", "/session/" + sid + "/execute/sync", {
    script:
      "document.querySelector('div[style*=2147483647]')?.shadowRoot?.querySelector('.install')?.click()",
    args: [],
  });
  await sleep(2000);

  // ---- 2. example.com: injection + GM ----
  console.log("[e2e] 2. example.com…");
  await nav("https://example.com/");
  const injDl = Date.now() + 20000;
  let inj = false;
  let demoText = "";
  let injPos = "";
  while (Date.now() < injDl && !inj) {
    try {
      const r = await wd("POST", "/session/" + sid + "/execute/sync", {
        script:
          "return JSON.stringify({r:!!window.__infinRunnerReady,d:!!document.getElementById('infin-demo'),t:(document.getElementById('infin-demo')?.textContent??'').slice(0,40),p:document.getElementById('infin-demo')?getComputedStyle(document.getElementById('infin-demo')).position:''})",
        args: [],
      });
      const o = JSON.parse(r as string);
      if (o.d) {
        inj = true;
        demoText = o.t;
        injPos = o.p;
      }
    } catch { /* retry */ }
    await sleep(500);
  }
  ok(inj, "user script injected (MAIN world)", demoText);
  ok(demoText.includes("visits=1"), "GM storage works", demoText);
  ok(injPos === "fixed", "GM_addStyle works", injPos);

  // ---- 3. GM_xhr ----
  console.log("[e2e] 3. GM_xhr…");
  await wd("POST", "/session/" + sid + "/execute/sync", {
    script:
      "(() => { var e = document.getElementById('infin-e2e-out'); if(e) e.textContent=''; document.getElementById('infin-btn-xhr')?.click(); })()",
    args: [],
  });
  const xhrDl = Date.now() + 10000;
  let xhrOk = false;
  while (Date.now() < xhrDl) {
    try {
      const t = await wd("POST", "/session/" + sid + "/execute/sync", {
        script: "return document.getElementById('infin-e2e-out')?.textContent ?? ''",
        args: [],
      });
      if ((t as string).includes("xhr-ok:200")) {
        xhrOk = true;
        break;
      }
    } catch {
      await sleep(300);
    }
  }
  ok(xhrOk, "GM_xmlhttpRequest local");

  // ---- 4. GM_setClipboard ----
  console.log("[e2e] 4. GM_setClipboard…");
  await wd("POST", "/session/" + sid + "/execute/sync", {
    script: "(() => { document.getElementById('infin-e2e-out').textContent = ''; })()",
    args: [],
  });
  await wd("POST", "/session/" + sid + "/execute/sync", {
    script: "document.getElementById('infin-btn-clip')?.click()",
    args: [],
  });
  let clipOk = false;
  const clipDl = Date.now() + 10000;
  while (Date.now() < clipDl) {
    try {
      const t = await wd("POST", "/session/" + sid + "/execute/sync", {
        script: "return document.getElementById('infin-e2e-out')?.textContent ?? ''",
        args: [],
      });
      if ((t as string).includes("clip-ok")) {
        clipOk = true;
        break;
      }
    } catch {
      await sleep(300);
    }
  }
  ok(clipOk, "GM_setClipboard");

  console.log("[e2e] " + passed + " passed, " + failed + " failed");
  if (failed > 0) Deno.exit(1);
} catch (e) {
  console.error("[e2e] error:", e);
  failed++;
} finally {
  if (sid) await wd("DELETE", "/session/" + sid).catch(() => {});
  try {
    proc.kill();
  } catch { /* ignore */ }
}

if (failed > 0) Deno.exit(1);
