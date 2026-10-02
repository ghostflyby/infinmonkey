/**
 * Stack-frame attribution for userscript errors (findUserFrame +
 * buildUserScriptBody.userLineOffset in shared/inject.ts).
 *
 * The runner reports a userscript line by subtracting two offsets from the
 * engine-reported sourceURL frame: the new Function wrapper lines (probed at
 * runtime in the browser — engine-specific, out of scope here) and the
 * @require prefix line count. These tests pin the pure half: matching a frame
 * by the exact file name appendSourceDirectives emits, and the offset
 * arithmetic that recovers the user line.
 */
import { assertEquals } from "@std/assert";
import {
  appendSourceDirectives,
  buildUserScriptBody,
  findUserFrame,
} from "@infinmonkey/shared/inject";

Deno.test("a Chrome-style sourceURL frame yields its line and column", () => {
  const stack = [
    "Error: boom",
    "    at userscript (InfinMonkey/Demo.user.js:12:5)",
    "    at other (https://page.example/x.js:1:1)",
  ].join("\n");
  assertEquals(findUserFrame(stack, "Demo"), { line: 12, col: 5 });
});

Deno.test("a Firefox-style frame (@ separator) yields its line and column too", () => {
  const stack = "handler@InfinMonkey/Demo.user.js:7:3\nbootstrap@page.example:1:1";
  assertEquals(findUserFrame(stack, "Demo"), { line: 7, col: 3 });
});

Deno.test("a stack with no frame of the script yields null", () => {
  const stack = "Error: boom\n    at other (https://page.example/x.js:1:1)";
  assertEquals(findUserFrame(stack, "Demo"), null);
});

Deno.test("when several frames match, the first (innermost) user frame wins", () => {
  const stack = [
    "Error: boom",
    "    at inner (InfinMonkey/Demo.user.js:20:2)",
    "    at outer (InfinMonkey/Demo.user.js:9:1)",
  ].join("\n");
  assertEquals(findUserFrame(stack, "Demo"), { line: 20, col: 2 });
});

Deno.test("an existing .user.js suffix in the name is not doubled when matching", () => {
  const stack = "f@InfinMonkey/Demo.user.js:4:1";
  assertEquals(findUserFrame(stack, "Demo.user.js"), { line: 4, col: 1 });
});

Deno.test("the matched name is byte-identical to the file appendSourceDirectives emits", () => {
  // A hostile name (newline, trailing spaces, existing suffix) survives
  // sanitization into one line; the directive and the matcher must agree on it.
  const name = "bad\nname .user.js ";
  const directive = appendSourceDirectives("x", name).split("\n")[1];
  const file = directive.slice("//# sourceURL=InfinMonkey/".length);
  const stack = `    at f (InfinMonkey/${file}:9:4)`;
  assertEquals(findUserFrame(stack, name), { line: 9, col: 4 });
});

Deno.test("regex metacharacters in the name match literally, not as a pattern", () => {
  const stack = "    at f (InfinMonkey/a.b(c).user.js:4:2)";
  assertEquals(findUserFrame(stack, "a.b(c)"), { line: 4, col: 2 });
  // A near-miss name must not be satisfied by the metacharacter's wildcard.
  assertEquals(findUserFrame(stack, "aXb(c)"), null);
});

Deno.test("the engine frame minus the require prefix recovers the user line", () => {
  // User line 3 throws; one require contributes a 4-line prefix
  // ("one\ntwo" + blank + ";"), the engine wrapper adds +2 (simulated).
  const { body, userLineOffset } = buildUserScriptBody({
    code: "let a = 1;\nlet b = 2;\nthrowUp();",
    requires: [{ url: "https://x/one.js", text: "one\ntwo" }],
  });
  assertEquals(userLineOffset, 4);
  assertEquals(body.split("\n").length, 7); // 4 prefix + 3 user lines
  const engineWrapperOffset = 2;
  const engineLine = engineWrapperOffset + userLineOffset + 3;
  const stack = `Error: x\n    at f (InfinMonkey/Demo.user.js:${engineLine}:1)`;
  const frame = findUserFrame(stack, "Demo");
  assertEquals(frame, { line: engineLine, col: 1 });
  // The runner's arithmetic: user line = engine line - wrapper - prefix.
  assertEquals((frame?.line ?? 0) - engineWrapperOffset - userLineOffset, 3);
});

Deno.test("with no requires the user line is the engine line minus the wrapper alone", () => {
  const code = "a();\nb();";
  const { body, userLineOffset } = buildUserScriptBody({ code, requires: [] });
  assertEquals(body, code);
  assertEquals(userLineOffset, 0);
  const engineLine = 5 + userLineOffset + 1; // wrapper 5, user line 1
  const frame = findUserFrame(`x@InfinMonkey/S.user.js:${engineLine}:2`, "S");
  assertEquals(frame, { line: engineLine, col: 2 });
  assertEquals((frame?.line ?? 0) - userLineOffset - 5, 1);
});
