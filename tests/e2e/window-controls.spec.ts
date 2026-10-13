import { browser, $ } from "@wdio/globals";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";

describe("Windows integrated window controls", () => {
  it("places tabs and three buttons in one row and invokes the native window operations", async () => {
    await $('div[data-path="01-Welcome.html"]').waitForExist();
    await $('div[data-path="01-Welcome.html"]').click();
    await $(".document-pane.active iframe").waitForExist();
    const url = await $(".document-pane.active iframe").getAttribute("src");
    const metrics = async () =>
      browser.execute(async () => {
        const api = (
          window as unknown as {
            __TAURI_INTERNALS__: {
              invoke: (command: string) => Promise<{ maximized: boolean; minimized: boolean }>;
            };
          }
        ).__TAURI_INTERNALS__;
        return api.invoke("get_window_chrome");
      });
    const geometry = await browser.execute(() => {
      const header = document.querySelector(".titlebar")!.getBoundingClientRect();
      const controls = Array.from(
        document.querySelectorAll<HTMLButtonElement>(".window-controls button"),
      );
      return {
        top: header.top,
        height: header.height,
        controls: controls.map((b) => {
          const r = b.getBoundingClientRect();
          return {
            top: r.top,
            height: r.height,
            width: r.width,
            hit:
              document
                .elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
                ?.closest("button") === b,
          };
        }),
      };
    });
    assert.equal(geometry.top, 0);
    assert.equal(geometry.height, 40);
    assert.equal(geometry.controls.length, 3);
    assert(
      geometry.controls.every(
        (c) => c.top === 0 && c.height >= 39 && c.height <= 40 && c.width === 46 && c.hit,
      ),
    );
    await $(".window-controls button:nth-child(2)").click();
    await browser.waitUntil(async () => (await metrics()).maximized);
    assert.equal(
      await $(".window-controls button:nth-child(2)").getAttribute("aria-label"),
      "元のサイズに戻す",
    );
    await browser.saveScreenshot(resolve(".tools/native-integrated-maximized.png"));
    await $(".window-controls button:nth-child(2)").click();
    await browser.waitUntil(async () => !(await metrics()).maximized);
    await $(".window-controls button:first-child").click();
    await browser.waitUntil(async () => (await metrics()).minimized);
    // WebDriver restores this dedicated test window; it does not touch another application.
    await browser.maximizeWindow();
    await browser.waitUntil(async () => !(await metrics()).minimized);
    await $(".window-controls button:nth-child(2)").click();
    await browser.waitUntil(async () => !(await metrics()).maximized);
    assert.equal(await $(".document-pane.active iframe").getAttribute("src"), url);
    await browser.execute(() =>
      document.querySelector<HTMLButtonElement>(".window-controls button:nth-child(2)")!.focus(),
    );
    await browser.keys("Enter");
    await browser.waitUntil(async () => (await metrics()).maximized);
    await browser.keys("Enter");
    await browser.waitUntil(async () => !(await metrics()).maximized);
    await browser.saveScreenshot(resolve(".tools/native-integrated-restored.png"));
    writeFileSync(
      resolve(".tools/native-window-controls.json"),
      JSON.stringify({
        geometry,
        maximizedRestored: true,
        minimizedRestored: true,
        keyboardEnter: true,
        iframeUrlRetained: true,
      }),
    );
  });
  it("closes only the dedicated test window through its visible close button", async () => {
    await $(".window-close").click();
    await browser.waitUntil(async () => {
      try {
        return (await browser.getWindowHandles()).length === 0;
      } catch (error) {
        return /no such window|invalid session|target window already closed/i.test(String(error));
      }
    });
    writeFileSync(
      resolve(".tools/native-window-close.json"),
      JSON.stringify({ visibleCloseButton: true }),
    );
  });
});
