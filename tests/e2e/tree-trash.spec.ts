import { browser, $ } from "@wdio/globals";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Snapshot, MutationResult } from "../../src/lib/types";

// Explicit opt-in: this suite touches only a newly created exclusive fixture.
// It does not empty the bin, restore arbitrary items, or delete user documents.
describe("Disposable Windows OS recycle fixture", () => {
  it("recycles a newly created folder recursively, preserving unrelated originals", async function () {
    if (process.platform !== "win32" || process.env.MOGLEDGE_E2E_TRASH !== "1") this.skip();
    assert.ok(process.env.MOGLEDGE_E2E_ACTION_CAPTURE, "requires ordinary disposable fixture run");
    assert.equal(process.env.MOGLEDGE_CLOUD_FIXTURE_ROOT, undefined);
    assert.equal(process.env.MOGLEDGE_BENCH_ROOT, undefined);
    assert.equal(process.env.MOGLEDGE_TEST_BINARY, undefined);
    const root = resolve(".tools/e2e-knowledge");
    assert.equal(resolve(process.env.MOGLEDGE_E2E_ROOT!), root);
    const name = "TrashFixture-" + Date.now();
    assert.equal(existsSync(resolve(root, name)), false);
    const unrelated = readFileSync(resolve(root, "01-Welcome.html"));
    const invoke = (request: unknown) =>
      browser.executeAsync(
        (payload, done) => {
          const api = (
            window as unknown as {
              __TAURI_INTERNALS__: {
                invoke: (command: string, args?: unknown) => Promise<unknown>;
              };
            }
          ).__TAURI_INTERNALS__;
          void (async () => {
            try {
              const snapshot = (await api.invoke("get_knowledge_tree")) as Snapshot;
              if (
                snapshot.rootPath?.replace(/^\\\\\?\\/, "").toLowerCase() !==
                payload.root.toLowerCase()
              )
                throw new Error("fixture root mismatch");
              const result =
                payload.request === null
                  ? snapshot
                  : ((await api.invoke("mutate_tree", {
                      workspaceId: snapshot.workspaceId,
                      viewId: snapshot.viewId,
                      mutation: payload.request,
                    })) as MutationResult);
              done({ result });
            } catch (error) {
              done({ nativeFailure: String(error) });
            }
          })();
        },
        { root, request },
      ) as Promise<{ result?: Snapshot | MutationResult; nativeFailure?: string }>;
    assert.equal(
      (await invoke({ kind: "createFolder", parent: "", name })).nativeFailure,
      undefined,
    );
    writeFileSync(resolve(root, name, "child.html"), "<title>external fixture</title>", {
      flag: "wx",
    });
    writeFileSync(resolve(root, name, ".hidden"), "disposable-hidden");
    writeFileSync(resolve(root, name, "asset.json"), "disposable-asset");
    await $('button[aria-controls="knowledge-files"]').click();
    const folder = $(`div[data-path="${name}"]`);
    await folder.waitForExist();
    await folder.click({ button: "right" });
    await $("button*=ごみ箱に移動").click();
    const dialog = $('dialog[aria-labelledby="trash-title"]');
    await dialog.waitForExist();
    assert.ok((await dialog.getText()).includes("配下すべて"));
    await dialog.$('button[type="button"]').click();
    assert.equal(existsSync(resolve(root, name, "child.html")), true);
    const current = await invoke(null);
    assert.equal(current.nativeFailure, undefined);
    const snapshot = current.result as Snapshot;
    const result = await invoke({ kind: "trash", source: name, revision: snapshot.revision });
    assert.equal(result.nativeFailure, undefined);
    assert.equal(existsSync(resolve(root, name)), false);
    assert.deepEqual(readFileSync(resolve(root, "01-Welcome.html")), unrelated);
    // Verify actual Recycle Bin contents and restoration manually; disappearance
    // alone does not prove that Windows made an item recoverable.
  });
});
