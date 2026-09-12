import { assert, assertEquals } from "@std/assert";
import { describeTargets, splitUserStyle, targetsMatch } from "@infinmonkey/shared/mozdoc";

Deno.test("splitUserStyle: whole-rule domain wrap", () => {
  const css = `@-moz-document domain("example.com") {
  body { background: #000; color: #fff; }
}`;
  const chunks = splitUserStyle(css);
  assertEquals(chunks.length, 1);
  assertEquals(chunks[0].targets, [{ type: "domain", value: "example.com" }]);
  assert(chunks[0].css.includes("background: #000"));
  assert(!chunks[0].css.includes("@-moz-document"));
});

Deno.test("splitUserStyle: mixing unscoped and multi-selector", () => {
  const css = `:root { --x: 1; }
@-moz-document url-prefix("https://a.example/"), domain("b.example") {
  .btn { color: red; }
  .card { border: 0; }
}`;
  const chunks = splitUserStyle(css);
  assertEquals(chunks.length, 2);
  assertEquals(chunks[0].targets, null);
  assertEquals(chunks[1].targets, [
    { type: "url-prefix", value: "https://a.example/" },
    { type: "domain", value: "b.example" },
  ]);
  assert(chunks[1].css.includes(".card { border: 0; }"));
});

Deno.test("splitUserStyle: unconditional when unwrapped", () => {
  const chunks = splitUserStyle("body { color: red; }");
  assertEquals(chunks.length, 1);
  assertEquals(chunks[0].targets, null);
});

Deno.test("targetsMatch: all four target types", () => {
  assert(targetsMatch(null, "https://anything.com/"));
  assert(targetsMatch([{ type: "domain", value: "example.com" }], "https://example.com/"));
  assert(targetsMatch([{ type: "domain", value: "example.com" }], "https://a.example.com/"));
  assert(!targetsMatch([{ type: "domain", value: "example.com" }], "https://notexample.com/"));
  assert(
    targetsMatch(
      [{ type: "url-prefix", value: "https://example.com/forum" }],
      "https://example.com/forum/t/1",
    ),
  );
  assert(
    !targetsMatch(
      [{ type: "url-prefix", value: "https://example.com/forum" }],
      "https://example.com/",
    ),
  );
  assert(
    targetsMatch(
      [{ type: "url", value: "https://example.com/exact" }],
      "https://example.com/exact",
    ),
  );
  assert(
    targetsMatch([{ type: "regexp", value: "example\\.(com|net)" }], "https://x.example.net/a"),
  );
  assert(!targetsMatch([{ type: "regexp", value: "[" }], "https://example.com/"));
  // Multiple targets are ORed
  const ts = [{ type: "domain" as const, value: "a.com" }, {
    type: "domain" as const,
    value: "b.com",
  }];
  assert(targetsMatch(ts, "https://b.com/"));
});

Deno.test("describeTargets", () => {
  // The empty-target case renders user-facing copy; assert only non-empty so the test stays language-agnostic.
  assert(describeTargets(null).length > 0);
  assertEquals(describeTargets([{ type: "domain", value: "a.com" }]), "domain: a.com");
});
