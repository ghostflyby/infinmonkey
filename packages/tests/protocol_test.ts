import { assert } from "@std/assert";
import {
  isRequestFrame,
  isResponseFrame,
  isWireEntry,
  makeErr,
  makeOk,
  makeRequest,
  PROTOCOL_VERSION,
  type ResponseFrame,
} from "@infinmonkey/protocol";

const FIXTURES = new URL("./fixtures/protocol/", import.meta.url);

async function load(name: string): Promise<unknown> {
  return JSON.parse(await Deno.readTextFile(new URL(name, FIXTURES)));
}

Deno.test("protocol: request fixtures pass structural guards", async () => {
  for (const name of ["request-hello.json", "request-createEntry.json"]) {
    const f = await load(name);
    assert(isRequestFrame(f), `${name} should be a request frame`);
    assert((f as { v: number }).v === PROTOCOL_VERSION);
  }
});

Deno.test("protocol: response fixtures pass structural guards", async () => {
  const ok = await load("response-hello-ok.json");
  const err = await load("response-err.json");
  assert(isResponseFrame(ok));
  assert(isResponseFrame(err));
  const errFrame = err as Extract<ResponseFrame, { ok: false }>;
  assert((ok as { ok: boolean }).ok === true);
  assert(errFrame.error.code === "notFound");
});

Deno.test("protocol: wire entry fixture round-trips through JSON", async () => {
  const entry = await load("wire-entry.json");
  assert(isWireEntry(entry));
  const round = JSON.parse(JSON.stringify(entry)) as unknown;
  assert(isWireEntry(round));
});

Deno.test("protocol: builders emit frames matching the guards", () => {
  const req = makeRequest("ping", {});
  assert(isRequestFrame(req) && req.type === "ping");
  const ok = makeOk("x", { rev: 1 });
  const bad = makeErr("x", "badRequest", "nope");
  assert(isResponseFrame(ok) && ok.ok);
  assert(isResponseFrame(bad) && !bad.ok);
});

Deno.test("protocol: guards reject malformed frames", () => {
  assert(!isRequestFrame({ v: 999, id: "x", type: "ping" }));
  assert(!isRequestFrame(null));
  assert(!isResponseFrame({ v: 1, id: "x" }));
  assert(!isResponseFrame({ v: 1, id: "x", ok: false }));
  assert(!isWireEntry({ id: "e1", kind: "script" }));
});
