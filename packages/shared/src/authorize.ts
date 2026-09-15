import { urlMatchesMeta } from "./matcher.ts";
import type { AnyEntry } from "./types.ts";

/**
 * Permission gate for GM_* calls.
 *
 * The calling page must be inside the script's own declared scope: a page
 * where the script does not run has no business invoking its GM APIs, and a
 * request that claims otherwise cannot be trusted (the transport between the
 * injected runner and the bridge is a shared, page-observable channel - see
 * bridge.ts). The authoritative inputs are therefore the browser-provided
 * sender URL and the script's own metadata; nothing from the request body
 * participates in this decision.
 *
 * `url === undefined` fails closed: engines we support report the sender URL
 * (verified on Firefox/Zen and Chromium).
 */
export type GmAuthorization =
  | { ok: true }
  | { ok: false; code: GmDenyCode; reason: string };

export type GmDenyCode = "unknownScript" | "notScript" | "disabled" | "urlUnknown" | "urlMismatch";

export function authorizeGmCall(entry: AnyEntry, url: string | undefined): GmAuthorization {
  if (entry.kind !== "script") {
    return { ok: false, code: "notScript", reason: "not a userscript" };
  }
  if (!entry.enabled) {
    return { ok: false, code: "disabled", reason: "script is disabled" };
  }
  if (url === undefined) {
    return { ok: false, code: "urlUnknown", reason: "calling page URL is unknown" };
  }
  if (!urlMatchesMeta(url, entry.meta)) {
    return { ok: false, code: "urlMismatch", reason: "script does not run on this page" };
  }
  return { ok: true };
}
