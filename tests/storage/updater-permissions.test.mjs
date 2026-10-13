import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";

test("application updater commands stay local to main; plugin update/process grants never reach HTML", async () => {
  const directory = new URL("../../src-tauri/capabilities/", import.meta.url);
  const commands = [
    "get-app-update-status",
    "check-app-update",
    "download-app-update",
    "cancel-app-update",
    "restart-app-update",
  ].map((name) => `allow-${name}`);
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  let owners = 0;
  for (const name of names) {
    const capability = JSON.parse(await readFile(new URL(name, directory), "utf8"));
    const permissions = capability.permissions.map((value) =>
      typeof value === "string" ? value : value.identifier,
    );
    assert.equal(
      permissions.some((value) => /^(updater|process):/.test(value)),
      false,
      name,
    );
    if (permissions.some((value) => commands.includes(value))) {
      owners++;
      assert.equal(capability.identifier, "main");
      assert.equal(capability.local, true);
      assert.equal(capability.remote, undefined);
      assert.deepEqual(capability.webviews, ["main"]);
      assert.equal(capability.windows, undefined);
      for (const permission of commands) assert.ok(permissions.includes(permission), permission);
    }
  }
  assert.equal(owners, 1);
  const cargo = await readFile(new URL("../../src-tauri/Cargo.toml", import.meta.url), "utf8");
  assert.doesNotMatch(cargo.match(/^default\s*=.*$/m)?.[0] ?? "", /distribution-updater/);
  const config = JSON.parse(
    await readFile(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
  );
  assert.equal(config.identifier, "com.shimilynx.myknowledge");
  assert.equal(config.plugins?.updater, undefined);
  assert.notEqual(config.bundle.createUpdaterArtifacts, true);
});
