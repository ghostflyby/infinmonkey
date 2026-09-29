import { DEFAULT_DEV_ORIGIN } from "./constants.ts";
import { matchPatternToRegExp } from "./matcher.ts";

/**
 * Settings-derived decisions shared by the background and content scripts.
 *
 * Lives in shared because the installer/bridge (content scripts) and the
 * background must reach the same verdicts, and content scripts cannot import
 * from the background package.
 */

export function isDevOrigin(url: string, settings?: { devOrigin?: string }): boolean {
  const origin = settings?.devOrigin ?? DEFAULT_DEV_ORIGIN;
  return url.startsWith(origin + "/");
}

/**
 * Whether the manager may act on this URL at all: the master switch is on and
 * no blacklist pattern matches. Match-pattern semantics apply to the URL
 * without its #fragment. An unknown URL passes the site checks (the GM
 * authorization layer fails closed on it separately); malformed blacklist
 * patterns are skipped so a single typo cannot take down injection.
 */
export function userAllows(
  url: string | undefined,
  settings?: { masterEnabled?: boolean; siteBlacklist?: string[] },
): boolean {
  if (settings?.masterEnabled === false) return false;
  if (url === undefined) return true;
  const bare = url.split("#")[0];
  for (const pattern of settings?.siteBlacklist ?? []) {
    // matchPatternToRegExp yields null for a malformed pattern: skipped.
    if (matchPatternToRegExp(pattern)?.test(bare)) return false;
  }
  return true;
}
