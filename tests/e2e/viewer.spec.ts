import { createServer } from "node:http";
import { browser, $ } from "@wdio/globals";
import assert from "node:assert/strict";
import {
  writeFileSync,
  renameSync,
  unlinkSync,
  readFileSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { resolve, toNamespacedPath } from "node:path";

async function snapshot() {
  return browser.executeAsync((done) => {
    void (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (command: string) => Promise<{
            workspaceId: string;
            viewId: string;
            revision: number;
            nodes: unknown[];
            rootPath?: string | null;
          }>;
        };
      }
    ).__TAURI_INTERNALS__
      .invoke("get_knowledge_tree")
      .then(done, () => done({ workspaceId: "ERROR", viewId: "ERROR", revision: -1, nodes: [] }));
  }) as Promise<{
    workspaceId: string;
    viewId: string;
    revision: number;
    nodes: unknown[];
    rootPath?: string | null;
  }>;
}
async function select(path: string) {
  const sidebar = $('button[aria-controls="knowledge-sidebar"]');
  if ((await sidebar.getAttribute("aria-expanded")) === "false") await sidebar.click();
  if (!(await $('div[data-path="' + path + '"]').isDisplayed()))
    await $('button[aria-label="ファイル"]').click();
  // Fixture checks request a fresh run when a retained tab already exists.
  const reused = await browser.execute(
    (path) => Boolean(document.querySelector('iframe[title="' + path + '"]')),
    path,
  );
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
  // Shortcut kbd text is intentionally excluded from the accessible name, but
  // WebDriver's text selector includes it. Match the visible action label.
  await $('button[role="menuitem"]*=' + label).click();
}

async function moveActiveTab(direction: "Left" | "Right") {
  const panel = await $(".document-pane.active").getAttribute("id");
  assert.ok(panel);
  await $('button[role="tab"][aria-controls="' + panel + '"]').click();
  await browser.keys(["Control", "Shift", "Arrow" + direction]);
}

async function renameFixture(source: string, target: string) {
  const root = resolve(".tools/e2e-knowledge") + "/";
  for (const path of [source, target])
    assert.ok(resolve(path).replaceAll("\\", "/").startsWith(root.replaceAll("\\", "/")));
  // Windows scanning may briefly hold these owned fixture paths. Retry only
  // sharing/permission errors; a persistent error still fails the test.
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      renameSync(source, target);
      return;
    } catch (error) {
      if (
        !["EBUSY", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "") ||
        Date.now() >= deadline
      )
        throw error;
      await browser.pause(100);
    }
  }
}

async function enterFrame() {
  // The external driver accepts frame indexes; its legacy element-reference
  // transport does not accept WebdriverIO's W3C element wrapper.
  const index = await browser.execute(() => {
    const frame = document.querySelector<HTMLIFrameElement>(".document-pane.active iframe");
    return frame ? Array.from(document.querySelectorAll("iframe")).indexOf(frame) : -1;
  });
  assert.ok(index >= 0, "The active iframe must belong to the current Native document");
  await browser.switchToFrame(index);
}
async function leaveFrame() {
  await browser.switchToParentFrame();
}
describe("Native desktop viewer", () => {
  afterEach(async () => {
    await browser.switchToParentFrame();
  });
  it("runs local classic scripts, Modules, JSON, controls and Canvas", async () => {
    await $('div[data-path="Examples"]').waitForExist();
    await $('div[data-path="Examples"]').click();
    await select("Examples/Interactive.html");
    await enterFrame();
    await browser.waitUntil(
      async () => (await $("#module-result").getText()) === "Module ready: local JSON",
    );
    assert.equal(await browser.execute(() => document.documentElement.dataset.classic), "ready");
    assert.equal(
      await browser.execute(() => getComputedStyle(document.body).backgroundColor),
      "rgb(246, 250, 247)",
    );
    await $("#text").setValue("edited input");
    assert.equal(await $("#text").getValue(), "edited input");
    await $("#action").click();
    assert.equal(await browser.execute(() => document.documentElement.dataset.canvas), "drawn");
    await browser.execute(() => {
      const range = document.querySelector<HTMLInputElement>("#range")!;
      range.value = "73";
      range.dispatchEvent(new Event("input", { bubbles: true }));
    });
    assert.equal(await $("#value").getText(), "73");
    await browser.saveScreenshot(resolve(".tools/native-viewer.png"));
    await leaveFrame();
    await browser.refresh();
    await $('div[data-path="Examples"]').waitForExist();
    await $('div[data-path="Examples"]').click();
    await select("Examples/Interactive.html");
    await enterFrame();
    await $("#module-result").waitForExist();
    await leaveFrame();
  });
  it("rejects real Native IPC, parent access and external resources", async () => {
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
    assert.notEqual(before.workspaceId, "ERROR", "Native snapshot must be available");
    await $('div[data-path="Security"]').click();
    await select("Security/Isolation.html");
    await enterFrame();
    await browser.waitUntil(
      async () => (await browser.execute(() => document.documentElement.dataset.done)) === "true",
    );
    const result = JSON.parse(await $("#results").getText());
    for (const [name, value] of Object.entries(result)) assert.equal(value, true, name);
    await leaveFrame();
    const after = await snapshot();
    assert.notEqual(after.workspaceId, "ERROR");
    assert.equal(
      after.workspaceId,
      before.workspaceId,
      "Injected refresh command must not execute",
    );
    assert.equal(after.viewId, before.viewId, "Injected IPC must not reset renderer ownership");
    assert.equal(after.revision, before.revision, "Injected IPC must not mutate native state");
    assert.equal(
      await $("#document-search-query").isDisplayed(),
      false,
      "Forged window-command postMessages must not focus search",
    );
    assert.equal(
      await browser.execute(() =>
        document
          .querySelector<HTMLIFrameElement>(".document-pane.active iframe")!
          .getAttribute("sandbox"),
      ),
      "allow-scripts",
    );
  });
  it("dispatches validated file actions without changing the actual clipboard or OS apps", async function () {
    const capture = process.env.MOGLEDGE_E2E_ACTION_CAPTURE;
    if (!capture) this.skip();
    const target = $('div[data-path="Examples/Interactive.html"]');
    const records = () =>
      existsSync(capture!)
        ? readFileSync(capture!, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { action: string; target: string })
        : [];
    const previous = await $('iframe[title="Security/Isolation.html"]').getAttribute("src");
    for (const [index, label] of [
      "フルパスをコピー",
      "元フォルダーを開く",
      "既定ブラウザーで表示",
    ].entries()) {
      await target.click({ button: "right" });
      await $('button[role="menuitem"]=' + label).click();
      await browser.waitUntil(async () => records().length === index + 1);
    }
    const [copy, folder, web] = records();
    assert.equal(copy.action, "copyPath");
    assert.equal(folder.action, "openFolder");
    assert.equal(web.action, "openBrowser");
    assert.equal(copy.target, resolve(".tools/e2e-knowledge/Examples/Interactive.html"));
    assert.equal(folder.target, resolve(".tools/e2e-knowledge/Examples"));
    const url = new URL(web.target);
    assert.equal(url.protocol, "http:");
    assert.equal(url.hostname, "127.0.0.1");
    assert.ok(decodeURIComponent(url.pathname).endsWith("/Examples/Interactive.html"));
    const response = await fetch(web.target);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("content-security-policy")!.includes("sandbox allow-scripts"));
    assert.equal(await $('iframe[title="Security/Isolation.html"]').getAttribute("src"), previous);
    await browser
      .executeAsync((done) => {
        const api = (
          window as unknown as {
            __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> };
          }
        ).__TAURI_INTERNALS__;
        void api.invoke("get_knowledge_tree", {}).then(async (value) => {
          const snapshot = value as { workspaceId: string; viewId: string };
          try {
            await api.invoke("perform_file_action", {
              ...snapshot,
              relativePath: "../outside.html",
              action: "openFolder",
            });
            done(false);
          } catch {
            done(true);
          }
        });
      })
      .then((value) => assert.equal(value, true));
    assert.equal(records().length, 3, "Rejected paths must not dispatch OS actions");
  });
  it("retains hidden input, Canvas and heap across columns and revokes closed grants", async () => {
    await select("Examples/Interactive.html");
    const original = await $(".document-pane.active iframe").getAttribute("src");
    await enterFrame();
    await $("#module-result").waitForExist();
    await $("#text").setValue("retained native input");
    await $("#action").click();
    await browser.execute(() => {
      (window as unknown as { retainedHeap: object }).retainedHeap = { value: 42 };
    });
    await leaveFrame();
    await select("Security/Isolation.html");
    await $('div[data-path="Examples/Interactive.html"]').click();
    assert.equal(await $(".document-pane.active iframe").getAttribute("src"), original);
    await browser.execute(() => {
      (window as unknown as { retainedNativeFrame: Element | null }).retainedNativeFrame =
        document.querySelector(".document-pane.active iframe");
    });
    await moveActiveTab("Right");
    assert.equal(
      await browser.execute(() => document.querySelectorAll('[role="tablist"]').length),
      2,
    );
    await moveActiveTab("Left");
    assert.equal(
      await browser.execute(() => document.querySelectorAll('[role="tablist"]').length),
      1,
    );
    assert.ok(
      await browser.execute(
        () =>
          (window as unknown as { retainedNativeFrame: Element }).retainedNativeFrame ===
          document.querySelector(".document-pane.active iframe"),
      ),
    );
    await enterFrame();
    assert.equal(await $("#text").getValue(), "retained native input");
    assert.equal(
      await browser.execute(
        () => (window as unknown as { retainedHeap: { value: number } }).retainedHeap.value,
      ),
      42,
    );
    assert.equal(
      await browser.execute(
        () =>
          document
            .querySelector<HTMLCanvasElement>("#canvas")!
            .getContext("2d")!
            .getImageData(0, 0, 1, 1).data[0],
      ),
      51,
    );
    await leaveFrame();
    const sibling = await $('iframe[title="Security/Isolation.html"]').getAttribute("src");
    assert.equal((await fetch(original!)).status, 200);
    const siblingPath = new URL(sibling!).pathname.split("/").slice(3).join("/");
    const otherHtml = new URL(original!);
    otherHtml.pathname = otherHtml.pathname.split("/").slice(0, 3).join("/") + "/" + siblingPath;
    assert.equal((await fetch(otherHtml)).status, 403, "A tab grant must not read another HTML");
    await $('button[aria-label="Examples/Interactive.htmlを閉じる"]').click();
    await browser.waitUntil(
      async () => !(await $('iframe[title="Examples/Interactive.html"]').isExisting()),
    );
    const asset = new URL(original!);
    asset.pathname = asset.pathname.split("/").slice(0, 3).join("/") + "/assets/data.json";
    assert.equal((await fetch(original!)).status, 404);
    assert.equal((await fetch(asset)).status, 404);
    assert.equal((await fetch(sibling!)).status, 200, "Closing one tab retains the other grant");
    await activeTabAction("閉じたタブを開き直す");
    await browser.waitUntil(
      async () =>
        (await $(".document-pane.active iframe").getAttribute("title")) ===
        "Examples/Interactive.html",
    );
    assert.notEqual(await $(".document-pane.active iframe").getAttribute("src"), original);
    assert.equal(
      (await fetch(original!)).status,
      404,
      "Reopening must not resurrect the old grant",
    );
    await enterFrame();
    await $("#text").waitForExist();
    assert.notEqual(await $("#text").getValue(), "retained native input");
    await leaveFrame();
  });
  it("blocks iframe navigation before any foreign HTTP request", async () => {
    let requests = 0;
    const trap = createServer((_, response) => {
      requests++;
      response.end("foreign");
    });
    await new Promise<void>((done) => trap.listen(0, "127.0.0.1", done));
    const address = trap.address();
    assert.ok(address && typeof address !== "string");
    const url = "http://127.0.0.1:" + address.port + "/blocked";
    try {
      await select("Examples/Interactive.html");
      await enterFrame();
      await browser.executeAsync((target, done) => {
        done(true);
        setTimeout(() => {
          location.href = target;
        }, 100);
      }, url);
      await browser.pause(250);

      assert.equal(requests, 0, "Frame navigation must not transmit a request");
      await leaveFrame();
      await select("Examples/Interactive.html");
      await enterFrame();
      await $("#module-result").waitForExist();
      await browser.execute(() => {
        setTimeout(() => {
          location.hash = "anchor";
        }, 20);
      });
      await browser.waitUntil(
        async () => (await browser.execute(() => location.hash)) === "#anchor",
      );
    } finally {
      await leaveFrame();
      await new Promise<void>(
        (done, reject) => (
          trap.closeAllConnections(),
          trap.close((error) => (error ? reject(error) : done()))
        ),
      );
    }
  });
  it("opens independent Native same-file views and restores their history from the shell", async () => {
    await select("Examples/Interactive.html");
    const leftPanel = await $(".document-pane.active").getAttribute("id");
    const leftUrl = await $(".document-pane.active iframe").getAttribute("src");
    await enterFrame();
    await $("#text").setValue("left independent");
    await leaveFrame();
    await activeTabAction("右の列で開く");
    const rightPanel = await $(".document-pane.active").getAttribute("id");
    const rightUrl = await $(".document-pane.active iframe").getAttribute("src");
    assert.notEqual(rightPanel, leftPanel);
    assert.notEqual(rightUrl, leftUrl);
    await enterFrame();
    await $("#text").waitForExist();
    assert.notEqual(await $("#text").getValue(), "left independent");
    await $("#text").setValue("right independent");
    await leaveFrame();
    await $('button[aria-label="文書検索"]').click();
    await $("#document-search-query").waitForDisplayed();
    await browser.waitUntil(async () =>
      browser.execute(() => document.activeElement?.id === "document-search-query"),
    );
    await $('button[aria-label="ファイル"]').click();
    await $('button[role="tab"][aria-controls="' + leftPanel + '"]').click();
    await enterFrame();
    assert.equal(await $("#text").getValue(), "left independent");
    await leaveFrame();
    await $('button[role="tab"][aria-controls="' + rightPanel + '"]').click();
    await activeTabAction("タブを閉じる");
    await browser.waitUntil(async () => !(await $("#" + rightPanel).isExisting()));
    assert.equal(
      await browser.execute(() => document.querySelectorAll('[role="tablist"]').length),
      1,
    );
    assert.equal((await fetch(rightUrl!)).status, 404);
    assert.equal((await fetch(leftUrl!)).status, 200);
    await $('button[role="tab"][aria-controls="' + leftPanel + '"]').click();
    await browser.keys(["Control", "Shift", "t"]);
    await browser.waitUntil(async () =>
      browser.execute(
        () => document.querySelectorAll('iframe[title="Examples/Interactive.html"]').length === 2,
      ),
    );
    assert.equal(
      await browser.execute(() => document.querySelectorAll('[role="tablist"]').length),
      2,
    );
    assert.notEqual(await $(".document-pane.active iframe").getAttribute("src"), rightUrl);
    await enterFrame();
    await $("#text").waitForExist();
    assert.notEqual(await $("#text").getValue(), "right independent");
    await leaveFrame();
    await activeTabAction("タブを閉じる");
    await browser.waitUntil(async () =>
      browser.execute(() => document.querySelectorAll('[role="tablist"]').length === 1),
    );
    await $('button[role="tab"][aria-controls="' + leftPanel + '"]').click();
    await enterFrame();
    assert.equal(await $("#text").getValue(), "left independent");
    await leaveFrame();
  });
  // WebDriver injects Chromium/CDP events. Those events do not update the Win32
  // modifier queue or guarantee the host's AcceleratorKeyPressed delivery.
  // Enable this case only with a physical keyboard harness for the isolated app.
  it.skip("routes physical Ctrl+Shift+F/T from opaque iframes (pending a physical keyboard harness)", async () => {
    await select("Examples/Interactive.html");
    const originalUrl = await $(".document-pane.active iframe").getAttribute("src");
    await enterFrame();
    await $("#text").setValue("physical shortcut retains input");
    await browser.keys(["Control", "Shift", "f"]);
    await leaveFrame();
    await $("#document-search-query").waitForDisplayed();
    await browser.waitUntil(async () =>
      browser.execute(() => document.activeElement?.id === "document-search-query"),
    );
    await $('button[aria-label="ファイル"]').click();
    await enterFrame();
    assert.equal(await $("#text").getValue(), "physical shortcut retains input");
    await leaveFrame();
    await activeTabAction("右の列で開く");
    const closedUrl = await $(".document-pane.active iframe").getAttribute("src");
    await activeTabAction("タブを閉じる");
    assert.equal((await fetch(closedUrl!)).status, 404);
    await enterFrame();
    await $("#text").click();
    await browser.keys(["Control", "Shift", "t"]);
    await leaveFrame();
    await browser.waitUntil(async () =>
      browser.execute(
        () => document.querySelectorAll('iframe[title="Examples/Interactive.html"]').length === 2,
      ),
    );
    assert.equal(
      await browser.execute(() => document.querySelectorAll('[role="tablist"]').length),
      2,
    );
    assert.notEqual(await $(".document-pane.active iframe").getAttribute("src"), closedUrl);
    assert.equal((await fetch(closedUrl!)).status, 404);
    assert.equal((await fetch(originalUrl!)).status, 200);
    await enterFrame();
    await $("#text").waitForExist();
    assert.notEqual(await $("#text").getValue(), "physical shortcut retains input");
    await leaveFrame();
    await activeTabAction("タブを閉じる");
    await enterFrame();
    assert.equal(await $("#text").getValue(), "physical shortcut retains input");
    await leaveFrame();
  });
  it("keeps the Native titlebar aligned during window resize and pauses shortcuts in a shell dialog", async () => {
    await $('div[data-path="Examples"]').waitForExist();
    if (!(await $('div[data-path="Examples/Interactive.html"]').isExisting()))
      await $('div[data-path="Examples"]').click();
    await select("Examples/Interactive.html");
    const notice = $('button[aria-label="操作通知を閉じる"]');
    if (await notice.isExisting()) await notice.click();
    const previousUrl = await $(".document-pane.active iframe").getAttribute("src");
    const dimensions = await browser.getWindowSize();
    const visualFiles: string[] = [];
    try {
      await browser.setWindowSize(900, 700);
      const metrics = (await browser.executeAsync((done) => {
        void (
          window as unknown as {
            __TAURI_INTERNALS__: { invoke: (command: string) => Promise<unknown> };
          }
        ).__TAURI_INTERNALS__
          .invoke("get_window_chrome")
          .then((value) =>
            done(value as { height: number; leftInset: number; rightInset: number }),
          );
      })) as { height: number; leftInset: number; rightInset: number };
      const geometry = await browser.execute(() => {
        const titlebar = document.querySelector<HTMLElement>(".titlebar")!;
        const frame = document
          .querySelector(".document-pane.active iframe")!
          .getBoundingClientRect();
        return {
          height: titlebar.getBoundingClientRect().height,
          top: frame.top,
          width: innerWidth,
          titlebarBackground: getComputedStyle(titlebar).backgroundColor,
          sidebarBackground: getComputedStyle(document.querySelector(".sidebar")!).backgroundColor,
          controls: Array.from(
            titlebar.querySelectorAll("button:not(.window-controls button)"),
            (button) => ({
              left: button.getBoundingClientRect().left,
              right: button.getBoundingClientRect().right,
            }),
          ),
        };
      });
      assert.equal(geometry.height, metrics.height);
      assert.equal(geometry.titlebarBackground, "rgb(21, 31, 44)");
      assert.equal(geometry.titlebarBackground, geometry.sidebarBackground);
      assert.equal(geometry.top, metrics.height);
      assert.ok(
        geometry.controls.every(
          (rect) =>
            rect.left >= metrics.leftInset && rect.right <= geometry.width - metrics.rightInset,
        ),
      );
      assert.equal(await $(".document-pane.active iframe").getAttribute("src"), previousUrl);
      await browser.saveScreenshot(resolve(".tools/native-chrome-theme.png"));
      const alignment = await browser.execute(() => {
        const tabs = document.querySelector(".tab-strip")!.getBoundingClientRect();
        const content = document.querySelector(".content")!.getBoundingClientRect();
        const search = document
          .querySelector(".titlebar-views button:last-child")!
          .getBoundingClientRect();
        return { delta: tabs.left - content.left, gap: tabs.left - search.right };
      });
      assert.ok(Math.abs(alignment.delta) <= 1);
      assert.ok(alignment.gap >= 16);
      // These screenshots capture real WebView pixels, excluding the OS nonclient caption.
      await activeTabAction("右の列で開く");
      await browser.waitUntil(async () =>
        browser.execute(() => document.querySelectorAll('[role="tablist"]').length === 2),
      );
      await $(".document-pane.active iframe").waitForExist();
      await enterFrame();
      await $("#module-result").waitForDisplayed();
      await leaveFrame();
      const splitGeometry = await browser.execute(() => ({
        groups: Array.from(document.querySelectorAll(".tab-group"), (element) => ({
          left: element.getBoundingClientRect().left,
          width: element.getBoundingClientRect().width,
        })),
        frames: Array.from(
          document.querySelectorAll(".document-pane:not([hidden]) iframe"),
          (element) => ({
            left: element.getBoundingClientRect().left,
            width: element.getBoundingClientRect().width,
          }),
        ),
        viewport: innerWidth,
      }));
      writeFileSync(
        resolve(".tools/native-visual-split-geometry.json"),
        JSON.stringify(splitGeometry),
      );
      assert.ok(Math.abs(splitGeometry.groups[1].left - splitGeometry.frames[1].left) <= 1);
      await browser.saveScreenshot(resolve(".tools/native-visual-two-columns.png"));
      await $('button[aria-label="左メニューを閉じる"]').click();
      await browser.saveScreenshot(resolve(".tools/native-visual-sidebar-hidden.png"));
      await browser.setWindowSize(620, 700);
      await browser.saveScreenshot(resolve(".tools/native-visual-narrow.png"));
      await $('button[aria-label="左メニューを開く"]').click();
      assert.equal(await $(".tab-strip").isDisplayed(), false);
      await browser.saveScreenshot(resolve(".tools/native-visual-narrow-menu.png"));
      await browser.setWindowSize(1100, 760);
      await $('div[data-path="Examples/Interactive.html"]').click({ button: "right" });
      await browser.saveScreenshot(resolve(".tools/native-visual-context.png"));
      await $('button[role="menuitem"]*=名前を変更').click();
      await $("dialog input").waitForDisplayed();
      await $("dialog input").setValue("shortcut scope remains in dialog");
      await browser.saveScreenshot(resolve(".tools/native-visual-rename.png"));
      // The trusted shell pauses the Native accelerators while its editor is open.
      await browser.keys(["Control", "Shift", "f"]);
      assert.equal(await $("dialog input").getValue(), "shortcut scope remains in dialog");
      assert.ok(await browser.execute(() => document.activeElement?.closest("dialog") !== null));
      await $('dialog .mutation-dialog-buttons button[type="button"]').click();
      await $('button[aria-label="文書検索"]').click();
      await $("#document-search-query").setValue("Interactive");
      await $('.search-results button[title="Examples/Interactive.html"]').waitForDisplayed();
      await browser.saveScreenshot(resolve(".tools/native-visual-search.png"));
      await $('button[aria-label="ファイル"]').click();
      for (let index = 1; index <= 10; index++) {
        const name = `Visual-${index}-long-document-name-for-tab-overflow.html`;
        const fixturePath = resolve(".tools/e2e-knowledge/Examples", name);
        visualFiles.push(fixturePath);
        writeFileSync(fixturePath, `<h1>Visual fixture ${index}</h1><p>Tab overflow sample</p>`);
        await $('div[data-path="Examples/' + name + '"]').waitForExist();
        await select("Examples/" + name);
      }
      await browser.saveScreenshot(resolve(".tools/native-visual-many-tabs.png"));
      assert.ok(
        await browser.execute(() =>
          Array.from(document.querySelectorAll(".tab-group")).every(
            (element) => element.scrollHeight <= element.clientHeight,
          ),
        ),
      );
      try {
        await browser.maximizeWindow();
        await browser.saveScreenshot(resolve(".tools/native-visual-maximized.png"));
        writeFileSync(
          resolve(".tools/native-visual-maximize.json"),
          JSON.stringify({ supported: true, physicalCaptionClick: false }),
        );
      } catch (error) {
        writeFileSync(
          resolve(".tools/native-visual-maximize.json"),
          JSON.stringify({ supported: false, physicalCaptionClick: false, reason: String(error) }),
        );
      }
    } finally {
      await browser.setWindowSize(dimensions.width, dimensions.height);
      for (const path of visualFiles) if (existsSync(path)) unlinkSync(path);
    }
  });
  it("aligns split tabs with documents when sidebar is visible, hidden, or narrow", async () => {
    await $('div[data-path="Examples"]').waitForExist();
    if (!(await $('div[data-path="Examples/Interactive.html"]').isExisting()))
      await $('div[data-path="Examples"]').click();
    await select("Examples/Interactive.html");
    const notice = $('button[aria-label="操作通知を閉じる"]');
    if (await notice.isExisting()) await notice.click();
    await activeTabAction("右の列で開く");
    await $(".document-pane.active iframe").waitForExist();
    await enterFrame();
    await $("#module-result").waitForDisplayed();
    await leaveFrame();
    const dimensions = await browser.getWindowSize();
    const frames = await browser.execute(() =>
      Array.from(document.querySelectorAll(".document-pane:not([hidden]) iframe"), (frame) =>
        frame.getAttribute("src"),
      ),
    );
    const results = [];
    try {
      for (const state of [
        { name: "visible", width: 1100, sidebar: true },
        { name: "hidden", width: 1100, sidebar: false },
        { name: "narrow", width: 620, sidebar: false },
      ]) {
        await browser.setWindowSize(state.width, 700);
        const menu = $("button.menu-toggle");
        if ((await menu.getAttribute("aria-expanded")) !== String(state.sidebar))
          await menu.click();
        await browser.waitUntil(async () =>
          browser.execute(() => {
            const tabs = document.querySelector('.tab-group[data-column="1"]');
            const frame = document.querySelectorAll(".document-pane:not([hidden]) iframe")[1];
            return Boolean(
              tabs &&
              frame &&
              Math.abs(tabs.getBoundingClientRect().left - frame.getBoundingClientRect().left) <= 1,
            );
          }),
        );
        await browser.executeAsync((done: () => void) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        );
        const geometry = await browser.execute(() => ({
          tabBoundary: document
            .querySelector('.tab-group[data-column="1"]')!
            .getBoundingClientRect().left,
          documentBoundary: document
            .querySelectorAll(".document-pane:not([hidden]) iframe")[1]
            .getBoundingClientRect().left,
          searchGap:
            document.querySelector(".tab-strip")!.getBoundingClientRect().left -
            document.querySelector(".titlebar-views button:last-child")!.getBoundingClientRect()
              .right,
          viewport: innerWidth,
          pixelRatio: devicePixelRatio,
          windowButtons: Array.from(
            document.querySelectorAll<HTMLButtonElement>(".window-controls button"),
            (b) => {
              const r = b.getBoundingClientRect();
              return {
                left: r.left,
                right: r.right,
                top: r.top,
                hit:
                  document
                    .elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
                    ?.closest("button") === b,
              };
            },
          ),
          frames: Array.from(
            document.querySelectorAll(".document-pane:not([hidden]) iframe"),
            (frame) => frame.getAttribute("src"),
          ),
        }));
        assert.ok(Math.abs(geometry.tabBoundary - geometry.documentBoundary) <= 1);
        assert.ok(geometry.searchGap >= 16);
        if (process.platform === "win32") {
          assert.equal(geometry.windowButtons.length, 3);
          assert.ok(
            geometry.windowButtons.every(
              (b) => b.left >= 0 && b.right <= geometry.viewport && b.top === 0 && b.hit,
            ),
          );
        }
        assert.deepEqual(geometry.frames, frames);
        results.push({ state: state.name, ...geometry });
        await browser.saveScreenshot(resolve(`.tools/native-compact-${state.name}.png`));
      }
      writeFileSync(resolve(".tools/native-compact-alignment.json"), JSON.stringify(results));
    } finally {
      await browser.setWindowSize(dimensions.width, dimensions.height);
    }
  });
  it("reflects HTML/assets and file create, atomic replace, rename and deletion", async () => {
    const root = resolve(".tools/e2e-knowledge");
    await select("Examples/Interactive.html");
    const first = await $(".document-pane.active iframe").getAttribute("src");
    writeFileSync(resolve(root, "assets/data.json"), '{"message":"updated JSON"}');
    await browser.waitUntil(
      async () => (await $(".document-pane.active iframe").getAttribute("src")) !== first,
    );
    await enterFrame();
    await browser.waitUntil(
      async () => (await $("#module-result").getText()) === "Module ready: updated JSON",
    );
    await leaveFrame();
    const created = resolve(root, "Live.html");
    writeFileSync(created, '<h1 id="live">one</h1>');
    await $('div[data-path="Live.html"]').waitForExist();
    await select("Live.html");
    writeFileSync(resolve(root, "Live.tmp"), '<h1 id="live">two</h1>');
    const old = await $(".document-pane.active iframe").getAttribute("src");
    unlinkSync(created);
    await renameFixture(resolve(root, "Live.tmp"), created);
    await browser.waitUntil(
      async () => (await $(".document-pane.active iframe").getAttribute("src")) !== old,
    );
    await enterFrame();
    await browser.waitUntil(async () => (await $("#live").getText()) === "two");
    await leaveFrame();
    await renameFixture(created, resolve(root, "Renamed.html"));
    await $('div[data-path="Renamed.html"]').waitForExist();
    await browser.waitUntil(async () => !(await $(".document-pane.active iframe").isExisting()));
    await select("Renamed.html");
    unlinkSync(resolve(root, "Renamed.html"));
    await browser.waitUntil(async () => !(await $(".document-pane.active iframe").isExisting()));
    assert.match(await $('[role="alert"]').getText(), /削除|移動/);
    writeFileSync(
      resolve(root, "assets/data.json"),
      readFileSync("tests/fixtures/knowledge/assets/data.json"),
    );
  });
  it("creates, reorders and atomically moves fixture folders while following open tabs", async function () {
    if (!process.env.MOGLEDGE_E2E_ACTION_CAPTURE) this.skip();
    const root = resolve(".tools/e2e-knowledge");
    const invoke = (mutation: unknown) =>
      browser.executeAsync(
        (mutation, done) => {
          const api = (
            window as unknown as {
              __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> };
            }
          ).__TAURI_INTERNALS__;
          void api.invoke("get_knowledge_tree", {}).then(async (value) => {
            const snapshot = value as { workspaceId: string; viewId: string; rootPath: string };
            const expected = mutation as { expectedRoot: string; request: unknown };
            if (
              snapshot.rootPath.replace(/^\\\\\?\\/, "").toLowerCase() !==
              expected.expectedRoot.toLowerCase()
            ) {
              done({ nativeFailure: "fixture root mismatch" });
              return;
            }
            try {
              done(
                (await api.invoke("mutate_tree", {
                  workspaceId: snapshot.workspaceId,
                  viewId: snapshot.viewId,
                  mutation: expected.request,
                })) as { nativeFailure?: string; warning?: string | null },
              );
            } catch (error) {
              // WebDriver reserves a truthy top-level `error` as a protocol failure.
              done({ nativeFailure: String(error) });
            }
          });
        },
        { expectedRoot: root, request: mutation },
      ) as Promise<{ nativeFailure?: string; warning?: string | null }>;
    for (const name of ["MutationSource", "MutationTarget", "A"]) {
      assert.equal(
        (await invoke({ kind: "createFolder", parent: "", name })).nativeFailure,
        undefined,
      );
    }
    await browser.execute(() => {
      const tree = document.querySelector<HTMLElement>('[role="tree"]')!;
      tree.scrollTop = tree.scrollHeight;
      tree.dispatchEvent(new Event("scroll"));
    });
    let uiStep = "select-folder";
    try {
      await $('div[data-path="MutationSource"]').waitForDisplayed();
      await $('div[data-path="MutationSource"]').click();
      await $('[role="tree"]').waitForExist();
      await browser.waitUntil(
        async () =>
          (await $('[role="tree"]').getAttribute("aria-activedescendant")) ===
          "tree-MutationSource",
      );
      uiStep = "open-create-dialog";
      await $(".tree-tools").$("button=HTMLを作成").click();
      uiStep = "enter-create-name";
      await $("dialog input").waitForDisplayed();
      await $("dialog input").setValue("日本語メモ");
      uiStep = "submit-create";
      await $('dialog button[type="submit"]').click();
    } catch (failure) {
      console.error("NATIVE_MUTATION_UI_FAILURE " + uiStep);
      throw failure;
    }
    const path = "MutationSource/日本語メモ.html";
    await $('iframe[title="' + path + '"]').waitForExist();
    const oldUrl = await $('iframe[title="' + path + '"]').getAttribute("src");
    const bytes = readFileSync(resolve(root, path));
    assert.match(bytes.toString("utf8"), /<!doctype html>/i);
    assert.match(bytes.toString("utf8"), /charset="utf-8"/);
    assert.equal(
      (await invoke({ kind: "createHtml", parent: "MutationSource", name: "second" }))
        .nativeFailure,
      undefined,
    );
    assert.equal(
      (
        await invoke({
          kind: "reorder",
          source: "MutationSource/second.html",
          anchor: path,
          after: false,
        })
      ).nativeFailure,
      undefined,
    );
    assert.equal(
      (await invoke({ kind: "move", source: "MutationSource", parent: "MutationTarget" }))
        .nativeFailure,
      undefined,
    );
    const moved = "MutationTarget/MutationSource/日本語メモ.html";
    await $('iframe[title="' + moved + '"]').waitForExist();
    assert.ok(oldUrl);
    assert.equal((await fetch(oldUrl)).status, 404);
    assert.deepEqual(readFileSync(resolve(root, moved)), bytes);
    assert.equal(existsSync(resolve(root, path)), false);
    assert.ok(
      (
        await invoke({
          kind: "move",
          source: "MutationTarget",
          parent: "MutationTarget/MutationSource",
        })
      ).nativeFailure,
    );
    assert.ok(
      (
        await invoke({
          kind: "createHtml",
          parent: "MutationTarget/MutationSource",
          name: "日本語メモ",
        })
      ).nativeFailure,
    );
    assert.deepEqual(readFileSync(resolve(root, moved)), bytes);
    assert.equal(
      (await invoke({ kind: "move", source: "A", parent: "MutationTarget" })).nativeFailure,
      undefined,
      "one-character folder rename must succeed",
    );
    assert.ok(existsSync(resolve(root, "MutationTarget/A")));
  });
  for (const sample of ["Generated", "Converted"] as const) {
    it("persists " + sample + " sample inputs across Native reload and close/reopen", async () => {
      const fixtureRoot = process.env.MOGLEDGE_E2E_ROOT ?? resolve(".tools/e2e-knowledge");
      const current = await snapshot();
      assert.ok(current.rootPath, "Native fixture must have a selected root");
      assert.equal(
        toNamespacedPath(current.rootPath),
        toNamespacedPath(realpathSync.native(fixtureRoot)),
        "Storage tests must stay in the dedicated fixture root",
      );
      const folder = $('div[data-path="Storage"]');
      await folder.waitForExist();
      if ((await folder.getAttribute("aria-expanded")) !== "true") await folder.click();
      const path = "Storage/" + sample + ".html";
      const sourcePath = resolve(fixtureRoot, path);
      const source = readFileSync(sourcePath);
      await select(path);
      const firstUrl = await $(".document-pane.active iframe").getAttribute("src");
      assert.ok(firstUrl);
      await enterFrame();
      await browser.waitUntil(async () => (await $("#status").getText()) !== "保存状態を読込中…");
      const descriptor = await browser.execute(() => {
        const descriptor = (
          window as unknown as {
            __MOGLEDGE_STORAGE_V1__?: {
              version: number;
              endpoint: string;
              available: boolean;
            };
          }
        ).__MOGLEDGE_STORAGE_V1__;
        return {
          version: descriptor?.version,
          available: descriptor?.available,
          frozen: Object.isFrozen(descriptor),
          endpoint: descriptor?.endpoint,
        };
      });
      assert.equal(descriptor.version, 1);
      assert.equal(descriptor.available, true, "Native state storage must be initialized");
      assert.equal(descriptor.frozen, true, "The served storage descriptor must be frozen");
      assert.ok(descriptor.endpoint);
      assert.equal(new URL(descriptor.endpoint).origin, new URL(firstUrl).origin);
      const appId = sample.toLowerCase() + "-calculator";
      try {
        await clearSampleState(appId);
        await leaveFrame();
        await activeTabAction("状態をリセットして再読み込み");
        await browser.waitUntil(
          async () => (await $(".document-pane.active iframe").getAttribute("src")) !== firstUrl,
        );
        await enterFrame();
        await browser.waitUntil(async () => (await $("#status").getText()) === "保存値なし");
        const expected =
          sample === "Generated"
            ? { amount: "7", mode: "square", enabled: false, result: "無効" }
            : { amount: "9", mode: "double", enabled: true, result: "18" };
        await browser.execute((values) => {
          const amount = document.querySelector<HTMLInputElement>("#amount")!;
          amount.value = values.amount;
          document.querySelector<HTMLSelectElement>("#mode")!.value = values.mode;
          document.querySelector<HTMLInputElement>("#enabled")!.checked = values.enabled;
          amount.dispatchEvent(new Event("input", { bubbles: true }));
        }, expected);
        await $("#save").click();
        await browser.waitUntil(async () => (await $("#status").getText()) === "保存済み");
        assert.equal(await $("#result").getText(), expected.result);
        await leaveFrame();
        const savedUrl = await $(".document-pane.active iframe").getAttribute("src");
        await activeTabAction("状態をリセットして再読み込み");
        await browser.waitUntil(
          async () => (await $(".document-pane.active iframe").getAttribute("src")) !== savedUrl,
        );
        await enterFrame();
        await assertSampleRestored(expected);
        await leaveFrame();
        const beforeClose = await $(".document-pane.active iframe").getAttribute("src");
        await $('button[aria-label="' + path + 'を閉じる"]').click();
        await browser.waitUntil(
          async () => !(await $('iframe[title="' + path + '"]').isExisting()),
        );
        assert.equal(
          (await fetch(beforeClose!)).status,
          404,
          "Closing must revoke the served HTML grant",
        );
        const closedEndpoint = new URL(beforeClose!);
        closedEndpoint.pathname =
          closedEndpoint.pathname.split("/").slice(0, 3).join("/") + "/__mogledge_storage_v1__";
        const revoked = await fetch(closedEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: "null" },
          body: JSON.stringify({ version: 1, op: "read", key: "probe" }),
        });
        assert.equal(revoked.status, 403, "Closed/reloaded grants must not read saved state");
        await select(path);
        assert.notEqual(await $(".document-pane.active iframe").getAttribute("src"), beforeClose);
        await enterFrame();
        await assertSampleRestored(expected);
        await leaveFrame();
        assert.deepEqual(
          readFileSync(sourcePath),
          source,
          "Saving must leave the original HTML unchanged",
        );
      } finally {
        // Only this sample's known app key is removed. Never clear the profile
        // database or another document's state when a test fails or is rerun.
        await browser.switchToParentFrame();
        const cleanupRoot = (await snapshot()).rootPath;
        assert.ok(cleanupRoot, "Cleanup requires the dedicated fixture root");
        assert.equal(
          toNamespacedPath(cleanupRoot),
          toNamespacedPath(realpathSync.native(fixtureRoot)),
          "Do not clean state after the selected root changes",
        );
        await select(path);
        await enterFrame();
        await clearSampleState(appId);
        await leaveFrame();
      }
    });
  }
});

async function assertSampleRestored(expected: {
  amount: string;
  mode: string;
  enabled: boolean;
  result: string;
}) {
  await browser.waitUntil(async () => (await $("#status").getText()) === "復元済み");
  const restored = await browser.execute(() => ({
    amount: document.querySelector<HTMLInputElement>("#amount")!.value,
    mode: document.querySelector<HTMLSelectElement>("#mode")!.value,
    enabled: document.querySelector<HTMLInputElement>("#enabled")!.checked,
    result: document.querySelector<HTMLOutputElement>("#result")!.value,
  }));
  assert.deepEqual(restored, expected, "Controls and calculation must use the restored state");
}

async function clearSampleState(appId: string) {
  const result: { ok: boolean } = await browser.executeAsync((appId, done) => {
    const sdk = (
      window as unknown as {
        MogledgeStorage: {
          create: (options: { appId: string; schemaVersion: number }) => {
            remove: () => Promise<void>;
            flush: () => Promise<void>;
          };
        };
      }
    ).MogledgeStorage;
    const storage = sdk.create({ appId, schemaVersion: 1 });
    void storage
      .remove()
      .then(() => storage.flush())
      .then(
        () => done({ ok: true }),
        () => done({ ok: false }),
      );
  }, appId);
  assert.equal(result.ok, true, "Sample state cleanup must be acknowledged");
}

describe("Native document-only zoom", () => {
  it("retains a live document, scaled input and drawing button clicks with Canvas pixels", async () => {
    await $('[aria-label="ファイル"]').click();
    if (!(await $('div[data-path="Examples/Interactive.html"]').isExisting()))
      await $('div[data-path="Examples"]').click();
    await select("Examples/Interactive.html");
    const original = await $(".document-pane.active iframe").getAttribute("src");
    await browser.execute(() => {
      (window as unknown as { qaZoomFrame: Element | null }).qaZoomFrame = document.querySelector(
        ".document-pane.active iframe",
      );
    });
    await enterFrame();
    await $("#text").waitForExist();
    await $("#text").setValue("Native zoom state");
    await $("#action").click();
    await browser.execute(() => {
      (window as unknown as { qaZoomState: { count: number } }).qaZoomState = { count: 0 };
      document.querySelector("#action")!.addEventListener("click", (event) => {
        if (event.isTrusted)
          (window as unknown as { qaZoomState: { count: number } }).qaZoomState.count++;
      });
      document.body.style.minHeight = "2000px";
      window.scrollTo(0, 180);
    });
    await leaveFrame();
    await activeTabAction("文書を拡大");
    const layout = await browser.execute(() => {
      const frame = document.querySelector<HTMLIFrameElement>(".document-pane.active iframe")!;
      return {
        width: frame.getBoundingClientRect().width,
        viewer: frame.parentElement!.getBoundingClientRect().width,
        transform: getComputedStyle(frame).transform,
      };
    });
    assert.equal(layout.transform, "matrix(1.25, 0, 0, 1.25, 0, 0)");
    assert.ok(Math.abs(layout.width - layout.viewer) < 2);
    await enterFrame();
    assert.ok((await browser.execute(() => window.scrollY)) > 100);
    const width = await browser.execute(() => window.innerWidth);
    assert.ok(Math.abs(layout.width / width - 1.25) < 0.02);
    await browser.execute(() => window.scrollTo(0, 0));
    await $("#text").setValue("Scaled pointer state");
    await $("#action").click();
    assert.equal(
      await browser.execute(
        () => (window as unknown as { qaZoomState: { count: number } }).qaZoomState.count,
      ),
      1,
    );
    assert.deepEqual(
      await browser.execute(() => [
        ...document
          .querySelector<HTMLCanvasElement>("#canvas")!
          .getContext("2d")!
          .getImageData(0, 0, 1, 1).data,
      ]),
      [51, 136, 102, 255],
    );
    await leaveFrame();
    for (let i = 0; i < 3; i++) await activeTabAction("文書を縮小");
    await enterFrame();
    await $("#action").click();
    assert.equal(
      await browser.execute(
        () => (window as unknown as { qaZoomState: { count: number } }).qaZoomState.count,
      ),
      2,
    );
    await leaveFrame();
    for (let i = 0; i < 6; i++) await activeTabAction("文書を拡大");
    await enterFrame();
    await $("#action").click();
    assert.equal(
      await browser.execute(
        () => (window as unknown as { qaZoomState: { count: number } }).qaZoomState.count,
      ),
      3,
    );
    await leaveFrame();
    await activeTabAction("100%に戻す");
    assert.equal(await $(".document-pane.active iframe").getAttribute("src"), original);
    assert.equal(
      await browser.execute(
        () =>
          document.querySelector(".document-pane.active iframe") ===
          (window as unknown as { qaZoomFrame: Element | null }).qaZoomFrame,
      ),
      true,
    );
    await enterFrame();
    assert.equal(await $("#text").getValue(), "Scaled pointer state");
    assert.equal(
      await browser.execute(
        () => (window as unknown as { qaZoomState: { count: number } }).qaZoomState.count,
      ),
      3,
    );
    await leaveFrame();
  });
});
