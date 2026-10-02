/**
 * Source-mapping directives appended to userscript code before MAIN-world
 * compilation (appendSourceDirectives in shared/inject.ts).
 *
 * The directives are what make an anonymously `new Function`-compiled
 * userscript visible in DevTools under a stable name, and — for dev-mapped
 * scripts — let DevTools load the served origin file as the original source.
 * The security-relevant property under test: both directives are line
 * comments, so a hostile name or URL containing a newline must never be able
 * to escape the comment line and inject code of its own.
 */
import { assert, assertEquals, assertFalse } from "@std/assert";
import { appendSourceDirectives } from "@infinmonkey/shared/inject";

Deno.test("sourceURL names the compiled script with the InfinMonkey prefix and .user.js suffix", () => {
  const out = appendSourceDirectives("const a = 1;", "Demo");
  assertEquals(out, "const a = 1;\n//# sourceURL=InfinMonkey/Demo.user.js");
});

Deno.test("an existing .user.js suffix is not doubled", () => {
  const out = appendSourceDirectives("x", "Demo.user.js");
  assert(out.endsWith("//# sourceURL=InfinMonkey/Demo.user.js"));
  assertFalse(out.includes("user.js.user.js"));
});

Deno.test("a dev URL adds sourceMappingURL after sourceURL", () => {
  const out = appendSourceDirectives(
    "x",
    "Demo",
    "http://127.0.0.1:17321/demo.user.js",
  );
  const lines = out.split("\n");
  assertEquals(lines.length, 3);
  assertEquals(lines[1], "//# sourceURL=InfinMonkey/Demo.user.js");
  assertEquals(lines[2], "//# sourceMappingURL=http://127.0.0.1:17321/demo.user.js");
});

Deno.test("a non-dev script gets no sourceMappingURL", () => {
  assertFalse(appendSourceDirectives("x", "Demo").includes("sourceMappingURL"));
});

Deno.test("newlines in the name cannot escape the comment line", () => {
  const hostile = 'foo"); alert(1);\nalert(2); //#';
  const out = appendSourceDirectives("let a = 1;", hostile);
  // The code line is untouched, and everything after it is directives only.
  const lines = out.split("\n");
  assertEquals(lines[0], "let a = 1;");
  assert(lines.length === 2, `expected 2 lines, got ${lines.length}`);
  assert(lines[1].startsWith("//# sourceURL=InfinMonkey/foo"));
});

Deno.test("newlines in a dev URL cannot escape either", () => {
  const out = appendSourceDirectives("x", "Demo", "http://x/\nalert(1)");
  const lines = out.split("\n");
  // The newline collapses to a space: the URL line stays a single comment
  // line ("alert" survives only as comment text, never as code).
  assertEquals(lines.length, 3);
  assertEquals(lines[2], "//# sourceMappingURL=http://x/ alert(1)");
});

Deno.test("code already ending in a newline does not get a blank separator line", () => {
  const out = appendSourceDirectives("let a = 1;\n", "Demo");
  assertEquals(out.split("\n").length, 2);
});

Deno.test("an empty name falls back to a stable placeholder", () => {
  const out = appendSourceDirectives("x", "");
  assert(out.includes("//# sourceURL=InfinMonkey/script.user.js"));
});
