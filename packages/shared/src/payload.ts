import { base64ToBytes, bytesToBase64 } from "./util.ts";
import type { PreparedScript } from "./types.ts";

/**
 * Deterministic delivery carrier between the bridge (isolated world) and the
 * runner (MAIN world).
 *
 * The bridge serializes the delivery payload and writes it as the text content
 * of a dedicated, inert element (`<script type="application/x-infinmonkey-payload">`).
 * The runner discovers that element - by initial scan or by MutationObserver -
 * and executes. The dependency is structural: *the element exists* is the
 * trigger, so neither listener-registration order nor message-bus timing can
 * lose a delivery. base64 keeps the payload inert (no `</script>` breakout) and
 * byte-exact (no re-serialization drift).
 */

export const PAYLOAD_ELEMENT_ID = "infinmonkey-payload";

/** Primary carrier: this attribute on documentElement (`setAttribute`, readable in every world). */
export const PAYLOAD_ATTR = "data-infin-payload";

export interface DeliveryPayload {
  /** Page URL of the delivering frame; used to suppress value-change echoes. */
  frameKey: string;
  scripts: PreparedScript[];
  styles: { id: string; css: string }[];
}

export function encodeDeliveryPayload(payload: DeliveryPayload): string {
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(payload)));
}

export function decodeDeliveryPayload(text: string): DeliveryPayload | null {
  try {
    const bytes = base64ToBytes(text);
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as DeliveryPayload;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.frameKey !== "string" ||
      !Array.isArray(parsed.scripts) ||
      !Array.isArray(parsed.styles)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
