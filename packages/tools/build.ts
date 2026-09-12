/**
 * Build script: deno bundle packaging + manifest assembly (shared fields from packages/manifest.json,
 * per-browser overrides below) + static asset copying.
 * Usage: deno run -A tools/build.ts [--browser firefox|chrome|all] [--zip]
 */
import { dirname, fromFileUrl, join, relative } from "@std/path";

// packages/tools/ → repo root
const ROOT = dirname(fromFileUrl(import.meta.url)) + "/../..";
const DIST = join(ROOT, "dist");
const PACKAGES = join(ROOT, "packages");

// Shared manifest fields live in packages/manifest.json; browser-specific fields are merged in per target (BROWSER_SPECIFIC below).
// The MAIN-world runner content_script there is deliberate: injection must not depend on
// background tab resolution (works around the Zen engine sender defect).
const SHARED_MANIFEST: Record<string, unknown> = JSON.parse(
  await Deno.readTextFile(join(PACKAGES, "manifest.json")),
);
const VERSION = SHARED_MANIFEST.version as string;

const args = new Set(Deno.args);
let browserArg = "all";
const bi = Deno.args.indexOf("--browser");
if (bi >= 0 && Deno.args[bi + 1]) browserArg = Deno.args[bi + 1];
const doZip = args.has("--zip");

const targets = browserArg === "all" ? ["firefox", "chrome"] : [browserArg];

// [in-package source file, dist-relative output] (dist layout must match manifest references)
const ENTRIES: [string, string][] = [
  ["background/src/main.ts", "background/main.js"],
  ["content/src/bridge.ts", "content/bridge.js"],
  ["content/src/installer.ts", "content/installer.js"],
  ["inject/src/runner.ts", "inject/runner.js"],
  ["ui/src/options/main.ts", "options/main.js"],
  ["ui/src/popup/main.ts", "popup/main.js"],
  ["ui/src/install/main.ts", "install/main.js"],
  ["ui/src/prompt/main.ts", "prompt/main.js"],
];

async function copyStatic(to: string) {
  // Page html/css (the ui member's src is the pages root)
  const uiSrc = join(PACKAGES, "ui/src");
  for await (const p of walk(uiSrc)) {
    if (!/\.(html|css)$/.test(p)) continue;
    const rel = relative(uiSrc, p);
    const dest = join(to, rel);
    await Deno.mkdir(dirname(dest), { recursive: true });
    await Deno.copyFile(p, dest);
  }
  // License ships with the package
  await Deno.copyFile(join(ROOT, "LICENSE"), join(to, "LICENSE"));
  // Icons
  const iconDir = join(ROOT, "assets/icons");
  await Deno.mkdir(join(to, "icons"), { recursive: true });
  for await (const p of walk(iconDir)) {
    const rel = relative(iconDir, p);
    await Deno.copyFile(p, join(to, "icons", rel));
  }
}

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const p = join(dir, e.name);
    if (e.isDirectory) yield* walk(p);
    else if (e.isFile) yield p;
  }
}

const GECKO_ID = "{3f7d2a91-6b5e-4c8a-9d20-51e8f0b7c642}";

const BROWSER_SPECIFIC: Record<"firefox" | "chrome", Record<string, unknown>> = {
  firefox: {
    background: { scripts: ["background/main.js"] },
    browser_specific_settings: { gecko: { id: GECKO_ID, strict_min_version: "128.0" } },
  },
  chrome: {
    background: { service_worker: "background/main.js" },
    minimum_chrome_version: "111",
  },
};

function manifest(browser: "firefox" | "chrome"): Record<string, unknown> {
  return { ...SHARED_MANIFEST, ...BROWSER_SPECIFIC[browser] };
}

for (const browser of targets as ("firefox" | "chrome")[]) {
  const out = join(DIST, browser);
  await Deno.remove(out, { recursive: true }).catch(() => {});
  await Deno.mkdir(out, { recursive: true });

  // deno bundle (oxc): bundles TS directly, resolves npm from the global cache, emits a classic script without import/export
  for (const [entryRel, outRel] of ENTRIES) {
    const entry = join(PACKAGES, entryRel);
    const outFile = join(out, outRel);
    await Deno.mkdir(dirname(outFile), { recursive: true });
    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "bundle",
        "--platform=browser",
        "--sourcemap=inline",
        "--no-check",
        "-o",
        outFile,
        entry,
      ],
      stdout: "inherit",
      stderr: "inherit",
    });
    const st = cmd.outputSync();
    if (!st.success) {
      console.error(`[build] deno bundle failed (${outRel})`);
      Deno.exit(1);
    }
  }

  await copyStatic(out);
  await Deno.writeTextFile(
    join(out, "manifest.json"),
    JSON.stringify(manifest(browser), null, "\t") + "\n",
  );

  if (doZip) {
    const zip = join(DIST, `infinmonkey-${browser}-${VERSION}.zip`);
    await Deno.remove(zip).catch(() => {});
    const cmd = new Deno.Command("zip", { args: ["-rq", zip, "."], cwd: out });
    const st = await cmd.output();
    if (!st.success) console.error("[build] zip failed");
  }

  const files: string[] = [];
  for await (const p of walk(out)) files.push(relative(out, p));
  console.log(`[build] dist/${browser}: ${files.length} files`);
}

console.log("[build] done");
