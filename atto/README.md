# Native AttoLang telemetry boundary (candidate)

`src/span_sequence_gate.atto` enforces bounded local span/event sequence
admission without reflection, host code or synchronous I/O. It deliberately
does not fabricate an OpenTelemetry wire export API. The `tests/*.atto`
fixture returns a different nonzero code for each violated invariant.

No compiler-backed execution is claimed. Add a pinned backend compile/run gate
and record the exact source tree, process exit code, actual job steps and
negative mutation proof before treating the guest as verified. The JS
`live-api.e2e.mjs` tests target deployed real HTTP services, not mock servers.
Until a deployed service is supplied, they explicitly skip; run the strict
`npm run test:live` command with `ORES_OTEL_BASE_URL` set.
