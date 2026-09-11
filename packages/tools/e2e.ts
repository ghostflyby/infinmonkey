/**
 * InfinMonkey E2E：WebDriver 冒烟/全量（Firefox 系=geckodriver，Chromium 系=chromedriver）。
 * 前置：对应 dist 已构建（dist/firefox 或 dist/chrome）；dev server 运行于 127.0.0.1:17321。
 * 用法：deno run -A packages/tools/e2e.ts [--browser <名>] [--suite smoke|full]
 *   --browser 走 browsers.ts 解析（CLI > INFIN_BROWSER > .browsers.local.json > zen），
 *   驱动可执行文件取条目 driver 字段，缺省按内核类型取 PATH 上的 geckodriver/chromedriver。
 *   --suite smoke 只跑安装链路 + 注入核心（CI Firefox 腿），full 追加 GM_xhr/剪贴板。
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
  } catch { /* 非 JSON 响应原样进错误信息 */ }
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

/** 轮询 execute 直到真值或超时（页面未加载完/元素未出现时 WebDriver 会抛错，一并重试；
 * false/'' 视为未就绪继续等——横幅这类「出现型」断言在 load 完成后可能晚几百 ms 才生效）。 */
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
  console.error(`[e2e] 未知 --suite "${suite}"（可选 smoke | full）`);
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
} catch { /* 不存在 */ }
await Deno.mkdir(PROFILE, { recursive: true });

let driverLog: Deno.FsFile | undefined;
try {
  driverLog = await Deno.open(join(SHOTS, "driver.log"), {
    write: true,
    create: true,
    truncate: true,
  });
} catch { /* 截图目录都能建，这里失败就用 null */ }

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
    // 排空 stderr 落盘（driver 启动失败的根因只在这里），会话结束随进程终止
    void proc.stderr.pipeTo(driverLog.writable).catch(() => {});
  } else {
    void proc.stderr.cancel().catch(() => {});
  }
}

// 等 driver 就绪（替代盲等，就绪判断走 WebDriver /status）
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
    } catch { /* 未监听，重试 */ }
    await sleep(200);
  }
  if (!up) {
    console.error(`[e2e] ${driverBin} 未在 ${BASE} 就绪`);
    Deno.exit(1);
  }
}

try {
  console.log("[e2e] session…");
  const caps = kind === "firefox"
    ? {
      // profile 交给 geckodriver 建一次性临时 profile（CI 的 snap Firefox 读不了隐藏目录）
      alwaysMatch: {
        browserName: "firefox",
        "moz:firefoxOptions": { binary: cfg.binary, args: ["-headless"] },
      },
    }
    : {
      // 新无头模式才支持扩展；-disable-extensions-except 保证只有被测扩展
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
  if (!sid) throw new Error("session 响应无 sessionId");

  if (kind === "firefox") {
    console.log("[e2e] addon install…");
    await wd("POST", "/session/" + sid + "/moz/addon/install", {
      path: distDir,
      temporary: true,
    });
  }

  // ---- 1. Banner install ----
  console.log("[e2e] 1. banner install…");
  // ?as=html：官方 Firefox 拒绝对 text/plain 文档 execute，走 dev server 的 html 包裹视图
  await nav(DEV + "/demo-e2e.user.js?as=html");
  const banner = await poll(10000, "return !!document.querySelector(\"div[style*='2147483647']\")");
  ok(banner === true, "install banner shown");
  await screenshot("01-banner");

  // Click install (shadow DOM, open mode)
  await exec(
    "document.querySelector(\"div[style*='2147483647']\")?.shadowRoot?.querySelector('.install')?.click()",
  );
  // 安装结果直接读横幅回显（✓ 已安装 / 安装失败：<原因>）；横幅 3s 后自毁，轮询窗口要短
  const doneT = await poll(
    5000,
    `return document.querySelector("div[style*='2147483647']")?.shadowRoot?.querySelector('.done')?.textContent ?? ''`,
  );
  ok(
    typeof doneT === "string" && doneT.includes("已安装"),
    "banner install persisted",
    String(doneT),
  );
  await sleep(2000);

  // ---- 2. example.com: injection + GM ----
  console.log("[e2e] 2. example.com…");
  await nav("https://example.com/");
  const r = await poll(
    20000,
    // 门控：demo 元素出现前返回空串（falsy 让 poll 继续等），出现后一次性回传全部观感
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
    } catch { /* 注入超时 */ }
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
