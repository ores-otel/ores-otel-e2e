# Schema IR source conformance

This additive pilot exercises the actual contracts from `ores-otel/ores-interfaces`
and compiler from `ores-otel/ores-lib-core`. It does not introduce another domain
model, copied production implementation, migration authority, or dependency registry.

Companion changes:
- Contract: https://github.com/ores-otel/ores-interfaces/pull/9
- Compiler: https://github.com/ores-otel/ores-lib-core/pull/8

## Run against the pinned sources

Use the exact commits in `source-lock.json`. Obtain checkouts through the existing
authenticated Git workflow, or point at approved Zed-installed source snapshots
whose consumed file bytes match the lock. The harness never downloads dependencies,
uses credentials, changes checkouts, or applies SQL.

From this repository, with Node 20+ already installed:

```sh
ORES_INTERFACES_DIR=/path/to/ores-interfaces \
ORES_LIB_CORE_DIR=/path/to/ores-lib-core \
  node --test schema-ir/conformance.test.mjs
```

The default paths are sibling `ores-interfaces` and `ores-lib-core` directories.
Missing inputs, changed bytes, out-of-root symlinks and oversized source files
fail before compiler import. Tests copy only the enumerated locked source files
into private temporary directories, never an entire user checkout or its secrets.
Temporary files are removed after testing.

`source-lock.json` records source commits and SHA-256 hashes. It is **not** a Zed
package lock, registry release certification, full dependency attestation, or a
claim that arbitrary concurrent local modification is prevented. The dedicated
GitHub workflow additionally checks both checkout HEADs against the commit pins.

`expected-manifest.json` freezes the reviewed example's output digests. The suite
independently checks the digest of every artifact, exact artifact inventory,
normalization idempotence, declaration-order independence, presence/nullability,
relational projections, bad-reference rejection, and source-integrity failures.
Golden output is never automatically rewritten when a check fails.

## Additional explicit checks

With the approved TypeScript toolchain already available (no installation occurs):

```sh
ORES_INTERFACES_DIR=/path/to/ores-interfaces \
ORES_LIB_CORE_DIR=/path/to/ores-lib-core \
  node --test schema-ir/typescript.test.mjs
```

This emits models into a private temporary directory and invokes `tsc` with
`--strict --exactOptionalPropertyTypes`. Negative consumer assertions cover
required-null, present-undefined, and readonly writes. Missing `tsc` is a failure,
not a skip. Generated language types alone do not enforce runtime data bounds.

`instances.json` contains 19 synthetic data-validation cases for a standards-based
Draft 2020-12 validator: UUID shape/newline suffix, code-point lengths, nullability,
required fields, unknown properties, NUL, integer bounds, and boolean/integer
separation. The Node source suite checks that this corpus is present; **it does not
claim to be a general JSON Schema validator**. An independent Python `jsonschema`
validator was used locally to validate all 19 cases and the schema metaschemas;
no new Python implementation or dependency is shipped here.

## Evidence at authoring

- Compiler unit suite: 98 passed, no failures or skipped tests.
- Source-conformance suite: 22 passed, no failures or skipped tests.
- Strict TypeScript consumer gate: 1 passed, no failures or skipped tests.
- Structural IR metaschema/example and both output metaschemas: passed.
- Independent generated-data corpus: 19 passed.

The new CI workflow runs source conformance and the pinned compiler unit tests
only. Its check status must be read from the actual workflow run, not inferred
from these local results. Existing E2E workflows are untouched.

## Required next steps, in order

1. **Native acceptance gate.** Run generated Rust through `rustc`, Dart through
   the Dart 3 analyzer, CUE through `cue vet`, and desired SQL against a disposable
   PostgreSQL database. Add real positive/negative insert/update tests, FK cycles,
   Unicode and omitted/null cases. No production database is a test target.
   These four native gates were not available locally and are NOT marked passed.
2. **Real authoring frontend.** Implement a TypeSpec-to-IR emitter (and evaluate
   CUE authoring separately) with diagnostics for unsupported metadata. Test
   semantic parity, stable model IDs and explicit DB annotations. This pilot
   emits CUE; it does not yet accept TypeSpec/CUE input.
3. **Reviewed migrations and projections.** Integrate desired SQL with the
   existing declarative-migrations/Atlas path, including destructive-change
   blocking, schema diff review, data/backfill/lock plans and rollback strategy.
   Keep create/patch/read DTOs distinct, and preserve explicit RLS/grant policy.
4. **Zed release adoption.** Publish real package versions, resolve and commit
   authentic Zed artifact/digest locks, then repeat tests from those artifacts
   in the independent test organization before adopting in product repositories.

Do not promote the contract/compiler beyond draft solely because source hashes
or text snapshots pass. No migration, deployment, merge or production rollout
is authorized by this suite.
