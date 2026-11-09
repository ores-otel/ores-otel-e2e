import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { runOtlpAdmission, validateTarget } from './otlp-live-admission.mjs';

const bearer = 'synthetic-test-only-token';
async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
const handler = ({ allowAnonymous = false, rejectOne = false, partial = false } = {}) => (req, res) => {
  let bytes = '';
  req.on('data', data => { bytes += data; });
  req.on('end', () => {
    const auth = req.headers.authorization === `Bearer ${bearer}`;
    if (!auth && !allowAnonymous) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{}'); return; }
    try { JSON.parse(bytes); } catch { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{}'); return; }
    const signal = req.url.split('/').pop();
    if (rejectOne && signal === 'metrics') { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{}'); return; }
    const value = partial && signal === 'traces' ? { partialSuccess: { rejectedSpans: 1 } } : {};
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
  });
};

test('rejects missing, insecure and credential-bearing target configuration', () => {
  assert.throws(() => validateTarget(undefined, bearer));
  assert.throws(() => validateTarget('http://example.com', bearer));
  assert.throws(() => validateTarget('https://user:pass@example.com', bearer));
  assert.throws(() => validateTarget('https://example.com', 'short'));
});

test('real local TCP fixture verifies admission, missing auth and malformed JSON', async () => {
  await withServer(handler(), async baseUrl => {
    const result = await runOtlpAdmission({ baseUrl, bearer });
    assert.equal(result.classification, 'OTLP_HTTP_ADMISSION_ONLY');
    assert.deepEqual(result.signals.map(s => s.signal), ['traces', 'logs', 'metrics']);
    assert.equal(result.exportVerified, false);
    assert.equal(result.guestVerified, false);
  });
});

test('rejects anonymous ingest even when authorized requests succeed', async () => {
  await withServer(handler({ allowAnonymous: true }), async baseUrl => {
    await assert.rejects(runOtlpAdmission({ baseUrl, bearer }), /missing auth was not rejected/);
  });
});

test('rejects partial acceptance and server-side failures', async () => {
  await withServer(handler({ partial: true }), async baseUrl => {
    await assert.rejects(runOtlpAdmission({ baseUrl, bearer }), /partial rejection/);
  });
  await withServer(handler({ rejectOne: true }), async baseUrl => {
    await assert.rejects(runOtlpAdmission({ baseUrl, bearer }), /expected OTLP\/HTTP 200 admission/);
  });
});
