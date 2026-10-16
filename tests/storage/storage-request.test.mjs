import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const descriptorSource = await readFile(
  new URL("../../src-tauri/src/document_server/storage-descriptor.js", import.meta.url),
  "utf8",
);
const adapterSource = await readFile(
  new URL("../../.agents/skills/mogledge-html/assets/storage.js", import.meta.url),
  "utf8",
);
function setup(available = true, throwingNotice = false) {
  const notices = [];
  const fetches = [];
  const descriptor = {
    version: 1,
    available,
    endpoint: "http://127.0.0.1:1234/s/fixture/__mogledge_storage_v1__",
    maximumDocumentBytes: 1000000000,
  };
  const scope = vm.createContext({
    TextEncoder,
    URL,
    queueMicrotask,
    parent: {
      postMessage(message, target) {
        if (throwingNotice) throw new Error("notification unavailable");
        notices.push({ message, target });
      },
    },
    fetch: async (endpoint, options) => {
      fetches.push({ endpoint, options });
      return {
        ok: false,
        json: async () => ({ version: 1, error: "StorageIdentityConfirmationRequired" }),
      };
    },
  });
  scope.window = scope;
  vm.runInContext(
    descriptorSource
      .replace("__MOGLEDGE_STORAGE_DESCRIPTOR__", JSON.stringify(descriptor))
      .replace("__MOGLEDGE_STORAGE_TOKEN__", JSON.stringify("a".repeat(64))),
    scope,
  );
  vm.runInContext(adapterSource, scope);
  return { scope, notices, fetches };
}

for (const name of ["MogledgeStorage", "MyKnowledgeStorage"]) {
  test(`${name}: viewing and adapter construction stay quiet; actual operations retain protected errors`, async () => {
    const { scope, notices, fetches } = setup();
    assert.equal(notices.length, 0);
    const storage = scope[name].create({ appId: "example", schemaVersion: 1 });
    assert.equal(notices.length, 0);
    for (const operation of [
      () => storage.read(),
      () => storage.write({ value: 1 }),
      () => storage.remove(),
    ])
      await assert.rejects(operation(), { code: "StorageIdentityConfirmationRequired" });
    assert.equal(notices.length, 1);
    assert.equal(notices[0].message.type, "mogledge-storage-request-v1");
    assert.equal(notices[0].message.token, "a".repeat(64));
    assert.equal(notices[0].target, "*");
    assert.equal(fetches.length, 3);
    assert.ok(Object.isFrozen(scope.__MOGLEDGE_STORAGE_V1__));
    assert.equal(scope.__MOGLEDGE_STORAGE_V1__, scope.__MY_KNOWLEDGE_STORAGE_V1__);
    assert.equal(Object.getOwnPropertyDescriptor(scope, "__MOGLEDGE_STORAGE_V1__").writable, false);
  });
}

test("unavailable Native storage still rejects without browser fallback and reports the attempt", async () => {
  const { scope, notices, fetches } = setup(false);
  const storage = scope.MogledgeStorage.create({ appId: "example", schemaVersion: 1 });
  await assert.rejects(storage.read(), { code: "storage_unavailable" });
  assert.equal(notices.length, 1);
  assert.equal(fetches.length, 0);
});

test("a failed advisory notification never changes the protected storage error", async () => {
  const { scope, fetches } = setup(true, true);
  const storage = scope.MogledgeStorage.create({ appId: "example", schemaVersion: 1 });
  await assert.rejects(storage.read(), { code: "StorageIdentityConfirmationRequired" });
  assert.equal(fetches.length, 1);
});
