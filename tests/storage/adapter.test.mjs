import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(
  new URL("../../.agents/skills/mogledge-html/assets/storage.js", import.meta.url),
  "utf8",
);
function setup(overrides = {}) {
  const records = new Map();
  const storage = {
    getItem: (key) => records.get(key) ?? null,
    setItem: (key, value) => records.set(key, value),
    removeItem: (key) => records.delete(key),
  };
  const scope = vm.createContext({
    TextEncoder,
    URL,
    queueMicrotask,
    location: { href: "https://example.test/calculator.html" },
    localStorage: storage,
    ...overrides,
  });
  vm.runInContext(source, scope);
  return {
    scope,
    records,
    adapter: scope.MogledgeStorage.create({ appId: "calculator", schemaVersion: 1 }),
  };
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const rejectCode = (promise, code) => assert.rejects(promise, (error) => error.code === code);
const descriptor = {
  version: 1,
  available: true,
  endpoint: "http://127.0.0.1:1234/doc/storage/token",
};
function response(value, revision = 1, ok = true) {
  return { ok, json: async () => ({ version: 1, value, revision }) };
}

test("browser saves snapshots and document/app namespaces stay isolated", async () => {
  const { adapter, records, scope } = setup();
  const state = { amount: 20, mode: "sum", enabled: true };
  const saving = adapter.write(state);
  state.amount = 99;
  await saving;
  assert.deepEqual(plain(await adapter.read()), { amount: 20, mode: "sum", enabled: true });
  const otherApp = scope.MogledgeStorage.create({ appId: "other", schemaVersion: 1 });
  assert.equal(await otherApp.read(), null);
  scope.location.href = "https://example.test/other.html";
  assert.equal(await adapter.read(), null);
  scope.location.href = "https://example.test/calculator.html?preview=1#part";
  assert.deepEqual(plain(await adapter.read()), { amount: 20, mode: "sum", enabled: true });
  assert.equal(records.size, 1);
});

test("legacy API is a frozen alias and never discovers old browser keys", async () => {
  const { scope, adapter, records } = setup();
  const oldKey = "my-knowledge:v1:" + encodeURIComponent(scope.location.href) + ":calculator";
  const oldValue = JSON.stringify({
    version: 1,
    revision: 7,
    value: { schemaVersion: 1, data: 99 },
  });
  records.set(oldKey, oldValue);
  assert.equal(scope.MyKnowledgeStorage, scope.MogledgeStorage);
  assert.equal(Object.isFrozen(scope.MogledgeStorage), true);
  assert.equal(Object.getOwnPropertyDescriptor(scope, "MyKnowledgeStorage").writable, false);
  assert.equal(await adapter.read(), null);
  await scope.MyKnowledgeStorage.create({ appId: "calculator", schemaVersion: 1 }).write(12);
  assert.equal(await adapter.read(), 12);
  assert.equal(records.get(oldKey), oldValue);
  assert.equal(records.size, 2);
  assert.ok([...records.keys()].some((key) => key.startsWith("mogledge:v1:")));
});

test("legacy Native descriptors retain authorization failures and canonical descriptors take precedence", async () => {
  for (const settings of [
    { __MY_KNOWLEDGE_STORAGE_V1__: { version: 1, available: false } },
    {
      __MY_KNOWLEDGE_STORAGE_V1__: descriptor,
      fetch: async () => ({ ok: false, json: async () => ({ version: 1, error: "Revoked" }) }),
    },
    { __MOGLEDGE_STORAGE_V1__: { version: 2 }, __MY_KNOWLEDGE_STORAGE_V1__: descriptor },
  ]) {
    const { adapter, records } = setup(settings);
    await assert.rejects(adapter.read());
    await assert.rejects(adapter.write({ amount: 2 }));
    await assert.rejects(adapter.flush());
    assert.equal(records.size, 0);
  }
  const requests = [];
  const { scope } = setup({
    __MY_KNOWLEDGE_STORAGE_V1__: descriptor,
    fetch: async (endpoint, options) => {
      requests.push([endpoint, JSON.parse(options.body)]);
      return response({ schemaVersion: 1, data: 42 });
    },
  });
  assert.equal(
    await scope.MyKnowledgeStorage.create({ appId: "calculator", schemaVersion: 1 }).read(),
    42,
  );
  assert.equal(requests[0][0], descriptor.endpoint);
});

test("consecutive queued writes coalesce, while reads and deletion preserve operation order", async () => {
  const requests = [];
  let persisted = null;
  let revision = 0;
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const { adapter } = setup({
    __MOGLEDGE_STORAGE_V1__: descriptor,
    fetch: async (_, options) => {
      const request = JSON.parse(options.body);
      requests.push(request);
      if (requests.length === 1) await blocked;
      if (request.op === "write") {
        persisted = request.value;
        revision++;
      }
      if (request.op === "delete") {
        persisted = null;
        revision++;
      }
      return response(persisted, revision);
    },
  });
  const first = adapter.write({ amount: 1 });
  await new Promise(queueMicrotask);
  const pending = [adapter.write({ amount: 2 }), adapter.write({ amount: 3 })];
  const reading = adapter.read();
  const removal = adapter.remove();
  const finalRead = adapter.read();
  release();
  assert.equal(await first, 1);
  assert.deepEqual(await Promise.all(pending), [2, 2]);
  assert.deepEqual(plain(await reading), { amount: 3 });
  await removal;
  assert.equal(await finalRead, null);
  await adapter.flush();
  assert.deepEqual(
    requests.map((request) => request.op),
    ["write", "write", "read", "delete", "read"],
  );
});

test("provided Native transport never falls back even when unavailable or revoked", async () => {
  for (const settings of [
    { __MOGLEDGE_STORAGE_V1__: { version: 1, available: false } },
    {
      __MOGLEDGE_STORAGE_V1__: descriptor,
      fetch: async () => ({ ok: false, json: async () => ({ version: 1, error: "expired_view" }) }),
    },
    {
      __MOGLEDGE_STORAGE_V1__: descriptor,
      fetch: async () => {
        throw new Error("Network failed");
      },
    },
  ]) {
    let accesses = 0;
    const { adapter, scope } = setup(settings);
    Object.defineProperty(scope, "localStorage", {
      get() {
        accesses++;
        throw new Error("Unexpected fallback");
      },
    });
    await assert.rejects(adapter.write({ amount: 2 }));
    await assert.rejects(adapter.flush());
    assert.equal(accesses, 0);
  }
});

test("failed saves remain visible to flush until an acknowledged retry succeeds", async () => {
  let fail = true;
  const { adapter } = setup({
    __MOGLEDGE_STORAGE_V1__: descriptor,
    fetch: async (_, options) => {
      if (fail) return { ok: false, json: async () => ({ version: 1, error: "quota_exceeded" }) };
      return response(JSON.parse(options.body).value);
    },
  });
  await rejectCode(adapter.write({ amount: 2 }), "quota_exceeded");
  await rejectCode(adapter.flush(), "quota_exceeded");
  await rejectCode(adapter.flush(), "quota_exceeded");
  fail = false;
  await adapter.write({ amount: 2 });
  await adapter.flush();
});

test("validation failures preserve queue order and do not disappear behind an earlier valid save", async () => {
  const { adapter } = setup();
  const saved = adapter.write({ amount: 2 });
  const invalid = adapter.write(undefined);
  const invalidResult = rejectCode(invalid, "invalid_value");
  const flush = rejectCode(adapter.flush(), "invalid_value");
  await Promise.all([saved, invalidResult, flush]);
  await adapter.write({ amount: 3 });
  await adapter.flush();
});

test("quota uses UTF-8 bytes; browser quota failures and malformed/schema-mismatch values surface", async () => {
  const { adapter, records, scope } = setup();
  await rejectCode(
    adapter.write({ text: "あ".repeat(Math.ceil((5 * 1024 * 1024) / 3)) }),
    "quota_exceeded",
  );
  assert.equal(records.size, 0);
  const circular = {};
  circular.self = circular;
  await rejectCode(adapter.write(circular), "invalid_value");
  await rejectCode(
    adapter.write(() => 1),
    "invalid_value",
  );
  await adapter.write({ amount: 1 });
  const key = [...records.keys()][0];
  records.set(
    key,
    JSON.stringify({ version: 1, value: { schemaVersion: 2, data: { amount: 20 } }, revision: 1 }),
  );
  await rejectCode(adapter.read(), "schema_mismatch");
  assert.equal(JSON.parse(records.get(key)).value.data.amount, 20);
  records.set(key, "bad json");
  await rejectCode(adapter.read(), "invalid_response");
  scope.localStorage.setItem = () => {
    const error = new Error("Quota full");
    error.name = "QuotaExceededError";
    throw error;
  };
  await rejectCode(adapter.write({ amount: 2 }), "quota_exceeded");
});

test("malformed Native replies are rejected and app/schema initialization is validated", async () => {
  const { adapter, scope } = setup({
    __MOGLEDGE_STORAGE_V1__: descriptor,
    fetch: async () => ({ ok: true, json: async () => null }),
  });
  await rejectCode(adapter.read(), "invalid_response");
  assert.throws(
    () => scope.MogledgeStorage.create({ appId: "../foreign", schemaVersion: 1 }),
    (error) => error.code === "invalid_key",
  );
  assert.throws(
    () => scope.MogledgeStorage.create({ appId: "ok", schemaVersion: 0 }),
    (error) => error.code === "invalid_schema",
  );
});

test("5MiB includes appId, schema/data envelope and UTF-8 escaping; requests send objects", async () => {
  const requests = [];
  const { scope } = setup({
    __MOGLEDGE_STORAGE_V1__: descriptor,
    fetch: async (_, options) => {
      requests.push(options.body);
      return response(JSON.parse(options.body).value);
    },
  });
  const appId = "k".repeat(80);
  const adapter = scope.MogledgeStorage.create({ appId, schemaVersion: 1 });
  const bytes = 5 * 1024 * 1024;
  const encoder = new TextEncoder();
  const overhead = encoder.encode(
    JSON.stringify({ [appId]: { schemaVersion: 1, data: "" } }),
  ).byteLength;
  const pattern = '日本語"\\\n';
  const patternBytes = encoder.encode(JSON.stringify(pattern)).byteLength - 2;
  const remaining = bytes - overhead;
  const text =
    pattern.repeat(Math.floor(remaining / patternBytes)) + "x".repeat(remaining % patternBytes);
  assert.equal(
    encoder.encode(JSON.stringify({ [appId]: { schemaVersion: 1, data: text } })).byteLength,
    bytes,
  );
  await adapter.write(text);
  assert.equal(typeof JSON.parse(requests[0]).value, "object");
  assert.equal(JSON.parse(requests[0]).value.data, text);
  assert.ok(encoder.encode(requests[0]).byteLength < bytes + 1024);
  await rejectCode(adapter.write(text + "x"), "quota_exceeded");
  await rejectCode(adapter.flush(), "quota_exceeded");
  assert.equal(requests.length, 1);
});

test("browser QuotaExceededError keeps the previous record and revision", async () => {
  const { adapter, records, scope } = setup();
  await adapter.write({ amount: 7 });
  const before = [...records.entries()];
  scope.localStorage.setItem = () => {
    const error = new Error("Origin quota reached");
    error.name = "QuotaExceededError";
    throw error;
  };
  await rejectCode(adapter.write({ amount: 9 }), "quota_exceeded");
  await rejectCode(adapter.flush(), "quota_exceeded");
  assert.deepEqual([...records.entries()], before);
  assert.deepEqual(plain(await adapter.read()), { amount: 7 });
});

test("a finite 8MiB Native ceiling keeps current quota changes server-authoritative", async () => {
  const appId = "configurable";
  const bytes = 8 * 1024 * 1024;
  let quota = bytes;
  let persisted = null;
  let requests = 0;
  const { scope } = setup({
    __MOGLEDGE_STORAGE_V1__: { ...descriptor, maximumDocumentBytes: bytes },
    fetch: async (_, options) => {
      requests++;
      const request = JSON.parse(options.body);
      if (request.op === "write") {
        const size = new TextEncoder().encode(
          JSON.stringify({ [request.key]: request.value }),
        ).byteLength;
        if (size > quota)
          return { ok: false, json: async () => ({ version: 1, error: "QuotaExceeded" }) };
        persisted = request.value;
      }
      return response(persisted, requests);
    },
  });
  Object.defineProperty(scope, "localStorage", {
    get() {
      return assert.fail("Native must never fall back");
    },
  });
  const adapter = scope.MogledgeStorage.create({ appId, schemaVersion: 1 });
  const overhead = new TextEncoder().encode(
    JSON.stringify({ [appId]: { schemaVersion: 1, data: "" } }),
  ).byteLength;
  const exact =
    "あ".repeat(Math.floor((bytes - overhead) / 3)) + "x".repeat((bytes - overhead) % 3);
  await adapter.write(exact);
  assert.equal(requests, 1, "No extra limit query per write");
  await rejectCode(adapter.write(exact + "x"), "quota_exceeded");
  assert.equal(requests, 1, "Over absolute transport ceiling is refused before HTTP");
  await adapter.write({ amount: 1 });
  quota = 1024 * 1024;
  await rejectCode(adapter.write("x".repeat(1024 * 1024)), "QuotaExceeded");
  await rejectCode(adapter.flush(), "QuotaExceeded");
  assert.deepEqual(plain(await adapter.read()), { amount: 1 });
  quota = bytes;
  await adapter.write("x".repeat(6 * 1024 * 1024));
  assert.equal((await adapter.read()).length, 6 * 1024 * 1024);
});

test("Native ceilings above 8MiB and non-MiB byte limits retain exact UTF-8 boundaries", async () => {
  for (const bytes of [9 * 1024 * 1024, 16 * 1024 * 1024, 9 * 1024 * 1024 + 37]) {
    let requests = 0;
    const appId = "byte-boundary";
    const { scope } = setup({
      __MOGLEDGE_STORAGE_V1__: { ...descriptor, maximumDocumentBytes: bytes },
      fetch: async (_, options) => {
        requests++;
        return response(JSON.parse(options.body).value);
      },
    });
    Object.defineProperty(scope, "localStorage", {
      get() {
        return assert.fail("Native must never fall back");
      },
    });
    const adapter = scope.MogledgeStorage.create({ appId, schemaVersion: 1 });
    const encoder = new TextEncoder();
    const overhead = encoder.encode(
      JSON.stringify({ [appId]: { schemaVersion: 1, data: "" } }),
    ).byteLength;
    const remaining = bytes - overhead;
    const exact = "あ".repeat(Math.floor(remaining / 3)) + "x".repeat(remaining % 3);
    assert.equal(
      encoder.encode(JSON.stringify({ [appId]: { schemaVersion: 1, data: exact } })).byteLength,
      bytes,
    );
    await adapter.write(exact);
    assert.equal(requests, 1);
    await rejectCode(adapter.write(exact + "x"), "quota_exceeded");
    await rejectCode(adapter.flush(), "quota_exceeded");
    assert.equal(requests, 1, "One byte over the descriptor limit never reaches HTTP");
  }
});

test("positive safe integer byte ceilings do not require MiB multiples or large allocations", async () => {
  for (const maximumDocumentBytes of [1, 1_000_000_000, Number.MAX_SAFE_INTEGER]) {
    let requests = 0;
    const { adapter } = setup({
      __MOGLEDGE_STORAGE_V1__: { ...descriptor, maximumDocumentBytes },
      fetch: async (_, options) => {
        requests++;
        return response(JSON.parse(options.body).value);
      },
    });
    if (maximumDocumentBytes === 1) {
      await rejectCode(adapter.write({ amount: 2 }), "quota_exceeded");
      assert.equal(requests, 0);
    } else {
      await adapter.write({ amount: 2 });
      assert.equal(requests, 1);
    }
  }
});

test("ordinary browser writes retain the 5MiB limit and previous record", async () => {
  const { adapter, records } = setup();
  await adapter.write({ amount: 7 });
  const before = [...records.entries()];
  await rejectCode(adapter.write("x".repeat(5 * 1024 * 1024)), "quota_exceeded");
  await rejectCode(adapter.flush(), "quota_exceeded");
  assert.deepEqual([...records.entries()], before);
});

test("invalid Native ceiling fails closed without a request or browser fallback", async () => {
  for (const maximumDocumentBytes of [
    null,
    "8388608",
    NaN,
    Infinity,
    -Infinity,
    -1,
    0,
    true,
    {},
    0.5,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    const { adapter, scope } = setup({
      __MOGLEDGE_STORAGE_V1__: { ...descriptor, maximumDocumentBytes },
      fetch: async () => assert.fail("Invalid descriptor must not reach Native"),
    });
    Object.defineProperty(scope, "localStorage", {
      get() {
        return assert.fail("No fallback");
      },
    });
    await rejectCode(adapter.write({ amount: 2 }), "storage_unavailable");
    await rejectCode(adapter.flush(), "storage_unavailable");
  }
});
