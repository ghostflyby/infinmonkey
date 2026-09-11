/**
 * InfinMonkey 端到端验证：geckodriver 驱动 Zen（Firefox 内核）。
 *
 * 前置：deno task build:firefox；deno task devserver（127.0.0.1:17321 提供 examples/）。
 * 运行：deno run -A tools/e2e.ts
 *
 * 说明：WebDriver 禁止直接导航到 moz-extension:// URL，因此全部走真实用户路径：
 * .user.js 页安装横幅（open shadow DOM）→ 安装确认页 → 「管理面板」进入 options。
 *
 * 覆盖：临时安装扩展 → 横幅安装脚本 → 确认页元数据 → example.com 注入（DOM/存储/addStyle）
 * → GM_xmlhttpRequest（本地 + @connect 授权弹窗）→ GM_setClipboard → dev 映射热更新
 * → 用户样式注入。
 */
import { dirname, fromFileUrl, join } from "@std/path";

const ROOT = join(dirname(fromFileUrl(import.meta.url)), "..", "..");
const DRIVER = "http://127.0.0.1:4444";
const ZEN_BIN = "/Applications/Zen.app/Contents/MacOS/zen";
const PROFILE = join(ROOT, ".webext/e2e-profile");
const ADDON_DIR = join(ROOT, "dist/firefox");
const SHOTS = join(ROOT, ".e2e");
const DEV = "http://127.0.0.1:17321";

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
    `poll 超时 ${timeoutMs}ms${lastErr ? `（最后错误: ${String(lastErr).slice(0, 160)}）` : ""}`,
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

/** 横幅位于 open shadow root 里，直接 JS 点击。 */
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
  if (!res) throw new Error(`点击失败: ${css}`);
}

async function shot(name: string): Promise<void> {
  try {
    const b64 = await wd<string>("GET", `/session/${sessionId}/screenshot`);
    await Deno.writeTextFile(join(SHOTS, `${name}.png`), b64);
    console.log(`  📸 ${name}.png`);
  } catch (e) {
    console.log(`  （截图失败 ${name}: ${String(e).slice(0, 80)}）`);
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

/** 按 URL 片段找到对应标签页句柄并切换。 */
async function switchToUrl(substr: string): Promise<void> {
  for (const h of await handles()) {
    try {
      await switchTo(h);
      const u = await currentUrl();
      if (u.includes(substr)) return;
    } catch {
      // 句柄可能已销毁
    }
  }
  throw new Error(`未找到包含 ${substr} 的标签页`);
}

// ---- 主流程 ----

await Deno.mkdir(SHOTS, { recursive: true });
// 全新 profile：排除历史存储干扰
await Deno.remove(PROFILE, { recursive: true }).catch(() => {});
await Deno.mkdir(PROFILE, { recursive: true });

console.log("[e2e] 启动 geckodriver…");
const driver = new Deno.Command("geckodriver", {
  args: ["--port", "4444", "--allow-origins", DRIVER],
  stdout: "null",
  stderr: "null",
});
const driverProc = driver.spawn();

try {
  await poll(async () => {
    const r = await fetch(DRIVER + "/status").then((r) => r.json()).catch(() => null);
    return r?.value?.ready ? "ok" : null;
  }, 10000);

  console.log("[e2e] 创建会话（Zen 无头）…");
  const sess = await wd<{ sessionId?: string }>("POST", "/session", {
    capabilities: {
      alwaysMatch: {
        browserName: "firefox",
        "moz:firefoxOptions": {
          binary: ZEN_BIN,
          args: ["-headless", "-profile", PROFILE],
          prefs: {
            "browser.shell.checkDefaultBrowser": false,
            "datareporting.policy.dataSubmissionEnabled": false,
          },
        },
      },
    },
  });
  sessionId = (sess as unknown as { sessionId: string }).sessionId ?? (sess as unknown as string);

  console.log("[e2e] 临时安装扩展…");
  const addonId = await wd<string>("POST", `/session/${sessionId}/moz/addon/install`, {
    path: ADDON_DIR,
    temporary: true,
  });
  console.log(`  addon id = ${addonId}`);

  // 临时安装的扩展不写入 extensions.json，从 prefs.js 的 extensions.webextensions.uuids 取
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
  ok(!!extUuid, "获取扩展 UUID", `uuid=${extUuid}`);

  // ---- 1. 安装横幅 → 安装确认页 → 装入 ----
  console.log("[e2e] 1. 横幅安装 E2E 脚本…");
  await go(`${DEV}/demo-e2e.user.js`);
  await poll(async () => {
    const found = await exec<boolean>(`!!document.querySelector("div[style*='2147483647']")`);
    return found;
  }, 8000);
  const bannerName = await exec<string>(
    `return document.querySelector("div[style*='2147483647']").shadowRoot.querySelector(".name")?.textContent ?? ""`,
  );
  ok(bannerName.includes("E2E 验证脚本"), "横幅解析出脚本名", bannerName);
  await shot("01-banner");
  const beforeInstall = await handles();
  await clickShadowBanner();

  // 安装页是新开标签页（扩展页），等待新句柄出现后切换
  const installHandle = await poll(async () => {
    const now = await handles();
    return now.find((hh) => !beforeInstall.includes(hh)) ?? null;
  }, 8000);
  await switchTo(installHandle);
  await poll(async () => (await currentUrl()).startsWith("moz-extension://"), 8000);
  await waitText("#app .card h1", 8000);
  const installName = await textOf("#app .card h1");
  ok(installName.includes("E2E 验证脚本"), "安装页元数据名称", installName);
  const grid = await textOf("#app .grid");
  ok(grid.includes("GM_xmlhttpRequest"), "安装页展示授权列表");
  ok(grid.includes("document-end"), "安装页展示运行时机");
  ok(grid.includes("本地映射"), "安装页识别 dev server 来源");
  await shot("02-install-page");
  await clickEl("button.primary");
  await sleep(800);
  console.log("  ✓ 已点击安装");

  // ---- 2. example.com 注入验证 ----
  console.log("[e2e] 2. example.com 注入…");
  await switchTo((await handles())[0]); // 安装页可能已自动关闭，回到首个标签页
  await go("https://example.com/");
  const demoText = await waitText("#infin-demo", 12000);
  ok(demoText.includes("MARKER-A"), "用户脚本已注入（MAIN world）", demoText);
  ok(demoText.includes("visits=1"), "GM_getValue/GM_setValue 存储生效", demoText);
  const pos = await exec<string>(
    `return getComputedStyle(document.getElementById("infin-demo")).position`,
  );
  ok(pos === "fixed", "GM_addStyle 生效", pos);
  await shot("03-example-injected");

  // ---- 3. GM_xmlhttpRequest（本地回环免授权） ----
  console.log("[e2e] 3. GM_xmlhttpRequest / 剪贴板…");
  await clickEl("#infin-btn-xhr");
  const xhrOut = await waitText("#infin-e2e-out", 10000);
  ok(xhrOut.startsWith("xhr-ok:200"), "GM_xmlhttpRequest 本地请求", xhrOut);

  await exec(`document.getElementById("infin-e2e-out").textContent = ""`);
  await clickEl("#infin-btn-clip");
  const clipOut = await waitText("#infin-e2e-out", 6000);
  ok(clipOut === "clip-ok", "GM_setClipboard", clipOut);

  // ---- 4. @connect 严格授权弹窗 ----
  console.log("[e2e] 4. @connect 授权弹窗…");
  await clickEl("#infin-btn-remote");
  try {
    const before = await handles();
    const newHandle = await poll(async () => {
      const now = await handles();
      return now.find((hh) => !before.includes(hh)) ?? null;
    }, 8000);
    await switchTo(newHandle);
    const domainShown = await waitText("#domain", 5000);
    ok(domainShown === "example.net", "授权窗口显示目标域名", domainShown);
    await shot("04-connect-auth");
    await clickEl("#always");
    await sleep(800);
    await switchTo(before[0]);
    const remoteOut = await poll(async () => {
      const t = await textOf("#infin-e2e-out");
      return t.startsWith("remote-") ? t : null;
    }, 12000);
    ok(remoteOut.startsWith("remote-ok:"), "@connect 允许后请求放行", remoteOut);
  } catch (e) {
    ok(false, "@connect 授权弹窗流程", String(e).slice(0, 150));
    await switchTo((await handles())[0]).catch(() => {});
  }

  // ---- 5. dev 映射 + 热更新（走 options 面板） ----
  console.log("[e2e] 5. dev 映射热更新…");
  // 重新拉起安装页只为点「管理面板」（不会重复安装：不点安装按钮）
  await go(`${DEV}/demo-e2e.user.js`);
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
  await poll(async () => (await currentUrl()).startsWith("moz-extension://"), 8000);
  await waitText("#app .card", 8000);
  const beforeNav = await handles();
  await clickEl(".btns button:nth-child(3)"); // 「管理面板」
  const navHandle = await poll(async () => {
    const now = await handles();
    const fresh = now.find((hh) => !beforeNav.includes(hh));
    return fresh ?? null;
  }, 8000);
  await switchTo(navHandle);
  await poll(async () => (await currentUrl()).includes("/options/index.html"), 8000);
  ok((await currentUrl()).includes("/options/index.html"), "管理面板已打开", await currentUrl());

  // 编辑脚本：设置本地映射
  await poll(
    async () => await exec<boolean>(`!!document.querySelector(".entry .acts button")`),
    6000,
  );
  await clickEl(".entry .acts button"); // 编辑
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
  ok(devChecked, "脚本已切换为本地映射");

  const e2ePath = join(ROOT, "examples/demo-e2e.user.js");
  const original = await Deno.readTextFile(e2ePath);
  await Deno.writeTextFile(
    e2ePath,
    original.replace(/MARKER-A/g, "MARKER-B").replace("@version      1.0.0", "@version      1.1.0"),
  );
  try {
    console.log("  等待 dev server 推送 + 自动刷新…");
    await switchTo((await handles())[0]); // example.com 标签页
    await go("https://example.com/");
    const newText = await poll(
      async () => {
        const t = await textOf("#infin-demo").catch(() => "");
        return t.includes("MARKER-B") ? t : null;
      },
      25000,
      800,
    );
    ok(newText.includes("MARKER-B"), "文件保存 → 推送 → 自动刷新 → 新代码运行", newText);
  } finally {
    await Deno.writeTextFile(e2ePath, original);
  }
  await shot("05-hot-reload");

  // ---- 6. 用户样式 ----
  console.log("[e2e] 6. 用户样式…");
  await switchToUrl("/options/index.html");
  await poll(async () => await exec<boolean>(`!!document.querySelector("#nav")`), 8000);
  await clickEl("#nav button[data-view='styles']");
  await sleep(300);
  await clickEl("#add-style");
  // 等编辑器真正载入新建的样式条目（而非遗留编辑态）
  await poll(
    async () =>
      await exec<boolean>(
        `!document.getElementById("view-editor").hidden && document.getElementById("ed-name").textContent.includes("新样式")`,
      ),
    10000,
  );
  // 填值 + 保存原子执行，避免异步 fillEditor 覆盖；执行时校验编辑器确实是目标条目
  await exec(
    `(() => {
    if (!document.getElementById("ed-name").textContent.includes("E2E 样式")) return "stale";
    const ta = document.getElementById("ed-code");
    ta.value = arguments[0];
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("ed-save").click();
    return "saved";
  })()`,
    [
      '/* ==UserStyle==\n@name         E2E 样式\n@namespace    infinmonkey.e2e\n@version      1.0.0\n==/UserStyle== */\n\n@-moz-document domain("example.com") {\n  body { background: #101014 !important; }\n}\n',
    ],
  );
  await sleep(2500);
  const msgProbe = await wd<string>("POST", `/session/${sessionId}/execute/async`, {
    script: `const [d] = arguments; (async () => {
      const t = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r('HANG'), 5000))]);
      const out = {};
      out.ping = await t(browser.runtime.sendMessage({type:'ping'}).then(r => 'ok'), 5000);
      out.list = await t(browser.runtime.sendMessage({type:'ListEntries'}).then(r => 'ok'), 5000);
      out.save = await t(browser.runtime.sendMessage({type:'SaveCode', id: (await browser.runtime.sendMessage({type:'ListEntries'})).styles[0].id, code: '/* ==UserStyle== */ body{background:#101014 !important;}'}).then(r => 'ok:' + JSON.stringify(r).slice(0, 40)).catch(e => 'rej:' + e.message), 6000);
      d(JSON.stringify(out));
    })().catch(e => d('err:' + e.message));`,
    args: [],
  });
  console.log("  消息探针:", msgProbe);
  console.log(
    "  保存诊断:",
    JSON.stringify(await exec<unknown>(`return window.__imDebug ? window.__imDebug() : "-"`)),
    JSON.stringify(
      await wd<string>("POST", `/session/${sessionId}/execute/async`, {
        script:
          `const [d] = arguments; browser.storage.local.get(["imUpd"]).then(r => d(r.imUpd ?? "none")).catch(e => d("e:" + e.message));`,
        args: [],
      }),
    ),
  );
  // 等待保存落库（内核消息可能延迟送达）
  const savedCode = await poll(
    async () => {
      const r = await wd<string>("POST", `/session/${sessionId}/execute/async`, {
        script:
          `const [d] = arguments; browser.runtime.sendMessage({type:"ListEntries"}).then(r => d(JSON.stringify((r.styles||[]).map(s => s.code.slice(0, 60))))).catch(e => d("err:" + e.message));`,
        args: [],
      });
      return r.includes("#101014") ? r : null;
    },
    60000,
    1500,
  );
  ok(savedCode.includes("#101014"), "编辑器保存落库", savedCode);
  console.log(
    "  保存诊断:",
    JSON.stringify(await exec<unknown>(`return window.__imDebug ? window.__imDebug() : "-"`)),
    JSON.stringify(
      await wd<string>("POST", `/session/${sessionId}/execute/async`, {
        script:
          `const [d] = arguments; browser.storage.local.get(["imUpd"]).then(r => d(r.imUpd ?? "none")).catch(e => d("e:" + e.message));`,
        args: [],
      }),
    ),
  );

  // 双通道核对：直接读 storage
  const rawStore = await wd<string>("POST", `/session/${sessionId}/execute/async`, {
    script:
      `const [d] = arguments; browser.storage.local.get(null).then(r => d(JSON.stringify({ styles: (r.styles||[]).map(s => s.code.slice(0, 50)) }))).catch(e => d("err:" + e.message));`,
    args: [],
  });
  console.log("  storage 直读:", rawStore);

  // 回到 example.com 做样式断言（带诊断，失败不中断后续）
  let styleOk = false;
  try {
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
    ok(styleOk, "用户样式 @-moz-document 作用域注入", demoHit);
  } catch (e) {
    const st = await exec<string>(
      `return JSON.stringify({ url: location.href, ready: !!window.__infinRunnerReady, demo: !!document.getElementById("infin-demo"), demoText: (document.getElementById("infin-demo")?.textContent ?? "").slice(0, 40), styles: Array.from(document.querySelectorAll("style[data-infin-style]")).length })`,
    ).catch((ee) => "exec-err:" + String(ee).slice(0, 80));
    let entries = "n/a";
    for (const h of await handles()) {
      try {
        await switchTo(h);
        const u = await currentUrl();
        if (u.includes("/options/") || u.includes("/install/")) {
          entries = await wd<string>("POST", `/session/${sessionId}/execute/async`, {
            script:
              `const [d] = arguments; browser.runtime.sendMessage({type:"ListEntries"}).then(r => d(JSON.stringify(r.scripts.map(s => ({ on: s.enabled, m: s.meta.matches, src: s.source.type, code: s.code.slice(0, 30) }))))).catch(e => d("err:" + e.message));`,
            args: [],
          });
          await switchToUrl("example.com");
          break;
        }
      } catch {
        // 跳过失效句柄
      }
    }
    ok(
      styleOk,
      "用户样式 @-moz-document 作用域注入",
      `${String(e).slice(0, 80)} state=${st} entries=${entries}`,
    );
  }
  await shot("06-style-applied");
} catch (e) {
  failures.push(`主流程异常: ${String(e).slice(0, 300)}`);
  console.error("[e2e] 主流程异常:", e);
  try {
    // 从扩展页读后台诊断
    for (const h of await handles()) {
      try {
        await switchTo(h);
        const u = await currentUrl();
        if (u.includes("/options/") || u.includes("/install/")) {
          const err = await wd<string>("POST", `/session/${sessionId}/execute/async`, {
            script:
              `const [d] = arguments; browser.storage.local.get("imLastError").then(r => d(r.imLastError ?? "none")).catch(e => d("e:" + e.message));`,
            args: [],
          });
          console.log("  imLastError:", err);
          break;
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  try {
    await shot("99-error");
  } catch {
    // ignore
  }
} finally {
  if (sessionId) await wd("DELETE", `/session/${sessionId}`).catch(() => {});
  driverProc.kill();
}

console.log(`\n[e2e] 结果: ${passed} 通过, ${failures.length} 失败`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  Deno.exit(1);
}
