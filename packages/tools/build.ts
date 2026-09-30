/**
 * Build script: deno bundle packaging + manifest assembly (shared fields from packages/manifest.json,
 * per-browser overrides below) + static asset copying.
 * Usage: deno run -A tools/build.ts [--browser firefox|chrome|safari|all] [--zip]
 *
 * The safari target is a plain dist output like the others; the root-level InfinMonkey.xcodeproj
 * references dist/safari directly (inside its project container) and its extension targets copy
 * the entries into the appex via the native Copy Bundle Resources phase.
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

type Browser = "firefox" | "chrome" | "safari";
const BROWSERS: Browser[] = ["firefox", "chrome", "safari"];
const targets: Browser[] = browserArg === "all" ? ["firefox", "chrome"] : [browserArg as Browser];
for (const t of targets) {
  if (!BROWSERS.includes(t)) {
    console.error(`[build] unknown browser "${t}" (expected: ${BROWSERS.join(", ")}, all)`);
    Deno.exit(1);
  }
}

// [in-package source file, dist-relative output] (dist layout must match manifest references)
const ENTRIES: [string, string][] = [
  ["background/src/main.ts", "background/main.js"],
  ["content/src/bridge.ts", "content/bridge.js"],
  ["content/src/installer.ts", "content/installer.js"],
  ["inject/src/runner.ts", "inject/runner.js"],
  ["ui/src/monaco/worker.ts", "monaco/editor.worker.js"],
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

/** Absolute path of the codicon icon font inside the deno npm cache. */
function monacoCodiconFont(): string {
  const info = new Deno.Command(Deno.execPath(), {
    args: ["info", "--json", `npm:monaco-editor@${MONACO_VERSION}`],
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  if (!info.success) throw new Error(`deno info failed for monaco-editor`);
  const parsed = JSON.parse(new TextDecoder().decode(info.stdout)) as {
    npmPackages?: Record<string, { name?: string; version?: string; localPath?: string }>;
  };
  const entry = Object.entries(parsed.npmPackages ?? {}).find(
    ([key, v]) =>
      v.name === "monaco-editor" && v.version === MONACO_VERSION &&
      key === `monaco-editor@${MONACO_VERSION}`,
  ) ?? Object.entries(parsed.npmPackages ?? {}).find(([key]) =>
    key.startsWith(`monaco-editor@${MONACO_VERSION}`)
  );
  if (!entry) throw new Error(`monaco-editor@${MONACO_VERSION} not in deno info npmPackages`);
  const localPath = entry[1].localPath;
  if (!localPath) throw new Error(`monaco-editor cache entry has no localPath`);
  return join(
    localPath,
    "esm/vs/base/browser/ui/codicons/codicon/codicon.ttf",
  );
}

/** The bundler emits the editor CSS without the codicon @font-face (it has no
 * .ttf asset loader). Copy the font next to each emitted stylesheet and
 * restore the face, or editor widget icons render blank. */
async function patchMonacoCss(out: string, fontSrc: string): Promise<void> {
  for (const rel of ["options/main.css", "install/main.css"]) {
    const cssPath = join(out, rel);
    try {
      await Deno.stat(cssPath);
    } catch {
      // A renamed bundle output would silently lose the editor icons.
      console.warn(`[build] monaco css not found at ${rel}; codicon font skipped`);
      continue;
    }
    await Deno.copyFile(fontSrc, join(dirname(cssPath), "codicon.ttf"));
    await Deno.writeTextFile(
      cssPath,
      '\n@font-face {\n  font-family: "codicon";\n  src: url("codicon.ttf") format("truetype");\n}\n',
      { append: true },
    );
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

// Must match the monaco-editor pin in the root deno.json imports map.
const MONACO_VERSION = "0.57.0";

// Safari: service_worker background and MAIN-world content scripts both require Safari 16.4+.
// Safari has no manifest-level minimum-version key (minimum_chrome_version is Chromium-only),
// so the floor is documented here instead of declared in the manifest.
const BROWSER_SPECIFIC: Record<Browser, Record<string, unknown>> = {
  firefox: {
    background: { scripts: ["background/main.js"] },
    browser_specific_settings: { gecko: { id: GECKO_ID, strict_min_version: "128.0" } },
  },
  chrome: {
    background: { service_worker: "background/main.js" },
    minimum_chrome_version: "111",
  },
  safari: {
    background: { service_worker: "background/main.js" },
  },
};

function manifest(browser: Browser): Record<string, unknown> {
  return { ...SHARED_MANIFEST, ...BROWSER_SPECIFIC[browser] };
}

for (const browser of targets) {
  const out = join(DIST, browser);
  await Deno.remove(out, { recursive: true }).catch(() => {});
  await Deno.mkdir(out, { recursive: true });

  // deno bundle (oxc): bundles TS directly, resolves npm from the global cache, emits a classic script without import/export
  // --format=iife is required, not cosmetic: the output is a classic script, and
  // Firefox runs every content script of one extension in a SINGLE sandbox realm,
  // so unwrapped top-level bindings would leak between bundles and a later-loaded
  // bundle overwrites an earlier one's helpers (observed as sporadic
  // "X is not a function" delivery failures after minification).
  // Monaco's dependency tree produces tens of megabytes of inline sourcemap
  // text; the bundles carrying it ship the map as a linked file instead.
  const LINKED_SOURCEMAP = new Set([
    "monaco/editor.worker.js",
    "options/main.js",
    "install/main.js",
  ]);

  for (const [entryRel, outRel] of ENTRIES) {
    const entry = join(PACKAGES, entryRel);
    const outFile = join(out, outRel);
    await Deno.mkdir(dirname(outFile), { recursive: true });
    const sourcemapArgs = LINKED_SOURCEMAP.has(outRel)
      ? ["--sourcemap=linked"]
      : ["--sourcemap=inline"];
    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "bundle",
        "--platform=browser",
        "--format=iife",
        ...sourcemapArgs,
        "--no-check",
        "--minify",
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
  await patchMonacoCss(out, monacoCodiconFont());
  await Deno.writeTextFile(
    join(out, "manifest.json"),
    JSON.stringify(manifest(browser), null, "\t") + "\n",
  );

  if (doZip) {
    const zip = join(DIST, `infinmonkey-${browser}-${VERSION}.zip`);
    await Deno.remove(zip).catch(() => {});
    // Source maps stay in dist for local debugging but not in the artifact.
    const cmd = new Deno.Command("zip", {
      args: ["-rq", zip, ".", "-x", "*.map"],
      cwd: out,
    });
    const st = await cmd.output();
    if (!st.success) console.error("[build] zip failed");
  }

  const files: string[] = [];
  for await (const p of walk(out)) files.push(relative(out, p));
  console.log(`[build] dist/${browser}: ${files.length} files`);
}

console.log("[build] done");
