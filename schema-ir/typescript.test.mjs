/** Explicit additional gate: missing tsc is a failure, never a silently skipped pass. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadCompilerFixture } from "./support.mjs";

const { compiler, fixture, sources } = await loadCompilerFixture();
test("generated TypeScript compiles under strict and exact optional rules", async () => {
  const result = compiler.compileSchemaIr(fixture);
  assert.equal(result.ok, true);
  const temporary = await mkdtemp(join(tmpdir(), "ores-schema-ts-"));
  try {
    const models = join(temporary, "models.ts");
    const consumer = join(temporary, "consumer.ts");
    await writeFile(models, result.files["typescript/models.ts"]);
    await writeFile(consumer, [
      'import type { Member } from "./models.js";',
      'const member: Member = { id: "synthetic", organizationId: "synthetic", displayName: "Synthetic", score: 4, enabled: true };',
      'const nullable: Member = { ...member, nickname: null };',
      '// @ts-expect-error A required non-nullable value cannot be null.',
      'const invalidNull: Member = { ...member, displayName: null };',
      '// @ts-expect-error An optional property cannot be present undefined.',
      'const invalidUndefined: Member = { ...member, nickname: undefined };',
      '// @ts-expect-error Generated properties are readonly.',
      'member.score = 5;',
      'void nullable; void invalidNull; void invalidUndefined;',
      '',
    ].join("\n"));
    const check = spawnSync("tsc", ["--noEmit", "--strict", "--exactOptionalPropertyTypes", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", models, consumer, join(sources.interfaces.root, "contracts/schema-ir/v1/types.d.ts"), join(sources.core.root, "languages/typescript/src/schema-ir/index.d.ts")], { encoding: "utf8", timeout: 30000 });
    assert.equal(check.error, undefined, "tsc must already be available through the approved toolchain.");
    assert.equal(check.status, 0, `${check.stdout}\n${check.stderr}`);
    assert.equal(await readFile(models, "utf8"), result.files["typescript/models.ts"]);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
