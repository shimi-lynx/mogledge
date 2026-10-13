import { browser, $ } from "@wdio/globals";
import assert from "node:assert/strict";
import { writeFileSync, renameSync, unlinkSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:http";
declare global {
  interface Window {
    __wikiReports?: Record<string, unknown>;
  }
}

async function snapshot() {
  return (await browser.executeAsync((done) => {
    void (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (
            cmd: string,
          ) => Promise<{ workspaceId: string; viewId: string; revision: number }>;
        };
      }
    ).__TAURI_INTERNALS__
      .invoke("get_knowledge_tree")
      .then(done);
  })) as { workspaceId: string; viewId: string; revision: number };
}
async function select(path: string) {
  // Fixture checks request a fresh run when a retained tab already exists.
  const reused = await browser.execute(
    (path) => Boolean(document.querySelector('iframe[title="' + path + '"]')),
    path,
  );
  await browser.execute(() => {
    window.__wikiReports = {};
  });
  await $('div[data-path="' + path + '"]').click();
  await browser.waitUntil(
    async () => (await $(".document-pane.active iframe").getAttribute("title")) === path,
  );
  if (reused) {
    const previous = await $(".document-pane.active iframe").getAttribute("src");
    await activeTabAction("状態をリセットして再読み込み");
    await browser.waitUntil(
      async () => (await $(".document-pane.active iframe").getAttribute("src")) !== previous,
    );
  }
}

async function activeTabAction(label: string) {
  const panel = await $(".document-pane.active").getAttribute("id");
  assert.ok(panel);
  await $('button[role="tab"][aria-controls="' + panel + '"]').click({ button: "right" });
  await $('button[role="menuitem"]=' + label).click();
}

async function send(action: string, url = "") {
  await browser.execute(
    (action, url) => {
      document
        .querySelector<HTMLIFrameElement>(".document-pane.active iframe")!
        .contentWindow!.postMessage({ type: "wiki-fixture-command", action, url }, "*");
    },
    action,
    url,
  );
}
async function report<T>(name: string) {
  await browser.waitUntil(async () =>
    Boolean(await browser.execute((key) => window.__wikiReports?.[key], name)),
  );
  return (await browser.execute((key) => window.__wikiReports?.[key], name)) as T;
}
describe("WKWebView opaque sandbox", () => {
  before(async () => {
    await browser.execute(() => {
      window.__wikiReports = {};
      window.addEventListener("message", (event) => {
        // A test-only result collector: no Native invocation or command forwarding.
        if (
          event.source !==
            document.querySelector<HTMLIFrameElement>(".document-pane.active iframe")
              ?.contentWindow ||
          event.origin !== "null"
        )
          return;
        if (typeof event.data?.__wikiFixture !== "string") return;
        window.__wikiReports![event.data.__wikiFixture] = event.data.value;
      });
    });
  });
  it("executes Modules, local JSON, CSS, input, range, button and Canvas inside WKWebView", async () => {
    await $('div[data-path="Examples"]').waitForExist();
    await $('div[data-path="Examples"]').click();
    await select("Examples/Interactive.html");
    assert.equal(await report<string>("ready"), "local JSON");
    await send("exercise");
    const values = await report<Record<string, unknown>>("exercise");
    assert.equal(values.module, "Module ready: local JSON");
    assert.equal(values.classic, "ready");
    assert.equal(values.background, "rgb(246, 250, 247)");
    assert.equal(values.range, "73");
    assert.equal(values.input, "edited");
    assert.equal(values.canvasPixel, 51);
    assert.equal(values.nativeAbsent, true);
    assert.equal(values.image, true);
    await browser.saveScreenshot(resolve(".tools/mac-viewer.png"));
  });
  it("rejects actual Native IPC and parent DOM/storage", async () => {
    const isolationSource = readFileSync(
      resolve("tests/fixtures/knowledge/Security/Isolation.html"),
      "utf8",
    );
    for (const command of ["get_document_state_recovery", "recover_document_state"])
      assert.ok(
        isolationSource.includes('"' + command + '"'),
        "The malicious document must probe each trusted recovery command",
      );
    const before = await snapshot();
    assert.ok(before.workspaceId);
    await $('div[data-path="Security"]').click();
    await select("Security/Isolation.html");
    const values = await report<Record<string, boolean>>("isolation");
    for (const [name, value] of Object.entries(values)) assert.equal(value, true, name);
    await browser.pause(150);
    const after = await snapshot();
    assert.equal(after.workspaceId, before.workspaceId);
    assert.equal(after.viewId, before.viewId, "Injected IPC must not reset renderer ownership");
    assert.equal(after.revision, before.revision);
    assert.equal(
      await $("#document-search-query").isDisplayed(),
      false,
      "Forged window-command messages must not open search",
    );
  });
  it("retains the WKWebView document across independent column views and close/reopen", async () => {
    await select("Examples/Interactive.html");
    await report("ready");
    await send("exercise");
    assert.equal((await report<Record<string, unknown>>("exercise")).input, "edited");
    const leftUrl = await $(".document-pane.active iframe").getAttribute("src");
    const leftPanel = await $(".document-pane.active").getAttribute("id");
    await browser.execute(() => {
      (window as unknown as { retainedMacFrame: Element | null }).retainedMacFrame =
        document.querySelector(".document-pane.active iframe");
      window.__wikiReports = {};
    });
    await activeTabAction("右の列で開く");
    await report("ready");
    const rightUrl = await $(".document-pane.active iframe").getAttribute("src");
    assert.notEqual(rightUrl, leftUrl);
    assert.equal(
      await browser.execute(() => document.querySelectorAll('[role="tablist"]').length),
      2,
    );
    await activeTabAction("タブを閉じる");
    await browser.waitUntil(async () =>
      browser.execute(() => document.querySelectorAll('[role="tablist"]').length === 1),
    );
    assert.equal((await fetch(rightUrl!)).status, 404);
    assert.equal((await fetch(leftUrl!)).status, 200);
    await browser.execute(() => {
      window.__wikiReports = {};
    });
    await activeTabAction("閉じたタブを開き直す");
    await report("ready");
    assert.notEqual(await $(".document-pane.active iframe").getAttribute("src"), rightUrl);
    assert.equal((await fetch(rightUrl!)).status, 404);
    await activeTabAction("タブを閉じる");
    await browser.waitUntil(async () =>
      browser.execute(() => document.querySelectorAll('[role="tablist"]').length === 1),
    );
    await $('button[role="tab"][aria-controls="' + leftPanel + '"]').click();
    assert.ok(
      await browser.execute(
        () =>
          (window as unknown as { retainedMacFrame: Element }).retainedMacFrame ===
          document.querySelector(".document-pane.active iframe"),
      ),
    );
    await browser.execute(() => {
      window.__wikiReports = {};
    });
    await send("ping");
    assert.equal(await report<string>("ping"), "Module ready: local JSON");
  });
  it("rejects foreign document navigation and preserves anchors", async () => {
    let requests = 0;
    const trap = createServer((_, response) => {
      requests++;
      response.end("foreign");
    });
    await new Promise<void>((done) => trap.listen(0, "127.0.0.1", done));
    const address = trap.address();
    assert.ok(address && typeof address !== "string");
    try {
      await select("Examples/Interactive.html");
      await report("ready");
      await send("navigate", "http://127.0.0.1:" + address.port + "/blocked");
      await browser.pause(300);
      assert.equal(requests, 0);
      await select("Examples/Interactive.html");
      await report("ready");
      await send("ping");
      assert.equal(await report<string>("ping"), "Module ready: local JSON");
      await send("anchor");
      assert.equal(await report<string>("anchor"), "#anchor");
    } finally {
      trap.closeAllConnections();
      await new Promise<void>((done) => trap.close(() => done()));
    }
  });
  it("observes assets and HTML create, atomic save, rename and delete", async () => {
    const root = resolve(".tools/e2e-knowledge");
    const previous = await $(".document-pane.active iframe").getAttribute("src");
    await browser.execute(() => {
      window.__wikiReports = {};
    });
    writeFileSync(resolve(root, "assets/data.json"), '{"message":"updated JSON"}');
    await browser.waitUntil(
      async () => (await $(".document-pane.active iframe").getAttribute("src")) !== previous,
    );
    assert.equal(await report<string>("ready"), "updated JSON");
    const html = (value: string) =>
      '<h1 id="live">' +
      value +
      '</h1><script>parent.postMessage({__wikiFixture:"live",value:document.querySelector("#live").textContent},"*")</script>';
    writeFileSync(resolve(root, "Live.html"), html("one"));
    await $('div[data-path="Live.html"]').waitForExist();
    await select("Live.html");
    assert.equal(await report<string>("live"), "one");
    await browser.execute(() => {
      window.__wikiReports = {};
    });
    writeFileSync(resolve(root, "Live.tmp"), html("two"));
    unlinkSync(resolve(root, "Live.html"));
    renameSync(resolve(root, "Live.tmp"), resolve(root, "Live.html"));
    assert.equal(await report<string>("live"), "two");
    renameSync(resolve(root, "Live.html"), resolve(root, "Renamed.html"));
    await $('div[data-path="Renamed.html"]').waitForExist();
    await browser.waitUntil(async () => !(await $(".document-pane.active iframe").isExisting()));
    await select("Renamed.html");
    unlinkSync(resolve(root, "Renamed.html"));
    await browser.waitUntil(async () => !(await $(".document-pane.active iframe").isExisting()));
    assert.match(await $("[role=alert]").getText(), /削除|移動/);
  });
});
