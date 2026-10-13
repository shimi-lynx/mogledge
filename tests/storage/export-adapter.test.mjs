import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
const adapterSource = await readFile(".agents/skills/my-knowledge-html/assets/export.js", "utf8");
const bridgeSource = (await readFile("src-tauri/src/document_server/export.js", "utf8")).replace(
  "__MY_KNOWLEDGE_EXPORT_TOKEN__",
  JSON.stringify("a".repeat(64)),
);
const rejectCode = (operation, code) => assert.rejects(operation, (error) => error.code === code);
function setup({ native = false, descriptor, gesture = true } = {}) {
  const messages = [],
    downloads = [],
    timers = new Map();
  const activation = { isActive: gesture };
  let now = 1000,
    listener;
  const parent = { postMessage: (data) => messages.push(data) };
  const scope = vm.createContext({
    Blob,
    TextEncoder,
    Uint8Array,
    navigator: { userActivation: activation },
    performance: { now: () => now },
    crypto: { randomUUID: () => "12345678-1234-1234-1234-123456789abc" },
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    setTimeout: (fn) => {
      const id = Symbol();
      timers.set(id, fn);
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    URL: { createObjectURL: () => "blob:generated", revokeObjectURL: () => {} },
    document: {
      hasFocus: () => true,
      querySelector: () => null,
      body: { append: () => {} },
      createElement: () => {
        const link = {
          click: () => downloads.push({ href: link.href, name: link.download }),
          remove: () => {},
        };
        return link;
      },
    },
  });
  scope.window = scope;
  scope.parent = parent;
  scope.addEventListener = (_, receive) => {
    listener = receive;
  };
  if (descriptor !== undefined) scope.__MY_KNOWLEDGE_EXPORT_V1__ = descriptor;
  if (native) vm.runInContext(bridgeSource, scope);
  vm.runInContext(adapterSource, scope);
  return {
    scope,
    messages,
    downloads,
    timers,
    activation,
    advance: () => {
      now += 1000;
    },
    export: (value) => scope.MyKnowledgeExport.exportArtifact(value),
    reply: (result, options = {}) =>
      listener({
        source: parent,
        data: {
          type: "my-knowledge-artifact-result-v1",
          token: "a".repeat(64),
          id: "12345678-1234-1234-1234-123456789abc",
          result,
        },
        ...options,
      }),
  };
}
const proposal = () => ({ blob: new Blob(["report"]), name: "report", format: "text" });
test("browser-only download is synchronous, gesture-gated, bounded and reports a request rather than saved", async () => {
  const browser = setup();
  const operation = browser.export(proposal());
  assert.equal(browser.downloads.length, 1);
  assert.equal((await operation).status, "download-requested");
  await rejectCode(browser.export(proposal()), "ArtifactCooldown");
  browser.advance();
  browser.activation.isActive = false;
  await rejectCode(browser.export(proposal()), "ArtifactGestureRequired");
  assert.equal(browser.downloads.length, 1);
  browser.activation.isActive = true;
  await rejectCode(browser.export({ ...proposal(), format: "svg" }), "ArtifactInvalidRequest");
  await rejectCode(
    browser.export({ ...proposal(), blob: new Blob([new Uint8Array(5 * 1024 * 1024 + 1)]) }),
    "ArtifactTooLargeOrInvalid",
  );
  await rejectCode(browser.export({ ...proposal(), extra: "path" }), "ArtifactInvalidRequest");
});
test("Native descriptor presence forbids fallback on invalid bridge, denial, encoding error and unknown result", async () => {
  const invalid = setup({ descriptor: { version: 2 } });
  await rejectCode(invalid.export(proposal()), "ArtifactUnavailable");
  assert.equal(invalid.downloads.length, 0);
  for (const code of [
    "ArtifactSaveFailed",
    "ArtifactPublishedUnconfirmed",
    "ArtifactResultUnknown",
  ]) {
    const native = setup({ native: true });
    const operation = native.export(proposal());
    await new Promise(setImmediate);
    assert.equal(native.messages[0].data, Buffer.from("report").toString("base64"));
    native.reply({ error: code });
    await rejectCode(operation, code);
    assert.equal(native.downloads.length, 0);
  }
});
test("injected transport snapshots name/format, admits one request and only settles exact parent/token/id replies", async () => {
  const native = setup({ native: true });
  const value = proposal(),
    operation = native.export(value);
  value.name = "changed";
  value.format = "png";
  await rejectCode(native.export(proposal()), "ArtifactBusy");
  await new Promise(setImmediate);
  assert.equal(native.messages[0].name, "report");
  assert.equal(native.messages[0].format, "text");
  let settled = false;
  operation.then(() => {
    settled = true;
  });
  native.reply({ status: "saved", name: "report.txt", bytes: 6 }, { source: {} });
  native.reply(
    { status: "saved", name: "report.txt", bytes: 6 },
    {
      data: {
        type: "my-knowledge-artifact-result-v1",
        token: "wrong",
        id: "12345678-1234-1234-1234-123456789abc",
        result: { status: "cancelled" },
      },
    },
  );
  native.reply({ status: "cancelled", extra: true });
  await new Promise(setImmediate);
  assert.equal(settled, false);
  native.reply({ status: "cancelled" });
  assert.equal((await operation).status, "cancelled");
  assert.equal(native.timers.size, 0);
  assert.equal(native.downloads.length, 0);
});
test("pending result timeout is uncertain and never causes another dispatch or browser fallback", async () => {
  const native = setup({ native: true });
  const operation = native.export(proposal());
  await new Promise(setImmediate);
  for (const timer of native.timers.values()) timer();
  await rejectCode(operation, "ArtifactResultUnknown");
  assert.equal(native.messages.length, 1);
  assert.equal(native.downloads.length, 0);
});
