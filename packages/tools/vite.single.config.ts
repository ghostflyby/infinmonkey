// Vite config for the single-file build targets: content scripts, the
// MAIN-world runner, and the monaco workers. Rolldown cannot emit multiple
// iife entries from one build, so build.ts invokes this config once per
// target with VITE_ENTRY (absolute source path) and VITE_OUT (dist-relative
// output path); VITE_FORMAT selects the module system ("iife" for classic
// targets, "es" for the self-assembled TS worker, which editor.ts creates
// as a module worker).
//
// The iife format is required for content scripts, not cosmetic: Firefox
// runs every content script of one extension in a SINGLE sandbox realm, so
// unwrapped top-level bindings would leak between bundles and a
// later-loaded bundle overwrites an earlier one's helpers (observed as
// sporadic "X is not a function" delivery failures after minification).
// The editor/css workers are classic workers created via runtime.getURL by
// packages/ui/src/monaco/editor.ts — the default MV3 CSP (script-src
// 'self') allows them without blob:. The TS worker needs "es" instead of a
// shared-graph build: its monaco imports are the RPC bootstrap chain, whose
// page-side siblings touch the DOM at evaluation time, so a shared chunk
// would crash the worker ("window is not defined", observed in a
// geckodriver probe).
import deno from "unplugin-deno/vite";

const ROOT = new URL("../../", import.meta.url).pathname;
const entry = Deno.env.get("VITE_ENTRY");
const outFile = Deno.env.get("VITE_OUT");
const format = Deno.env.get("VITE_FORMAT") === "es" ? "es" : "iife";
if (!entry || !outFile) {
  throw new Error("vite.single.config.ts requires VITE_ENTRY and VITE_OUT");
}

export default ({ mode }: { mode: string }) => ({
  root: ROOT,
  base: "./",
  plugins: [deno()],
  build: {
    emptyOutDir: false,
    minify: true,
    target: "es2022",
    sourcemap: mode === "safari" ? false : "hidden",
    rollupOptions: {
      input: { entry },
      output: {
        format,
        entryFileNames: outFile,
      },
    },
  },
});
