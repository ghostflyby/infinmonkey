import { assertEquals } from "@std/assert";
import { compareVersions } from "@infinmonkey/shared/version";

Deno.test("compareVersions", () => {
  assertEquals(compareVersions("1.2.3", "1.2.3"), 0);
  assertEquals(compareVersions("1.2.10", "1.2.9"), 1);
  assertEquals(compareVersions("1.0", "1.0.0"), 0);
  assertEquals(compareVersions("2.0.0", "1.9.9"), 1);
  assertEquals(compareVersions("1.0.0-beta", "1.0.0"), -1);
  assertEquals(compareVersions("1.0.0-beta", "1.0.0-alpha"), 1);
  assertEquals(compareVersions("v1.2.0", "1.1.0"), 1);
  assertEquals(compareVersions("", "1.0.0"), -1);
});
