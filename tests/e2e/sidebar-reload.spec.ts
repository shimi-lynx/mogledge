import { browser, $ } from "@wdio/globals";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

async function enterInteractive() {
  const index = await browser.execute(() =>
    [...document.querySelectorAll("iframe")].findIndex(
      (f) => f.title === "Examples/Interactive.html",
    ),
  );
  assert.ok(index >= 0);
  await browser.switchToFrame(index);
}
describe("Sidebar and refresh protection", () => {
  it("retains tabs, columns and close history for shell/document R keys, with explicit reload usable", async () => {
    await $('button[aria-controls="knowledge-files"]').click();
    await $('div[data-path="01-Welcome.html"]').click();
    if (!(await $('div[data-path="Examples/Interactive.html"]').isExisting()))
      await $('div[data-path="Examples"]').click();
    await $('div[data-path="Examples/Interactive.html"]').click();
    await $('iframe[title="Examples/Interactive.html"]').waitForExist();
    const panel = await browser.execute(
      () =>
        document
          .querySelector('iframe[title="Examples/Interactive.html"]')
          ?.closest(".document-pane")?.id,
    );
    assert.ok(panel);
    await $('[aria-controls="' + panel + '"][role="tab"]').click();
    await browser.keys(["Control", "Shift", "ArrowRight"]);
    if (!(await $('div[data-path="Search/Quality.html"]').isExisting()))
      await $('div[data-path="Search"]').click();
    await $('div[data-path="Search/Quality.html"]').click();
    await $('button[aria-label="Search/Quality.htmlを閉じる"]').click();
    await $('button[aria-label="Search/Quality.htmlを閉じる"]').waitForExist({ reverse: true });
    const before = await browser.execute(() => ({
      origin: performance.timeOrigin,
      tabs: [...document.querySelectorAll('[role="tab"]')].map((e) =>
        e.getAttribute("aria-controls"),
      ),
      columns: document.querySelectorAll(".tab-group").length,
    }));
    await browser.execute(() => {
      const state = window as unknown as {
        qaShellR: { key: string; shift: boolean; trusted: boolean; prevented: boolean }[];
      };
      state.qaShellR = [];
      window.addEventListener(
        "keydown",
        (event) => {
          if (event.ctrlKey && event.key.toLowerCase() === "r")
            state.qaShellR.push({
              key: event.key,
              shift: event.shiftKey,
              trusted: event.isTrusted,
              prevented: event.defaultPrevented,
            });
        },
        true,
      );
    });
    const checkShellScope = async (selector: string) => {
      assert.equal(
        await browser.execute(
          (selector) => Boolean(document.activeElement?.closest(selector)),
          selector,
        ),
        true,
      );
      const count = await browser.execute(
        () => (window as unknown as { qaShellR: unknown[] }).qaShellR.length,
      );
      await browser.keys(["Control", "r"]);
      await browser.keys(["Control", "Shift", "r"]);
      const events = await browser.execute(
        () => (window as unknown as { qaShellR: unknown[] }).qaShellR,
      );
      assert.deepEqual(events.slice(count), [
        { key: "r", shift: false, trusted: true, prevented: true },
        { key: "R", shift: true, trusted: true, prevented: true },
      ]);
      assert.equal(await $(selector).isExisting(), true);
    };
    await $('div[data-path="Examples/Interactive.html"]').click({ button: "right" });
    await checkShellScope(".file-context-menu");
    await browser.saveScreenshot(resolve(".tools/native-sidebar-file-menu.png"));
    await browser.keys("Escape");
    await $('[aria-controls="' + panel + '"][role="tab"]').click({ button: "right" });
    await checkShellScope(".tab-context-menu");
    await browser.saveScreenshot(resolve(".tools/native-sidebar-tab-menu.png"));
    await browser.keys("Escape");
    await $("button=HTMLを作成").click();
    await $("dialog[open] input").waitForExist();
    await checkShellScope("dialog[open]");
    await $('dialog[open] button[type="button"]').click();
    await enterInteractive();
    await $("#text").setValue("reload-protected");
    await $("#action").click();
    await browser.execute(() => {
      const state = window as unknown as {
        qaRKeys: { key: string; shift: boolean; trusted: boolean; prevented: boolean }[];
        qaReloadHeap: number;
      };
      state.qaRKeys = [];
      state.qaReloadHeap = 97;
      window.addEventListener("keydown", (event) => {
        if (event.ctrlKey && event.key.toLowerCase() === "r")
          state.qaRKeys.push({
            key: event.key,
            shift: event.shiftKey,
            trusted: event.isTrusted,
            prevented: event.defaultPrevented,
          });
      });
    });
    await browser.switchToFrame(null);
    for (const focus of ["shell", "document"])
      for (const shift of [false, true]) {
        if (focus === "shell") await $('button[aria-controls="knowledge-files"]').click();
        else {
          await enterInteractive();
          await $("#action").click();
        }
        await browser.keys(shift ? ["Control", "Shift", "r"] : ["Control", "r"]);
        await browser.pause(150);
        if (focus === "document") {
          assert.equal(await $("#text").getValue(), "reload-protected");
          assert.equal(
            await browser.execute(
              () => (window as unknown as { qaReloadHeap: number }).qaReloadHeap,
            ),
            97,
          );
          await browser.switchToFrame(null);
        }
        assert.deepEqual(
          await browser.execute(() => ({
            origin: performance.timeOrigin,
            tabs: [...document.querySelectorAll('[role="tab"]')].map((e) =>
              e.getAttribute("aria-controls"),
            ),
            columns: document.querySelectorAll(".tab-group").length,
          })),
          before,
        );
      }
    await enterInteractive();
    const htmlEvents = await browser.execute(
      () => (window as unknown as { qaRKeys: unknown[] }).qaRKeys,
    );
    assert.deepEqual(htmlEvents, [
      { key: "r", shift: false, trusted: true, prevented: false },
      { key: "R", shift: true, trusted: true, prevented: false },
    ]);
    await browser.switchToFrame(null);
    await $('[aria-controls="' + panel + '"][role="tab"]').click();
    await browser.keys(["Control", "Shift", "t"]);
    await $('button[aria-label="Search/Quality.htmlを閉じる"]').waitForExist();
    await $('[aria-controls="' + panel + '"][role="tab"]').click({ button: "right" });
    const old = await $('iframe[title="Examples/Interactive.html"]').getAttribute("src");
    await $('button[role="menuitem"]*=状態をリセットして再読み込み').click();
    await browser.waitUntil(
      async () =>
        (await $('iframe[title="Examples/Interactive.html"]').getAttribute("src")) !== old,
    );
    await enterInteractive();
    assert.equal(
      await browser.execute(
        () => (window as unknown as { qaReloadHeap?: number }).qaReloadHeap ?? null,
      ),
      null,
    );
    await browser.switchToFrame(null);
    await browser.saveScreenshot(resolve(".tools/native-sidebar-reload.png"));
    const shellEvents = await browser.execute(
      () => (window as unknown as { qaShellR: unknown[] }).qaShellR,
    );
    writeFileSync(
      resolve(".tools/native-sidebar-reload.json"),
      JSON.stringify(
        {
          trustedWebDriverDomKeys: true,
          shellAndDocumentKeysPreserved: true,
          htmlEvents,
          shellEvents,
          closedTabRestored: true,
          explicitDocumentReload: true,
          physicalWin32AcceleratorNotTested: true,
        },
        null,
        2,
      ),
    );
  });
});
