import { assert } from "@std/assert";
import { globToRegExp, matchPatternToRegExp, urlMatchesMeta } from "@infinmonkey/shared/matcher";

Deno.test("matchPatternToRegExp: 标准模式", () => {
  const r1 = matchPatternToRegExp("https://example.com/*")!;
  assert(r1.test("https://example.com/"));
  assert(r1.test("https://example.com/a/b?c=1"));
  assert(!r1.test("http://example.com/"));
  assert(!r1.test("https://sub.example.com/"));

  const r2 = matchPatternToRegExp("*://*.example.org/*")!;
  assert(r2.test("https://example.org/x"));
  assert(r2.test("http://a.b.example.org/x"));
  assert(!r2.test("https://example.orgx/"));

  const r3 = matchPatternToRegExp("<all_urls>")!;
  assert(r3.test("https://a.b/"));
  assert(r3.test("file:///x"));

  const r4 = matchPatternToRegExp("file:///*")!;
  assert(r4.test("file:///Users/x/y.js"));
  assert(!r4.test("https://x/"));
});

Deno.test("matchPatternToRegExp: 无通配路径允许查询串", () => {
  const r = matchPatternToRegExp("https://example.com/path")!;
  assert(r.test("https://example.com/path?x=1"));
  assert(!r.test("https://example.com/other"));
});

Deno.test("globToRegExp: glob 与 /regex/ 形式", () => {
  const g = globToRegExp("*.example.com/*")!;
  assert(g.test("https://www.example.com/a"));
  assert(g.test("http://example.com/"));
  assert(!g.test("https://example.org/"));

  const re = globToRegExp("/^https:\\/\\/example\\.(com|org)\\//")!;
  assert(re.test("https://example.com/"));
  assert(!re.test("http://example.com/"));

  assert(globToRegExp("") === null);
  assert(globToRegExp("/bad[(/") === null);
});

Deno.test("urlMatchesMeta: 正负组合与默认全站", () => {
  const meta = {
    matches: ["https://example.com/*"],
    includes: [] as string[],
    excludes: ["https://example.com/private*"],
  };
  assert(urlMatchesMeta("https://example.com/page", meta));
  assert(!urlMatchesMeta("https://example.com/private/x", meta));
  assert(!urlMatchesMeta("https://other.com/", meta));

  // 都没声明 → 对网页协议默认全站
  const all = { matches: [], includes: [], excludes: [] };
  assert(urlMatchesMeta("https://anything.example/", all));
  assert(!urlMatchesMeta("moz-extension://abc/x", all));

  // 只有 include
  const inc = { matches: [], includes: ["*.wiki*"], excludes: [] };
  assert(urlMatchesMeta("https://zh.wikipedia.org/x", inc));
  assert(!urlMatchesMeta("https://example.com/", inc));
});
