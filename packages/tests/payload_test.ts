import { assert, assertEquals } from "@std/assert";
import { decodeDeliveryPayload, encodeDeliveryPayload } from "@infinmonkey/shared/payload";
import type { DeliveryPayload } from "@infinmonkey/shared/payload";

function validPayload(overrides: Partial<DeliveryPayload> = {}): DeliveryPayload {
  return {
    frameKey: "https://example.org/frame",
    bridgeNonce: "nonce-1",
    scripts: [
      {
        id: "s1",
        name: "Demo",
        namespace: "",
        version: "1.0",
        description: "",
        author: "",
        icon: "",
        runAt: "document-end",
        noframes: false,
        grants: [],
        connects: [],
        code: "console.log(1);",
        requires: [],
        resources: [],
        metaPlain: {},
        headerRaw: "",
        values: {},
      },
    ],
    styles: [{ id: "st1", css: "body{color:red}" }],
    ...overrides,
  };
}

Deno.test("delivery payload roundtrips through encode and decode with bridgeNonce", () => {
  const decoded = decodeDeliveryPayload(encodeDeliveryPayload(validPayload()));
  assert(decoded !== null, "a well-formed payload must decode");
  assertEquals(decoded.bridgeNonce, "nonce-1");
  assertEquals(decoded.frameKey, "https://example.org/frame");
  assertEquals(decoded.scripts.length, 1);
  assertEquals(decoded.styles, [{ id: "st1", css: "body{color:red}" }]);
});

Deno.test("decodeDeliveryPayload rejects a payload missing bridgeNonce", () => {
  // The runner compares senderKey against bridgeNonce to compute `remote`;
  // a payload without it must be dropped, not defaulted to "".
  const missing = validPayload();
  delete (missing as unknown as Record<string, unknown>).bridgeNonce;
  assertEquals(decodeDeliveryPayload(encodeDeliveryPayload(missing)), null);
});

Deno.test("decodeDeliveryPayload rejects a non-string bridgeNonce", () => {
  const wrongType = validPayload({ bridgeNonce: 42 as unknown as string });
  assertEquals(decodeDeliveryPayload(encodeDeliveryPayload(wrongType)), null);
});

Deno.test("decodeDeliveryPayload still rejects garbage input", () => {
  assertEquals(decodeDeliveryPayload("not base64!"), null);
  assertEquals(decodeDeliveryPayload(""), null);
});
