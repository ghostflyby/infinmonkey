import { assert } from "@std/assert";
import { globToRegExp, matchPatternToRegExp, urlMatchesMeta } from "@infinmonkey/shared/matcher";

Deno.test("matchPatternToRegExp: standard patterns", () => {
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

Deno.test("matchPatternToRegExp: non-wildcard path allows query strings", () => {
  const r = matchPatternToRegExp("https://example.com/path")!;
  assert(r.test("https://example.com/path?x=1"));
  assert(!r.test("https://example.com/other"));
});

Deno.test("globToRegExp: glob and /regex/ forms", () => {
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

Deno.test("urlMatchesMeta: positive/negative combos and default all-sites", () => {
  const meta = {
    matches: ["https://example.com/*"],
    includes: [] as string[],
    excludes: ["https://example.com/private*"],
  };
  assert(urlMatchesMeta("https://example.com/page", meta));
  assert(!urlMatchesMeta("https://example.com/private/x", meta));
  assert(!urlMatchesMeta("https://other.com/", meta));

  // Nothing declared → all web protocols by default
  const all = { matches: [], includes: [], excludes: [] };
  assert(urlMatchesMeta("https://anything.example/", all));
  assert(!urlMatchesMeta("moz-extension://abc/x", all));

  // include only
  const inc = { matches: [], includes: ["*.wiki*"], excludes: [] };
  assert(urlMatchesMeta("https://zh.wikipedia.org/x", inc));
  assert(!urlMatchesMeta("https://example.com/", inc));
});
