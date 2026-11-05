# AttoLang integration surface

`src/telemetry_policy.atto` provides a pure, bounds-checked telemetry batching and retry policy.
This is native AttoLang source, not a TypeScript shim and not a claim that any
AttoLang compiler currently runs it. Wire serialization, transport permissions,
actor scheduling, ownership and callback invocation remain future adapter work.

The HTTP integration fixture is executed by `npm test`. The separate exact-head
production-owner gate runs only when `OTEL_OWNER_BASE_URL` and
`OTEL_OWNER_SHA` are provided (or fails closed if
`REQUIRE_OTEL_OWNER_E2E=1`). Static acceptance of this file must not be
reported as compiler-backed execution.
