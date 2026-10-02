/**
 * @require splicing for MAIN-world compilation (buildUserScriptBody in
 * shared/inject.ts).
 *
 * GM semantics: fetched @require code shares the userscript's scope and runs
 * ahead of it, in declaration order. The layout contract under test: every
 * require block is closed by a lone `;` on its own line (an EmptyStatement
 * ASI can never merge across), and `userLineOffset` states the exact line
 * where the user code begins — the amount stack traces must shift by.
 */
import { assert, assertEquals } from "@std/assert";
import { buildUserScriptBody } from "@infinmonkey/shared/inject";

Deno.test("requires are spliced ahead of the user code in declaration order", () => {
  const { body } = buildUserScriptBody({
    code: "start();",
    requires: [
      { url: "https://x/one.js", text: "first();" },
      { url: "https://x/two.js", text: "second();" },
    ],
  });
  const first = body.indexOf("first();");
  const second = body.indexOf("second();");
  const user = body.indexOf("start();");
  assert(first !== -1 && second !== -1 && user !== -1);
  assert(first < second && second < user);
});

Deno.test("each require block is closed by a lone semicolon on its own line", () => {
  const { body } = buildUserScriptBody({
    code: "x",
    requires: [{ url: "https://x/one.js", text: "var a = 1" }],
  });
  assertEquals(body.split("\n"), ["var a = 1", "", ";", "x"]);
});

Deno.test("text already ending in a newline yields the same block shape", () => {
  const { body } = buildUserScriptBody({
    code: "x",
    requires: [{ url: "https://x/one.js", text: "var a = 1;\n" }],
  });
  assertEquals(body.split("\n"), ["var a = 1;", "", ";", "x"]);
});

Deno.test("userLineOffset points exactly at the first line of the user code", () => {
  const code = "let a = 1;\nlet b = 2;\nlet c = 3;";
  const { body, userLineOffset } = buildUserScriptBody({
    code,
    requires: [
      { url: "https://x/one.js", text: "one" }, // no trailing newline
      { url: "https://x/two.js", text: "two\n" }, // trailing newline
      { url: "https://x/three.js", text: "a\nb\nc" }, // multi-line, no trailing newline
    ],
  });
  const lines = body.split("\n");
  // The user code begins exactly at the offset and is byte-identical below it.
  assertEquals(lines[userLineOffset], "let a = 1;");
  assertEquals(lines.slice(userLineOffset).join("\n"), code);
});

Deno.test("userLineOffset is exact across multiple requires, with and without trailing newlines", () => {
  // Blocks contribute 3 + 3 + 4 lines respectively (text, blank, ";" each).
  const { userLineOffset } = buildUserScriptBody({
    code: "x",
    requires: [
      { url: "https://x/one.js", text: "a" },
      { url: "https://x/two.js", text: "b\n" },
      { url: "https://x/three.js", text: "c\nd" },
    ],
  });
  assertEquals(userLineOffset, 10);
});

Deno.test("empty requires keep the body identical at offset zero", () => {
  const code = "const a = 1;\nfoo(a);";
  const out = buildUserScriptBody({ code, requires: [] });
  assertEquals(out.body, code);
  assertEquals(out.userLineOffset, 0);
});
