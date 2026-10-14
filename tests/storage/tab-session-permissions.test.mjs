import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";

test("tab layout writes and exit acknowledgments stay restricted to local main", async () => {
  const directory = new URL("../../src-tauri/capabilities/", import.meta.url);
  const grants = [
    "allow-get-tab-session",
    "allow-capture-tab-session",
    "allow-confirm-tab-session-flush",
  ];
  let owners = 0;
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".json")) continue;
    const capability = JSON.parse(await readFile(new URL(name, directory), "utf8"));
    if (!capability.permissions.some((permission) => grants.includes(permission))) continue;
    owners++;
    assert.equal(capability.local, true);
    assert.equal(capability.remote, undefined);
    assert.deepEqual(capability.webviews, ["main"]);
    for (const grant of grants) assert.ok(capability.permissions.includes(grant));
  }
  assert.equal(owners, 1);
});
