import { DEFAULT_DEV_ORIGIN } from "./constants.ts";

/**
 * Settings-derived decisions shared by the background and content scripts.
 *
 * Lives in shared because the installer (content script) and the store
 * (background) must agree on what counts as a dev-mapped URL, and the
 * installer cannot import from the background package.
 */
export function isDevOrigin(url: string, settings?: { devOrigin?: string }): boolean {
  const origin = settings?.devOrigin ?? DEFAULT_DEV_ORIGIN;
  return url.startsWith(origin + "/");
}
