import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

// Real loopback HTTP wire tests of the integration fixture. These do not
// certify the production Rust owner; that is the separate owner-live gate.
const TRACE = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01';

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function bodyOf(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65_536) throw new RangeError('payload too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function withGateway(run) {
  const received = [];
  const collector = await listen(async (req, res) => {
    const body = await bodyOf(req);
    if (req.method !== 'POST' || req.url !== '/v1/records') {
      res.writeHead(404).end();
      return;
    }
    if (!/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/.test(String(req.headers.traceparent))) {
      res.writeHead(400).end();
      return;
    }
    const event = JSON.parse(body);
    if (event.reject === true) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'collector_unavailable' }));
      return;
    }
    received.push({ event, headers: req.headers });
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ accepted: true }));
  });
  const gateway = await listen(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/ingest') {
      res.writeHead(404).end();
      return;
    }
    let body;
    try {
      body = await bodyOf(req);
      JSON.parse(body);
    } catch (error) {
      res.writeHead(error instanceof RangeError ? 413 : 400).end();
      return;
    }
    try {
      const response = await fetch(collector.url + '/v1/records', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          traceparent: String(req.headers.traceparent ?? ''),
          'x-tenant-id': String(req.headers['x-tenant-id'] ?? ''),
        },
        body,
        signal: AbortSignal.timeout(5_000),
      });
      res.writeHead(response.status, { 'content-type': 'application/json' });
      res.end(await response.text());
    } catch {
      res.writeHead(502).end();
    }
  });
  try {
    await run(gateway.url, received);
  } finally {
    await gateway.close();
    await collector.close();
  }
}

test('fixture client -> gateway -> collector preserves trace and tenant but strips auth', async () => {
  await withGateway(async (url, received) => {
    const responses = await Promise.all(['tenant-a', 'tenant-b', 'tenant-a'].map(
      (tenant, index) => fetch(url + '/ingest', {
        method: 'POST',
        headers: { traceparent: TRACE, 'x-tenant-id': tenant, authorization: 'Bearer fixture-secret' },
        body: JSON.stringify({ kind: 'span', sequence: index }),
      }),
    ));
    assert.deepEqual(responses.map((r) => r.status), [202, 202, 202]);
    assert.equal(received.length, 3);
    assert.deepEqual(received.map((r) => r.event.sequence).sort(), [0, 1, 2]);
    assert.deepEqual(received.map((r) => r.headers['x-tenant-id']).sort(), ['tenant-a', 'tenant-a', 'tenant-b']);
    for (const r of received) {
      assert.equal(r.headers.traceparent, TRACE);
      assert.equal(r.headers.authorization, undefined);
    }
  });
});

test('fixture malformed JSON is rejected before server-to-server forwarding', async () => {
  await withGateway(async (url, received) => {
    const response = await fetch(url + '/ingest', {
      method: 'POST', headers: { traceparent: TRACE }, body: '{not-json',
    });
    assert.equal(response.status, 400);
    assert.equal(received.length, 0);
    const wrongRoute = await fetch(url + '/other', { method: 'POST' });
    assert.equal(wrongRoute.status, 404);
  });
});

test('fixture upstream 503 propagates and is not recorded as accepted telemetry', async () => {
  await withGateway(async (url, received) => {
    const response = await fetch(url + '/ingest', {
      method: 'POST', headers: { traceparent: TRACE },
      body: JSON.stringify({ kind: 'span', reject: true }),
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'collector_unavailable');
    assert.equal(received.length, 0);
  });
});
