/**
 * Site controls verdicts (shared/settings userAllows).
 *
 * The gate sits in front of injection (bridge) and GM authorization
 * (background), so its table pins: master off denies everywhere, blacklist
 * patterns deny only their own URLs, and a malformed pattern is skipped
 * rather than taking the whole gate down.
 */
import { assert, assertFalse } from "@std/assert";
import { userAllows } from "@infinmonkey/shared/settings";

Deno.test("master off denies regardless of URL, even an unknown one", () => {
  assertFalse(userAllows("https://a.test/", { masterEnabled: false }));
  assertFalse(userAllows(undefined, { masterEnabled: false }));
});

Deno.test("blacklist patterns deny only their own URLs", () => {
  const settings = { masterEnabled: true, siteBlacklist: ["https://a.test/*"] };
  assertFalse(userAllows("https://a.test/x", settings));
  assertFalse(userAllows("https://a.test/", settings));
  assert(userAllows("https://b.test/x", settings));
  assert(userAllows("https://a.test.evil.test/x", settings));
});

Deno.test("wildcard scheme/host patterns behave like match patterns", () => {
  const settings = { masterEnabled: true, siteBlacklist: ["*://ads.example.com/*"] };
  assertFalse(userAllows("https://ads.example.com/x", settings));
  assertFalse(userAllows("http://ads.example.com/x", settings));
  assert(userAllows("https://example.com/x", settings));
});

Deno.test("a malformed pattern is skipped, not fatal", () => {
  const settings = { masterEnabled: true, siteBlacklist: ["not a pattern", ""] };
  assert(userAllows("https://a.test/x", settings));
});

Deno.test("an unknown URL passes the site checks (the GM layer fails closed on it)", () => {
  assert(userAllows(undefined, { masterEnabled: true, siteBlacklist: ["https://a.test/*"] }));
});

Deno.test("fragments do not let a page escape the blacklist", () => {
  const settings = { masterEnabled: true, siteBlacklist: ["https://a.test/page"] };
  assertFalse(userAllows("https://a.test/page#section", settings));
});

Deno.test("defaulting: missing settings or an empty list allow everything", () => {
  assert(userAllows("https://a.test/", undefined));
  assert(userAllows("https://a.test/", {}));
  assert(userAllows("https://a.test/", { masterEnabled: true, siteBlacklist: [] }));
});
