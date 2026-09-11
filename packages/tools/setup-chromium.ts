/**
 * Chromium 系 CI/本地装配：从 Chrome for Testing 下载「Chrome + chromedriver」
 * 同版本配对（known-good 最新），解包到 .webext/，并写入 .browsers.local.json
 * 的 "cft" 条目。一次性 runner 环境的标配步骤；本机使用同样适用。
 *
 * 用法：deno run -A packages/tools/setup-chromium.ts
 * 支持：linux64 / mac-arm64 / mac-x64（CfT 官方发布平台）。
 */
import { dirname, fromFileUrl, join } from "@std/path";

const ROOT = join(dirname(fromFileUrl(import.meta.url)), "..", "..");
const DRIVERS = join(ROOT, ".webext/drivers");
const BROWSERS = join(ROOT, ".webext/browsers/cft");
const INDEX =
  "https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json";

function cftPlatform(): string {
  const os = Deno.build.os;
  const arch = Deno.build.arch;
  if (os === "darwin") return arch === "aarch64" ? "mac-arm64" : "mac-x64";
  if (os === "linux") return arch === "aarch64" ? "linux-aarch64" : "linux64";
  throw new Error(`不支持的平台: ${os}/${arch}`);
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败 ${res.status}: ${url}`);
  await Deno.writeFile(dest, new Uint8Array(await res.arrayBuffer()));
}

const platform = cftPlatform();
const index = JSON.parse(await (await fetch(INDEX)).text()) as {
  versions: { version: string; downloads: Record<string, { platform: string; url: string }[]> }[];
};

// known-good 列表最后一个同时提供 chrome + chromedriver 的版本（即最新可用配对）
let picked: { version: string; chrome: string; driver: string } | null = null;
for (const v of index.versions) {
  const chrome = (v.downloads.chrome ?? []).find((d) => d.platform === platform);
  const driver = (v.downloads.chromedriver ?? []).find((d) => d.platform === platform);
  if (chrome && driver) picked = { version: v.version, chrome: chrome.url, driver: driver.url };
}
if (!picked) throw new Error(`CfT 无 ${platform} 的 chrome/chromedriver 配对版本`);
console.log(`[setup-chromium] CfT ${picked.version} (${platform})`);

await Deno.mkdir(BROWSERS, { recursive: true });
await Deno.mkdir(DRIVERS, { recursive: true });

// chrome
const chromeZip = join(ROOT, ".webext/browsers/cft-chrome.zip");
await download(picked.chrome, chromeZip);
new Deno.Command("unzip", { args: ["-oq", chromeZip, "-d", BROWSERS] }).outputSync();
Deno.removeSync(chromeZip);

// chromedriver（zip 内有平台内层目录：chromedriver-<platform>/chromedriver）
const driverZip = join(ROOT, ".webext/drivers/chromedriver.zip");
await download(picked.driver, driverZip);
new Deno.Command("unzip", { args: ["-oq", driverZip, "-d", DRIVERS] }).outputSync();
Deno.removeSync(driverZip);

const binary = platform.startsWith("mac")
  ? join(
    BROWSERS,
    platform === "mac-arm64" ? "chrome-mac-arm64" : "chrome-mac-x64",
    "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  )
  : join(BROWSERS, "chrome-linux64/chrome");
const driver = join(DRIVERS, `chromedriver-${platform}`, "chromedriver");
for (const f of [binary, driver]) {
  await Deno.chmod(f, 0o755).catch(() => {});
  await Deno.stat(f);
}

// 写入 .browsers.local.json（合并已有内容）
const localPath = join(ROOT, ".browsers.local.json");
let local: { default?: string; browsers?: Record<string, unknown> } = {};
try {
  local = JSON.parse(await Deno.readTextFile(localPath));
} catch {
  // 文件不存在
}
local.browsers = { ...(local.browsers ?? {}), cft: { kind: "chromium", binary, driver } };
await Deno.writeTextFile(localPath, JSON.stringify(local, null, 2) + "\n");
console.log(`[setup-chromium] 已写入 cft 条目：${binary}`);
