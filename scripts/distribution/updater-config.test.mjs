import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));

test("pending distribution public key decodes to the owner-confirmed Ed25519 fingerprint", async () => {
  const pending = await readJson("../../src-tauri/tauri.updater.pending.json");
  const encoded = pending.plugins.updater.pubkey;
  const text = Buffer.from(encoded, "base64");
  assert.equal(text.toString("base64"), encoded);
  const lines = text.toString("utf8").trimEnd().split("\n");
  assert.equal(lines.length, 2);
  const key = Buffer.from(lines[1], "base64");
  assert.equal(key.toString("base64"), lines[1]);
  assert.equal(key.length, 42);
  assert.equal(key.subarray(0, 2).toString("ascii"), "Ed");
  const keyId = key.readBigUInt64LE(2).toString(16).toUpperCase().padStart(16, "0");
  assert.equal(keyId, "834723B673FE6C1E");
  assert.equal(lines[0], `untrusted comment: minisign public key: ${keyId}`);
  assert.equal(
    createHash("sha256").update(key.subarray(10)).digest("hex"),
    "65b10a703ca58b486328274e88c5999fee34e16c15356d64aa3b19e54dd49a55",
  );
});

test("pending overlay keeps enrolment disabled and cannot override identity or embed authentication", async () => {
  const pending = await readJson("../../src-tauri/tauri.updater.pending.json");
  const baseline = await readJson("../../src-tauri/tauri.conf.json");
  assert.deepEqual(Object.keys(pending).sort(), ["$schema", "bundle", "plugins"]);
  assert.deepEqual(pending.bundle, { createUpdaterArtifacts: false });
  assert.equal(baseline.identifier, "com.shimilynx.myknowledge");
  assert.equal(baseline.plugins?.updater, undefined);
  assert.notEqual(baseline.bundle.createUpdaterArtifacts, true);
  const updater = pending.plugins.updater;
  assert.deepEqual(Object.keys(updater).sort(), [
    "endpoints",
    "pubkey",
    "requireSignedVersion",
    "windows",
  ]);
  assert.equal(updater.requireSignedVersion, true);
  assert.deepEqual(updater.windows, { installMode: "passive" });
  assert.deepEqual(updater.endpoints, [
    "https://github.com/shimi-lynx/mogledge/releases/latest/download/latest.json",
  ]);
  const url = new URL(updater.endpoints[0]);
  assert.equal(url.protocol, "https:");
  assert.equal(url.username, "");
  assert.equal(url.password, "");
  assert.equal(url.search, "");
  const cargo = await readFile(new URL("../../src-tauri/Cargo.toml", import.meta.url), "utf8");
  assert.doesNotMatch(cargo.match(/^default\s*=.*$/m)?.[0] ?? "", /distribution-updater/);
});
