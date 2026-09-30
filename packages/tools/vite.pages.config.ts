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

// monaco's language services each embed a
// `new Worker(new URL("<lang>.worker.js", import.meta.url))` fallback factory.
// In our wiring MonacoEnvironment.getWorker (packages/ui/src/monaco/editor.ts)
// creates the workers from the standalone monaco/*.worker.js targets built by
// the single-file pass instead — those fallbacks never execute, but rolldown
// still emits them as worker chunks (~8 MB of dead weight; their `new URL`
// references bypass the resolveId hook, so they cannot be stubbed out).
// Drop the dead chunks at emit time; the dangling `new URL` strings inside
// monaco-core sit on the never-taken branch and reference the extension's
// own worker files at runtime anyway.
const DEAD_WORKER_CHUNK_PREFIXES = ["assets/css.worker-", "assets/ts.worker-"];

function dropDeadWorkerFallbacks() {
  return {
    name: "drop-dead-worker-fallbacks",
    generateBundle(_options: unknown, bundle: Record<string, unknown>) {
      for (const fileName of Object.keys(bundle)) {
        if (DEAD_WORKER_CHUNK_PREFIXES.some((p) => fileName.startsWith(p))) {
          delete bundle[fileName];
        }
      }
    },
  };
}

export default ({ mode }: { mode: string }) => ({
  root: ROOT,
  base: "./",
  plugins: [deno(), dropDeadWorkerFallbacks()],
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
