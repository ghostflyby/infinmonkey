/**
 * Launches a dev browser: build → resolve the browser config (--browser / INFIN_BROWSER /
 * .browsers.local.json / default zen) → web-ext loads the extension temporarily.
 *
 * Usage: deno task run [--browser <name>]
 */
import { join } from "@std/path";
import { cliBrowserName, resolveBrowser, ROOT } from "./browsers.ts";

const { name, kind, cfg, profileAbs } = await resolveBrowser(cliBrowserName());
const buildTarget = kind === "chromium" ? "chrome" : "firefox";

// 1) Build
const build = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", "packages/tools/build.ts", "--browser", buildTarget],
  stdout: "inherit",
  stderr: "inherit",
});
const built = await build.output();
if (!built.success) Deno.exit(1);

// 2) Profile directory
await Deno.mkdir(profileAbs, { recursive: true });

if (kind === "chromium") {
  // Chromium family: load the unpacked extension directly via --load-extension (no web-ext auto-reload)
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
  // Firefox family: web-ext run (args after -- are forwarded to the browser)
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

  console.log(`[launch] Firefox family "${name}": ${cfg.binary}`);
  const proc = new Deno.Command(Deno.execPath(), {
    args: webextArgs,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const st = await proc.output();
  if (!st.success) Deno.exit(st.code);
}
