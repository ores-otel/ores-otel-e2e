import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadCompilerFixture, readJson, sha256, sourceLock, verifySources } from "./support.mjs";

const { compiler, fixture, schema, sources } = await loadCompilerFixture();
const expected = await readFile(new URL("./expected-manifest.json", import.meta.url), "utf8");
const generated = compiler.compileSchemaIr(fixture);
assert.equal(generated.ok, true, "Pinned example must compile before conformance runs.");
const entity = (input, name = "Member") => input.entities.find((item) => item.name === name);

// These test projections and bytes; they do not pretend to execute native compilers or SQL.
test("compiler discriminator agrees with the authoritative structural contract", () => {
  assert.equal(compiler.IR_VERSION, schema.properties.schemaVersion.const);
  assert.equal(fixture.schemaVersion, compiler.IR_VERSION);
  assert.equal(schema.additionalProperties, false);
});
test("all output bytes match the separately committed golden manifest", () => {
  assert.equal(generated.files["manifest.json"], expected);
  const manifest = JSON.parse(expected);
  assert.deepEqual(manifest.artifacts.map((item) => item.path).sort(), Object.keys(generated.files).filter((path) => path !== "manifest.json").sort());
  for (const artifact of manifest.artifacts) assert.equal(sha256(generated.files[artifact.path]), artifact.sha256, artifact.path);
  assert.equal(sha256(generated.files["schema-ir.json"]), generated.irSha256);
});
test("raw and normalized IR generate identical artifacts", () => {
  assert.deepEqual(compiler.compileSchemaIr(JSON.parse(generated.files["schema-ir.json"])), generated);
});
test("permuted declarations do not alter artifact digests", () => {
  const input = structuredClone(fixture);
  input.entities.reverse().forEach((item) => { item.fields.reverse(); item.indexes?.reverse(); item.uniqueKeys?.reverse(); item.foreignKeys?.reverse(); });
  assert.deepEqual(compiler.compileSchemaIr(input), generated);
});
test("canonical input remains unmodified", () => {
  const before = JSON.stringify(fixture);
  compiler.compileSchemaIr(fixture);
  assert.equal(JSON.stringify(fixture), before);
});
for (const model of fixture.entities) test(`JSON Schema projection preserves ${model.name} field presence, types and bounds`, () => {
  const output = JSON.parse(generated.files[`json-schema/${model.name}.schema.json`]);
  const types = { string: "string", uuid: "string", int32: "integer", boolean: "boolean" };
  assert.equal(output.additionalProperties, false);
  assert.deepEqual(Object.keys(output.properties).sort(), model.fields.map((field) => field.name).sort());
  assert.deepEqual(output.required.sort(), model.fields.filter((field) => field.required).map((field) => field.name).sort());
  for (const field of model.fields) {
    const property = output.properties[field.name];
    assert.deepEqual(property.type, field.nullable ? [types[field.type], "null"] : types[field.type]);
    for (const key of ["minimum", "maximum", "minLength", "maxLength"]) if (field[key] !== undefined) assert.equal(property[key], field[key]);
  }
});
test("desired SQL retains composite uniqueness and ordered foreign-key target", () => {
  const sql = generated.files["postgres/desired.sql"];
  assert.match(sql, /UNIQUE \("organization_id", "display_name"\)/);
  assert.match(sql, /FOREIGN KEY \("organization_id"\) REFERENCES "schema_example"\."organizations" \("id"\)/);
  assert.ok(sql.indexOf("ALTER TABLE") > sql.lastIndexOf("CREATE TABLE"));
});
test("native type artifacts retain optional-nullable distinctions", () => {
  assert.match(generated.files["typescript/models.ts"], /readonly nickname\?: string \| null;/);
  assert.match(generated.files["rust/models.rs"], /pub r#nickname: SchemaOptional<std::option::Option<std::string::String>>/);
  assert.match(generated.files["dart/models.dart"], /final SchemaOptional<String\?> nickname;/);
  assert.match(generated.files["cue/models.cue"], /"nickname"\?: null \| \(string/);
});
const negatives = [
  ["unsupported frontend metadata", (x) => { x.typespec = "unknown"; }, "UNKNOWN_PROPERTY"],
  ["injected SQL identifier", (x) => { entity(x).table = 'members"; DROP SCHEMA x; --'; }, "INVALID_IDENTIFIER"],
  ["unknown scalar", (x) => { entity(x).fields[0].type = "decimal"; }, "UNSUPPORTED_TYPE"],
  ["optional primary key", (x) => { entity(x).fields[0].required = false; }, "INVALID_PRIMARY_KEY"],
  ["missing FK target", (x) => { entity(x).foreignKeys[0].references.entity = "Absent"; }, "INVALID_REFERENCE"],
  ["nullable metadata list", (x) => { entity(x).indexes = null; }, "INVALID_ARRAY"],
  ["future model version", (x) => { x.schemaVersion = "ores.schema-ir.v2"; }, "UNSUPPORTED_VERSION"],
  ["PostgreSQL system column", (x) => { entity(x).fields[0].column = "ctid"; }, "INVALID_IDENTIFIER"],
];
for (const [name, mutate, code] of negatives) test(`cross-repository input rejects ${name} without partial files`, () => {
  const input = structuredClone(fixture); mutate(input);
  const result = compiler.compileSchemaIr(input);
  assert.equal(result.ok, false); assert.equal(result.errors[0].code, code);
  assert.equal(Object.hasOwn(result, "files"), false);
});
test("data-validator fixture corpus includes both positive and negative cases", async () => {
  const cases = await readJson(new URL("./instances.json", import.meta.url));
  assert.equal(cases.length, 19);
  assert.ok(cases.some((item) => item.valid) && cases.some((item) => !item.valid));
  for (const item of cases) assert.ok(Object.hasOwn(generated.files, `json-schema/${item.entity}.schema.json`));
});
for (const scenario of ["changed", "missing", "symlink"]) test(`source-integrity gate rejects ${scenario} compiler before import`, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "ores-schema-inputs-"));
  try {
    const root = join(temporary, "core");
    for (const [path, content] of Object.entries(sources.core.files)) {
      const destination = join(root, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content);
    }
    const file = join(root, "languages/typescript/src/schema-ir/index.js");
    if (scenario === "changed") await writeFile(file, "throw new Error('UNVERIFIED_CODE_MUST_NOT_RUN');\n");
    else {
      await rm(file);
      if (scenario === "symlink") { const outside = join(temporary, "outside.js"); await writeFile(outside, sources.core.files["languages/typescript/src/schema-ir/index.js"]); await symlink(outside, file); }
    }
    await assert.rejects(loadCompilerFixture({ core: root, interfaces: sources.interfaces.root }), (error) => {
      if (scenario === "changed") return /Pinned source mismatch/.test(error.message);
      if (scenario === "missing") return error.code === "ENOENT";
      return /Source escapes/.test(error.message);
    });
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
test("pinned package metadata is also verified", async () => {
  assert.ok(Object.hasOwn(sourceLock.packages.core.files, "languages/typescript/package.json"));
  assert.equal(JSON.parse(sources.core.files["languages/typescript/package.json"]).type, "module");
  assert.equal(Object.keys(await verifySources()).length, 2);
});
