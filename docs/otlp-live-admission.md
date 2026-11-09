# OTLP/HTTP live admission smoke — not an end-to-end telemetry certification

This optional test sends **synthetic** standard OTLP/HTTP JSON requests to an explicitly configured *test* collector at `/v1/traces`, `/v1/logs`, and `/v1/metrics`. It checks:
- authorized HTTP 200 success without nonzero `partialSuccess.rejected*`;
- anonymous/missing-bearer HTTP 401/403 on the same endpoint;
- malformed JSON HTTP 400/415/422;
- a bounded 5-second per-request timeout and max 16 KiB response.

It emits a random, non-secret run ID, W3C-size trace/span IDs, one synthetic log, one span, and one low-cardinality counter. No customer data, bearer token, or target URL appears in the success receipt. It does not send raw headers, user IDs, or untrusted full URLs as metric attributes.

## Fixture self-test (no production dependency)

```sh
node --test tests/otlp-live-admission.test.mjs
```

The fixture tests create a real **loopback TCP** mock receiver and assert positive, auth-negative, malformed-input, partial-success and server-error behavior. This proves only that the checker works. It cannot certify a production collector, durable storage, exporters, browser instrumentation or query UI.

## Live collector test (explicit opt-in)

Configure a **separate test-only authenticated collector** supporting all three OTLP/HTTP signals. Run:

```sh
OTLP_BASE_URL=https://your-test-collector.example/otlp \
OTLP_SMOKE_BEARER='your-scoped-test-bearer' \
node tests/otlp-live-admission.mjs
```

The script refuses missing bearer, insecure non-loopback URLs, URL-embedded credentials, redirects, non-200 acceptance, partial OTLP rejection, unauthenticated access or malformed JSON accepted as success. It fails closed if the real collector has not been deployed.

A workflow-dispatch live job may use repository variable `OTLP_SMOKE_BASE_URL` and secret `OTLP_SMOKE_BEARER` once the test receiver and short-lived token are provisioned. The workflow never runs the secret-bearing job for pull requests.

**Security:** Use only an isolated synthetic-data target and least-privilege, short-lived ingest-only credential. Do not run against an unapproved production backend; do not set tokens in URLs, arguments, commit contents, workflow inputs or log output.

## Evidence classification

The live checker prints `OTLP_HTTP_ADMISSION_ONLY`, with `exportVerified=false`, `queryVerified=false`, and `guestVerified=false`. Even a real 200 response could be followed by exporter failure. Durable persistence, two-tenant isolation, query read-back, automatic instrumentation and compiled AttoLang guest signals **must be certified separately** against exact source/deployment commits as described in [observability parity ADR-0002](https://github.com/ores-otel/ores-otel-docs/pull/8).

A failed or skipped live job is `NOT_EXECUTED` or `NOT_VERIFIED`, never a passing product E2E test.
