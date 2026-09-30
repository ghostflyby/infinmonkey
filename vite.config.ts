// Root Vite config — the whole build pipeline for every browser target.
// Invoked as `deno run -A npm:vite build --mode <firefox|chrome|safari>`
// (add VITE_ZIP=1 for a packaged zip). `builder: {}` makes one invocation
// build every environment in order:
//
//   client        the chunked ESM pass: the four extension pages + the module
//                 background (manifest "type": "module"; Firefox 112+,
//                 Chrome 91+, Safari 16.4+ — all above the shipped floors).
//                 Shared code (the monaco core) splits into chunks/ at the
//                 dist root so opening a second page hits the extension
//                 cache instead of re-downloading monaco.
//   bridge / installer / runner   single-file iife content scripts and the
//                 MAIN-world runner. iife is required, not cosmetic: Firefox
//                 runs every content script of one extension in a SINGLE
//                 sandbox realm, so unwrapped top-level bindings would leak
//                 between bundles.
//   editorworker / cssworker      classic single-file iife workers, created
//                 from same-origin extension URLs via runtime.getURL by
//                 packages/ui/src/monaco/editor.ts — the default MV3 CSP
//                 (script-src 'self') allows them without blob:.
//   tsworker      the self-assembled TS language worker (npm:typescript +
//                 monaco RPC bootstrap) as ESM: it is created as a module
//                 worker, and it must NOT share a graph with the pages —
//                 monaco's page-side modules evaluate DOM at module scope
//                 and share base modules with the RPC bootstrap
//                 ("window is not defined", observed in a geckodriver
//                 probe).
//
// Everything that is not bundling — manifest assembly, static copies, the
// 5 MiB size guard, packaging, the file-count log — runs in the finalize
// plugin's closeBundle, once, after all environments have written.
import path from "node:path";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import deno from "unplugin-deno/vite";
import type { EnvironmentOptions, Plugin, UserConfig } from "vite";

const ROOT = new URL(".", import.meta.url).pathname;
const PACKAGES = path.join(ROOT, "packages");

type Browser = "firefox" | "chrome" | "safari";

// monaco's language worker managers each embed a fallback factory:
//   createWorker: () => new Worker(new URL("<lang>.worker.js", import.meta.url), { type: "module" })
// MonacoEnvironment.getWorker intercepts worker creation for every label, so
// the factories never execute — but the `new URL` reference makes rolldown
// emit the module as a worker chunk (~8 MB of dead weight). The reference
// bypasses the resolveId hook, so the only source-level fix is rewriting the
// module before it enters the graph. Client-env only: the worker entries
// legitimately import these trees.
const WORKER_FALLBACK_RE =
  /new Worker\(new URL\('[^']*', import\.meta\.url\), \{ type: "module" \}\)/g;

function neutralizeMonacoWorkerFallbacks(): Plugin {
  return {
    name: "neutralize-monaco-worker-fallbacks",
    applyToEnvironment: (env) => env.name === "client",
    transform(code: string, id: string) {
      if (!id.includes("/esm/vs/languages/features/")) return null;
      const rewritten = code.replace(WORKER_FALLBACK_RE, "undefined");
      if (rewritten !== code) return { code: rewritten, map: null };
      // The factory lives in <lang>/workerManager.js. If that module stops
      // matching the pattern above (monaco upgrade), fail the build instead
      // of silently shipping the dead chunks again.
      if (id.endsWith("/workerManager.js") && code.includes("createWorker")) {
        throw new Error(
          `worker fallback factory not found in ${id} — monaco changed shape; update WORKER_FALLBACK_RE`,
        );
      }
      return null;
    },
  };
}

const GECKO_ID = "{3f7d2a91-6b5e-4c8a-9d20-51e8f0b7c642}";

// Safari: service_worker background and MAIN-world content scripts both
// require Safari 16.4+. Safari has no manifest-level minimum-version key
// (minimum_chrome_version is Chromium-only), so the floor is documented here
// instead of declared in the manifest. The module service worker
// ("type": "module") needs the same 16.4 floor.
const BROWSER_SPECIFIC: Record<Browser, Record<string, unknown>> = {
  firefox: {
    background: { scripts: ["background/main.js"], "type": "module" },
    browser_specific_settings: { gecko: { id: GECKO_ID, strict_min_version: "128.0" } },
  },
  chrome: {
    background: { service_worker: "background/main.js", "type": "module" },
    minimum_chrome_version: "111",
  },
  safari: {
    background: { service_worker: "background/main.js", "type": "module" },
  },
};

// Size discipline for shipped files: web-ext/AMO refuse to parse (and AMO
// upload lints) any extension file larger than 5 MiB — the FILE_TOO_LARGE
// error ts.worker.js used to trip. Fail the build naming the offender files.
// Source maps are dev-only and never zipped, so they are exempt.
const FILE_SIZE_LIMIT = 5 * 1024 * 1024;

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

// Runs once after every environment has written: assembles the browser
// manifest, copies the static assets (page html/css, license, icons, the
// typescript lib d.ts files the TS worker fetches at init), enforces the
// size guard, optionally zips, and prints the file count.
function finalize(browser: Browser, outDir: string, totalEnvironments: number): Plugin {
  // closeBundle fires per environment even with sharedDuringBuild (observed
  // in vite 8.3.1: the shared instance fires after the FIRST environment),
  // so finalize only once every environment has closed. The counter is
  // deliberately monotonic — buildStart also fires per environment and
  // resetting there would zero it mid-accumulation (finalize never ran,
  // observed). Monotonicity is what watch mode needs anyway: each rebuilt
  // environment closes once more and re-finalizes immediately.
  let closed = 0;
  return {
    name: "infinmonkey-finalize",
    sharedDuringBuild: true,
    async closeBundle() {
      closed++;
      if (closed < totalEnvironments) return;

      const shared = JSON.parse(await readFile(path.join(PACKAGES, "manifest.json"), "utf8"));
      const manifest = { ...shared, ...BROWSER_SPECIFIC[browser] };
      await writeFile(
        path.join(outDir, "manifest.json"),
        JSON.stringify(manifest, null, "\t") + "\n",
      );

      // Page html/css (the ui member's src is the pages root).
      const uiSrc = path.join(PACKAGES, "ui/src");
      for await (const p of walk(uiSrc)) {
        if (!/\.(html|css)$/.test(p)) continue;
        const dest = path.join(outDir, path.relative(uiSrc, p));
        await mkdir(path.dirname(dest), { recursive: true });
        await copyFile(p, dest);
      }
      // TS default-lib d.ts files, fetched on demand by the self-assembled
      // TS worker instead of being bundled into it as string data.
      const tsLibDir = path.join(ROOT, "node_modules/typescript/lib");
      const libsOut = path.join(outDir, "monaco/libs");
      await mkdir(libsOut, { recursive: true });
      for (const e of await readdir(tsLibDir)) {
        if (/^lib\..*\.d\.ts$/.test(e)) {
          await copyFile(path.join(tsLibDir, e), path.join(libsOut, e));
        }
      }
      // License ships with the package; icons.
      await copyFile(path.join(ROOT, "LICENSE"), path.join(outDir, "LICENSE"));
      const iconDir = path.join(ROOT, "assets/icons");
      await mkdir(path.join(outDir, "icons"), { recursive: true });
      for await (const p of walk(iconDir)) {
        await copyFile(p, path.join(outDir, "icons", path.relative(iconDir, p)));
      }

      const offenders: string[] = [];
      let count = 0;
      for await (const p of walk(outDir)) {
        count++;
        if (p.endsWith(".map")) continue;
        const { size } = await stat(p);
        if (size > FILE_SIZE_LIMIT) {
          offenders.push(`${path.relative(outDir, p)} (${size} bytes)`);
        }
      }
      if (offenders.length > 0) {
        throw new Error(
          `files over ${FILE_SIZE_LIMIT} bytes:\n  ${offenders.join("\n  ")}`,
        );
      }

      if (Deno.env.get("VITE_ZIP") === "1") {
        const zip = path.join(
          ROOT,
          "dist",
          `infinmonkey-${browser}-${shared.version}.zip`,
        );
        await rm(zip, { recursive: true, force: true });
        // Source maps stay in dist for local debugging but not in the artifact.
        const cmd = new Deno.Command("zip", {
          args: ["-rq", zip, ".", "-x", "*.map"],
          cwd: outDir,
        });
        const st = await cmd.output();
        if (!st.success) throw new Error("zip failed");
      }

      console.log(`[build] dist/${browser}: ${count} files`);
    },
  };
}

// Cleans the output directory once, before the first environment writes.
// Per-environment emptyOutDir cannot be used: all environments share one
// outDir and vite would empty it again for each of them.
function cleanFirst(outDir: string): Plugin {
  let cleaned = false;
  return {
    name: "infinmonkey-clean",
    sharedDuringBuild: true,
    async buildStart() {
      if (cleaned) return;
      cleaned = true;
      // Awaited: nothing orders a fire-and-forget rm against the first
      // environment's writes.
      await rm(outDir, { recursive: true, force: true });
    },
  };
}

// Single-entry environments: [source entry, dist-relative output, format].
const SINGLE_ENTRIES = [
  ["content/src/bridge.ts", "content/bridge.js", "iife"],
  ["content/src/installer.ts", "content/installer.js", "iife"],
  ["inject/src/runner.ts", "inject/runner.js", "iife"],
  ["ui/src/monaco/worker.ts", "monaco/editor.worker.js", "iife"],
  ["ui/src/monaco/css-worker.ts", "monaco/css.worker.js", "iife"],
  ["ui/src/monaco/ts-worker.ts", "monaco/ts.worker.js", "es"],
] as const;

const singleEnvironment = (
  entryRel: string,
  outFile: string,
  format: "iife" | "es",
): EnvironmentOptions => ({
  // Custom environments default to a non-client consumer; the bundling
  // pipeline (and plugin resolution) needs the client one.
  consumer: "client",
  build: {
    rolldownOptions: {
      input: { entry: path.join(PACKAGES, entryRel) },
      output: { format, entryFileNames: outFile },
    },
  },
});

export default ({ mode }: { mode: string }): UserConfig => {
  if (mode !== "firefox" && mode !== "chrome" && mode !== "safari") {
    throw new Error(`unknown mode "${mode}" (expected firefox | chrome | safari)`);
  }
  const browser = mode as Browser;
  const outDir = path.join(ROOT, "dist", browser);
  // Declared before the return so the finalize total derives from the map
  // itself — a directly added environment must not silently never finalize.
  const environments: UserConfig["environments"] = {
    client: {
      build: {
        rolldownOptions: {
          input: {
            options: "packages/ui/src/options/main.ts",
            install: "packages/ui/src/install/main.ts",
            popup: "packages/ui/src/popup/main.ts",
            prompt: "packages/ui/src/prompt/main.ts",
            background: "packages/background/src/main.ts",
          },
          output: {
            format: "es",
            entryFileNames: "[name]/main.js",
            chunkFileNames: "chunks/[name]-[hash].js",
            assetFileNames: "assets/[name][extname]",
            manualChunks(id: string) {
              if (id.includes("/esm/vs/")) return "monaco-core";
            },
          },
        },
      },
    },
    ...Object.fromEntries(
      SINGLE_ENTRIES.map(([entry, out, format]) => [
        path.basename(out, ".js").replace(/[^a-z]/g, "") + "env",
        singleEnvironment(entry, out, format),
      ]),
    ),
  };
  return {
    root: ROOT,
    base: "./",
    publicDir: false,
    plugins: [
      deno(),
      neutralizeMonacoWorkerFallbacks(),
      cleanFirst(outDir),
      finalize(browser, outDir, Object.keys(environments).length),
    ],
    builder: {},
    build: {
      outDir,
      emptyOutDir: false,
      minify: true,
      target: "es2022",
      // Safari dist is copied whole into the app extension by Xcode; the
      // appex must not carry tens of megabytes of source maps.
      sourcemap: browser === "safari" ? false : "hidden",
    },
    environments,
  };
};
