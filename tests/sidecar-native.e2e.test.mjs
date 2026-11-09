import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createConnection, createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

// This suite MUST launch the real, pinned Rust sidecar binary. There is no
// in-process HTTP mock and no skip path when the binary is absent.
const BIN = process.env.OTEL_SIDECAR_BIN;
const SOURCE_DIR = process.env.OTEL_SIDECAR_DIR;
const SHA = process.env.OTEL_SIDECAR_SHA;
const MAX_REPLY = 64 * 1024;

async function availablePort() {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const { port } = reservation.address();
  await new Promise((done, fail) =>
    reservation.close((error) => (error ? fail(error) : done())));
  return port;
}

async function rawExchange(port, wire) {
  return new Promise((done, fail) => {
    const client = createConnection({ host: "127.0.0.1", port });
    const chunks = [];
    let length = 0;
    client.setTimeout(4_000, () => client.destroy(new Error("wire exchange timeout")));
    client.on("connect", () => client.end(wire));
    client.on("data", (bytes) => {
      length += bytes.length;
      if (length > MAX_REPLY) {
        client.destroy(new Error("unbounded HTTP response"));
        return;
      }
      chunks.push(bytes);
    });
    client.once("error", fail);
    client.once("end", () => done(Buffer.concat(chunks).toString("utf8")));
  });
}

function status(reply, expected) {
  assert.match(reply, new RegExp("^HTTP/1\\.1 " + expected + " "));
  assert.match(reply, /\r\ncache-control: no-store\r\n/i);
  assert.match(reply, /\r\nx-content-type-options: nosniff\r\n/i);
}

async function awaitReady(port, child) {
  for (let i = 0; i < 80; i += 1) {
    assert.equal(child.exitCode, null, "sidecar exited before serving");
    try {
      const reply = await fetch("http://127.0.0.1:" + port + "/readyz", {
        redirect: "manual",
        signal: AbortSignal.timeout(600),
      });
      if (reply.status === 200) {
        await reply.arrayBuffer();
        return;
      }
    } catch {
      // Expected during startup only; the bounded retry loop fails closed.
    }
    await delay(100);
  }
  throw new Error("pinned production sidecar never became ready");
}

async function shutdown(child) {
  const running = () => child.exitCode === null && child.signalCode === null;
  if (!child.pid || !running()) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([exited, delay(3_000)]);
  if (running()) {
    const killed = once(child, "exit");
    child.kill("SIGKILL");
    await killed;
  }
}

test("exact-source Rust sidecar process serves secure HTTP over real TCP", { timeout: 45_000 }, async (t) => {
  assert.ok(BIN, "OTEL_SIDECAR_BIN must name a compiled binary");
  assert.ok(SOURCE_DIR, "OTEL_SIDECAR_DIR must name the checked-out owner source");
  assert.match(SHA ?? "", /^[a-f0-9]{40}$/, "immutable sidecar source SHA is required");

  const port = await availablePort();
  const child = spawn(resolve(BIN), [], {
    cwd: resolve(SOURCE_DIR),
    env: {
      ...process.env,
      ORES_OTEL_SIDECAR_BIND: "127.0.0.1:" + port,
      ORES_OTEL_SIDECAR_ALLOW_NON_LOOPBACK: "false",
    },
    stdio: "ignore",
  });
  child.on("error", () => { /* bounded readiness check reports launch failure */ });
  try {
    await awaitReady(port, child);

    await t.test("health, readiness and metrics are served by the real binary", async () => {
      const health = await fetch("http://127.0.0.1:" + port + "/healthz", {
        signal: AbortSignal.timeout(3_000),
      });
      assert.equal(health.status, 200);
      assert.equal(health.headers.get("cache-control"), "no-store");
      const body = await health.json();
      assert.equal(body.ok, true);
      assert.equal(body.service, "ores-otel-sidecar");

      const metrics = await rawExchange(port,
        "GET /metrics HTTP/1.1\r\nHost: localhost\r\n\r\n");
      status(metrics, 200);
      assert.match(metrics, /ores_otel_sidecar_up/);
    });

    await t.test("HEAD responses and forbidden methods have deterministic status", async () => {
      const head = await rawExchange(port,
        "HEAD /readyz HTTP/1.1\r\nHost: localhost\r\n\r\n");
      status(head, 200);
      assert.equal(head.split("\r\n\r\n")[1], "");
      const post = await rawExchange(port,
        "POST /readyz HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n");
      status(post, 405);
      status(await rawExchange(port,
        "GET /admin HTTP/1.1\r\nHost: localhost\r\n\r\n"), 404);
    });

    await t.test("duplicate framing and truncated requests are rejected", async () => {
      const cases = [
        "GET /readyz HTTP/1.1\r\nHost: first\r\nHost: second\r\n\r\n",
        "GET /readyz HTTP/1.1\r\nHost: first\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n",
        "GET /readyz HTTP/1.1\r\nHost: first\r\n",
        "GET /readyz HTTP/1.1\nHost: first\n\n",
        "GET /readyz HTTP/1.1\r\nHost: first\r\n Folded: no\r\n\r\n",
      ];
      for (const wire of cases) {
        const reply = await rawExchange(port, wire);
        status(reply, 400);
      }
    });

    await t.test("oversized fields reject without poisoning subsequent probes", async () => {
      const oversized = "GET /readyz HTTP/1.1\r\nHost: localhost\r\nX-Fill: "
        + "x".repeat(4_096) + "\r\n\r\n";
      status(await rawExchange(port, oversized), 431);
      const good = await rawExchange(port,
        "GET /readyz HTTP/1.1\r\nHost: localhost\r\n\r\n");
      status(good, 200);
      assert.match(good, /"ok":true/);
    });
  } finally {
    await shutdown(child);
  }
});
