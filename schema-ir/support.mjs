/** Source reads are an explicit test-harness effect, never a compiler effect. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const readJson = async (url) => JSON.parse(await readFile(url, "utf8"));
export const sourceLock = await readJson(new URL("./source-lock.json", import.meta.url));

export function defaultRoots() {
  return {
    interfaces: process.env.ORES_INTERFACES_DIR ?? fileURLToPath(new URL("../../ores-interfaces", import.meta.url)),
    core: process.env.ORES_LIB_CORE_DIR ?? fileURLToPath(new URL("../../ores-lib-core", import.meta.url)),
  };
}

/** Missing, changed, oversized or out-of-root inputs fail before importing code. */
export async function verifySources(roots = defaultRoots()) {
  assert.equal(sourceLock.version, 1);
  assert.equal(sourceLock.kind, "source-conformance-lock");
  assert.deepEqual(Object.keys(sourceLock.packages).sort(), ["core", "interfaces"]);
  const sources = {};
  for (const [key, entry] of Object.entries(sourceLock.packages)) {
    assert.match(entry.commit, /^[a-f0-9]{40}$/);
    const root = await realpath(roots[key]);
    const files = {};
    for (const [path, expected] of Object.entries(entry.files)) {
      assert.match(path, /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/);
      assert.ok(!path.split("/").some((part) => part === "." || part === ".."));
      assert.match(expected, /^[a-f0-9]{64}$/);
      const actual = await realpath(resolve(root, path));
      assert.ok(actual.startsWith(root + sep), "Source escapes its declared checkout.");
      const metadata = await stat(actual);
      assert.ok(metadata.isFile() && metadata.size <= 1024 * 1024, "Source is not a bounded regular file.");
      const bytes = await readFile(actual);
      assert.equal(sha256(bytes), expected, `Pinned source mismatch: ${entry.repository}/${path}`);
      files[path] = bytes.toString("utf8");
    }
    sources[key] = { root, files };
  }
  return sources;
}

export async function loadCompilerFixture(roots = defaultRoots()) {
  const sources = await verifySources(roots);
  const compiler = await import(pathToFileURL(resolve(sources.core.root, "languages/typescript/src/schema-ir/index.js")).href);
  return {
    sources,
    compiler,
    schema: JSON.parse(sources.interfaces.files["contracts/schema-ir/v1/schema.json"]),
    fixture: JSON.parse(sources.interfaces.files["contracts/schema-ir/v1/example.json"]),
  };
}
