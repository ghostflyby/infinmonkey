// Generates .monaco-esm — a copy of monaco-editor's esm/vs tree with the
// CSS imports stripped from every JS module.
//
// Why: `deno bundle` has no asset loader, and monaco's module CSS references
// the codicon.ttf font via url(), so bundling the unmodified tree fails with
// "No loader is configured for .ttf files". The stripped JS bundles cleanly;
// the styles ship separately as monaco's aggregated
// min/vs/editor/editor.main.css plus the codicon.ttf font (copied by
// build.ts).
//
// Run automatically by build.ts; also runnable directly:
//   deno task monaco-esm [--force]
import { join } from "@std/path";

const MONACO_VERSION = "0.57.0";
const OUT_DIR = ".monaco-esm";
// Shadow mirrors the whole esm/ directory (vs/ plus the vendored external/
// dependencies that some modules reach via relative paths).
const CSS_IMPORT_RE = /import\s+["'][^"']*\.css["'];\n?/g;

/** Resolves monaco-editor's deno npm cache directory. */
export function monacoLocalDir(): string {
  const info = new Deno.Command(Deno.execPath(), {
    args: ["info", "--json", `npm:monaco-editor@${MONACO_VERSION}`],
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  if (!info.success) throw new Error("deno info failed for monaco-editor");
  const parsed = JSON.parse(new TextDecoder().decode(info.stdout)) as {
    npmPackages?: Record<
      string,
      { name?: string; version?: string; localPath?: string }
    >;
  };
  for (
    const [key, entry] of Object.entries(parsed.npmPackages ?? {})
  ) {
    if (
      key === `monaco-editor@${MONACO_VERSION}` && entry.localPath
    ) {
      return entry.localPath;
    }
  }
  throw new Error(
    `monaco-editor@${MONACO_VERSION} not found in the deno npm cache`,
  );
}

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const path = join(dir, e.name);
    if (e.isDirectory) yield* walk(path);
    else yield path;
  }
}

/** Ensures .monaco-esm exists for the pinned monaco version; returns its path. */
export async function ensureMonacoEsm(force = false): Promise<string> {
  const marker = join(OUT_DIR, ".version");
  const existing = await Deno.readTextFile(marker).catch(() => null);
  if (existing?.trim() === MONACO_VERSION && !force) return OUT_DIR;
  const src = join(monacoLocalDir(), "esm");
  await Deno.remove(OUT_DIR, { recursive: true }).catch(() => {});
  let files = 0;
  for await (const path of walk(src)) {
    const rel = path.slice(src.length + 1);
    const dest = join(OUT_DIR, rel);
    await Deno.mkdir(dirname(dest), { recursive: true });
    if (path.endsWith(".css")) continue;
    if (path.endsWith(".js")) {
      // Strip the css imports: the styles ship via the aggregated
      // editor.main.css instead.
      const text = await Deno.readTextFile(path);
      await Deno.writeTextFile(dest, text.replace(CSS_IMPORT_RE, ""));
    } else {
      await Deno.copyFile(path, dest);
    }
    files++;
  }
  await Deno.writeTextFile(marker, MONACO_VERSION);
  console.log(`[monaco-esm] generated ${files} files for ${MONACO_VERSION}`);
  return OUT_DIR;
}

function dirname(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? "." : p.slice(0, idx);
}

if (import.meta.main) {
  await ensureMonacoEsm(Deno.args.includes("--force"));
}
