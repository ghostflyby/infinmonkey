/**
 * Unused export detection: scans exported symbols under each member's src,
 * counting references in "other files" (tests included).
 *
 * Reports two categories:
 *   [dead]     no external references and unused within its own file → safe to delete
 *   [narrow]   no external references but used within its file → the export keyword is redundant, make it private
 *
 * Known limitation: lexical matching only; members accessed dynamically via strings are out of scope.
 * Usage: deno task unused
 */
import { dirname, fromFileUrl, join, relative } from "@std/path";

const PACKAGES = join(dirname(fromFileUrl(import.meta.url)), "..", "..", "packages");

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const p = join(dir, e.name);
    if (e.isDirectory) yield* walk(p);
    else if (e.isFile && e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) yield p;
  }
}

const files: string[] = [];
for (const m of ["shared", "background", "content", "inject", "ui", "tools", "tests"]) {
  for await (const f of walk(join(PACKAGES, m))) files.push(f);
}

const content = new Map<string, string>();
const linesOf = new Map<string, string[]>();
for (const f of files) {
  const text = await Deno.readTextFile(f);
  content.set(f, text);
  linesOf.set(f, text.split("\n"));
}

// Collect exported symbols
const EXPORT_RE =
  /export (?:default )?(?:async )?(?:function|const|class|type|interface|enum) (\w+)|export \{([^}]+)\}/g;
const symbols = new Map<string, { file: string; line: number }>();
for (const [file, text] of content) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(EXPORT_RE)) {
      const names = m[1]
        ? [m[1]]
        : (m[2] ?? "").split(",").map((s) => s.trim().split(/\s+as\s+/).pop()!.trim());
      for (const name of names) {
        if (name && /^\w+$/.test(name)) symbols.set(name, { file, line: i + 1 });
      }
    }
  }
}

// Count references
let dead = 0;
let narrow = 0;
for (const [name, loc] of symbols) {
  const re = new RegExp(`\\b${name}\\b`);
  let external = 0;
  let internal = 0;
  for (const [file, text] of content) {
    const isOwner = file === loc.file;
    if (!isOwner && !re.test(text)) continue;
    const lines = linesOf.get(file)!;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (i + 1 === loc.line && isOwner) continue; // skip the export declaration line itself
      const hits = line.match(new RegExp(`\\b${name}\\b`, "g"))?.length ?? 0;
      if (hits > 0) isOwner ? (internal += hits) : (external += hits);
    }
  }
  const rel = relative(PACKAGES, loc.file);
  if (external === 0 && internal === 0) {
    console.log(`[dead] ${name}  (${rel}:${loc.line})`);
    dead++;
  } else if (external === 0) {
    console.log(
      `[narrow] ${name}  (${rel}:${loc.line})  used only within its file ${internal} time(s)`,
    );
    narrow++;
  }
}
console.log(`\n${symbols.size} exported symbols: ${dead} dead, ${narrow} narrowable`);
