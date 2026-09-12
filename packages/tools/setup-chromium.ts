/**
 * Chromium-family CI/local setup: downloads a version-matched "Chrome + chromedriver" pair
 * (latest known-good) from Chrome for Testing, unpacks it into .webext/, and writes the "cft" entry
 * into .browsers.local.json. Standard for one-shot runner environments; works locally too.
 *
 * Usage: deno run -A packages/tools/setup-chromium.ts
 * Supports: linux64 / mac-arm64 / mac-x64 (official CfT platforms).
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
  throw new Error(`Unsupported platform: ${os}/${arch}`);
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
  await Deno.writeFile(dest, new Uint8Array(await res.arrayBuffer()));
}

const platform = cftPlatform();
const index = JSON.parse(await (await fetch(INDEX)).text()) as {
  versions: { version: string; downloads: Record<string, { platform: string; url: string }[]> }[];
};

// The last version in the known-good list offering both chrome + chromedriver (i.e. the newest usable pair)
let picked: { version: string; chrome: string; driver: string } | null = null;
for (const v of index.versions) {
  const chrome = (v.downloads.chrome ?? []).find((d) => d.platform === platform);
  const driver = (v.downloads.chromedriver ?? []).find((d) => d.platform === platform);
  if (chrome && driver) picked = { version: v.version, chrome: chrome.url, driver: driver.url };
}
if (!picked) throw new Error(`CfT has no matching chrome/chromedriver pair for ${platform}`);
console.log(`[setup-chromium] CfT ${picked.version} (${platform})`);

await Deno.mkdir(BROWSERS, { recursive: true });
await Deno.mkdir(DRIVERS, { recursive: true });

// chrome
const chromeZip = join(ROOT, ".webext/browsers/cft-chrome.zip");
await download(picked.chrome, chromeZip);
new Deno.Command("unzip", { args: ["-oq", chromeZip, "-d", BROWSERS] }).outputSync();
Deno.removeSync(chromeZip);

// chromedriver (the zip has a platform inner directory: chromedriver-<platform>/chromedriver)
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
// Normalize to a canonical path: the e2e DRIVER_BIN resolution looks for .webext/drivers/chromedriver
const driver = join(DRIVERS, "chromedriver");
await Deno.copyFile(join(DRIVERS, `chromedriver-${platform}`, "chromedriver"), driver);
for (const f of [binary, driver]) {
  await Deno.chmod(f, 0o755).catch(() => {});
  await Deno.stat(f);
}

// Write .browsers.local.json (merging existing content)
const localPath = join(ROOT, ".browsers.local.json");
let local: { default?: string; browsers?: Record<string, unknown> } = {};
try {
  local = JSON.parse(await Deno.readTextFile(localPath));
} catch {
  // File does not exist
}
local.browsers = { ...(local.browsers ?? {}), cft: { kind: "chromium", binary, driver } };
await Deno.writeTextFile(localPath, JSON.stringify(local, null, 2) + "\n");
console.log(`[setup-chromium] wrote cft entry: ${binary}`);
