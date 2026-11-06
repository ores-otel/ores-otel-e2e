import test from "node:test";
import assert from "node:assert/strict";

const base = process.env.ORES_OTEL_BASE_URL?.replace(/\/$/u, "");
const liveOnly = { skip: base ? false : "ORES_OTEL_BASE_URL is unset: live API not exercised" };

async function exchange(path, method = "GET") {
  const response = await fetch(base + path, {
    method,
    headers: { accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.ok(bytes.byteLength <= 64 * 1024, "API response must remain bounded");
  return { response, bytes };
}

test("deployed SDK /v1/health alias exactly matches canonical health over HTTP", liveOnly, async () => {
  const [canonical, sdk] = await Promise.all([
    exchange("/health"),
    exchange("/v1/health"),
  ]);
  for (const { response } of [canonical, sdk]) {
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/iu);
  }
  assert.deepEqual(JSON.parse(new TextDecoder().decode(sdk.bytes)), {
    ok: true,
    service: "ores-otel-api-server",
  });
  assert.deepEqual(sdk.bytes, canonical.bytes, "SDK and canonical health diverged");
});

test("deployed HTTP HEAD has no body and encoded-route probing cannot bypass read-only projection", liveOnly, async () => {
  const head = await exchange("/v1/health", "HEAD");
  assert.equal(head.response.status, 200);
  assert.equal(head.bytes.byteLength, 0, "HEAD unexpectedly returned a body");

  const encoded = await exchange("/v1/health%2Fadmin");
  assert.equal(encoded.response.status, 404, "encoded subroute unexpectedly admitted");

  const forbidden = await exchange("/v1/health", "POST");
  assert.equal(forbidden.response.status, 405, "write request was admitted on health route");

  const recovered = await exchange("/v1/health");
  assert.equal(recovered.response.status, 200, "invalid requests poisoned the health handler");
});
