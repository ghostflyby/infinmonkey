// Vite config for the single-file IIFE targets: content scripts, the
// MAIN-world runner, and the monaco workers. Rolldown cannot emit multiple
// iife entries from one build, so build.ts invokes this config once per
// target with VITE_ENTRY (absolute source path) and VITE_OUT (dist-relative
// output path).
//
// The iife format is required, not cosmetic: Firefox runs every content
// script of one extension in a SINGLE sandbox realm, so unwrapped top-level
// bindings would leak between bundles and a later-loaded bundle overwrites
// an earlier one's helpers (observed as sporadic "X is not a function"
// delivery failures after minification). The monaco workers are classic
// workers created via runtime.getURL by packages/ui/src/monaco/editor.ts —
// the default MV3 CSP (script-src 'self') allows them without blob:.
import deno from "unplugin-deno/vite";

const ROOT = new URL("../../", import.meta.url).pathname;
const entry = Deno.env.get("VITE_ENTRY");
const outFile = Deno.env.get("VITE_OUT");
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
        format: "iife",
        entryFileNames: outFile,
      },
    },
  },
});
