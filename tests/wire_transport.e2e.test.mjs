import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';

// Disposable live HTTP fixtures: this proves transport semantics, not a deployed OTel owner.
async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    close: () => new Promise((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve())),
  };
}

async function runFixture(upstreamHandler, scenario) {
  const deliveries = [];
  const upstream = await listen(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const receipt = {
      tenant: request.headers['x-tenant'],
      trace: request.headers.traceparent,
      auth: request.headers.authorization,
      body,
    };
    deliveries.push(receipt);
    upstreamHandler(request, response, receipt);
  });
  const gateway = await listen(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/logs') {
      response.writeHead(404).end(); return;
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      chunks.push(chunk);
      if (bytes > 2048) {
        response.writeHead(413).end();
        return;
      }
    }
    const body = Buffer.concat(chunks);
    try {
      const record = JSON.parse(body);
      if (typeof record.message !== 'string' || record.message.length === 0) {
        response.writeHead(422).end(); return;
      }
    } catch {
      response.writeHead(400).end(); return;
    }
    const forwarded = await fetch(upstream.url + '/ingest', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tenant': String(request.headers['x-tenant'] ?? ''),
        traceparent: String(request.headers.traceparent ?? ''),
      },
      body,
      signal: AbortSignal.timeout(3000),
    });
    response.writeHead(forwarded.status).end();
  });
  try { await scenario(gateway.url, deliveries); }
  finally { await gateway.close(); await upstream.close(); }
}

const TRACE = '00-0123456789abcdef0123456789abcdef-abcdef0123456789ab-01';
const send = (url, tenant, body = JSON.stringify({message:'synthetic'})) =>
  fetch(url + '/v1/logs', {
    method: 'POST',
    headers: {
      'x-tenant': tenant,
      traceparent: TRACE,
      authorization: 'Bearer synthetic-not-a-secret',
    },
    body,
    signal: AbortSignal.timeout(3000),
  });

test('20 concurrent client-to-gateway-to-collector sends preserve isolation and drop bearer', async () => {
  await runFixture((_request, response) => response.writeHead(202).end(), async (url, deliveries) => {
    const tenants = Array.from({length:20}, (_, i) => i % 2 ? 'tenant-a' : 'tenant-b');
    const replies = await Promise.all(tenants.map(t => send(url, t)));
    assert.deepEqual(replies.map(x => x.status), Array(20).fill(202));
    assert.equal(deliveries.length, 20);
    assert.equal(deliveries.filter(x => x.tenant === 'tenant-a').length, 10);
    assert.equal(deliveries.filter(x => x.tenant === 'tenant-b').length, 10);
    assert.ok(deliveries.every(x => x.trace === TRACE && x.auth === undefined));
  });
});

test('malformed and invalid record bodies fail before the collector', async () => {
  await runFixture((_request, response) => response.writeHead(202).end(), async (url, deliveries) => {
    assert.equal((await send(url, 'tenant-a', '{')).status, 400);
    assert.equal((await send(url, 'tenant-a', JSON.stringify({message:42}))).status, 422);
    assert.equal(deliveries.length, 0);
  });
});

test('payload budget rejects 2049 bytes while admitting exactly 2048 bytes', async () => {
  await runFixture((_request, response) => response.writeHead(202).end(), async (url, deliveries) => {
    const exact = JSON.stringify({message:'x'.repeat(2034)});
    assert.equal(Buffer.byteLength(exact), 2048);
    assert.equal((await send(url, 'tenant-a', exact)).status, 202);
    assert.equal((await send(url, 'tenant-a', exact + ' ')).status, 413);
    assert.equal(deliveries.length, 1);
  });
});

test('collector 503 is propagated exactly once rather than retrying non-idempotent POST', async () => {
  await runFixture((_request, response) => response.writeHead(503).end(), async (url, deliveries) => {
    assert.equal((await send(url, 'tenant-a')).status, 503);
    assert.equal(deliveries.length, 1);
  });
});
