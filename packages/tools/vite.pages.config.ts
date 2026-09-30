// Vite config for the ESM pass: the four extension pages and the module
// background (manifest "type": "module"; Firefox 112+, Chrome 91+, Safari
// 16.4+ — all above the shipped floors). Each entry keeps its
// manifest/html-referenced path ([name]/main.js); code shared across pages
// (the monaco core) is split into chunks/ at the dist root, so opening a
// second page hits the extension cache instead of re-downloading a monaco
// copy the first page already loaded. The monaco styles are emitted from
// monaco's own css imports as assets/monaco-core.css and linked from the
// pages' html.
import deno from "unplugin-deno/vite";

const ROOT = new URL("../../", import.meta.url).pathname;

// monaco's language worker managers each embed a fallback factory:
//   createWorker: () => new Worker(new URL("<lang>.worker.js", import.meta.url), { type: "module" })
// In our wiring MonacoEnvironment.getWorker (packages/ui/src/monaco/editor.ts)
// intercepts worker creation for every label and dispatches to the standalone
// monaco/*.worker.js targets built by the single-file pass, so the factories
// never execute — but the `new URL` reference makes rolldown emit the module
// as a worker chunk (~8 MB of dead weight). The reference bypasses the
// resolveId hook, so the only source-level fix is rewriting the module
// before it enters the graph: neutralize the factory expression.
const WORKER_FALLBACK_RE =
  /new Worker\(new URL\('[^']*', import\.meta\.url\), \{ type: "module" \}\)/g;

function neutralizeMonacoWorkerFallbacks() {
  return {
    name: "neutralize-monaco-worker-fallbacks",
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

export default ({ mode }: { mode: string }) => ({
  root: ROOT,
  base: "./",
  plugins: [deno(), neutralizeMonacoWorkerFallbacks()],
  build: {
    // The dist directory is passed via --outDir from build.ts.
    emptyOutDir: false,
    minify: true,
    target: "es2022",
    // Safari dist is copied whole into the app extension by Xcode; the
    // appex must not carry tens of megabytes of source maps.
    sourcemap: mode === "safari" ? false : "hidden",
    rollupOptions: {
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
});
