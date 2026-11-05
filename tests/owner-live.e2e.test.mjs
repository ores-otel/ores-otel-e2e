import assert from 'node:assert/strict';
import test from 'node:test';

// Production-owner integration is opt-in but FAILS CLOSED in required mode.
// A pass must be accompanied by an immutable source SHA and a running owner.
const target = process.env.OTEL_OWNER_BASE_URL;
const required = process.env.REQUIRE_OTEL_OWNER_E2E === '1';
test('exact-head OTel Rust owner HTTP health and catalog', { skip: !target && !required }, async () => {
  assert.ok(target, 'OTEL_OWNER_BASE_URL is required');
  assert.match(process.env.OTEL_OWNER_SHA ?? '', /^[0-9a-f]{40}$/, 'OTEL_OWNER_SHA must bind the owner commit');
  const base = new URL(target);
  assert.ok(['http:', 'https:'].includes(base.protocol));
  for (const [path, verify] of [
    ['/health', (body) => { assert.equal(body.ok, true); assert.equal(body.service, 'ores-otel-api-server'); }],
    ['/v1', (body) => { assert.equal(body.resource, 'TelemetryRecord'); }],
  ]) {
    const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/i);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.ok(bytes.length > 0 && bytes.length <= 65_536, path + ' must be bounded');
    verify(JSON.parse(new TextDecoder().decode(bytes)));
  }
});
