/**
 * InfinMonkey end-to-end validation: geckodriver drives Zen (Firefox-based).
 *
 * Prerequisites: deno task build:firefox; deno task devserver (serves examples/ on 127.0.0.1:17321).
 * Run: deno run -A packages/tools/e2e.ts [--browser <name>] [--suite smoke|full]
 *
 * Note: WebDriver forbids navigating directly to moz-extension:// URLs, so everything
 * goes through real user paths: the install banner on .user.js pages (open shadow DOM,
 * served via the dev server's ?as=html HTML view) → install confirmation page →
 * "管理面板" button into the options page.
 *
 * Suites:
 *   full  - all 18 assertions (chromedriver allows execute on extension pages)
 *   smoke - reduced set for engines whose WebDriver refuses execute on
 *           text/plain and extension documents (official Firefox)
 *
 * Coverage (full): temporary addon install → banner install → confirmation metadata
 * → example.com injection (DOM/storage/addStyle) → GM_xmlhttpRequest (local +
 * @connect authorization prompt) → GM_setClipboard → dev mapping hot reload
 * → user style injection.
 */
import { dirname, fromFileUrl, join } from "@std/path";
import { cliBrowserName, resolveBrowser } from "./browsers.ts";

const ROOT = join(dirname(fromFileUrl(import.meta.url)), "..", "..");
// Random port to avoid CI/local leftover processes occupying 4444
const DRIVER_PORT = 20000 + Math.floor(Math.random() * 20000);
const DRIVER = `http://127.0.0.1:${DRIVER_PORT}`;
// Browser resolved via --browser / INFIN_BROWSER / .browsers.local.json / default "zen"
const { name: browserLabel, kind, cfg } = await resolveBrowser(cliBrowserName());
const BROWSER_BIN = cfg.binary;
const PROFILE = join(
  ROOT,
  kind === "chromium" ? ".webext/e2e-chromium-profile" : ".webext/e2e-profile",
);
const EXT_DIR = join(ROOT, kind === "chromium" ? "dist/chrome" : "dist/firefox");
// chromium: prefer the pinned .webext/drivers/chromedriver, else chromedriver from PATH
// BrowserConfig.driver 显式指定优先（CI 由 setup-chromium 写入本地配置）
const DRIVER_BIN = cfg.driver
  ? (cfg.driver.startsWith("/") ? cfg.driver : join(ROOT, cfg.driver))
  : kind === "chromium"
  ? (await Deno.stat(join(ROOT, ".webext/drivers/chromedriver")).then(() =>
    join(ROOT, ".webext/drivers/chromedriver")
  ).catch(() => "chromedriver"))
  : "geckodriver";
const SHOTS = join(ROOT, ".e2e");
const DEV = "http://127.0.0.1:17321";
// full = all assertions (chromedriver allows execute on extension pages);
// smoke = reduced set (geckodriver on official Firefox refuses execute there)
const SUITE =
  (Deno.args.indexOf("--suite") >= 0 ? Deno.args[Deno.args.indexOf("--suite") + 1] : undefined) ??
    "full";

let sessionId = "";
let passed = 0;
const failures: string[] = [];

function ok(cond: boolean, name: string, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name} ${detail}`);
    console.log(`  ✗ ${name} ${detail}`);
  }
}

async function wd<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(DRIVER + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (res.status >= 400 || (json as { error?: string }).error) {
    throw new Error(
      `WebDriver ${method} ${path} → ${res.status} ${JSON.stringify(json).slice(0, 240)}`,
    );
  }
  return (json.value ?? json) as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function poll<T>(fn: () => Promise<T | null>, timeoutMs: number, every = 400): Promise<T> {
  const end = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v !== null && v !== undefined && v !== false && v !== "") return v;
    } catch (e) {
      lastErr = e;
    }
    await sleep(every);
  }
  throw new Error(
    `poll timed out after ${timeoutMs}ms${
      lastErr ? ` (last error: ${String(lastErr).slice(0, 160)})` : ""
    }`,
  );
}

async function go(url: string): Promise<void> {
  await wd("POST", `/session/${sessionId}/url`, { url });
}

async function exec<T = unknown>(script: string, args: unknown[] = []): Promise<T> {
  return await wd<T>("POST", `/session/${sessionId}/execute/sync`, { script, args });
}

async function textOf(css: string): Promise<string> {
  return await exec<string>(
    `return document.querySelector(${JSON.stringify(css)})?.textContent ?? ""`,
  );
}

/** The banner lives in an open shadow root; click it via plain JS. */
async function clickShadowBanner(): Promise<void> {
  await exec(`(() => {
    const host = document.querySelector("#infin-installer-host, div[style*='z-index']");
    const shadow = host?.shadowRoot;
    const btn = shadow?.querySelector(".install");
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
}

async function waitText(css: string, timeoutMs = 10000): Promise<string> {
  return await poll(() => textOf(css).then((t) => t ? t : null), timeoutMs);
}

async function clickEl(css: string): Promise<void> {
  const res = await exec<boolean>(`(() => {
    const el = document.querySelector(${JSON.stringify(css)});
    if (!el) return false;
    el.click();
    return true;
  })()`);
  if (!res) throw new Error(`click failed: ${css}`);
}

async function shot(name: string): Promise<void> {
  try {
    const b64 = await wd<string>("GET", `/session/${sessionId}/screenshot`);
    await Deno.writeTextFile(join(SHOTS, `${name}.png`), b64);
    console.log(`  📸 ${name}.png`);
  } catch (e) {
    console.log(`  (screenshot failed ${name}: ${String(e).slice(0, 80)})`);
  }
}

async function handles(): Promise<string[]> {
  return await wd<string[]>("GET", `/session/${sessionId}/window/handles`);
}

async function switchTo(handle: string): Promise<void> {
  await wd("POST", `/session/${sessionId}/window`, { handle });
}

async function currentUrl(): Promise<string> {
  return await wd<string>("GET", `/session/${sessionId}/url`);
}

/** Find a tab whose URL contains the given fragment and switch to it. */
async function switchToUrl(substr: string): Promise<void> {
  for (const h of await handles()) {
    try {
      await switchTo(h);
      const u = await currentUrl();
      if (u.includes(substr)) return;
    } catch {
      // handle may be gone
    }
  }
  throw new Error(`no tab containing ${substr}`);
}

function isExtPage(url: string): boolean {
  return /^[a-z]+-extension:\/\//.test(url);
}

// ---- Native WebDriver element APIs (fallback channel for documents/pages
// whose execute/sync is refused, e.g. extension pages on official Firefox) ----
async function findEl(css: string): Promise<string | null> {
  const r = await fetch(`${DRIVER}/session/${sessionId}/element`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ using: "css selector", value: css }),
  });
  const j = await r.json().catch(() => null);
  const id = j?.value?.["element-6066-11e4-a52e-4f735466cecf"] ?? j?.value?.ELEMENT;
  return typeof id === "string" ? id : null;
}

async function elClick(elId: string): Promise<void> {
  const res = await fetch(`${DRIVER}/session/${sessionId}/element/${elId}/click`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(`element click failed: ${JSON.stringify(j).slice(0, 200)}`);
  }
}

// ---- main flow ----

await Deno.mkdir(SHOTS, { recursive: true });
// Fresh profile: rule out leftover storage state
await Deno.remove(PROFILE, { recursive: true }).catch(() => {});
await Deno.mkdir(PROFILE, { recursive: true });

console.log(`[e2e] starting WebDriver (${kind} → ${DRIVER_BIN})…`);
const driverArgs = kind === "chromium"
  ? [`--port=${DRIVER_PORT}`]
  : ["--port", String(DRIVER_PORT), "--allow-origins", DRIVER];
const driver = new Deno.Command(DRIVER_BIN, {
  args: driverArgs,
  stdout: "null",
  stderr: "null",
});
const driverProc = driver.spawn();

try {
  await poll(async () => {
    const r = await fetch(DRIVER + "/status").then((r) => r.json()).catch(() => null);
    return r?.value?.ready ? "ok" : null;
  }, 10000);

  console.log(`[e2e] creating session (${browserLabel ?? kind}, headless)…`);
  const capabilities = kind === "chromium"
    ? {
      alwaysMatch: {
        browserName: "chrome",
        "goog:chromeOptions": {
          binary: BROWSER_BIN,
          args: [
            "--headless=new",
            "--no-sandbox",
            `--user-data-dir=${PROFILE}`,
            `--load-extension=${EXT_DIR}`,
            "--no-first-run",
            "--no-default-browser-check",
          ],
        },
      },
    }
    : {
      alwaysMatch: {
        browserName: "firefox",
        "moz:firefoxOptions": {
          binary: BROWSER_BIN,
          args: ["-headless", "-profile", PROFILE],
          prefs: {
            "browser.shell.checkDefaultBrowser": false,
            "datareporting.policy.dataSubmissionEnabled": false,
          },
        },
      },
    };
  const sess = await wd<{ sessionId?: string }>("POST", "/session", { capabilities });
  sessionId = (sess as unknown as { sessionId: string }).sessionId ?? (sess as unknown as string);

  let addonId = "chromium-unpacked";
  if (kind === "firefox") {
    console.log("[e2e] installing extension temporarily…");
    addonId = await wd<string>("POST", `/session/${sessionId}/moz/addon/install`, {
      path: EXT_DIR,
      temporary: true,
    });
    console.log(`  addon id = ${addonId}`);

    // Temporary addons are not written to extensions.json; read the UUID from prefs.js
    const readUuidsPref = async (): Promise<Record<string, string> | null> => {
      try {
        const prefs = await Deno.readTextFile(join(PROFILE, "prefs.js"));
        const m = /"extensions\.webextensions\.uuids",\s*"(.*)"\);/.exec(prefs);
        if (!m) return null;
        return JSON.parse(m[1].replaceAll('\\"', '"')) as Record<string, string>;
      } catch {
        return null;
      }
    };
    let extUuid = (await readUuidsPref())?.[addonId] ?? null;
    if (!extUuid) {
      await go("https://example.com/").catch(() => {});
      extUuid = await poll(async () => (await readUuidsPref())?.[addonId] ?? null, 20000);
    }
    ok(!!extUuid, "extension UUID resolved", `uuid=${extUuid}`);
  }

  if (SUITE === "smoke") {
    console.log("[e2e] smoke suite…");
    await go(`${DEV}/demo-e2e.user.js?as=html`);
    await poll(
      async () => await exec<boolean>(`!!document.querySelector("div[style*='2147483647']")`),
      8000,
    );
    const beforeInstall = await handles();
    const bannerName = await exec<string>(
      `return document.querySelector("div[style*='2147483647']").shadowRoot.querySelector(".name")?.textContent ?? ""`,
    );
    ok(bannerName.includes("E2E"), "install banner detected (text/html wrap view)", bannerName);
    // Element API click on the banner install button → confirmation page (extension page)
    // → element API click on the confirm button (execute is refused on extension pages
    // by official Firefox; plain element APIs work)
    await clickShadowBanner();
    const installHandle = await poll(async () => {
      const now = await handles();
      return now.find((hh) => !beforeInstall.includes(hh)) ?? null;
    }, 8000);
    await switchTo(installHandle);
    await poll(async () => isExtPage(await currentUrl()), 8000);
    const confirmEl = await poll(async () => await findEl("#app button.primary"), 8000);
    ok(!!confirmEl, "install confirmation button located (element API)");
    if (confirmEl) await elClick(confirmEl);
    await sleep(1000);
    // The install page may close itself: switch back to the first tab and assert injection
    await switchTo((await handles())[0]).catch(() => {});
    await go("https://example.com/");
    const smoke = await poll(async () => {
      return await exec<string>(
        `return JSON.stringify({ ready: !!window.__infinRunnerReady, demo: !!document.getElementById("infin-demo") })`,
      );
    }, 25000).catch(() => null);
    const parsed = JSON.parse(smoke ?? "{}") as { ready: boolean; demo: boolean };
    ok(parsed.ready === true, "runner injected (MAIN world)", smoke ?? "");
    ok(parsed.demo === true, "user script executed", smoke ?? "");
    await shot("90-smoke");
    const failed = failures.length > 0;
    console.log(`\n[e2e] result: ${passed} passed, ${failed} failed`);
    if (sessionId) await wd("DELETE", `/session/${sessionId}`).catch(() => {});
    try {
      driverProc.kill();
    } catch {
      // process may have exited already
    }
    if (failed) {
      for (const f of failures) console.log(`  ✗ ${f}`);
      Deno.exit(1);
    }
    Deno.exit(0);
  }

  // ---- 1. banner → install confirmation page → install ----
  console.log("[e2e] 1. install E2E script via banner…");
  await go(`${DEV}/demo-e2e.user.js?as=html`);
  await poll(async () => {
    const found = await exec<boolean>(`!!document.querySelector("div[style*='2147483647']")`);
    return found;
  }, 8000);
  const bannerName = await exec<string>(
    `return document.querySelector("div[style*='2147483647']").shadowRoot.querySelector(".name")?.textContent ?? ""`,
  );
  ok(bannerName.includes("E2E"), "banner parsed the script name", bannerName);
  await shot("01-banner");
  const beforeInstall = await handles();
  await clickShadowBanner();

  // The install page opens in a new (extension) tab; wait for the new handle
  const installHandle = await poll(async () => {
    const now = await handles();
    return now.find((hh) => !beforeInstall.includes(hh)) ?? null;
  }, 8000);
  await switchTo(installHandle);
  await poll(async () => isExtPage(await currentUrl()), 8000);
  await waitText("#app .card h1", 8000);
  const installName = await textOf("#app .card h1");
  ok(installName.includes("E2E"), "install page metadata name", installName);
  const grid = await textOf("#app .grid");
  ok(grid.includes("GM_xmlhttpRequest"), "install page shows grant list");
  ok(grid.includes("document-end"), "install page shows run-at");
  ok(grid.includes("本地映射"), "install page detects dev server origin");
  await shot("02-install-page");
  await clickEl("button.primary");
  await sleep(800);
  console.log("  ✓ install clicked");

  // ---- 2. injection on example.com ----
  console.log("[e2e] 2. injection on example.com…");
  await switchTo((await handles())[0]); // install page may have closed itself
  await go("https://example.com/");
  const demoText = await waitText("#infin-demo", 12000);
  ok(demoText.includes("MARKER-A"), "user script injected (MAIN world)", demoText);
  ok(demoText.includes("visits=1"), "GM_getValue/GM_setValue storage works", demoText);
  const pos = await exec<string>(
    `return getComputedStyle(document.getElementById("infin-demo")).position`,
  );
  ok(pos === "fixed", "GM_addStyle works", pos);
  await shot("03-example-injected");

  // ---- 3. GM_xmlhttpRequest (localhost, no grant needed) ----
  console.log("[e2e] 3. GM_xmlhttpRequest / clipboard…");
  await clickEl("#infin-btn-xhr");
  const xhrOut = await waitText("#infin-e2e-out", 10000);
  ok(xhrOut.startsWith("xhr-ok:200"), "GM_xmlhttpRequest local request", xhrOut);

  await exec(`document.getElementById("infin-e2e-out").textContent = ""`);
  await clickEl("#infin-btn-clip");
  const clipOut = await waitText("#infin-e2e-out", 6000);
  ok(clipOut === "clip-ok", "GM_setClipboard", clipOut);

  // ---- 4. strict @connect authorization prompt ----
  console.log("[e2e] 4. @connect authorization prompt…");
  await clickEl("#infin-btn-remote");
  try {
    const before = await handles();
    const newHandle = await poll(async () => {
      const now = await handles();
      return now.find((hh) => !before.includes(hh)) ?? null;
    }, 8000);
    await switchTo(newHandle);
    const domainShown = await waitText("#domain", 5000);
    ok(domainShown === "example.net", "auth window shows target domain", domainShown);
    await shot("04-connect-auth");
    await clickEl("#always");
    await sleep(800);
    await switchTo(before[0]);
    const remoteOut = await poll(async () => {
      const t = await textOf("#infin-e2e-out");
      return t.startsWith("remote-") ? t : null;
    }, 12000);
    ok(remoteOut.startsWith("remote-ok:"), "request allowed after @connect grant", remoteOut);
  } catch (e) {
    ok(false, "@connect authorization prompt flow", String(e).slice(0, 150));
    await switchTo((await handles())[0]).catch(() => {});
  }

  // ---- 5. dev mapping + hot reload (via the options page) ----
  console.log("[e2e] 5. dev mapping hot reload…");
  // Re-open the install page just to click "管理面板" (no duplicate install: install is not clicked)
  await go(`${DEV}/demo-e2e.user.js?as=html`);
  await poll(
    async () => await exec<boolean>(`!!document.querySelector("div[style*='2147483647']")`),
    8000,
  );
  const beforeOpt = await handles();
  await clickShadowBanner();
  const optHandle = await poll(async () => {
    const now = await handles();
    return now.find((hh) => !beforeOpt.includes(hh)) ?? null;
  }, 8000);
  await switchTo(optHandle);
  await poll(async () => isExtPage(await currentUrl()), 8000);
  await waitText("#app .card", 8000);
  const beforeNav = await handles();
  await clickEl(".btns button:nth-child(3)"); // "管理面板"
  const navHandle = await poll(async () => {
    const now = await handles();
    return now.find((hh) => !beforeNav.includes(hh)) ?? null;
  }, 8000);
  await switchTo(navHandle);
  await poll(async () => (await currentUrl()).includes("/options/index.html"), 8000);
  ok(
    (await currentUrl()).includes("/options/index.html"),
    "options page opened",
    await currentUrl(),
  );

  // Edit the script: switch to local mapping
  await poll(
    async () => await exec<boolean>(`!!document.querySelector(".entry .acts button")`),
    6000,
  );
  await clickEl(".entry .acts button"); // edit
  await poll(
    async () =>
      await exec<boolean>(
        `!document.getElementById("view-editor").hidden && document.getElementById("ed-name").textContent.includes("E2E")`,
      ),
    8000,
  );
  await exec(`(() => {
    document.getElementById("ed-dev-url").value = "${DEV}/demo-e2e.user.js";
    const radio = document.querySelector('input[name="ed-src"][value="dev"]');
    radio.click();
    radio.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await sleep(800);
  const devChecked = await exec<boolean>(
    `return !!document.querySelector('input[name="ed-src"][value="dev"]:checked')`,
  );
  ok(devChecked, "script switched to local mapping");

  const e2ePath = join(ROOT, "examples/demo-e2e.user.js");
  const original = await Deno.readTextFile(e2ePath);
  await Deno.writeTextFile(
    e2ePath,
    original.replace(/MARKER-A/g, "MARKER-B").replace("@version      1.0.0", "@version      1.1.0"),
  );
  try {
    console.log("  waiting for dev server push + auto reload…");
    await switchTo((await handles())[0]); // example.com tab
    await go("https://example.com/");
    const newText = await poll(
      async () => {
        const t = await textOf("#infin-demo").catch(() => "");
        return t.includes("MARKER-B") ? t : null;
      },
      25000,
      800,
    );
    ok(newText.includes("MARKER-B"), "file save → push → auto reload → new code ran", newText);
  } finally {
    await Deno.writeTextFile(e2ePath, original);
  }
  await shot("05-hot-reload");

  // ---- 6. user style ----
  console.log("[e2e] 6. user style…");
  await switchToUrl("/options/index.html");
  await poll(async () => await exec<boolean>(`!!document.querySelector("#nav")`), 8000);
  await clickEl("#nav button[data-view='styles']");
  await sleep(300);
  await clickEl("#add-style");
  // Wait until the editor actually loaded the new style entry (not a stale editor state)
  await poll(
    async () => {
      const st = await exec<string>(
        `return JSON.stringify({ hidden: document.getElementById("view-editor").hidden, name: document.getElementById("ed-name")?.textContent ?? null })`,
      );
      const parsed = JSON.parse(st) as { hidden: boolean; name: string | null };
      if (!parsed.hidden && parsed.name) return true;
      console.log("  [dbg] editor state:", st);
      return false;
    },
    10000,
  );
  // Fill + save atomically so a late fillEditor cannot clobber the value.
  // Zen kernel quirk: extension-page → background messages are intermittently
  // dropped, so the save click is retried and the effect is asserted on the
  // content page (example.com), not via extension-page messaging.
  const styleCss =
    '/* ==UserStyle==\n@name         E2E 样式\n@namespace    infinmonkey.e2e\n@version      1.0.0\n==/UserStyle== */\n\n@-moz-document domain("example.com") {\n  body { background: #101014 !important; }\n}\n';
  await exec(
    `(() => {
    if (!document.getElementById("ed-name").textContent.includes("新样式")) return "stale";
    const ta = document.getElementById("ed-code");
    ta.value = arguments[0];
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("ed-save").click();
    return "saved";
  })()`,
    [styleCss],
  );
  await sleep(1500);

  let styleOk = false;
  for (let round = 0; round < 3 && !styleOk; round++) {
    await switchToUrl("example.com");
    await go("https://example.com/");
    const demoHit = await poll(
      async () => {
        const st = await exec<string>(
          `return JSON.stringify({ demo: !!document.getElementById("infin-demo"), bg: getComputedStyle(document.body).backgroundColor })`,
        );
        const parsed = JSON.parse(st) as { demo: boolean; bg: string };
        return parsed.demo ? st : null;
      },
      15000,
      800,
    );
    const parsed = JSON.parse(demoHit) as { bg: string };
    styleOk = parsed.bg === "rgb(16, 16, 20)";
    if (!styleOk && round < 2) {
      // 回 options 重新点一次保存（点击本身可能落在内核丢包窗口里）
      await switchToUrl("/options/index.html");
      await poll(async () => await exec<boolean>(`!!document.querySelector("#nav")`), 8000);
      await switchToUrl("/options/index.html");
      await clickEl("#ed-save");
      await sleep(1500);
    }
  }
  ok(styleOk, "user style @-moz-document scoped injection");
  await shot("06-style-applied");
  await shot("06-style-applied");
} catch (e) {
  failures.push(`main flow error: ${String(e).slice(0, 300)}`);
  console.error("[e2e] main flow error:", e);
  try {
    await shot("99-error");
  } catch {
    // ignore
  }
} finally {
  if (sessionId) await wd("DELETE", `/session/${sessionId}`).catch(() => {});
  try {
    driverProc.kill();
  } catch {
    // process may have exited already
  }
}

console.log(`\n[e2e] result: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  Deno.exit(1);
}
