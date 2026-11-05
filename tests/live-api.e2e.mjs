import test from "node:test";
import assert from "node:assert/strict";

const base = process.env.ORES_OTEL_BASE_URL?.replace(/\/$/u, "");
const peer = process.env.ORES_OTEL_PEER_URL?.replace(/\/$/u, "");
const liveOnly = { skip: base ? false : "ORES_OTEL_BASE_URL is unset: no deployed server" };

async function jsonGet(origin, path) {
  const response = await fetch(origin + path, {
    method: "GET",
    headers: { accept: "application/json", traceparent: "00-11111111111111111111111111111111-2222222222222222-01" },
    signal: AbortSignal.timeout(5_000),
    redirect: "manual",
  });
  assert.equal(response.status, 200, `GET ${path} returned ${response.status}`);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/iu);
  const body = new Uint8Array(await response.arrayBuffer());
  assert.ok(body.byteLength > 0 && body.byteLength <= 64 * 1024, "bounded, nonempty JSON response");
  return JSON.parse(new TextDecoder().decode(body));
}

test("deployed Rust API responds over real HTTP with the authored health contract", liveOnly, async () => {
  const health = await jsonGet(base, "/health");
  assert.deepEqual(health, { ok: true, service: "ores-otel-api-server" });
});

test("deployed API exposes the catalog contract without invented APM paths", liveOnly, async () => {
  const catalog = await jsonGet(base, "/v1");
  assert.deepEqual(catalog, { resource: "TelemetryRecord" });
});

test("concurrent independent clients observe stable health/catalog responses", liveOnly, async () => {
  const paths = Array.from({ length: 24 }, (_, i) => i % 2 === 0 ? "/health" : "/v1");
  const responses = await Promise.all(paths.map(path => jsonGet(base, path)));
  for (let i = 0; i < paths.length; i += 1) {
    assert.deepEqual(responses[i], paths[i] === "/health"
      ? { ok: true, service: "ores-otel-api-server" }
      : { resource: "TelemetryRecord" });
  }
});

test("read-only projection rejects HTTP write to health", liveOnly, async () => {
  const response = await fetch(base + "/health", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ telemetry: "not-an-operation" }),
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
  assert.ok(response.status === 404 || response.status === 405,
    `unexpected write admission status: ${response.status}`);
  await response.arrayBuffer();
  assert.deepEqual(await jsonGet(base, "/health"), {
    ok: true, service: "ores-otel-api-server",
  });
});

test("optional second deployed server obeys the same network contract", {
  skip: peer ? false : "ORES_OTEL_PEER_URL is unset",
}, async () => {
  assert.deepEqual(await jsonGet(peer, "/health"), {
    ok: true, service: "ores-otel-api-server",
  });
  assert.deepEqual(await jsonGet(peer, "/v1"), { resource: "TelemetryRecord" });
});
