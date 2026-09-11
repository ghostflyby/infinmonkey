/**
 * 启动开发浏览器：构建 → 解析浏览器配置（--browser / INFIN_BROWSER /
 * .browsers.local.json / 默认 zen）→ web-ext 以临时方式装载扩展。
 *
 * 用法：deno task run [--browser <名>]
 */
import { join } from "@std/path";
import { cliBrowserName, resolveBrowser, ROOT } from "./browsers.ts";

const { name, kind, cfg, profileAbs } = await resolveBrowser(cliBrowserName());
const buildTarget = kind === "chromium" ? "chrome" : "firefox";

// 1) 构建
const build = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", "packages/tools/build.ts", "--browser", buildTarget],
  stdout: "inherit",
  stderr: "inherit",
});
const built = await build.output();
if (!built.success) Deno.exit(1);

// 2) profile 目录
await Deno.mkdir(profileAbs, { recursive: true });

if (kind === "chromium") {
  // Chromium 系：--load-extension 直接装载 unpacked 扩展（无 web-ext 自动重载）
  console.log(`[launch] Chromium "${name}": ${cfg.binary}`);
  const proc = new Deno.Command(cfg.binary, {
    args: [
      `--user-data-dir=${profileAbs}`,
      `--load-extension=${join(ROOT, "dist/chrome")}`,
      "--no-first-run",
      "--no-default-browser-check",
      ...(cfg.args ?? []),
    ],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const st = await proc.output();
  if (!st.success) Deno.exit(st.code);
} else {
  // Firefox 系：web-ext run（-- 之后的参数透传给浏览器）
  const webextArgs = [
    "run",
    "-A",
    "npm:web-ext@10.6.0",
    "run",
    "--source-dir",
    join(ROOT, "dist/firefox"),
    "--firefox-binary",
    cfg.binary,
    "--firefox-profile",
    profileAbs,
    "--keep-profile-changes",
  ];
  if (cfg.args?.length) webextArgs.push("--", ...cfg.args);

  console.log(`[launch] Firefox 系 "${name}": ${cfg.binary}`);
  const proc = new Deno.Command(Deno.execPath(), {
    args: webextArgs,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const st = await proc.output();
  if (!st.success) Deno.exit(st.code);
}
