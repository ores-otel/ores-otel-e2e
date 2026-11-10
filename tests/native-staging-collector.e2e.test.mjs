import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { runOtlpAdmission } from './otlp-live-admission.mjs';

const AUTH = 'staging-synthetic-ingest-bearer-000000000';
const EXPORT_AUTH = 'staging-synthetic-export-bearer-000000000';
const executable = process.env.COLLECTOR_BIN;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
async function pickPort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function close(server) {
  if (!server.listening) return;
  await new Promise(resolve => server.close(resolve));
}
async function waitUntilReady(base, child) {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error('collector exited before serving health');
    try {
      const r = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(500) });
      if (r.status === 200) return;
    } catch { /* server not bound yet */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('collector did not become ready within bounded retry attempts');
}
async function request(base, signal, value, headers = {}) {
  return fetch(`${base}/v1/${signal}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${AUTH}`, 'content-type': 'application/json', ...headers },
    body: typeof value === 'string' ? value : JSON.stringify(value),
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
  });
}

test('immutable staging Rust binary performs real OTLP/HTTP admission and exporter forwarding', { timeout: 45_000 }, async t => {
  assert.ok(executable, 'COLLECTOR_BIN must be set by exact-SHA Rust build');
  const received = [];
  let exporterFails = false;
  let exporterPartial = false;
  let exporterBogus = false;
  const exporter = createServer((req, res) => {
    const chunks = [];
    let total = 0;
    req.on('data', data => {
      total += data.byteLength;
      if (total > 65536) req.destroy();
      else chunks.push(data);
    });
    req.on('end', () => {
      if (req.headers['x-ores-tenant-id'] !== 'synthetic_tenant' ||
          req.headers.authorization !== `Bearer ${EXPORT_AUTH}` ||
          !['/v1/traces', '/v1/logs', '/v1/metrics'].includes(req.url)) {
        res.writeHead(401); res.end(); return;
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); }
      catch { res.writeHead(400); res.end(); return; }
      received.push({ path: req.url, tenant: req.headers['x-ores-tenant-id'], body });
      res.writeHead(exporterFails ? 503 : 200, { 'content-type': 'application/json' });
      res.end(exporterBogus
        ? JSON.stringify({ unexpected: 'not-an-OTLP-response' })
        : exporterPartial
          ? JSON.stringify({ partialSuccess: { rejectedLogRecords: '1', errorMessage: 'sensitive downstream diagnostic' } })
          : '{}');
    });
  });
  const exportPort = await listen(exporter);
  const ingestPort = await pickPort();
  const base = `http://127.0.0.1:${ingestPort}`;
  const child = spawn(executable, [], {
    env: {
      PATH: process.env.PATH,
      ORES_OTEL_STAGING_BIND: `127.0.0.1:${ingestPort}`,
      ORES_OTEL_STAGING_TENANT: 'synthetic_tenant',
      ORES_OTEL_STAGING_BEARER: AUTH,
      ORES_OTEL_STAGING_EXPORTER: `http://127.0.0.1:${exportPort}`,
      ORES_OTEL_STAGING_EXPORTER_BEARER: EXPORT_AUTH,
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await close(exporter);
  });
  await waitUntilReady(base, child);
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
  const receipt = await runOtlpAdmission({ baseUrl: base, bearer: AUTH });
  assert.equal(receipt.classification, 'OTLP_HTTP_ADMISSION_ONLY');
  assert.equal(receipt.exportVerified, false);
  assert.deepEqual(received.map(r => r.path), ['/v1/traces', '/v1/logs', '/v1/metrics']);
  assert.ok(received.every(r => r.tenant === 'synthetic_tenant'));
  assert.equal(received[0].body.resourceSpans[0].scopeSpans[0].spans[0].traceId.length, 32);
  exporterPartial = true;
  const partial = await request(base, 'logs', { resourceLogs: [{ scopeLogs: [{ logRecords: [{ body: { stringValue: 'partial' } }] }] }] });
  assert.equal(partial.status, 200, 'OTLP partial success must not become retryable 503');
  const partialBody = await partial.json();
  assert.equal(partialBody.partialSuccess.rejectedLogRecords, '1');
  assert.equal(partialBody.partialSuccess.errorMessage, 'upstream exporter warning or partial rejection');
  assert.ok(!JSON.stringify(partialBody).includes('sensitive downstream diagnostic'));
  exporterPartial = false;

  exporterBogus = true;
  const bogus = await request(base, 'logs', { resourceLogs: [{ scopeLogs: [{ logRecords: [{}] }] }] });
  assert.equal(bogus.status, 502, 'unexpected exporter 200 body is not full acceptance');
  exporterBogus = false;

  const before = received.length;
  assert.equal((await request(base, 'logs', { resourceLogs: [{ scopeLogs: [{ logRecords: [{}] }] }] },
    { 'x-ores-tenant-id': 'forged_other_tenant' })).status, 403);
  assert.equal((await request(base, 'logs', { resourceLogs: [{ scopeLogs: [{ logRecords: [
    { attributes: [{ key: 'http.request.header.authorization', value: { stringValue: 'never' } }] },
  ] }] }] })).status, 400);
  assert.equal((await request(base, 'logs', '{')).status, 400);
  assert.equal((await request(base, 'logs', { resourceLogs: [{ scopeLogs: [{ logRecords: [
    { body: { stringValue: 'x'.repeat(70000) } },
  ] }] }] })).status, 413);
  assert.equal((await request(base, 'logs', { resourceLogs: [{ scopeLogs: [{ logRecords: [{}] }] }] },
    { 'content-encoding': 'gzip' })).status, 415);
  assert.equal(received.length, before, 'all rejected requests must be kept out of exporter');
  exporterFails = true;
  assert.equal((await request(base, 'logs', { resourceLogs: [{ scopeLogs: [{ logRecords: [{}] }] }] })).status, 503,
    'exporter failure cannot become a success acknowledgment');
  assert.equal(received.length, before + 1);
});
