/**
 * Authorization rule for cross-origin `GM_xmlhttpRequest` targets.
 *
 * Pure policy, kept next to the matcher: declared @connect entries, permanent
 * user grants, and loopback addresses. No browser APIs, so every consumer
 * (background, tests, and a future native host) evaluates identical rules.
 */
/** @connect strict mode: declared match / user permanent grant / loopback addresses allowed. */
export function isConnectAllowed(connects: string[], grants: string[], host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]") return true;
  const list = [...connects, ...grants];
  for (const c0 of list) {
    const c = c0.trim().toLowerCase().replace(/^\./, "");
    if (!c) continue;
    if (c === "*") return true;
    if (c.startsWith("*.")) {
      const base = c.slice(2);
      if (h === base || h.endsWith("." + base)) return true;
    } else if (c === h) return true;
  }
  return false;
}
