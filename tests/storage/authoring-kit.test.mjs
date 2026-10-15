import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, copyFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { JSDOM } from "jsdom";

const kit = "src-tauri/html-authoring-kit/";
const assets = ".agents/skills/my-knowledge-html/assets/";
const files = ["guide.md", "template.html", "codex-skill.md", "claude-skill.md"];
const hash = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const read = (path) => readFile(path, "utf8");
async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((done) => setTimeout(done, 5));
  }
  assert.fail("Kit template did not reach expected state");
}
async function open(beforeParse = () => {}, ready = true, htmlPath = kit + "template.html") {
  const html = await read(htmlPath);
  const dom = new JSDOM(html, {
    url: "https://example.test/standalone.html",
    runScripts: "dangerously",
    beforeParse(window) {
      window.TextEncoder = TextEncoder;
      beforeParse(window);
    },
  });
  if (ready)
    await waitFor(
      () => dom.window.document.querySelector("#status").textContent !== "保存状態を読込中…",
    );
  return dom;
}
function edit(window, amount, mode = "square", enabled = true) {
  window.document.querySelector("#amount").value = String(amount);
  window.document.querySelector("#mode").value = mode;
  window.document.querySelector("#enabled").checked = enabled;
  window.document.querySelector("#amount").dispatchEvent(new window.Event("input"));
}
const status = (dom) => dom.window.document.querySelector("#status").textContent;
const save = (dom) => dom.window.document.querySelector("#save");
/** @param {{value?: unknown, readFailure?: string|null, writeFailure?: string|null, holdRead?: Promise<void>|null}} [options] */
function nativeFixture({
  value = null,
  readFailure = null,
  writeFailure = null,
  holdRead = null,
} = {}) {
  let persisted = value,
    revision = value === null ? 0 : 1,
    localAccesses = 0;
  const calls = [];
  return {
    setup: (window) => {
      window.__MY_KNOWLEDGE_STORAGE_V1__ = Object.freeze({
        version: 1,
        available: true,
        endpoint: "https://example.test/native-fixture",
      });
      Object.defineProperty(window, "localStorage", {
        get() {
          localAccesses++;
          throw Error("Unexpected localStorage fallback");
        },
      });
      window.fetch = async (endpoint, options) => {
        assert.equal(endpoint, "https://example.test/native-fixture");
        assert.equal(options.method, "POST");
        assert.equal(options.credentials, "omit");
        const request = JSON.parse(options.body);
        calls.push(request);
        if (request.op === "read" && holdRead) await holdRead;
        if (request.op === "read" && readFailure)
          return { ok: false, json: async () => ({ version: 1, error: readFailure }) };
        if (request.op === "write" && writeFailure)
          return { ok: false, json: async () => ({ version: 1, error: writeFailure }) };
        if (request.op === "write") {
          persisted = request.value;
          revision++;
        }
        return { ok: true, json: async () => ({ version: 1, value: persisted, revision }) };
      };
    },
    calls,
    get persisted() {
      return persisted;
    },
    get localAccesses() {
      return localAccesses;
    },
  };
}

test("bundled contents reproduce canonical assets/API hashes and both installed skill links", async () => {
  const before = await Promise.all(files.map((file) => read(kit + file)));
  const result = spawnSync(process.execPath, ["scripts/build-html-authoring-kit.mjs"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await Promise.all(files.map((file) => read(kit + file))), before);
  const withoutDocumentId = (html) =>
    html.replace(/(<meta name="mogledge-document-id" content=")[^"]+("\s*\/>)/, "$1UUID$2");
  assert.equal(
    withoutDocumentId(await read(kit + "template.html")),
    withoutDocumentId(await read("tests/fixtures/knowledge/Storage/Generated.html")),
  );
  assert.match(before[1], /content="REPLACE_WITH_NEW_UUID"/);
  for (const content of [before[0], before[2], before[3]]) {
    assert.ok(content.includes("kitVersion=2"));
    assert.ok(content.includes(`adapterSHA256=${hash(await read(assets + "storage.js"))}`));
    assert.ok(
      content.includes(`canonicalTemplateSHA256=${hash(await read(assets + "template.html"))}`),
    );
    assert.ok(content.includes(`apiSpecSHA256=${hash(await read("docs/document-storage.md"))}`));
    assert.ok(content.includes("exportAPI=1"));
    assert.ok(content.includes(`exportAdapterSHA256=${hash(await read(assets + "export.js"))}`));
    assert.ok(
      content.includes(`exportApiSpecSHA256=${hash(await read("docs/html-artifact-export.md"))}`),
    );
    assert.doesNotMatch(
      content,
      /\.\.\/.*docs\/|node_modules|scripts\/build-knowledge-html|\/workspace\/|\ufffd/,
    );
  }
  for (const folder of [".agents", ".claude"]) {
    const skill = before[folder === ".agents" ? 2 : 3];
    assert.match(skill, /^---\nname: my-knowledge-html-authoring\ndescription: .+\n---/);
    for (const [target, installed] of [
      ["GUIDE.md", "guide.md"],
      ["template.html", "template.html"],
    ]) {
      const link = `../../../.my-knowledge/html-authoring/${target}`;
      assert.ok(skill.includes(link));
      assert.equal(
        resolve(dirname(`${folder}/skills/my-knowledge-html-authoring/SKILL.md`), link),
        resolve(`.my-knowledge/html-authoring/${target}`),
      );
      assert.ok(before[files.indexOf(installed)].length > 0);
    }
    assert.match(skill, /Native failure|Native descriptor/);
    assert.match(skill, /Ordinary build scripts must not noninteractively write/);
  }
});

test("complete HTML copied outside repo saves and restores normal browser controls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "knowledge-kit-template-"));
  const output = join(directory, "standalone.html");
  await copyFile(kit + "template.html", output);
  const first = await open(() => {}, true, output);
  try {
    assert.equal(first.window.document.querySelectorAll("script[src],link[href]").length, 0);
    edit(first.window, 7, "square", false);
    save(first).click();
    await waitFor(() => status(first) === "保存済み");
    const records = Object.entries(first.window.localStorage);
    assert.equal(records.length, 1);
    const second = await open(
      (window) => {
        for (const [key, value] of records) window.localStorage.setItem(key, value);
      },
      true,
      output,
    );
    try {
      assert.equal(second.window.document.querySelector("#amount").value, "7");
      assert.equal(second.window.document.querySelector("#mode").value, "square");
      assert.equal(second.window.document.querySelector("#enabled").checked, false);
      assert.equal(second.window.document.querySelector("#result").value, "無効");
      assert.equal(status(second), "復元済み");
    } finally {
      second.window.close();
    }
  } finally {
    first.window.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("fake Native read completes before restoration/calculation/save, and saved state reopens", async () => {
  let release;
  const pending = new Promise((done) => {
    release = done;
  });
  const fixture = nativeFixture({
    value: { schemaVersion: 1, data: { amount: 9, mode: "square", enabled: true } },
    holdRead: pending,
  });
  const dom = await open(fixture.setup, false);
  try {
    await waitFor(() => fixture.calls.length === 1);
    assert.equal(dom.window.document.querySelector("#amount").disabled, true);
    assert.equal(save(dom).disabled, true);
    assert.equal(dom.window.document.querySelector("#result").value, "—");
    assert.deepEqual(
      fixture.calls.map((call) => call.op),
      ["read"],
    );
    release();
    await waitFor(() => status(dom) === "復元済み");
    assert.equal(dom.window.document.querySelector("#amount").value, "9");
    assert.equal(dom.window.document.querySelector("#result").value, "81");
    edit(dom.window, 12, "double", true);
    save(dom).click();
    await waitFor(() => status(dom) === "保存済み");
    assert.deepEqual(fixture.persisted, {
      schemaVersion: 1,
      data: { amount: 12, mode: "double", enabled: true },
    });
    const second = await open(fixture.setup);
    try {
      assert.equal(second.window.document.querySelector("#result").value, "24");
      assert.equal(status(second), "復元済み");
    } finally {
      second.window.close();
    }
    assert.equal(fixture.localAccesses, 0);
  } finally {
    dom.window.close();
  }
});

test("initial Native read/schema/data failure cannot overwrite original state or fall back", async () => {
  for (const options of [
    { readFailure: "StorageUnavailable" },
    { value: { schemaVersion: 2, data: { amount: 77 } } },
    { value: { schemaVersion: 1, data: { amount: "broken", mode: "square", enabled: true } } },
  ]) {
    const fixture = nativeFixture(options),
      original = fixture.persisted;
    const dom = await open(fixture.setup);
    try {
      edit(dom.window, 8, "double", true);
      save(dom).click();
      await new Promise((done) => setTimeout(done, 150));
      assert.equal(save(dom).disabled, true);
      assert.match(status(dom), /保存できません/);
      assert.equal(dom.window.document.querySelector("#result").value, "16");
      assert.deepEqual(
        fixture.calls.map((call) => call.op),
        ["read"],
      );
      assert.deepEqual(fixture.persisted, original);
      assert.equal(fixture.localAccesses, 0);
    } finally {
      dom.window.close();
    }
  }
});

test("Native descriptor unavailable and write failure never access localStorage", async () => {
  let accesses = 0;
  const unavailable = await open((window) => {
    window.__MY_KNOWLEDGE_STORAGE_V1__ = Object.freeze({ version: 1, available: false });
    Object.defineProperty(window, "localStorage", {
      get() {
        accesses++;
        throw Error("Unexpected fallback");
      },
    });
  });
  try {
    assert.equal(save(unavailable).disabled, true);
    assert.match(status(unavailable), /storage_unavailable/);
    assert.equal(accesses, 0);
  } finally {
    unavailable.window.close();
  }
  const fixture = nativeFixture({
    value: { schemaVersion: 1, data: { amount: 4, mode: "double", enabled: true } },
    writeFailure: "QuotaExceeded",
  });
  const dom = await open(fixture.setup);
  try {
    edit(dom.window, 15);
    save(dom).click();
    await waitFor(() => status(dom).includes("QuotaExceeded"));
    assert.equal(dom.window.document.querySelector("#amount").value, "15");
    assert.equal(dom.window.document.querySelector("#result").value, "225");
    assert.deepEqual(fixture.persisted, {
      schemaVersion: 1,
      data: { amount: 4, mode: "double", enabled: true },
    });
    assert.equal(fixture.localAccesses, 0);
  } finally {
    dom.window.close();
  }
});

test("normal browser quota failure retains previous value and current unsaved input", async () => {
  let previous;
  const dom = await open((window) => {
    const key =
      "my-knowledge:v1:" + encodeURIComponent(window.location.href) + ":generated-calculator";
    previous = JSON.stringify({
      version: 1,
      revision: 1,
      value: { schemaVersion: 1, data: { amount: 6, mode: "double", enabled: true } },
    });
    window.localStorage.setItem(key, previous);
    window.Storage.prototype.setItem = function () {
      throw new window.DOMException("Browser quota full", "QuotaExceededError");
    };
  });
  try {
    edit(dom.window, 11);
    save(dom).click();
    await waitFor(() => status(dom).includes("quota_exceeded"));
    assert.equal(dom.window.document.querySelector("#amount").value, "11");
    assert.equal(dom.window.localStorage.getItem(dom.window.localStorage.key(0)), previous);
  } finally {
    dom.window.close();
  }
});

test("developer generator rejects user-root arguments instead of noninteractive installation", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/build-html-authoring-kit.mjs", "user-root"],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage: node scripts\/build-html-authoring-kit.mjs/);
});
