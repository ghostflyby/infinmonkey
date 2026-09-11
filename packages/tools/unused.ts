/**
 * 未使用导出检测：扫描各成员 src 下的导出符号，
 * 统计其在「其他文件」中的引用次数（含测试）。
 *
 * 输出两类：
 *   [死代码]  外部无引用、文件内部也无使用 → 可直接删除
 *   [可收窄]  外部无引用但文件内部在用 → export 关键字多余，可改为私有
 *
 * 已知局限：仅做词法级匹配；通过字符串动态访问的成员不在检测范围。
 * 用法：deno task unused
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

// 收集导出符号
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

// 统计引用
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
      if (i + 1 === loc.line && isOwner) continue; // 跳过导出声明行本身
      const hits = line.match(new RegExp(`\\b${name}\\b`, "g"))?.length ?? 0;
      if (hits > 0) isOwner ? (internal += hits) : (external += hits);
    }
  }
  const rel = relative(PACKAGES, loc.file);
  if (external === 0 && internal === 0) {
    console.log(`[死代码] ${name}  (${rel}:${loc.line})`);
    dead++;
  } else if (external === 0) {
    console.log(`[可收窄] ${name}  (${rel}:${loc.line})  仅文件内部使用 ${internal} 次`);
    narrow++;
  }
}
console.log(`\n导出符号 ${symbols.size} 个：死代码 ${dead}，可收窄 ${narrow}`);
