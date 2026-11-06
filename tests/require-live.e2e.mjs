import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const environment = { ...process.env };
delete environment.ORES_OTEL_BASE_URL;
delete environment.ORES_OTEL_PEER_URL;

function check(overrides = {}) {
  return spawnSync(process.execPath, ["tests/require-live.mjs"], {
    cwd: root,
    env: { ...environment, ...overrides },
    encoding: "utf8",
    timeout: 5_000,
  });
}

test("strict live E2E command fails closed if the deployed API base URL is missing", () => {
  const result = check();
  assert.notEqual(result.status, 0, "missing server URL was silently accepted");
  assert.match(result.stderr, /ORES_OTEL_BASE_URL/iu);
});

test("strict live E2E command rejects unsafe URL schemes, credentials and queries", () => {
  const badUrls = [
    "file:///tmp/fake-otel-server",
    "javascript:alert(1)",
    "http://user:password@127.0.0.1:19090",
    "http://127.0.0.1:19090/?redirect=https://elsewhere",
    "not-an-absolute-url",
  ];
  for (const value of badUrls) {
    const result = check({ ORES_OTEL_BASE_URL: value });
    assert.notEqual(result.status, 0, `unsafe base URL accepted: ${value}`);
  }
  const badPeer = check({
    ORES_OTEL_BASE_URL: "http://127.0.0.1:19090",
    ORES_OTEL_PEER_URL: "file:///tmp/peer",
  });
  assert.notEqual(badPeer.status, 0, "unsafe peer URL accepted");
});

test("strict live E2E command accepts absolute loopback HTTP and deployed HTTPS", () => {
  const result = check({
    ORES_OTEL_BASE_URL: "http://127.0.0.1:19090",
    ORES_OTEL_PEER_URL: "https://otel.example.test",
  });
  assert.equal(result.status, 0, result.stderr);
});
