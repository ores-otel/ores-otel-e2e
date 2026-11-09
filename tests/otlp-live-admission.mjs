import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

// This gate proves *HTTP admission only*, not durable storage or exporter delivery.
const SIGNALS = Object.freeze(['traces', 'logs', 'metrics']);
const RESOURCE = { attributes: [{ key: 'service.name', value: { stringValue: 'ores-otel-admission-smoke' } }] };

export function validateTarget(rawUrl, token) {
  assert.equal(typeof rawUrl, 'string', 'OTLP_BASE_URL must be set');
  assert.equal(typeof token, 'string', 'OTLP_SMOKE_BEARER must be set');
  assert.ok(token.trim().length >= 12, 'OTLP_SMOKE_BEARER must be a nonempty scoped test credential');
  const url = new URL(rawUrl);
  assert.ok(!url.username && !url.password && !url.search && !url.hash, 'no credentials, query, or fragment in target URL');
  assert.ok(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)), 'HTTPS required except loopback');
  return new URL(`${url.pathname.replace(/\/$/, '')}/`, url);
}

function fixture(signal, traceId, spanId, runId) {
  const time = String(BigInt(Date.now()) * 1_000_000n);
  const attr = [{ key: 'e2e.run', value: { stringValue: runId } }];
  if (signal === 'traces') return { resourceSpans: [{ resource: RESOURCE, scopeSpans: [{ scope: { name: 'ores-otel-e2e' }, spans: [{ traceId, spanId, name: 'e2e.otlp.admission', kind: 2, startTimeUnixNano: time, endTimeUnixNano: String(BigInt(time) + 1_000_000n), attributes: attr }] }] }] };
  if (signal === 'logs') return { resourceLogs: [{ resource: RESOURCE, scopeLogs: [{ scope: { name: 'ores-otel-e2e' }, logRecords: [{ timeUnixNano: time, severityNumber: 9, severityText: 'INFO', body: { stringValue: 'synthetic admission smoke' }, traceId, spanId, attributes: attr }] }] }] };
  return { resourceMetrics: [{ resource: RESOURCE, scopeMetrics: [{ scope: { name: 'ores-otel-e2e' }, metrics: [{ name: 'ores_otel_admission_smoke_total', sum: { dataPoints: [{ asInt: '1', timeUnixNano: time }], aggregationTemporality: 2, isMonotonic: true } }] }] }] };
}

async function exchange(fetchFn, url, payload, bearer, timeoutMs) {
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const response = await fetchFn(url, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  const length = Number(response.headers.get('content-length'));
  assert.ok(!Number.isFinite(length) || length <= 16384, 'response exceeds 16 KiB receipt limit');
  const reader = response.body?.getReader();
  let size = 0;
  const chunks = [];
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) { await reader.cancel(); throw new Error('response exceeds 16 KiB receipt limit'); }
      chunks.push(value);
    }
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  const text = new TextDecoder().decode(data);
  let parsed;
  if (response.status === 200 && text.trim()) {
    try { parsed = JSON.parse(text); } catch { throw new Error('non-JSON OTLP success response'); }
  }
  return { status: response.status, parsed };
}

export async function runOtlpAdmission({ baseUrl, bearer, fetchFn = fetch, timeoutMs = 5000 }) {
  const root = validateTarget(baseUrl, bearer);
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs >= 500 && timeoutMs <= 30000, 'bounded timeout required');
  const runId = randomBytes(8).toString('hex');
  const traceId = randomBytes(16).toString('hex');
  const spanId = randomBytes(8).toString('hex');
  const result = [];
  for (const signal of SIGNALS) {
    const url = new URL(`v1/${signal}`, root);
    const payload = JSON.stringify(fixture(signal, traceId, spanId, runId));
    const positive = await exchange(fetchFn, url, payload, bearer, timeoutMs);
    assert.equal(positive.status, 200, `${signal}: expected OTLP/HTTP 200 admission, received ${positive.status}`);
    const rejected = positive.parsed?.partialSuccess?.[signal === 'traces' ? 'rejectedSpans' : signal === 'logs' ? 'rejectedLogRecords' : 'rejectedDataPoints'];
    assert.ok(rejected === undefined || rejected === 0 || rejected === '0', `${signal}: response indicates partial rejection`);
    const unauthorized = await exchange(fetchFn, url, payload, null, timeoutMs);
    assert.ok([401, 403].includes(unauthorized.status), `${signal}: missing auth was not rejected`);
    const malformed = await exchange(fetchFn, url, '{', bearer, timeoutMs);
    assert.ok([400, 415, 422].includes(malformed.status), `${signal}: malformed JSON was not rejected`);
    result.push({ signal, accepted: true, missingAuthDenied: true, malformedRejected: true });
  }
  return Object.freeze({ classification: 'OTLP_HTTP_ADMISSION_ONLY', runId, signals: result, exportVerified: false, queryVerified: false, guestVerified: false });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const result = await runOtlpAdmission({ baseUrl: process.env.OTLP_BASE_URL, bearer: process.env.OTLP_SMOKE_BEARER });
    console.log(JSON.stringify(result));
  } catch (error) {
    // Never print the target URL, body, headers, or bearer on failure.
    console.error(`OTLP admission smoke FAILED: ${error.message.replace(/https?:\/\/[^ ]+/g, '[redacted-url]')}`);
    process.exitCode = 1;
  }
}
