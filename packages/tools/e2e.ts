/**
 * InfinMonkey E2E: WebDriver smoke/full suites (Firefox family=geckodriver, Chromium family=chromedriver).
 * Prerequisites: the matching dist built (dist/firefox or dist/chrome); dev server running on 127.0.0.1:17321.
 * Usage: deno run -A packages/tools/e2e.ts [--browser <name>] [--suite smoke|full]
 *   --browser resolves via browsers.ts (CLI > INFIN_BROWSER > .browsers.local.json > zen),
 *   the driver executable comes from the entry's driver field, defaulting to geckodriver/chromedriver on PATH per engine kind.
 *   --suite smoke runs only the install flow + injection core (the CI Firefox leg); full adds GM_xhr/clipboard
 *   and the source-mapping assertions (@require splicing, sourceURL stack frames, error line mapping, and on
 *   Chromium a CDP pass: sourceMapURL registration + breakpoint resolution through the served map).
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
    const bytes = Uint8Array.fromBase64(b64 as string);
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
  // chromedriver exposes the DevTools endpoint here (W3C mode rejects later
  // session introspection, so this is the only place to get it).
  const chromeDebuggerAddress = (sess as {
    capabilities?: { "goog:chromeOptions"?: { debuggerAddress?: string } };
  }).capabilities?.["goog:chromeOptions"]?.debuggerAddress ?? "";

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
    `return document.getElementById('infin-demo') ? JSON.stringify({` +
      `t:document.getElementById('infin-demo').textContent.slice(0,40),` +
      `p:getComputedStyle(document.getElementById('infin-demo')).position,` +
      `b:document.documentElement.dataset.infinBridge??'',` +
      `r:document.documentElement.dataset.infinRunner??''}) : ''`,
  );
  let demoText = "";
  let injPos = "";
  let bridgeMark = "";
  let runnerTrail = "";
  let carrierInfo = "";
  if (typeof r === "string") {
    try {
      const o = JSON.parse(r) as { t: string; p: string; b?: string; r?: string };
      demoText = o.t;
      injPos = o.p;
      bridgeMark = o.b ?? "";
      runnerTrail = o.r ?? "";
    } catch { /* injection timed out */ }
  } else {
    // Poll timed out without injection: read the stage markers for diagnosis.
    // The payload-visibility probe runs in the page MAIN world, the same world
    // as the runner, so it shows whether a handoff channel failure is a write
    // problem (carrier absent/corrupt) or a discovery problem (carrier fine).
    const diag = await exec(
      `return JSON.stringify({` +
        `b:document.documentElement.dataset.infinBridge??'',` +
        `r:document.documentElement.dataset.infinRunner??'',` +
        `pay:(function(){var el=document.getElementById('infinmonkey-payload');` +
        `var ds=document.documentElement.dataset.infinPayload||'';` +
        `return 'el='+(el?('len='+el.textContent.length+' head='+el.textContent.slice(0,24)):'MISSING')+` +
        `' ds=len='+ds.length+' head='+ds.slice(0,24);})(),` +
        `scripts:[].map.call(document.querySelectorAll('script'),function(s){` +
        `return s.id?s.id+'#'+s.textContent.length:(s.type||'plain')+'#'+s.textContent.length;}).join(',')})`,
    ).catch(() => "");
    if (typeof diag === "string" && diag) {
      try {
        const o = JSON.parse(diag) as {
          b?: string;
          r?: string;
          pay?: string;
          scripts?: string;
        };
        bridgeMark = o.b ?? "";
        runnerTrail = o.r ?? "";
        carrierInfo = ` pay=${o.pay} scripts=${o.scripts}`;
      } catch { /* ignore */ }
    }
  }
  const inj = demoText.length > 0;
  ok(
    inj,
    "user script injected (MAIN world)",
    `${demoText} bridge=${bridgeMark} runner=${runnerTrail}${carrierInfo}`,
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

  if (!smoke) {
    // ---- 5. source mapping: @require splicing + sourceURL stack frames ----
    console.log("[e2e] 5. source mapping…");
    // Install both diag scripts through the banner flow (dev origin: direct
    // storage write; the scripts then run on every devserver page load).
    for (const f of ["e2e-diag.user.js", "e2e-diag-async.user.js"]) {
      await nav(`${DEV}/${f}?as=html`);
      await poll(10000, "return !!document.querySelector(\"div[style*='2147483647']\")");
      await exec(
        "document.querySelector(\"div[style*='2147483647']\")?.shadowRoot?.querySelector('.install')?.click()",
      );
      await poll(
        5000,
        `return document.querySelector("div[style*='2147483647']")?.shadowRoot?.querySelector('[data-infin-done]')?.dataset.infinDone ?? ''`,
      );
    }
    // Reload a diag page so both scripts run: the @require lib must define
    // the global, and the probe stack must carry the sourceURL frame name.
    await nav(`${DEV}/e2e-diag.user.js?as=html`);
    const requireMark = await poll(
      10000,
      "return document.documentElement.dataset.infinRequire ?? ''",
    );
    ok(requireMark === "loaded", "@require spliced and executed", String(requireMark));
    const stack = await poll(10000, "return document.documentElement.dataset.infinStack ?? ''");
    ok(
      typeof stack === "string" && stack.includes("InfinMonkey/e2e-diag.user.js:"),
      "sourceURL names engine stack frames",
      String(stack).slice(0, 90),
    );
    // Give the async script's 30ms timer + attribution + storage write time.
    await sleep(1500);

    // ---- 6. Chrome/CDP: source maps registered + breakpoints resolve ----
    if (kind === "chromium") {
      console.log("[e2e] 6. CDP source maps…");
      const da = chromeDebuggerAddress;
      ok(typeof da === "string" && da.length > 0, "CDP endpoint available", String(da));
      if (typeof da === "string" && da.length > 0) {
        const targets = await (await fetch(`http://${da}/json/list`)).json() as Array<{
          type: string;
          url: string;
          webSocketDebuggerUrl: string;
        }>;
        const page = targets.find((t) => t.type === "page" && t.url.includes("127.0.0.1:17321"));
        ok(!!page, "diag page target found");
        if (page) {
          const ws = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise<void>((res, rej) => {
            ws.onopen = () => res();
            ws.onerror = () => rej(new Error("cdp ws failed"));
          });
          let msgId = 0;
          const pending = new Map<number, (m: Record<string, unknown>) => void>();
          const parsed: Array<{ url: string; sourceMapURL?: string }> = [];
          ws.onmessage = (ev) => {
            const m = JSON.parse(ev.data as string) as {
              id?: number;
              method?: string;
              params?: Record<string, unknown>;
              error?: unknown;
              result?: Record<string, unknown>;
            };
            if (m.id && pending.has(m.id)) {
              pending.get(m.id)!(m);
              pending.delete(m.id);
            } else if (m.method === "Debugger.scriptParsed") {
              parsed.push({
                url: String(m.params?.url ?? ""),
                sourceMapURL: m.params?.sourceMapURL === undefined
                  ? undefined
                  : String(m.params.sourceMapURL),
              });
            }
          };
          const send = (method: string, params: Record<string, unknown> = {}) =>
            new Promise<Record<string, unknown>>((res, rej) => {
              const id = ++msgId;
              pending.set(
                id,
                (m) =>
                  m.error
                    ? rej(new Error(JSON.stringify(m.error)))
                    : res((m.result ?? {}) as Record<string, unknown>),
              );
              ws.send(JSON.stringify({ id, method, params }));
            });
          const withTimeout = <T>(p: Promise<T>, ms: number) =>
            Promise.race([
              p,
              new Promise<never>((_, rej) => setTimeout(() => rej(new Error("cdp timeout")), ms)),
            ]);
          try {
            // Debugger.enable replays scriptParsed for every script the page
            // already compiled — including the MAIN-world userscripts.
            await withTimeout(send("Debugger.enable"), 10000);
            await sleep(1000);
            const named = parsed.filter((sc) => sc.url.startsWith("InfinMonkey/"));
            ok(
              named.length > 0,
              "sourceURL scripts registered in the debugger",
              `${parsed.length} scripts parsed`,
            );
            const diag = named.find((sc) => sc.url.includes("e2e-diag.user.js"));
            // The runner merges immap=<prefix lines> into the mapped dev url,
            // which may carry its own query (the fixtures are installed via
            // the ?as=html view), so assert the shape, not the exact query.
            ok(
              !!diag && !!diag.sourceMapURL &&
                diag.sourceMapURL.startsWith(`${DEV}/e2e-diag.user.js`) &&
                diag.sourceMapURL.includes("immap="),
              "dev script sourceMapURL registered",
              diag?.sourceMapURL ?? "none",
            );
            // Source-map resolution lives in the DevTools FRONTEND — the raw
            // CDP Debugger domain never translates original positions. So
            // translate here: fetch the served map, find the generated line
            // it assigns to the original throw line, and prove the engine
            // accepts a breakpoint at exactly that position in the compiled
            // script (map content ↔ engine reality).
            const map = await (await fetch(diag!.sourceMapURL!)).json() as {
              sources: string[];
              sourcesContent: string[];
              mappings: string;
            };
            const raw = await (await fetch(`${DEV}/e2e-diag.user.js`)).text();
            ok(
              map.sources[0] === `${DEV}/e2e-diag.user.js` &&
                map.sourcesContent[0] === raw,
              "source map serves the pristine original",
            );
            // Decode the one-segment-per-line mappings: find the segment
            // whose source line is the throw (0-based 22) and take its
            // generated line (0-based).
            const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
            let genLine = -1;
            let src = 0;
            const genLines = map.mappings.split(";");
            for (let gl = 0; gl < genLines.length && genLine < 0; gl++) {
              for (const seg of genLines[gl].split(",")) {
                if (seg === "") continue;
                const fields: number[] = [];
                let rest = seg;
                while (rest.length > 0) {
                  let value = 0;
                  let shift = 0;
                  do {
                    const digit = B64URL.indexOf(rest[0]);
                    value += (digit & 31) << shift;
                    shift += 5;
                    rest = rest.slice(1);
                    if ((digit & 32) === 0) break;
                  } while (true);
                  fields.push(value & 1 ? -(value >> 1) : value >> 1);
                }
                src += fields[2];
                if (src === 22) genLine = gl;
                break;
              }
            }
            ok(genLine >= 0, "map maps the original throw line", `genLine=${genLine}`);
            const bp = await withTimeout(
              send("Debugger.setBreakpointByUrl", {
                urlRegex: "^InfinMonkey/e2e-diag\.user\.js$",
                lineNumber: genLine,
                columnNumber: 0,
              }),
              10000,
            ) as { locations?: unknown[] };
            ok(
              (bp.locations?.length ?? 0) > 0,
              "breakpoint resolves at the map-translated position in the compiled script",
              JSON.stringify(bp).slice(0, 200),
            );
          } catch (e) {
            ok(false, "CDP assertions", String(e));
          } finally {
            ws.close();
          }
        }
      }
    }

    // ---- 7. error line mapping through the extension-page channel ----
    console.log("[e2e] 7. error line mapping…");
    // The options page is an extension context: Firefox must be driven there
    // through the extension's own manage button (direct moz-extension
    // navigation is refused), and even then only the URL is readable — the
    // self-check reports its verdict plus the recorded error lines
    // (name:line) in the hash. Chromium can navigate to the extension page
    // directly (chromedriver allows chrome-extension:// schemes); the
    // extension id comes from the CDP target list (the background service
    // worker's url). tabs.create was observed to open nothing on headless
    // Chromium, so the manage-button route is Firefox-only.
    const extId = kind === "chromium"
      ? await (async () => {
        const da = chromeDebuggerAddress;
        if (!da) return "";
        const targets = await (await fetch(`http://${da}/json/list`)).json() as Array<{
          type: string;
          url: string;
        }>;
        const sw = targets.find((t) => t.url.startsWith("chrome-extension://"));
        return sw ? new URL(sw.url).host : "";
      })()
      : "";
    if (kind === "chromium") {
      ok(extId.length > 0, "extension id resolved from CDP targets", extId);
      if (extId) {
        await nav(`chrome-extension://${extId}/options/index.html#e2e`);
      }
    } else {
      await nav(`${DEV}/e2e-diag-async.user.js?as=html`);
      await poll(10000, "return !!document.querySelector(\"div[style*='2147483647']\")");
      await exec(
        "const h = document.querySelector(\"div[style*='2147483647']\");" +
          "h.dataset.infinOpenFragment = '#e2e';" +
          "h.shadowRoot.querySelector('.manage').click(); return 'ok'",
      );
      // tabs.create lands asynchronously: poll for the new handle instead of
      // reading once (observed racing the click on headless Chromium).
      let other = "";
      const dl = Date.now() + 15000;
      while (Date.now() < dl && !other) {
        const handles = await wd("GET", `/session/${sid}/window/handles`).catch(
          () => [],
        ) as string[];
        const current = await wd("GET", `/session/${sid}/window`).catch(() => "") as string;
        other = (handles as string[]).find((h) => h !== current) ?? "";
        if (!other) await sleep(500);
      }
      if (!other) {
        ok(false, "options tab opened", "no second window handle");
      } else {
        await wd("POST", `/session/${sid}/window`, { handle: other });
      }
    }
    let verdict = "";
    {
      const dl = Date.now() + 120000;
      while (Date.now() < dl) {
        const u = await wd("GET", `/session/${sid}/url`).catch(() => "");
        const h = typeof u === "string" && u.includes("#e2e:")
          ? decodeURIComponent(u.split("#")[1])
          : "";
        if (h.includes("e2e:pass") || h.includes("e2e:fail")) {
          verdict = h;
          break;
        }
        await sleep(1000);
      }
    }
    // The err= segment trails the (long) self-check verdict — show it whole
    // in failure details, the 200-char slice would cut it off.
    const errPart = verdict.includes(" err=")
      ? "err=" + verdict.split(" err=")[1]
      : "no err= segment";
    ok(
      verdict.includes("e2e-diag:23"),
      "sync error maps to its source line",
      errPart,
    );
    ok(
      verdict.includes("e2e-diag-async:11"),
      "async error attributed to its source line",
      errPart,
    );
    ok(verdict.includes("e2e:pass"), "worker self-check still passes", verdict.slice(0, 140));
    await screenshot("07-error-lines");
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
