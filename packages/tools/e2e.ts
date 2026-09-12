/**
 * InfinMonkey E2E: WebDriver smoke/full suites (Firefox family=geckodriver, Chromium family=chromedriver).
 * Prerequisites: the matching dist built (dist/firefox or dist/chrome); dev server running on 127.0.0.1:17321.
 * Usage: deno run -A packages/tools/e2e.ts [--browser <name>] [--suite smoke|full]
 *   --browser resolves via browsers.ts (CLI > INFIN_BROWSER > .browsers.local.json > zen),
 *   the driver executable comes from the entry's driver field, defaulting to geckodriver/chromedriver on PATH per engine kind.
 *   --suite smoke runs only the install flow + injection core (the CI Firefox leg); full adds GM_xhr/clipboard.
 */
import { dirname, fromFileUrl, join } from "@std/path";
import { cliBrowserName, resolveBrowser } from "./browsers.ts";

const ROOT = join(dirname(fromFileUrl(import.meta.url)), "..", "..");
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = "http://127.0.0.1:" + PORT;
const PROFILE = join(ROOT, ".webext/e2e-profile");
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
  const text = await res.text();
  let j: { value?: unknown } = {};
  try {
    j = JSON.parse(text) as { value?: unknown };
  } catch { /* non-JSON responses go into the error message as-is */ }
  if (res.status >= 400) {
    const msg = (j.value as { message?: string } | undefined)?.message ?? text.slice(0, 400);
    throw new Error(`${method} ${path} → ${res.status}: ${msg}`);
  }
  return j.value ?? j;
}

async function exec<T = unknown>(script: string): Promise<T> {
  return await wd("POST", "/session/" + sid + "/execute/sync", { script, args: [] }) as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function nav(url: string): Promise<void> {
  await wd("POST", "/session/" + sid + "/url", { url });
}

async function screenshot(tag: string): Promise<void> {
  try {
    const b64 = await wd("GET", "/session/" + sid + "/screenshot");
    const bytes = Uint8Array.from(atob(b64 as string), (c) => c.charCodeAt(0));
    await Deno.writeFile(join(SHOTS, tag + ".png"), bytes);
    console.log("  shot: " + tag + ".png");
  } catch { /* ignore */ }
}

/** Polls execute until truthy or timeout (WebDriver throws while the page is loading or the element is absent; those errors are retried too;
 * false/'' is treated as not-ready and keeps waiting — "appearance" assertions like the banner can land a few hundred ms after load). */
async function poll(deadlineMs: number, script: string): Promise<unknown> {
  const dl = Date.now() + deadlineMs;
  while (Date.now() < dl) {
    try {
      const v = await exec(script);
      if (v) return v;
    } catch { /* retry */ }
    await sleep(300);
  }
  return null;
}

function argAfter(flag: string): string | undefined {
  const i = Deno.args.indexOf(flag);
  return i >= 0 && Deno.args[i + 1] ? Deno.args[i + 1] : undefined;
}

// ---- main ----
const suite = argAfter("--suite") ?? "full";
if (suite !== "smoke" && suite !== "full") {
  console.error(`[e2e] unknown --suite "${suite}" (choose smoke | full)`);
  Deno.exit(1);
}
const smoke = suite === "smoke";

const { name, kind, cfg } = await resolveBrowser(cliBrowserName());
const driverBin = cfg.driver ?? (kind === "firefox" ? "geckodriver" : "chromedriver");
const distDir = join(ROOT, kind === "firefox" ? "dist/firefox" : "dist/chrome");
console.log(`[e2e] browser=${name} kind=${kind} suite=${suite}`);

await Deno.mkdir(SHOTS, { recursive: true });
try {
  await Deno.remove(PROFILE, { recursive: true });
} catch { /* not found */ }
await Deno.mkdir(PROFILE, { recursive: true });

let driverLog: Deno.FsFile | undefined;
try {
  driverLog = await Deno.open(join(SHOTS, "driver.log"), {
    write: true,
    create: true,
    truncate: true,
  });
} catch { /* if even the screenshot dir fails, fall back to null */ }

console.log(`[e2e] ${driverBin}…`);
const proc = new Deno.Command(driverBin, {
  args: kind === "firefox"
    ? ["--port", String(PORT), "--allow-origins", BASE]
    : ["--port=" + String(PORT)],
  stdout: "null",
  stderr: "piped",
}).spawn();
if (proc.stderr) {
  if (driverLog) {
    // Drain stderr to disk (driver startup failures only show there); the process dies with the session
    void proc.stderr.pipeTo(driverLog.writable).catch(() => {});
  } else {
    void proc.stderr.cancel().catch(() => {});
  }
}

// Wait for the driver to be ready (instead of blind waiting; readiness via WebDriver /status)
{
  const dl = Date.now() + 15000;
  let up = false;
  while (Date.now() < dl) {
    try {
      const r = await fetch(BASE + "/status");
      if (r.ok) {
        up = true;
        break;
      }
    } catch { /* not listening yet, retry */ }
    await sleep(200);
  }
  if (!up) {
    console.error(`[e2e] ${driverBin} not ready on ${BASE}`);
    Deno.exit(1);
  }
}

try {
  console.log("[e2e] session…");
  const caps = kind === "firefox"
    ? {
      // Let geckodriver create a one-shot temp profile (the CI snap Firefox cannot read hidden dirs)
      alwaysMatch: {
        browserName: "firefox",
        "moz:firefoxOptions": { binary: cfg.binary, args: ["-headless"] },
      },
    }
    : {
      // Only the new headless mode supports extensions; -disable-extensions-except keeps only the extension under test
      alwaysMatch: {
        browserName: "chrome",
        "goog:chromeOptions": {
          binary: cfg.binary,
          args: [
            "--headless=new",
            "--disable-gpu",
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions-except=" + distDir,
            "--load-extension=" + distDir,
            "--user-data-dir=" + PROFILE,
          ],
        },
      },
    };
  const sess = await wd("POST", "/session", { capabilities: caps });
  sid = (sess as { sessionId: string }).sessionId;
  if (!sid) throw new Error("session response has no sessionId");

  if (kind === "firefox") {
    console.log("[e2e] addon install…");
    await wd("POST", "/session/" + sid + "/moz/addon/install", {
      path: distDir,
      temporary: true,
    });
  }

  // ---- 1. Banner install ----
  console.log("[e2e] 1. banner install…");
  // ?as=html: the official Firefox refuses execute on text/plain documents, so use the dev server's html wrapper view
  await nav(DEV + "/demo-e2e.user.js?as=html");
  const banner = await poll(10000, "return !!document.querySelector(\"div[style*='2147483647']\")");
  ok(banner === true, "install banner shown");
  await screenshot("01-banner");

  // Click install (shadow DOM, open mode)
  await exec(
    "document.querySelector(\"div[style*='2147483647']\")?.shadowRoot?.querySelector('.install')?.click()",
  );
  // Read the install result from the banner's data-infin-done marker (language-neutral);
  // the banner self-destructs after 3s, so keep the polling window short
  const doneState = await poll(
    5000,
    `return document.querySelector("div[style*='2147483647']")?.shadowRoot?.querySelector('[data-infin-done]')?.dataset.infinDone ?? ''`,
  );
  ok(doneState === "installed", "banner install persisted", String(doneState));
  await sleep(2000);

  // ---- 2. example.com: injection + GM ----
  console.log("[e2e] 2. example.com…");
  await nav("https://example.com/");
  const r = await poll(
    20000,
    // Gating: return an empty string until the demo element appears (falsy keeps poll waiting), then return all observations at once
    `return document.getElementById('infin-demo') ? JSON.stringify({` +
      `t:document.getElementById('infin-demo').textContent.slice(0,40),` +
      `p:getComputedStyle(document.getElementById('infin-demo')).position,` +
      `b:document.documentElement.dataset.infinBridge??'',` +
      `e:document.documentElement.dataset.infinBridgeErr??''}) : ''`,
  );
  let demoText = "";
  let injPos = "";
  let bridgeMark = "";
  let bridgeErr = "";
  if (typeof r === "string") {
    try {
      const o = JSON.parse(r) as { t: string; p: string; b?: string; e?: string };
      demoText = o.t;
      injPos = o.p;
      bridgeMark = o.b ?? "";
      bridgeErr = o.e ?? "";
    } catch { /* injection timed out */ }
  }
  const inj = demoText.length > 0;
  ok(
    inj,
    "user script injected (MAIN world)",
    `${demoText} bridge=${bridgeMark} err=${bridgeErr.slice(0, 200)}`,
  );
  ok(demoText.includes("visits=1"), "GM storage works", demoText);
  ok(injPos === "fixed", "GM_addStyle works", injPos);
  await screenshot("02-inject");

  if (!smoke) {
    // ---- 3. GM_xhr ----
    console.log("[e2e] 3. GM_xhr…");
    await exec(
      "(() => { var e = document.getElementById('infin-e2e-out'); if(e) e.textContent=''; " +
        "document.getElementById('infin-btn-xhr')?.click(); })()",
    );
    const xhrT = await poll(
      10000,
      "return document.getElementById('infin-e2e-out')?.textContent ?? ''",
    );
    ok(
      typeof xhrT === "string" && xhrT.includes("xhr-ok:200"),
      "GM_xmlhttpRequest local",
      String(xhrT),
    );

    // ---- 4. GM_setClipboard ----
    console.log("[e2e] 4. GM_setClipboard…");
    await exec("(() => { document.getElementById('infin-e2e-out').textContent = ''; })()");
    await exec("document.getElementById('infin-btn-clip')?.click()");
    const clipT = await poll(
      10000,
      "return document.getElementById('infin-e2e-out')?.textContent ?? ''",
    );
    ok(typeof clipT === "string" && clipT.includes("clip-ok"), "GM_setClipboard", String(clipT));
  }

  console.log(`[e2e] ${passed} passed, ${failed} failed`);
} catch (e) {
  console.error("[e2e] error:", e);
  failed++;
  await screenshot("99-error").catch(() => {});
} finally {
  if (sid) await wd("DELETE", "/session/" + sid).catch(() => {});
  try {
    proc.kill();
  } catch { /* ignore */ }
}

if (failed > 0) {
  console.log("[e2e] FAILED:\n  " + fails.join("\n  "));
  Deno.exit(1);
}
