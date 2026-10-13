import { browser, $ } from "@wdio/globals";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";

// Explicit opt-in overwrites the clipboard only with this owned fixture path.
// Never read or save its previous contents. Use an isolated identifier/profile.
describe("Windows Unicode clipboard and contextual operation feedback", () => {
  it("copies exact file/folder names, reports API rejection, and retains the document", async function () {
    if (process.platform !== "win32" || process.env.MY_KNOWLEDGE_E2E_CLIPBOARD !== "1") this.skip();
    assert.equal(process.env.MY_KNOWLEDGE_E2E_ACTION_CAPTURE, undefined);
    assert.equal(process.env.MY_KNOWLEDGE_TEST_BINARY, undefined);
    assert.equal(process.env.MY_KNOWLEDGE_BENCH_ROOT, undefined);
    assert.equal(process.env.MY_KNOWLEDGE_CLOUD_FIXTURE_ROOT, undefined);
    const binary = process.env.MY_KNOWLEDGE_E2E_BINARY!;
    const manifest = JSON.parse(readFileSync(resolve(dirname(binary), "manifest.json"), "utf8"));
    assert.notEqual(manifest.identifier, "com.shimilynx.aiwiki");
    assert.ok(manifest.features.includes("e2e"));
    assert.equal(createHash("sha256").update(readFileSync(binary)).digest("hex"), manifest.sha256);
    const root = resolve(".tools/e2e-knowledge");
    assert.equal(resolve(process.env.MY_KNOWLEDGE_E2E_ROOT!), root);
    const folder = `Clipboard-${Date.now()} 日本語 空白 & # % (é-e\u0301) 😀`;
    const leaf = "日本語 空白 & # % é e\u0301 😀.html";
    const relative = folder + "/" + leaf;
    await $('button[aria-controls="knowledge-files"]').click();
    await $('div[data-path="Examples"]').click();
    await $('div[data-path="Examples/Interactive.html"]').click();
    await $(".document-pane.active iframe").waitForExist();
    const enterFrame = async () => {
      const index = await browser.execute(() =>
        Array.from(document.querySelectorAll("iframe")).indexOf(
          document.querySelector(".document-pane.active iframe")!,
        ),
      );
      await browser.switchToFrame(index);
    };
    await $("button=ルートにフォルダーを作成").click();
    const dialog = $('dialog[aria-labelledby="mutation-title"]');
    await dialog.waitForExist();
    await dialog.$("input").setValue(folder);
    await dialog.$('button[type="submit"]').click();
    await browser.waitUntil(() => existsSync(resolve(root, folder)));
    assert.equal(
      existsSync(resolve(root, "Examples", folder)),
      false,
      "root creation must ignore selected document parent",
    );
    copyFileSync(resolve("tests/fixtures/knowledge/01-Welcome.html"), resolve(root, relative));
    copyFileSync(
      resolve("tests/fixtures/knowledge/01-Welcome.html"),
      resolve(root, folder, "ascii.html"),
    );
    copyFileSync(
      resolve("tests/fixtures/knowledge/01-Welcome.html"),
      resolve(root, folder, "カンバンToDo.html"),
    );
    const lockDirectory = resolve(".tools/clipboard-locks", folder);
    mkdirSync(lockDirectory, { recursive: true });
    writeFileSync(resolve(lockDirectory, ".clipboard-qa-marker"), "owned clipboard fixture\n");
    const row = $(`div[data-path="${folder}"]`);
    await row.waitForExist();
    if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
    // Fixture creation legitimately triggers watcher reloads. Prepare it before
    // the retained-state baseline, and keep lock markers outside knowledge.
    await browser.pause(500);
    const frame = $(".document-pane.active iframe");
    const before = await browser.execute(() => {
      const node = document.querySelector<HTMLIFrameElement>(".document-pane.active iframe")!;
      (window as unknown as { qaClipboardFrame: Element }).qaClipboardFrame = node;
      const r = node.getBoundingClientRect();
      return { top: r.top, height: r.height, url: node.src };
    });
    await enterFrame();
    await $("#module-result").waitForExist();
    await $("#text").setValue("clipboard retains document");
    await $("#action").click();
    const canvasPixel = await browser.execute(() =>
      Array.from(
        document
          .querySelector<HTMLCanvasElement>("#canvas")!
          .getContext("2d")!
          .getImageData(0, 0, 1, 1).data,
      ),
    );
    assert.notDeepEqual(canvasPixel, [0, 0, 0, 0]);
    await browser.switchToParentFrame();
    // Establish a known fixture value before any read. Do not intercept or mock
    // Native dispatch: wait for this real write acknowledgement before reading.
    const established = await browser.executeAsync((sentinel, done) => {
      const qa = window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
        };
      };
      const invoke = qa.__TAURI_INTERNALS__.invoke.bind(qa.__TAURI_INTERNALS__);
      void (async () => {
        try {
          const snapshot = (await invoke("get_knowledge_tree")) as {
            workspaceId: string;
            viewId: string;
          };
          await invoke("perform_file_action", {
            workspaceId: snapshot.workspaceId,
            viewId: snapshot.viewId,
            relativePath: sentinel,
            action: "copyPath",
          });
          done(true);
        } catch {
          done(false);
        }
      })();
    }, folder + "/ascii.html");
    assert.equal(
      established,
      true,
      "Native must acknowledge the fixture sentinel before any clipboard read",
    );
    const copy = async (path: string, expectedFailure = false) => {
      const node = $(`div[data-path="${path}"]`);
      await node.waitForDisplayed();
      await node.click({ button: "right" });
      await $('button[role="menuitem"]*=フルパスをコピー').click();
      await browser.waitUntil(
        async () => (await $("#knowledge-files").getAttribute("aria-busy")) === "false",
      );
      if (!expectedFailure) {
        // The acknowledged sentinel guarantees these bounded reads cannot start
        // with the previous user clipboard. Compare only booleans, never text.
        await browser.waitUntil(() => matchesOwned(path), {
          timeoutMsg: "Clipboard did not match the owned fixture",
        });
        assert.equal(await $('.workspace-feedback [role="alert"]').isExisting(), false);
      }
    };
    const readOwned = () => {
      assert.equal(established, true);
      const value = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-STA",
          "-Command",
          "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $qaCopiedText=Get-Clipboard -Raw; [Console]::Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($qaCopiedText)))",
        ],
        { encoding: "utf8", windowsHide: true },
      );
      return Buffer.from(value.trim(), "base64").toString("utf8");
    };
    // Do not print unexpected clipboard text in assertions or logs.
    const matchesOwned = (path: string) => readOwned() === resolve(root, path);
    // Every read follows the acknowledged fixture sentinel. UI success is
    // verified by the actual changed clipboard value; rejection retains it.
    for (const path of [
      relative,
      folder,
      folder + "/ascii.html",
      folder + "/カンバンToDo.html",
      relative,
    ]) {
      await copy(path);
      assert.equal(matchesOwned(path), true, "Clipboard must equal the acknowledged fixture path");
      assert.equal(await $(".viewer-content .notice").isExisting(), false);
    }
    const lock = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-File",
        resolve("tests/e2e/clipboard-lock.ps1"),
        "-FixtureDirectory",
        lockDirectory,
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    const closed = new Promise<void>((resolve, reject) => {
      lock.once("error", reject);
      lock.once("close", (code) =>
        code === 0 ? resolve() : reject(new Error("Clipboard lock helper failed")),
      );
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Clipboard lock timeout")), 10000);
        lock.stdout!.on("data", (value) => {
          if (String(value).includes("LOCKED")) {
            clearTimeout(timer);
            resolve();
          }
        });
        lock.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("Clipboard lock exited before readiness"));
        });
      });
      await copy(folder, true);
      await $('.workspace-feedback [role="alert"]').waitForExist();
      assert.match(
        await $('.workspace-feedback [role="alert"]').getText(),
        /クリップボードを開けません/,
      );
    } finally {
      writeFileSync(resolve(lockDirectory, ".clipboard-qa-release"), "release");
      await closed;
    }
    assert.equal(
      matchesOwned(relative),
      true,
      "API rejection must retain our previous fixture value",
    );
    const after = await browser.execute(() => {
      const node = document.querySelector<HTMLIFrameElement>(".document-pane.active iframe")!;
      const r = node.getBoundingClientRect();
      return {
        same: node === (window as unknown as { qaClipboardFrame: Element }).qaClipboardFrame,
        top: r.top,
        height: r.height,
        url: node.src,
      };
    });
    assert.equal(after.same, true);
    assert.equal(after.top, before.top);
    assert.equal(after.height, before.height);
    assert.equal(after.url, before.url);
    await enterFrame();
    assert.equal(await $("#text").getValue(), "clipboard retains document");
    assert.equal(await browser.execute(() => document.documentElement.dataset.canvas), "drawn");
    assert.deepEqual(
      await browser.execute(() =>
        Array.from(
          document
            .querySelector<HTMLCanvasElement>("#canvas")!
            .getContext("2d")!
            .getImageData(0, 0, 1, 1).data,
        ),
      ),
      canvasPixel,
    );
    await browser.switchToParentFrame();
    await browser.saveScreenshot(resolve(".tools/clipboard-feedback-native.png"));
    await copy(folder);
    assert.equal(matchesOwned(folder), true);
    assert.equal(await $('.workspace-feedback [role="alert"]').isExisting(), false);
    assert.deepEqual(
      readFileSync(resolve(root, relative)),
      readFileSync(resolve("tests/fixtures/knowledge/01-Welcome.html")),
    );
    assert.equal(await frame.getAttribute("src"), before.url);
    writeFileSync(
      resolve(".tools/clipboard-native-result.json"),
      JSON.stringify(
        {
          passed: true,
          buildSource: manifest.sourceCommit,
          fileAndFolderExact: true,
          japaneseSpacesSymbolsEmoji: true,
          nfcNfdPreserved: true,
          ascii: true,
          sequentialTargets: true,
          realClipboard: true,
          apiRejectionAndRetry: true,
          noOldClipboardReadOrSaved: true,
          fixtureSentinelAcknowledgedBeforeRead: true,
          uiCopyVerifiedAfterFixtureAcknowledgement: true,
          unexpectedClipboardTextNotLogged: true,
          exactKanbanToDoName: true,
          rootCreation: true,
          noViewerBanner: true,
          documentGeometryAndStateRetained: true,
          originalHtmlUnchanged: true,
        },
        null,
        2,
      ),
    );
  });
});
