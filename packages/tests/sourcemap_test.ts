/**
 * Line-offset source maps for dev-mapped userscripts (shared/sourcemap.ts).
 *
 * The consumer of these maps is DevTools itself, so the tests verify the
 * wire format against the source map v3 spec independently of the encoder:
 * a small VLQ decoder is implemented here from the spec's arithmetic, and
 * the decoded mappings are reconstructed back into absolute
 * (generated line ↔ original line) pairs.
 */
import { assert, assertEquals } from "@std/assert";
import { buildLineOffsetSourceMap, devMapUrl, vlqEncode } from "@infinmonkey/shared/sourcemap";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Spec-inverse of vlqEncode: decodes one value from the front of a segment
 * string, returning the value and the rest. */
function vlqDecode(segment: string): { value: number; rest: string } {
  let result = 0;
  let shift = 0;
  let i = 0;
  do {
    const digit = B64.indexOf(segment[i]);
    assert(digit >= 0, `invalid base64 char ${segment[i]}`);
    result += (digit & 31) << shift;
    shift += 5;
    i++;
    if ((digit & 32) === 0) break;
  } while (true);
  const negative = (result & 1) === 1;
  const value = negative ? -(result >> 1) : result >> 1;
  return { value, rest: segment.slice(i) };
}

interface Segment {
  genLine: number;
  genCol: number;
  srcLine: number;
  srcCol: number;
}

/** Decodes one mappings segment into its VLQ fields. */
function decodeSegment(raw: string): number[] {
  const fields: number[] = [];
  let rest = raw;
  while (rest.length > 0) {
    const { value, rest: r } = vlqDecode(rest);
    fields.push(value);
    rest = r;
  }
  return fields;
}

/** Decodes a mappings string back into absolute segments (one per entry).
 * Our encoder always emits 4-field segments. */
function decodeMappings(mappings: string): Segment[] {
  const out: Segment[] = [];
  let srcIdx = 0;
  let srcLine = 0;
  let srcCol = 0;
  const genLines = mappings.split(";");
  for (let genLine = 0; genLine < genLines.length; genLine++) {
    let genCol = 0;
    for (const raw of genLines[genLine].split(",")) {
      if (raw === "") continue;
      const f = decodeSegment(raw);
      assertEquals(f.length, 4, "our maps always emit 4-field segments");
      genCol += f[0];
      srcIdx += f[1];
      srcLine += f[2];
      srcCol += f[3];
      assertEquals(srcIdx, 0, "our maps use exactly one source file");
      out.push({ genLine, genCol, srcLine, srcCol });
    }
  }
  return out;
}

Deno.test("vlqEncode matches spec-published vectors", () => {
  assertEquals(vlqEncode(0), "A");
  assertEquals(vlqEncode(1), "C");
  assertEquals(vlqEncode(-1), "D");
  assertEquals(vlqEncode(123), "2H");
  assertEquals(vlqEncode(16), "gB");
});

Deno.test("the map is a valid line-shift translation", () => {
  const text = "line 0\nline 1\nline 2";
  const map = JSON.parse(
    buildLineOffsetSourceMap({
      sourceContent: text,
      sourceUrl: "http://127.0.0.1:17321/demo.user.js",
      generatedLineOffset: 3,
      file: "demo.user.js",
    }),
  );
  assertEquals(map.version, 3);
  assertEquals(map.names, []);
  assertEquals(map.sources, ["http://127.0.0.1:17321/demo.user.js"]);
  assertEquals(map.sourcesContent, [text]);

  const segments = decodeMappings(map.mappings);
  // Every original line maps to original line L at generated line L + 3.
  assertEquals(segments.length, 3);
  for (let l = 0; l < 3; l++) {
    assertEquals(segments[l].genLine, l + 3);
    assertEquals(segments[l].genCol, 0);
    assertEquals(segments[l].srcLine, l);
    assertEquals(segments[l].srcCol, 0);
  }
});

Deno.test("zero offset yields an identity map with no skipped prefix lines", () => {
  const map = JSON.parse(
    buildLineOffsetSourceMap({
      sourceContent: "a\nb",
      sourceUrl: "http://x/s.js",
      generatedLineOffset: 0,
    }),
  );
  const segments = decodeMappings(map.mappings);
  assertEquals(segments.map((s) => `${s.genLine}->${s.srcLine}`), ["0->0", "1->1"]);
});

Deno.test("devMapUrl appends immap and merges into existing queries", () => {
  assertEquals(devMapUrl("http://x/a.user.js", 4), "http://x/a.user.js?immap=4");
  assertEquals(
    devMapUrl("http://x/a.user.js?as=html", 2),
    "http://x/a.user.js?as=html&immap=2",
  );
});
