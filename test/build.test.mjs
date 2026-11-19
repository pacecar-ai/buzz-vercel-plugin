import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildPlugin } from "../src/build.mjs";
test("builds an origin-scoped, hash-pinned release with an automatic local sign-in return", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buzz-plugin-test-"));
  const origin = "https://gateway.example.org";
  const result = await buildPlugin({ origin, directory, folder: join(directory, "unpacked") });
  const artifact = await readFile(join(directory, result.sha256 + ".json"));
  assert.equal(createHash("sha256").update(artifact).digest("hex"), result.sha256);
  assert.deepEqual(JSON.parse(await readFile(join(directory, "release.json"))), result);
  const { manifest, code } = JSON.parse(artifact);
  assert.equal(manifest.id, "pacecar.vercel");
  assert.deepEqual(manifest.host.networkOrigins, [origin]);
  assert.equal(manifest.host.processes[0].args.at(-1), origin + "/connect/return/");
  assert.ok(Buffer.byteLength(manifest.host.processes[0].args[1]) <= 1024);
  assert.match(code, /Enable teams/);
  assert.doesNotMatch(code, /__GATEWAY_ORIGIN__/);
  assert.equal(await readFile(join(directory, "unpacked/plugin.js"), "utf8"), code);
  assert.equal((await buildPlugin({ origin, directory })).sha256, result.sha256);
  assert.notEqual((await buildPlugin({ origin: "https://second.example.org", directory })).sha256, result.sha256);
});
test("requires a canonical HTTPS origin", async () => {
  for (const origin of ["http://example.org", "https://user@example.org", "https://example.org/path", "https://example.org?token=value"]) {
    await assert.rejects(() => buildPlugin({ origin }));
  }
});
