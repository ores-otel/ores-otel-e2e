# ores-otel-e2e

End-to-end, integration, and contract tests for `ores-otel`.
Sibling production checkouts live under `~/codes/ores-otel`.

`npm test` runs the existing static contract checks and discovers the
live HTTP test suite. Real HTTP checks skip when no deployment is configured.

`ORES_OTEL_BASE_URL=http://127.0.0.1:3000 npm run test:live` is strict:
an absent or malformed base URL is an error; only absolute HTTP(S) origins
without embedded credentials, query strings, or fragments are accepted. A
non-listening service or unexpected contract is a failure. Optionally set `ORES_OTEL_PEER_URL` to check another deployed
service against the same API contract. The routes include `GET /health` and its SDK alias `GET /v1/health`
(`{ok:true, service:"ores-otel-api-server"}`), plus `GET /v1`
(`{resource:"TelemetryRecord"}`). The strict suite also checks HEAD, denied
writes, encoded-subroute rejection, and recovery after invalid requests. These are real endpoint contracts from
`ores-otel-api-server.rs`. The API server's existing mainline `run()` is a diagnostic stub;
[API PR #21](https://github.com/ores-otel/ores-otel-api-server.rs/pull/21)
introduces the listener and alias. Only execute the strict deployed tests
against a running binary that includes those changes. A green default CI run
with skipped live checks is not evidence of network interoperability.

AttoLang guest sources and execution caveats: [atto/README.md](atto/README.md).
