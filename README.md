# ores-otel-e2e

End-to-end, integration, and contract tests for `ores-otel`.
Sibling production checkouts live under `~/codes/ores-otel`.

`npm test` runs the existing static contract checks and discovers the
live HTTP test suite. Real HTTP checks skip when no deployment is configured.

`ORES_OTEL_BASE_URL=http://127.0.0.1:3000 npm run test:live` is strict:
an absent base URL is an error; a non-listening service or unexpected contract
is a failure. Optionally set `ORES_OTEL_PEER_URL` to check another deployed
service against the same API contract. The routes are `GET /health`
(`{ok:true, service:"ores-otel-api-server"}`) and `GET /v1`
(`{resource:"TelemetryRecord"}`). These are real endpoint contracts from
`ores-otel-api-server.rs`. That server's current `run()` is a diagnostic
stub, not an HTTP listener, so the strict live tests need a genuine deployment.

AttoLang guest sources and execution caveats: [atto/README.md](atto/README.md).
