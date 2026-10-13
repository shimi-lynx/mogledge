import { browser, $ } from "@wdio/globals";
import assert from "node:assert/strict";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve, toNamespacedPath } from "node:path";

describe("Native standalone storage sample handoff", () => {
  afterEach(async () => {
    await browser.switchToParentFrame();
  });
  it("keeps a separate root and restores both delivered samples after process restart", async () => {
    const root = process.env.MY_KNOWLEDGE_STORAGE_SAMPLE_ROOT;
    assert.ok(root, "Require an explicitly marked sample root");
    assert.equal(
      readFileSync(resolve(root, ".my-knowledge-storage-sample"), "utf8"),
      "MY_KNOWLEDGE_DISPOSABLE_STORAGE_SAMPLE_V1\n",
    );
    const actual = await browser.executeAsync((done) => {
      void (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke(cmd: string): Promise<{ rootPath: string }> };
        }
      ).__TAURI_INTERNALS__
        .invoke("get_knowledge_tree")
        .then((value) => done(value.rootPath));
    });
    assert.equal(toNamespacedPath(String(actual)), toNamespacedPath(realpathSync.native(root)));
    const seed = process.env.MY_KNOWLEDGE_STORAGE_RESTART_PHASE === "sample-seed";
    const folder = $('div[data-path="Storage"]');
    await folder.waitForExist();
    if ((await folder.getAttribute("aria-expanded")) !== "true") await folder.click();
    const record: { origin?: string; values: object[] } = { values: [] };
    for (const name of ["Generated", "Converted"]) {
      const path = "Storage/" + name + ".html",
        source: Buffer = readFileSync(resolve(root, path));
      await $('div[data-path="' + path + '"]').click();
      await $(".document-pane.active iframe").waitForExist();
      const url = await $(".document-pane.active iframe").getAttribute("src");
      assert.ok(url);
      record.origin = new URL(url).origin;
      const index = await browser.execute(() =>
        Array.from(document.querySelectorAll("iframe")).indexOf(
          document.querySelector(".document-pane.active iframe")!,
        ),
      );
      await browser.switchToFrame(index);
      await $("#save").waitForExist();
      await browser.waitUntil(async () => (await $("#status").getText()) !== "保存状態を読込中…");
      const expected =
        name === "Generated"
          ? { amount: "12.5", mode: "square", enabled: false, result: "無効" }
          : { amount: "9", mode: "double", enabled: true, result: "18" };
      if (seed) {
        assert.equal(
          await $("#status").getText(),
          "保存値なし",
          "A copied sample in a separate root must not inherit QA document identity",
        );
        await browser.execute((values) => {
          document.querySelector<HTMLInputElement>("#amount")!.value = values.amount;
          document.querySelector<HTMLSelectElement>("#mode")!.value = values.mode;
          document.querySelector<HTMLInputElement>("#enabled")!.checked = values.enabled;
          document.querySelector("#amount")!.dispatchEvent(new Event("input", { bubbles: true }));
        }, expected);
        await $("#save").click();
        await browser.waitUntil(async () => (await $("#status").getText()) === "保存済み");
      } else {
        await browser.waitUntil(async () => (await $("#status").getText()) === "復元済み");
      }
      const values = await browser.execute(() => ({
        amount: document.querySelector<HTMLInputElement>("#amount")!.value,
        mode: document.querySelector<HTMLSelectElement>("#mode")!.value,
        enabled: document.querySelector<HTMLInputElement>("#enabled")!.checked,
        result: document.querySelector("#result")!.textContent,
      }));
      assert.deepEqual(values, expected);
      record.values.push({ sample: name, ...values });
      await browser.saveScreenshot(
        resolve(".tools/native-storage-sample-" + name.toLowerCase() + ".png"),
      );
      await browser.switchToParentFrame();
      assert.deepEqual(readFileSync(resolve(root, path)), source);
    }
    if (seed) {
      const rebuilt = await browser.executeAsync((done) => {
        const api = (
          window as unknown as {
            __TAURI_INTERNALS__: {
              invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
            };
          }
        ).__TAURI_INTERNALS__;
        void api
          .invoke<{ workspaceId: string }>("get_knowledge_tree")
          .then((tree) => api.invoke("rebuild_search_index", { workspaceId: tree.workspaceId }))
          .then(
            () => done(true),
            () => done(false),
          );
      });
      assert.equal(rebuilt, true);
      await browser.waitUntil(
        async () =>
          await browser.executeAsync((done) => {
            const api = (
              window as unknown as {
                __TAURI_INTERNALS__: {
                  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
                };
              }
            ).__TAURI_INTERNALS__;
            void api
              .invoke<{ workspaceId: string }>("get_knowledge_tree")
              .then((tree) =>
                api.invoke<{ phase: string }>("get_index_status", {
                  workspaceId: tree.workspaceId,
                }),
              )
              .then(
                (status) => done(status.phase === "ready"),
                () => done(false),
              );
          }),
        {
          timeout: 30000,
          timeoutMsg: "The separate sample index must rebuild before process restart",
        },
      );
    }
    if (!seed) {
      const previous = JSON.parse(
        readFileSync(resolve(".tools/native-storage-sample-seed.json"), "utf8"),
      );
      assert.notEqual(
        record.origin,
        previous.origin,
        "A new app process must issue a new random origin",
      );
      assert.deepEqual(record.values, previous.values);
    }
    writeFileSync(
      resolve(".tools/native-storage-sample-" + (seed ? "seed" : "restored") + ".json"),
      JSON.stringify(record, null, 2),
    );
  });
});
