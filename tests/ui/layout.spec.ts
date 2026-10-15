import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const documentKeyboard = readFileSync("src-tauri/src/document_server/keyboard.js", "utf8");
const documentExportBridge = readFileSync("src-tauri/src/document_server/export.js", "utf8");
const documentExportAdapter = readFileSync(".agents/skills/mogledge-html/assets/export.js", "utf8");

const documentLinks = readFileSync("src-tauri/src/document_server/links.js", "utf8");

for (const [platform, primary, other] of [
  ["Win32", "Control", "Meta"],
  ["MacIntel", "Meta", "Control"],
]) {
  test(`sidebar toggle uses ${platform} primary and preserves width view tree and live HTML`, async ({
    page,
  }) => {
    await page.addInitScript(
      (platform) => Object.defineProperty(navigator, "platform", { value: platform }),
      platform,
    );
    await page.setViewportSize({ width: 1000, height: 700 });
    await prepare(page, false, false, undefined, true);
    await openDocument(page, 0);
    const sidebar = page.locator("#knowledge-sidebar");
    const tree = page.getByRole("tree");
    await page.getByRole("separator", { name: "左メニューの幅", exact: true }).press("Home");
    const frame = page.locator('iframe[title="Examples/0.html"]');
    const original = await frame.elementHandle();
    const input = frame.contentFrame().getByRole("textbox");
    await input.fill("toggle preserves input");
    await input.press(primary + "+b");
    await expect(sidebar).toBeVisible();
    const draw = frame.contentFrame().getByRole("button", { name: "Draw" });
    await draw.click();
    await draw.press(primary + "+b");
    await expect(sidebar).toBeHidden();
    await page.waitForTimeout(130); // Deliberately exceed the finite 120ms shortcut cooldown.
    await draw.press(primary + "+b");
    await expect(sidebar).toBeVisible();
    expect(await frame.evaluate((element, original) => element === original, original)).toBe(true);
    await expect(input).toHaveValue("toggle preserves input");
    await expect(sidebar).toHaveCSS("width", "230px");
    const calls = await page.evaluate("JSON.stringify(window.layoutCalls)");
    await draw.evaluate(() => {
      const cancel = (event: KeyboardEvent) => {
        if (event.key.toLowerCase() !== "b") return;
        event.preventDefault();
        window.removeEventListener("keydown", cancel);
      };
      window.addEventListener("keydown", cancel);
    });
    await draw.press(primary + "+b");
    await page.waitForTimeout(130);
    await expect(sidebar).toBeVisible();
    await tree.focus();
    await tree.press(other + "+b");
    await tree.press(primary + "+Shift+b");
    await expect(sidebar).toBeVisible();
    const selected = await tree.getAttribute("aria-activedescendant");
    await tree.press(primary + "+b");
    await expect(sidebar).toBeHidden();
    await expect(page.getByRole("button", { name: "左メニューを開く" })).toBeFocused();
    await page.waitForTimeout(130);
    await page.getByRole("button", { name: "左メニューを開く" }).press(primary + "+b");
    await expect(sidebar).toBeVisible();
    await expect(tree).toHaveAttribute("aria-activedescendant", selected!);
    await page.getByRole("button", { name: "文書検索", exact: true }).click();
    const search = page.getByRole("searchbox");
    await expect(search).toBeFocused();
    await search.press(primary + "+b");
    await expect(sidebar).toBeVisible();
    await page.getByRole("button", { name: "左メニューを閉じる" }).click();
    await expect(page.getByRole("button", { name: "左メニューを開く" })).toBeFocused();
    await page.getByRole("button", { name: "左メニューを開く" }).click();
    await expect(page.getByRole("button", { name: "文書検索", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(sidebar).toHaveCSS("width", "230px");
    expect(await page.evaluate("JSON.stringify(window.layoutCalls)")).toBe(calls);
    await expect(input).toHaveValue("toggle preserves input");
    expect(
      await draw.evaluate(
        () => (window as unknown as { runtimeState: { count: number } }).runtimeState.count,
      ),
    ).toBe(1);
  });
}

test("persistent favorites and recent preserve document input JS and mock preferences", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await prepare(page, false, false, undefined, true, false, true);
  await openDocument(page, 0);
  const frame = page.locator('iframe[title="Examples/0.html"]');
  const original = await frame.elementHandle();
  await frame.contentFrame().getByRole("textbox").fill("favorite input");
  await frame.contentFrame().getByRole("button", { name: "Draw" }).click();
  const panel = page.getByRole("region", { name: "お気に入り", exact: true });
  const panelOriginal = await panel.elementHandle();
  const disclosure = panel.getByRole("button", { name: "お気に入り", exact: true });
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  const collapsedTreeHeight = (await page.getByRole("tree").boundingBox())!.height;
  await page.screenshot({ path: test.info().outputPath("favorites-collapsed-1000.png") });
  await disclosure.focus();
  await disclosure.press("Enter");
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("treeitem", { name: "0 HTML", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "お気に入りに追加", exact: true }).click();
  const favorite = panel.getByRole("button", { name: "Examples/0.htmlを開く", exact: true });
  await expect(favorite).toBeVisible();
  await favorite.click();
  await disclosure.press("Space");
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await expect(favorite).toBeHidden();
  expect((await page.getByRole("tree").boundingBox())!.height).toBeGreaterThan(
    collapsedTreeHeight - 2,
  );
  await disclosure.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await frame.evaluate((element, original) => element === original, original)).toBe(true);
  await expect(frame.contentFrame().getByRole("textbox")).toHaveValue("favorite input");
  expect(
    await frame
      .contentFrame()
      .getByRole("button", { name: "Draw" })
      .evaluate(
        () => (window as unknown as { runtimeState: { count: number } }).runtimeState.count,
      ),
  ).toBe(1);
  expect(await page.evaluate("window.layoutCalls.open")).toBe(1);
  await panel.getByRole("button", { name: "最近の文書を表示" }).click();
  await expect(favorite).toBeVisible();
  await expect(panel.getByRole("heading", { name: "お気に入り" })).toBeVisible();
  await panel.getByRole("button", { name: "お気に入りを表示" }).click();
  await page.getByRole("button", { name: "文書検索", exact: true }).click();
  expect(await panel.evaluate((element, original) => element === original, panelOriginal)).toBe(
    true,
  );
  await expect(favorite).toBeVisible();
  await page.getByRole("button", { name: "ファイル", exact: true }).click();
  await page.screenshot({ path: test.info().outputPath("sidebar-favorites-1000.png") });
  await page.setViewportSize({ width: 320, height: 640 });
  await expect(favorite).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("sidebar-favorites-320.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await page.reload();
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await disclosure.click();
  await expect(favorite).toBeVisible();
  const remove = panel.getByRole("button", {
    name: "Examples/0.htmlをお気に入りから解除",
    exact: true,
  });
  await remove.focus();
  await remove.press("Enter");
  await expect(panel.getByText("お気に入りはまだありません")).toBeVisible();
});

test("persistent favorites allow keyboard removal of missing entries and retain failed writes", async ({
  page,
}) => {
  await prepare(page, false, false, undefined, true, false, true);
  await openDocument(page);
  await page.getByRole("treeitem", { name: "0 HTML", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "お気に入りに追加", exact: true }).click();
  await page.evaluate(
    "window.layoutSettingsWriteFailure=true;window.layoutListsModel.favorites[0].status='missing'",
  );
  const panel = page.getByRole("region", { name: "お気に入り", exact: true });
  await panel.getByRole("button", { name: "お気に入り", exact: true }).click();
  await panel.getByRole("button", { name: "お気に入りと最近の文書を更新" }).click();
  await expect(panel.getByRole("button", { name: "Examples/0.htmlを開く" })).toBeDisabled();
  const remove = panel.getByRole("button", {
    name: "Examples/0.htmlをお気に入りから解除",
    exact: true,
  });
  await remove.focus();
  await expect(remove).toBeFocused();
  await expect(remove).toHaveCSS("opacity", "1");
  await remove.press("Enter");
  await expect(page.getByRole("alert")).toContainText("write failed");
  expect(await page.evaluate("window.layoutListsModel.favorites.length")).toBe(1);
});

test("persistent favorites bound fifty long entries at 230px in both languages and themes", async ({
  page,
}) => {
  await prepare(page, false, false, undefined, true, false, true);
  await page.evaluate(() => {
    const model = (
      window as unknown as {
        layoutListsModel: { favorites: unknown[]; folderFavorites: unknown[] };
      }
    ).layoutListsModel;
    model.favorites = Array.from({ length: 49 }, (_, i) => ({
      relativePath: "Examples/" + "長い名前と日本語.$&.".repeat(6) + i + ".html",
      identity: "long:" + i,
      status: i === 0 ? "missing" : "available",
    }));
    model.folderFavorites = [
      { relativePath: "Examples", identity: "fixture:Examples", status: "available" },
    ];
    localStorage.setItem("workspace-list-fixture", JSON.stringify(model));
  });
  await page.reload();
  const panel = page.locator(".favorites-sidebar");
  await panel.getByRole("button", { name: "お気に入り", exact: true }).click();
  await expect(panel.locator("li")).toHaveCount(50);
  const tree = page.getByRole("tree");
  await page.getByRole("separator", { name: "左メニューの幅", exact: true }).press("Home");
  await expect(page.locator("#knowledge-sidebar")).toHaveCSS("width", "230px");
  for (const language of ["ja", "en"] as const) {
    if (language === "en") {
      await page.getByRole("button", { name: "設定", exact: true }).click();
      await page.getByRole("combobox", { name: "表示言語を選択" }).selectOption("en");
      await page
        .getByRole("dialog", { name: "Settings", exact: true })
        .getByRole("button", { name: "Close", exact: true })
        .click();
    }
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      expect(
        await panel.locator("ul").evaluate((el) => ({
          height: el.clientHeight,
          scroll: el.scrollHeight,
          width: el.clientWidth,
          scrollWidth: el.scrollWidth,
        })),
      ).toMatchObject({ height: 128 });
      expect(
        await panel
          .locator("ul")
          .evaluate((el) => el.scrollHeight > el.clientHeight && el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      expect((await tree.boundingBox())!.height).toBeGreaterThan(200);
      const tools = (await page.locator(".tree-tools").boundingBox())!;
      const header = (await panel.locator(".favorites-sidebar-header").boundingBox())!;
      const treeBounds = (await tree.boundingBox())!;
      expect(header.y).toBeGreaterThanOrEqual(tools.y + tools.height);
      expect(header.y + header.height).toBeLessThan(treeBounds.y);
      expect(header.x).toBe(treeBounds.x);
      expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await expect(panel.locator(".favorites-star")).toHaveCount(1);
      await expect(panel.locator(".favorites-disclosure .folder")).toHaveCount(0);
      await page.screenshot({
        path: test.info().outputPath(`sidebar-favorites-230-${language}-${colorScheme}.png`),
      });
    }
  }
  const reads = await page.evaluate("window.layoutCalls.listReads.length");
  await page.waitForTimeout(250);
  expect(await page.evaluate("window.layoutCalls.listReads.length")).toBe(reads);
  const folder = panel.getByRole("button", { name: "Show folder Examples", exact: true });
  await folder.scrollIntoViewIfNeeded();
  await folder.click();
  await expect(tree).toBeFocused();
  expect(await page.evaluate("window.layoutCalls.open")).toBe(0);
});

test("quick-open bounds metadata, restores focus and reuses live iframe input and JS at narrow width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await prepare(page, false, false, undefined, true);
  await openDocument(page, 0);
  const frame = page.locator('iframe[title="Examples/0.html"]');
  const original = await frame.elementHandle();
  await frame.contentFrame().getByRole("textbox").fill("kept quick-open input");
  const draw = frame.contentFrame().getByRole("button", { name: "Draw" });
  await draw.click();
  const tab = page.getByRole("tab", { name: "0.html", exact: true });
  await tab.focus();
  const calls = await page.evaluate("JSON.stringify(window.layoutCalls)");
  await page.keyboard.press("Control+p");
  const dialog = page.getByRole("dialog", { name: "クイックオープン" });
  const input = dialog.getByRole("combobox");
  await expect(input).toBeFocused();
  await expect(dialog.getByRole("option")).toHaveCount(20);
  expect(await page.evaluate("JSON.stringify(window.layoutCalls)")).toBe(calls);
  await page.screenshot({ path: test.info().outputPath("quick-open-1000.png") });
  await input.fill("missing");
  await expect(dialog.getByRole("option")).toHaveCount(0);
  await input.press("Enter");
  await expect(dialog).toBeVisible();
  await input.fill("0.html");
  await input.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(tab).toBeFocused();
  expect(await frame.evaluate((element, original) => element === original, original)).toBe(true);
  await expect(frame.contentFrame().getByRole("textbox")).toHaveValue("kept quick-open input");
  expect(
    await draw.evaluate(
      () => (window as unknown as { runtimeState: { count: number } }).runtimeState.count,
    ),
  ).toBe(1);
  expect(await page.evaluate("window.layoutCalls.open")).toBe(1);
  // Trusted keys from a non-editor in the opaque frame use the scoped receiver.
  await draw.click();
  await draw.press("Control+p");
  await expect(input).toBeFocused();
  await input.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe("IFRAME");
  await frame.contentFrame().getByRole("textbox").click();
  await frame.contentFrame().getByRole("textbox").press("Control+p");
  // Negative event observation: deferred document proposal is a next-task operation.
  await page.waitForTimeout(60);
  await expect(dialog).toHaveCount(0);
  await tab.focus();
  await page.keyboard.press("Control+p");
  await input.fill("10000");
  await expect(dialog.getByRole("option")).toHaveCount(1);
  expect(await page.evaluate("window.layoutCalls.open")).toBe(1);
  await input.press("Enter");
  await expect(page.getByRole("tab", { name: "10000.html", exact: true })).toBeVisible();
  expect(await page.evaluate("window.layoutCalls.open")).toBe(2);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.getByRole("button", { name: "左メニューを閉じる" }).focus();
  await page.keyboard.press("Control+p");
  await input.fill("Examples");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await expect(dialog.getByRole("button", { name: "閉じる", exact: true })).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath("quick-open-320.png") });
  await input.press("Tab");
  await expect(dialog.getByRole("button", { name: "閉じる", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(input).toBeFocused();
  await input.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("quick-open refreshes candidates after deletion and invalidates root changes", async ({
  page,
}) => {
  await prepare(page, false, true);
  await page.getByRole("tree").focus();
  await page.keyboard.press("Control+p");
  const dialog = page.getByRole("dialog", { name: "クイックオープン" });
  const input = dialog.getByRole("combobox");
  await input.fill(LONG_FILE_NAME);
  await expect(dialog.getByRole("option")).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath("quick-open-long-name.png") });
  await page.evaluate(
    `window.layoutSearchSnapshot.nodes[0].children.shift(); window.layoutChange([],true);`,
  );
  await expect(dialog.getByRole("option")).toHaveCount(0);
  await input.press("Enter");
  expect(await page.evaluate("window.layoutCalls.open")).toBe(0);
  await page.evaluate(
    `window.layoutSearchSnapshot.workspaceId='replaced'; window.layoutSearchSnapshot.viewId='replaced-view'; window.layoutChange([],true);`,
  );
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate("window.layoutCalls.open")).toBe(0);
});

test("local help uses one lazy sandboxed tab with keyboard sections and retains document views", async ({
  page,
}) => {
  const helpRequests: string[] = [];
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/AppHelp\.tsx|\/app-help\.css|\/help\/(?:ja|en)\.html/.test(request.url()))
      helpRequests.push(request.url());
    if (!request.url().startsWith("http://127.0.0.1:1420/")) externalRequests.push(request.url());
  });
  await prepare(page);
  await openDocument(page);
  const frame = page.locator('iframe[title="Examples/0.html"]');
  const original = await frame.elementHandle();
  const input = frame.contentFrame().getByRole("textbox");
  await input.fill("help keeps input");
  await frame.contentFrame().getByRole("button", { name: "Draw" }).click();
  expect(helpRequests).toHaveLength(0);
  const help = page.getByRole("button", { name: "機能と使い方", exact: true });
  const calls = await page.evaluate("JSON.stringify(window.layoutCalls)");
  await help.click();
  const helpTab = page.getByRole("tab", { name: "機能と使い方", exact: true });
  const helpFrame = page.locator(".app-help-frame");
  await expect(helpTab).toHaveAttribute("aria-selected", "true");
  await expect(helpFrame).toHaveAttribute("sandbox", "");
  const helpOriginal = await helpFrame.elementHandle();
  const content = helpFrame.contentFrame();
  await expect(content.getByRole("heading", { name: "機能と使い方", exact: true })).toBeVisible();
  await expect(content.locator("title")).toHaveJSProperty("textContent", "Mogledge — 機能と使い方");
  await expect(content.getByRole("region", { name: "機能の説明" })).toContainText(
    "Mogledge（モグリッジ）",
  );
  await page.screenshot({ path: test.info().outputPath("mogledge-help-ja.png") });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(content.getByRole("radio", { name: "機能", exact: true })).toBeChecked();
  await expect(content.locator("#help-features-panel h2").first()).toHaveText("AIに渡す");
  await expect(content.locator("#help-features-panel .ai-guide > .folder-note")).toContainText(
    "OneDrive同期フォルダー内のファイル・フォルダー操作は失敗する場合があります",
  );
  const aiDetails = content.locator("#help-features-panel .ai-guide details");
  await aiDetails.locator("summary").focus();
  await aiDetails.locator("summary").press("Enter");
  await expect(aiDetails).toHaveAttribute("open", "");
  await expect(aiDetails).toContainText("Codex CLI");
  await aiDetails.locator("summary").press("Enter");
  await expect(aiDetails).not.toHaveAttribute("open", "");
  const choices = content.getByRole("radio", { name: "機能", exact: true });
  await choices.focus();
  await choices.press("ArrowRight");
  await expect(content.getByRole("radio", { name: "使い方", exact: true })).toBeFocused();
  await expect(content.getByRole("heading", { name: "文書を開く", exact: true })).toBeVisible();
  await content.getByRole("radio", { name: "使い方", exact: true }).press("ArrowRight");
  const shortcuts = content.getByRole("radio", { name: "ショートカット", exact: true });
  await expect(shortcuts).toBeChecked();
  await shortcuts.press("Tab");
  await expect(content.getByRole("region", { name: "ショートカットの説明" })).toBeFocused();
  await expect(content.getByRole("table")).toContainText("Ctrl+Shift+A");
  await expect(content.getByRole("table")).toContainText("Cmd+Shift+A");
  const text = await content.locator("body").innerText();
  expect(text).not.toMatch(/未確認|未実装|未テスト|未対応|Draft|PR\s*#/);
  // Selecting the existing help from another tab keeps its same frame and section.
  await page.getByRole("tab", { name: "0.html", exact: true }).click();
  await help.click();
  await expect(helpTab).toHaveCount(1);
  expect(await helpFrame.evaluate((element, original) => element === original, helpOriginal)).toBe(
    true,
  );
  await expect(shortcuts).toBeChecked();
  await helpTab.focus();
  await helpTab.press("Control+Shift+ArrowRight");
  await expect(
    page
      .getByRole("tablist", { name: "右列の文書" })
      .getByRole("tab", { name: "機能と使い方", exact: true }),
  ).toBeVisible();
  await expect(frame).toBeVisible();
  await expect(helpFrame).toBeVisible();
  for (const width of [1000, 320]) {
    await page.setViewportSize({ width, height: 500 });
    if (width === 320) await page.getByRole("button", { name: "左メニューを閉じる" }).click();
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(content.locator("body")).toHaveCSS(
        "background-color",
        colorScheme === "dark" ? "rgb(37, 40, 44)" : "rgb(247, 249, 252)",
      );
      expect(
        await content.locator("body").evaluate((body) => body.scrollWidth <= body.clientWidth),
      ).toBe(true);
      await page.screenshot({
        path: test.info().outputPath(`help-tab-${width}-${colorScheme}.png`),
      });
    }
  }
  await page.setViewportSize({ width: 1000, height: 700 });
  await helpTab.focus();
  await helpTab.press("Control+w");
  await expect(helpTab).toHaveCount(0);
  await expect(helpFrame).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "0.html", exact: true })).toBeFocused();
  await help.click();
  await expect(helpTab).toHaveCount(1);
  await expect(content.getByRole("radio", { name: "機能", exact: true })).toBeChecked();
  await page.getByRole("button", { name: "機能と使い方を閉じる", exact: true }).click();
  await expect(helpFrame).toHaveCount(0);
  await help.click();
  await helpTab.click({ button: "middle" });
  await expect(helpFrame).toHaveCount(0);
  await expect(input).toHaveValue("help keeps input");
  expect(
    await frame
      .contentFrame()
      .locator("body")
      .evaluate(() => ({
        count: (window as unknown as { runtimeState: { count: number } }).runtimeState.count,
        pixel: [
          ...document.querySelector("canvas")!.getContext("2d")!.getImageData(0, 0, 1, 1).data,
        ],
      })),
  ).toEqual({ count: 1, pixel: [51, 170, 85, 255] });
  expect(await frame.evaluate((element, original) => element === original, original)).toBe(true);
  expect(await page.evaluate("JSON.stringify(window.layoutCalls)")).toBe(calls);
  expect(helpRequests.filter((url) => url.includes("AppHelp.tsx"))).toHaveLength(1);
  expect(externalRequests).toHaveLength(0);
});

test("viewer and bundled help switch ja and en without changing user HTML or tab identity", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await prepare(page, false, false, undefined, false, false, true);
  await openDocument(page);
  const userFrame = page.locator('iframe[title="Examples/0.html"]');
  const original = await userFrame.elementHandle();
  const source = await userFrame.getAttribute("src");
  await userFrame.contentFrame().getByRole("textbox").fill("日本語 / $& / {path}");
  await userFrame.contentFrame().getByRole("button", { name: "Draw" }).click();
  const htmlStyle = await userFrame
    .contentFrame()
    .locator("body")
    .evaluate((body) => ({
      text: body.textContent,
      lang: body.ownerDocument.documentElement.lang,
      background: getComputedStyle(body).backgroundColor,
      styles: body.ownerDocument.querySelectorAll("style").length,
    }));
  const calls = await page.evaluate("JSON.stringify(window.layoutCalls)");
  await page.getByRole("button", { name: "機能と使い方", exact: true }).click();
  const helpFrame = page.locator(".app-help-frame");
  const helpOriginal = await helpFrame.elementHandle();
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await page.getByRole("combobox", { name: "表示言語を選択", exact: true }).selectOption("en");
  await page
    .getByRole("dialog", { name: "Settings", exact: true })
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(page.getByRole("tab", { name: "Features and usage", exact: true })).toBeVisible();
  await expect(helpFrame).toHaveAttribute("title", "Features and usage");
  const help = helpFrame.contentFrame();
  await expect(
    help.getByRole("heading", { name: "Features and usage", exact: true }),
  ).toBeVisible();
  await expect(help.locator("title")).toHaveJSProperty(
    "textContent",
    "Mogledge — Features and usage",
  );
  await expect(help.getByRole("region", { name: "Features explained" })).toContainText(
    "Mogledge opens HTML files",
  );
  await expect(help.locator("#help-features-panel h2").first()).toHaveText("Send to AI");
  await expect(help.locator("#help-features-panel .quick-steps > li")).toHaveCount(3);
  await expect(help.locator("#help-features-panel .ai-guide > .folder-note")).toContainText(
    "File and folder operations inside OneDrive sync folders may fail.",
  );
  await page.screenshot({ path: test.info().outputPath("mogledge-help-en.png") });
  await help.getByText("Shortcuts", { exact: true }).click();
  await expect(help.getByRole("heading", { name: "Main shortcuts", exact: true })).toBeVisible();
  expect(await help.locator("body").innerText()).not.toMatch(/[ぁ-んァ-ヶ一-龠]/u);
  const englishHelpTab = page.getByRole("tab", { name: "Features and usage", exact: true });
  await englishHelpTab.focus();
  await englishHelpTab.press("Control+Shift+ArrowRight");
  for (const width of [1000, 320]) {
    await page.setViewportSize({ width, height: 500 });
    if (width === 320)
      await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(help.locator("body")).toHaveCSS(
        "background-color",
        colorScheme === "dark" ? "rgb(37, 40, 44)" : "rgb(247, 249, 252)",
      );
      expect(
        await help.locator("body").evaluate((body) => body.scrollWidth <= body.clientWidth),
      ).toBe(true);
      await page.screenshot({
        path: test.info().outputPath(`help-tab-en-${width}-${colorScheme}.png`),
      });
    }
  }
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.getByRole("tab", { name: "0.html", exact: true }).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Tab actions for Examples/0.html", exact: true });
  await expect(
    menu.getByRole("menuitem", { name: "Open in left column", exact: true }),
  ).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Reset state and reload", exact: true }),
  ).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Close all tabs to the right", exact: true }),
  ).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Forward in document history", exact: true }),
  ).toBeDisabled();
  expect(await menu.innerText()).not.toMatch(/[ぁ-んァ-ヶ一-龠]/u);
  await menu.press("Escape");
  await page.getByRole("button", { name: "Features and usage", exact: true }).click();
  await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Choose display language", exact: true })
    .selectOption("ja");
  await page
    .getByRole("dialog", { name: "設定", exact: true })
    .getByRole("button", { name: "閉じる", exact: true })
    .click();
  await expect(page.getByRole("tab", { name: "機能と使い方", exact: true })).toHaveCount(1);
  await expect(help.getByRole("radio", { name: "機能", exact: true })).toBeChecked();
  expect(await helpFrame.evaluate((element, original) => element === original, helpOriginal)).toBe(
    true,
  );
  await page.getByRole("button", { name: "機能と使い方を閉じる", exact: true }).click();
  await expect(userFrame).toHaveAttribute("src", source!);
  expect(await userFrame.evaluate((element, original) => element === original, original)).toBe(
    true,
  );
  await expect(userFrame.contentFrame().getByRole("textbox")).toHaveValue("日本語 / $& / {path}");
  expect(
    await userFrame
      .contentFrame()
      .getByRole("button", { name: "Draw" })
      .evaluate(
        () => (window as unknown as { runtimeState: { count: number } }).runtimeState.count,
      ),
  ).toBe(1);
  expect(
    await userFrame
      .contentFrame()
      .locator("body")
      .evaluate((body) => ({
        text: body.textContent,
        lang: body.ownerDocument.documentElement.lang,
        background: getComputedStyle(body).backgroundColor,
        styles: body.ownerDocument.querySelectorAll("style").length,
      })),
  ).toEqual(htmlStyle);
  expect(await page.evaluate("JSON.stringify(window.layoutCalls)")).toBe(calls);
});

test("document links keep anchors in place and reuse an existing target view", async ({ page }) => {
  await prepare(page, false, false, undefined, true, true);
  await openDocument(page);
  const source = page.locator('iframe[title="Examples/0.html"]');
  const original = await source.elementHandle();
  const input = source.contentFrame().getByRole("textbox");
  await input.fill("source state");
  await source
    .contentFrame()
    .locator("body")
    .evaluate((body) => {
      for (const [href, label] of [
        ["0.html#section", "Same page"],
        ["1.html#section", "Other HTML"],
      ]) {
        const link = document.createElement("a");
        link.href = href;
        link.textContent = label;
        body.prepend(link);
      }
      const section = document.createElement("h2");
      section.id = "section";
      section.textContent = "Anchor";
      body.append(section);
    });
  await source.contentFrame().getByRole("link", { name: "Same page" }).click();
  await expect
    .poll(() =>
      source
        .contentFrame()
        .locator("body")
        .evaluate(() => location.hash),
    )
    .toBe("#section");
  await expect(input).toHaveValue("source state");
  expect(await source.evaluate((element, original) => element === original, original)).toBe(true);
  await expect(page.getByRole("tab")).toHaveCount(1);
  expect(await page.evaluate("window.layoutCalls.open")).toBe(1);
  await source.contentFrame().getByRole("link", { name: "Other HTML" }).click();
  const target = page.locator('iframe[title="Examples/1.html"]');
  await expect(target).toBeVisible();
  await expect
    .poll(() =>
      target
        .contentFrame()
        .locator("body")
        .evaluate(() => location.hash),
    )
    .toBe("#section");
  const targetOriginal = await target.elementHandle();
  await target.contentFrame().getByRole("textbox").fill("target state");
  await page.getByRole("tab", { name: "0.html", exact: true }).click();
  // The link receiver bounds bursts; repeat after the admission interval.
  await page.waitForTimeout(350);
  await source.contentFrame().getByRole("link", { name: "Other HTML" }).click();
  await expect(target).toBeVisible();
  await expect(target.contentFrame().getByRole("textbox")).toHaveValue("target state");
  expect(await target.evaluate((element, original) => element === original, targetOriginal)).toBe(
    true,
  );
  expect(await page.evaluate("window.layoutCalls.open")).toBe(2);
});

test("external link proposals require a trusted main UI confirmation", async ({ page }) => {
  await prepare(page, false, false, undefined, true, true);
  await openDocument(page);
  const source = page.locator('iframe[title="Examples/0.html"]');
  const href = "https://example.com/?q=%E6%97%A5%E6%9C%AC&x=%22%5C#section";
  await source.contentFrame().getByRole("textbox").fill("kept state");
  await source
    .contentFrame()
    .locator("body")
    .evaluate((body, href) => {
      const link = document.createElement("a");
      link.href = href;
      link.textContent = "External";
      body.prepend(link);
    }, href);
  await expect(page.getByRole("dialog", { name: "外部リンクを開く" })).toHaveCount(0);
  await source.contentFrame().getByRole("link", { name: "External" }).click();
  await expect(page.getByRole("dialog", { name: "外部リンクを開く" })).toBeVisible();
  expect(await page.evaluate("window.layoutCalls.external?.length || 0")).toBe(0);
  await page.getByRole("button", { name: "キャンセル", exact: true }).click();
  await page.waitForTimeout(350);
  await source.contentFrame().getByRole("textbox").click();
  // Even a correctly scoped forged postMessage can only propose the URL.
  await source
    .contentFrame()
    .locator("body")
    .evaluate((_body, href) => {
      parent.postMessage(
        { type: "my-knowledge-link-v1", token: location.pathname.split("/")[2], href },
        "*",
      );
    }, href);
  const dialog = page.getByRole("dialog", { name: "外部リンクを開く" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("code")).toHaveText(href);
  await expect(dialog.getByRole("button", { name: "キャンセル" })).toBeFocused();
  await dialog
    .getByRole("button", { name: "既定ブラウザーで開く" })
    .evaluate((button) => (button as HTMLButtonElement).click());
  expect(await page.evaluate("window.layoutCalls.external?.length || 0")).toBe(0);
  await page.screenshot({ path: test.info().outputPath("external-link-confirmation.png") });
  await dialog.getByRole("button", { name: "既定ブラウザーで開く" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate("window.layoutCalls.external")).toEqual([href]);
  await expect(source.contentFrame().getByRole("textbox")).toHaveValue("kept state");
});

test("document link routing respects later window listeners cancelling a trusted click", async ({
  page,
}) => {
  await prepare(page, false, false, undefined, true, true);
  await openDocument(page);
  const source = page.locator('iframe[title="Examples/0.html"]');
  const original = await source.elementHandle();
  await source
    .contentFrame()
    .locator("body")
    .evaluate((body) => {
      for (const [href, label] of [
        ["#cancelled", "Cancel anchor"],
        ["1.html#section", "Cancel HTML"],
        ["https://example.com/cancelled", "Cancel external"],
      ]) {
        const link = document.createElement("a");
        link.href = href;
        link.textContent = label;
        body.prepend(link);
      }
      (window as unknown as { linkCancels: { trusted: boolean; type: string }[] }).linkCancels = [];
      window.addEventListener("click", (event) => {
        const link = event.target as HTMLAnchorElement;
        if (!link.textContent?.startsWith("Cancel")) return;
        (
          window as unknown as { linkCancels: { trusted: boolean; type: string }[] }
        ).linkCancels.push({ trusted: event.isTrusted, type: link.textContent });
        if (link.textContent === "Cancel HTML") event.returnValue = false;
        else event.preventDefault();
      });
    });
  for (const label of ["Cancel anchor", "Cancel HTML", "Cancel external"]) {
    await source.contentFrame().getByRole("link", { name: label, exact: true }).click();
    await page.waitForTimeout(350);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("tab")).toHaveCount(1);
    expect(
      await source
        .contentFrame()
        .locator("body")
        .evaluate(() => location.hash),
    ).toBe("");
  }
  expect(
    await source
      .contentFrame()
      .locator("body")
      .evaluate(() => (window as unknown as { linkCancels: { trusted: boolean }[] }).linkCancels),
  ).toEqual([
    { trusted: true, type: "Cancel anchor" },
    { trusted: true, type: "Cancel HTML" },
    { trusted: true, type: "Cancel external" },
  ]);
  expect(await source.evaluate((element, original) => element === original, original)).toBe(true);
  expect(await page.evaluate("window.layoutCalls.open")).toBe(1);
  expect(await page.evaluate("window.layoutCalls.external?.length || 0")).toBe(0);
});

test("special schemes cannot dispatch external links", async ({ page }) => {
  await prepare(page, false, false, undefined, true, true);
  await openDocument(page);
  const source = page.locator('iframe[title="Examples/0.html"]');
  await source
    .contentFrame()
    .locator("body")
    .evaluate((body) => {
      for (const [href, label] of [
        ["file:///outside.html", "Local file"],
        ["mailto:test@example.com", "Mail"],
      ]) {
        const link = document.createElement("a");
        link.href = href;
        link.textContent = label;
        body.prepend(link);
      }
    });
  await source.contentFrame().getByRole("link", { name: "Local file" }).click();
  await source.contentFrame().getByRole("link", { name: "Mail" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate("window.layoutCalls.external?.length || 0")).toBe(0);
  expect(await page.evaluate("window.layoutCalls.open")).toBe(1);
});

test("synthetic anchor clicks preserve the document without navigation or app routing", async ({
  page,
}) => {
  await prepare(page, false, false, undefined, true, true);
  await openDocument(page);
  const source = page.locator('iframe[title="Examples/0.html"]');
  await source.contentFrame().getByRole("textbox").fill("retained synthetic state");
  await source
    .contentFrame()
    .locator("body")
    .evaluate((body) => {
      const a = document.createElement("a");
      a.href = "#synthetic";
      a.textContent = "Synthetic anchor";
      body.prepend(a);
      a.click();
    });
  await page.waitForTimeout(350);
  expect(
    await source
      .contentFrame()
      .locator("body")
      .evaluate(() => location.hash),
  ).toBe("");
  await expect(source.contentFrame().getByRole("textbox")).toHaveValue("retained synthetic state");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate("window.layoutCalls.open")).toBe(1);
});

// UI-only bridge: no Native IPC or real knowledge files are used by these tests.
for (const platform of ["Win32", "MacIntel"]) {
  test(`context shortcut labels align at screen edges on ${platform}`, async ({ page }) => {
    await page.addInitScript(
      (platform) => Object.defineProperty(navigator, "platform", { get: () => platform }),
      platform,
    );
    await page.setViewportSize({ width: 850, height: 600 });
    await prepare(page, false, true);
    const row = page.locator(`[data-path="Examples/${LONG_FILE_NAME}"]`);
    await row.click({ button: "right" });
    const fileMenu = page.getByRole("menu");
    const modifier = platform === "MacIntel" ? "⌘" : "Ctrl";
    await expect(
      fileMenu.getByRole("menuitem", { name: "HTMLを作成", exact: true }).locator("kbd"),
    ).toHaveText(modifier + "+N");
    await expect(
      fileMenu.getByRole("menuitem", { name: "フォルダーを作成", exact: true }).locator("kbd"),
    ).toHaveText(modifier + "+Shift+N");
    await expect(
      fileMenu.getByRole("menuitem", { name: "名前を変更", exact: true }).locator("kbd"),
    ).toHaveText(platform === "MacIntel" ? "Enter" : "F2");
    await expect(
      fileMenu.getByRole("menuitem", { name: "右の列で開く", exact: true }).locator("kbd"),
    ).toHaveCount(0);
    const alignment = await fileMenu
      .locator("kbd")
      .evaluateAll((elements) => elements.map((e) => e.getBoundingClientRect().right));
    expect(Math.max(...alignment) - Math.min(...alignment)).toBeLessThan(1);
    await page.screenshot({ path: test.info().outputPath("file-menu-" + platform + ".png") });
    await page.keyboard.press("Escape");
    await row.click();
    const tab = page.getByRole("tab");
    await tab.click({ button: "right" });
    const menu = page.getByRole("menu");
    await expect(
      menu.getByRole("menuitem", { name: "左の列へ移動", exact: true }).locator("kbd"),
    ).toHaveText(modifier + "+Shift+←");
    await expect(menu.getByRole("menuitem", { name: "左の列へ移動", exact: true })).toBeDisabled();
    await expect(
      menu.getByRole("menuitem", { name: "右の列へ移動", exact: true }).locator("kbd"),
    ).toHaveText(modifier + "+Shift+→");
    await expect(
      menu.getByRole("menuitem", { name: "右の列で開く", exact: true }).locator("kbd"),
    ).toHaveCount(0);
    await expect(
      menu.getByRole("menuitem", { name: "タブを閉じる", exact: true }).locator("kbd"),
    ).toHaveText(modifier + "+W");
    await expect(
      menu.getByRole("menuitem", { name: "閉じたタブを開き直す", exact: true }),
    ).toBeDisabled();
    await expect(
      menu
        .getByRole("menuitem", { name: "状態をリセットして再読み込み", exact: true })
        .locator("kbd"),
    ).toHaveCount(0);
    const tabAlignment = await menu
      .locator("kbd")
      .evaluateAll((elements) => elements.map((e) => e.getBoundingClientRect().right));
    expect(Math.max(...tabAlignment) - Math.min(...tabAlignment)).toBeLessThan(1);
    await page.keyboard.press("End");
    await expect(menu.getByRole("menuitem", { name: "タブを閉じる", exact: true })).toBeFocused();
    await page.screenshot({ path: test.info().outputPath("tab-menu-" + platform + ".png") });
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 450, height: 400 });
    await page.getByRole("button", { name: "左メニューを閉じる" }).click();
    await tab.click({ button: "right" });
    const rect = await page.getByRole("menu").boundingBox();
    expect(rect!.x).toBeGreaterThanOrEqual(8);
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(442);
    expect(rect!.y + rect!.height).toBeLessThanOrEqual(392);
    expect(await page.getByRole("menu").evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("tab-menu-narrow-" + platform + ".png") });
  });
}
test("close tabs to the right uses an inactive context target and preserves both columns and same-path views", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await prepare(page);
  for (const index of [0, 1, 2, 3]) await openDocument(page, index);
  await page.getByRole("tab", { name: "0.html", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "右の列で開く", exact: true }).click();
  await openDocument(page, 4);
  const left = page.getByRole("tablist", { name: "左列の文書" });
  const right = page.getByRole("tablist", { name: "右列の文書" });
  const retained = [];
  for (const [column, filename, value] of [
    [left, "0.html", "left zero"],
    [left, "1.html", "left anchor"],
    [right, "0.html", "right zero"],
    [right, "4.html", "right four"],
  ] as const) {
    const tab = column.getByRole("tab", { name: filename, exact: true });
    await tab.click();
    const panel = await tab.getAttribute("aria-controls");
    const frame = page.locator(`[id="${panel}"] iframe`);
    await frame.contentFrame().getByRole("textbox").fill(value);
    await frame.contentFrame().getByRole("button", { name: "Draw" }).click();
    retained.push({ tab, frame, original: await frame.elementHandle(), value });
  }
  await left.getByRole("tab", { name: "3.html", exact: true }).click();
  const anchor = left.getByRole("tab", { name: "1.html", exact: true });
  await anchor.click({ button: "right" });
  await expect(anchor).toHaveAttribute("aria-selected", "false");
  await expect(left.getByRole("tab", { name: "3.html", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const closeRight = page.getByRole("menuitem", { name: "右側のタブを全て閉じる", exact: true });
  await expect(closeRight).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath("close-right-menu-1000.png") });
  await closeRight.click();
  await expect(left.getByRole("tab")).toHaveCount(2);
  await expect(right.getByRole("tab")).toHaveCount(2);
  await expect(anchor).toBeFocused();
  await expect(anchor).toHaveAttribute("aria-selected", "true");
  expect(await page.evaluate("window.layoutCalls.close")).toBe(2);
  expect(await page.evaluate("window.layoutCalls.open")).toBe(6);
  expect(await page.evaluate("window.layoutGrants.size")).toBe(4);
  expect(await page.evaluate("[...window.layoutTabPaths.values()].sort()")).toEqual([
    "Examples/0.html",
    "Examples/0.html",
    "Examples/1.html",
    "Examples/4.html",
  ]);
  for (const { tab, frame, original, value } of retained) {
    expect(await frame.evaluate((element, original) => element === original, original)).toBe(true);
    await tab.click();
    await expect(frame.contentFrame().getByRole("textbox")).toHaveValue(value);
    expect(
      await frame
        .contentFrame()
        .getByRole("button", { name: "Draw" })
        .evaluate(
          () => (window as unknown as { runtimeState: { count: number } }).runtimeState.count,
        ),
    ).toBe(1);
  }
  await anchor.press("Shift+F10");
  await expect(closeRight).toBeDisabled();
  await page.keyboard.press("Escape");
  for (const filename of ["2.html", "3.html"]) {
    await anchor.click({ button: "right" });
    await page.getByRole("menuitem", { name: "閉じたタブを開き直す", exact: true }).click();
    await expect(left.getByRole("tab", { name: filename, exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  }
  await expect(left.getByRole("tab")).toHaveCount(4);
  await right.getByRole("tab", { name: "0.html", exact: true }).click({ button: "right" });
  await closeRight.click();
  await expect(right.getByRole("tab")).toHaveCount(1);
  await expect(left.getByRole("tab")).toHaveCount(4);
  expect(await page.evaluate("window.layoutCalls.close")).toBe(3);
  await expect(retained[2].frame.contentFrame().getByRole("textbox")).toHaveValue("right zero");
});

test("close tabs to the right removes placeholders without loading them or changing the saved workspace set", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await prepare(page, false, false, undefined, true, false, true, true);
  await page.evaluate(
    `window.layoutSetsModel.sets = [{id:'right-close',name:'閉鎖確認',active:[15,null],activeColumn:0,items:Array.from({length:30},(_,i)=>({document:{relativePath:'Examples/'+i+'.html',identity:'fixture:Examples/'+i+'.html'},column:0,zoom:125}))}];`,
  );
  const saved = await page.evaluate("JSON.stringify(window.layoutSetsModel)");
  await page.getByRole("button", { name: "作業セット", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^閉鎖確認 / })
    .click();
  await expect(page.getByRole("tab")).toHaveCount(30);
  await expect(page.locator("iframe")).toHaveCount(1);
  const anchor = page.getByRole("tab", { name: "2.html 125%", exact: true });
  await anchor.click({ button: "right" });
  await page.getByRole("menuitem", { name: "右側のタブを全て閉じる", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(3);
  await expect(anchor).toHaveAttribute("aria-selected", "true");
  await expect(anchor).toBeFocused();
  await expect(page.locator("iframe")).toHaveCount(1);
  expect(await page.evaluate("window.layoutCalls.create")).toEqual([
    "Examples/15.html",
    "Examples/2.html",
  ]);
  expect(await page.evaluate("window.layoutCalls.open")).toBe(2);
  expect(await page.evaluate("window.layoutCalls.close")).toBe(1);
  expect(await page.evaluate("window.layoutGrants.size")).toBe(1);
  expect(await page.evaluate("JSON.stringify(window.layoutSetsModel)")).toBe(saved);
  await anchor.press("Shift+F10");
  await expect(
    page.getByRole("menuitem", { name: "右側のタブを全て閉じる", exact: true }),
  ).toBeDisabled();
  await page.screenshot({ path: test.info().outputPath("close-right-placeholders.png") });
  await page.getByRole("menuitem", { name: "閉じたタブを開き直す", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(4);
  await expect(page.getByRole("tab", { name: "15.html", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(await page.evaluate("window.layoutCalls.create.length")).toBe(3);
});

test("column move menu retains an inactive target's view and state", async ({ page }) => {
  await prepare(page);
  await openDocument(page);
  const frame = page.locator('iframe[title="Examples/0.html"]');
  const original = await frame.elementHandle();
  await frame.contentFrame().getByRole("textbox").fill("retained menu target");
  await frame.contentFrame().getByRole("button", { name: "Draw" }).click();
  await openDocument(page, 1);
  const calls = await page.evaluate("JSON.stringify(window.layoutCalls)");
  const target = page.getByRole("tab", { name: "0.html", exact: true });
  await expect(target).toHaveAttribute("aria-selected", "false");
  await target.click({ button: "right" });
  await expect(target).toHaveAttribute("aria-selected", "false");
  await page.getByRole("menuitem", { name: "右の列へ移動", exact: true }).click();
  await expect(
    page
      .getByRole("tablist", { name: "右列の文書" })
      .getByRole("tab", { name: "0.html", exact: true }),
  ).toBeFocused();
  await expect(frame.contentFrame().getByRole("textbox")).toHaveValue("retained menu target");
  expect(await frame.evaluate((element, original) => element === original, original)).toBe(true);
  expect(
    await frame
      .contentFrame()
      .locator("body")
      .evaluate(
        () => (window as unknown as { runtimeState: { count: number } }).runtimeState.count,
      ),
  ).toBe(1);
  expect(await page.evaluate("JSON.stringify(window.layoutCalls)")).toBe(calls);
});
const LONG_FILE_NAME =
  "検索を使わない通常表示で長い日本語の文書名と選択状態を確認するためのファイル.html";
async function prepare(
  page: Page,
  warning = false,
  longName = false,
  chrome = { platform: "other", height: 40, leftInset: 0, rightInset: 0 },
  keyboard = false,
  links = false,
  workspaceLists = false,
  workspaceSets = false,
  stateTransfer = false,
  artifactExport = false,
) {
  if (artifactExport) {
    await page.addInitScript(() => {
      const scope = window as unknown as {
        layoutArtifactCalls: unknown[];
        layoutArtifactFailure?: string;
        layoutArtifactSave: (request: {
          name: string;
          format: string;
          data: string;
        }) => Promise<unknown>;
      };
      scope.layoutArtifactCalls = [];
      scope.layoutArtifactSave = async (request) => {
        scope.layoutArtifactCalls.push(request);
        if (scope.layoutArtifactFailure) throw scope.layoutArtifactFailure;
        return { status: "saved", name: request.name + ".txt", bytes: atob(request.data).length };
      };
    });
    await page.route("**/src/lib/artifactExport.ts", async (route) => {
      const source = await (await route.fetch()).text();
      const body = source.replace(
        /invoke\("save_html_artifact",\s*\{\s*request\s*\}\)/,
        "window.layoutArtifactSave(request)",
      );
      if (body === source) throw new Error("Artifact mock did not match the real Native call");
      return route.fulfill({ contentType: "application/javascript", body });
    });
  }
  await page.route("**/__app/help/*.html", async (route) => {
    const language = route.request().url().endsWith("en.html") ? "en" : "ja";
    // Read the literal source via Node rather than serving Vite's raw-module wrapper.
    const { readFile } = await import("node:fs/promises");
    return route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: await readFile(`src/app/help/${language}.html`, "utf8"),
    });
  });
  await page.route("**/src/app/windowChrome.ts*", async (route) => {
    const source = await (await route.fetch()).text();
    const reactModule = source.match(/from\s+["']([^"']*\/react\.js[^"']*)["']/)?.[1];
    if (!reactModule) throw new Error("Vite did not resolve the React import for window chrome");
    return route.fulfill({
      contentType: "application/javascript",
      body: `
      import React from ${JSON.stringify(reactModule)};
      const { useEffect, useRef } = React;
      export const shortcutScope = () => document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]') ? 'paused' : document.activeElement?.id === 'document-search-query' ? 'search-input' : document.activeElement?.closest('input, textarea, select, [contenteditable]') ? 'paused' : 'app';
      export const acceptsWindowCommand = command => shortcutScope() === 'app' || (shortcutScope() === 'search-input' && command === 'focus-search');
      export function useWindowChrome(onCommand) {
        const callback = useRef(onCommand); callback.current = onCommand;
        useEffect(() => {
          window.layoutNativeCommand = command => { if (acceptsWindowCommand(command)) callback.current(command); };
          return () => { delete window.layoutNativeCommand; };
        }, []);
        return ${JSON.stringify(chrome)};
      }
    `,
    });
  });
  await page.route("**/src/lib/bridge.ts", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `
        const calls = window.layoutCalls = { tree: 0, open: 0, refresh: 0, close: 0, actions: [], mutations: [] };
        const snapshot = {
          workspaceId: 'layout', viewId: 'view-layout', rootPath: '/knowledge', revision: 1,
          documentOrigin: 'http://127.0.0.1:1420',
          watchError: ${JSON.stringify(warning ? "監視エラー: " + "長いパス/".repeat(20) : null)},
          nodes: [{ name: 'Examples', relativePath: 'Examples', kind: 'folder',
            children: Array.from({length: 10001}, (_, i) => ({
              name: i === 0 && ${longName} ? ${JSON.stringify(LONG_FILE_NAME)} : i + '.html',
              relativePath: 'Examples/' + (i === 0 && ${longName} ? ${JSON.stringify(LONG_FILE_NAME)} : i + '.html'), kind: 'html', children: []
            })) }, {name: 'Target', relativePath: 'Target', kind: 'folder', children: []}]
        };
        window.layoutSearchSnapshot = snapshot;
        let serial = 0;
        const paths = window.layoutTabPaths = new Map();
        const grants = window.layoutGrants = new Map();
        const lists = window.layoutListsModel = ${workspaceLists} ? JSON.parse(localStorage.getItem('workspace-list-fixture') || '{"favorites":[],"recent":[],"error":null,"readOnly":false}') : null;
        const sets = window.layoutSetsModel = JSON.parse(localStorage.getItem('workspace-set-fixture') || '{"sets":[],"error":null,"readOnly":false}');
        sets.setShortcuts ||= Array(10).fill(null);
        if (lists) lists.folderFavorites ||= [];
        const persistSets = () => localStorage.setItem('workspace-set-fixture', JSON.stringify(sets));
        const persistLists = () => localStorage.setItem('workspace-list-fixture', JSON.stringify(lists));
        const revoke = id => { for (const [url, owner] of grants) if (owner === id) grants.delete(url); };
        let listener = () => {};
        window.layoutChange = (changedPaths, structureChanged = false) => {
          snapshot.revision++;
          listener({workspaceId: 'layout', revision: snapshot.revision, changedPaths, structureChanged, watchError: null});
        };
        let transferPlan;
        let transferReceipt;
        export const aiHandoffApi = {
          prepare: async context => {
            (calls.aiPrepare ||= []).push(context);
            const selectedPath = context.target === 'root' ? '/knowledge' : '/knowledge/' + context.relativePath;
            return {kind: context.target === 'root' || !context.relativePath.endsWith('.html') ? 'folder' : 'file', selectedPath, workingDirectory: context.target !== 'root' && context.relativePath.endsWith('.html') ? selectedPath.slice(0, selectedPath.lastIndexOf('/')) : selectedPath, revision: snapshot.revision};
          },
          perform: async request => { (calls.aiPerform ||= []).push(request); }
        };
        export const bridge = {
          chooseStateTransferFile: ${stateTransfer} ? async (_context, kind) => { (calls.transferChoose ||= []).push(kind); return {fileId:kind, kind, name:kind + '.json'}; } : undefined,
          prepareStateTransfer: ${stateTransfer} ? async request => {
            (calls.transferPrepare ||= []).push(request);
            if (!request.backupFileId && request.fileId === 'import') throw {code:'explicit_backup_required'};
            transferPlan = { context: request.context, planId: 'plan-' + calls.transferPrepare.length, operation: request.fileId === 'export' ? 'export' : 'import', documentIdentity: 'fixture:' + request.relativePath, logicalBytes:12, incomingApps:[{appId:'calculator',schemaVersion:1}], previousApps:[], replacesExisting:request.fileId === 'import', backupRequired:request.fileId === 'import', stopReloadRequired:request.fileId === 'import', browserGrants:1, openingRequests:0, unflushedInput:'unknown', affectedViews:[...paths].filter(([id,path]) => path === request.relativePath && [...grants.values()].includes(id)).map(([id]) => ({tabId:id,documentIdentity:'fixture:' + request.relativePath,matchesTargetIdentity:true,visibility:request.activeTabIds.includes(id)?'active':'hidden',saveAcknowledgement:'unknown'})) };
            return structuredClone(transferPlan);
          } : undefined,
          confirmStateTransfer: ${stateTransfer} ? async confirmation => {
            (calls.transferConfirm ||= []).push(confirmation);
            transferReceipt = {operationId:transferPlan.planId, operation:transferPlan.operation, context:transferPlan.context, documentIdentity:transferPlan.documentIdentity, reloadTabIds:transferPlan.affectedViews.map(view=>view.tabId), revokedBrowserGrants:1};
            transferPlan.affectedViews.forEach(view=>revoke(view.tabId));
            if (window.layoutTransferLost) throw new Error('response lost');
            return structuredClone(transferReceipt);
          } : undefined,
          cancelStateTransfer: ${stateTransfer} ? async () => { calls.transferCancel=(calls.transferCancel||0)+1; return transferReceipt?{status:'completed',receipt:structuredClone(transferReceipt)}:{status:'cancelled'}; } : undefined,
          verifyStateTransfer: ${stateTransfer} ? async request => { calls.transferVerify=(calls.transferVerify||0)+1; return request.kind === 'import'?{status:'verified_current_values',matches:true,documentIdentity:transferPlan.documentIdentity,provesPastOperation:false}:{status:'completed',receipt:structuredClone(transferReceipt)}; } : undefined,
          validateDocumentNavigation: async (_workspace, _view, relativePath, fragment, id) => {
            (calls.historyValidations ||= []).push({relativePath, fragment, id});
            if (window.layoutHistoryFailure) throw new Error('unreadable');
            if (id && paths.get(id) !== relativePath) throw new Error('DocumentChanged');
            return {relativePath, identity: 'fixture:' + relativePath};
          },
          getWorkspaceSets: async () => structuredClone(sets),
          captureWorkspaceSet: ${workspaceSets} ? async (_workspace, _view, name, items, active, activeColumn) => {
            if (window.layoutSettingsWriteFailure) throw new Error('write failed');
            sets.sets.push({ id: 'set-' + sets.sets.length, name, items: items.map(item => ({ document: item.document || { relativePath: paths.get(item.tabId), identity: 'fixture:' + paths.get(item.tabId) }, column: item.column, zoom: item.zoom })), active, activeColumn });
            persistSets(); return structuredClone(sets);
          } : undefined,
          editWorkspaceSet: ${workspaceSets} ? async (_workspace, _view, id, name) => {
            if (window.layoutSettingsWriteFailure) throw new Error('write failed');
            if (name === null) { sets.sets = sets.sets.filter(set => set.id !== id); sets.setShortcuts = sets.setShortcuts.map(assigned => assigned === id ? null : assigned); }
            else sets.sets.find(set => set.id === id).name = name;
            persistSets(); return structuredClone(sets);
          } : undefined,
          assignWorkspaceSetShortcut: ${workspaceSets} ? async (_workspace, _view, id, slot) => {
            if (window.layoutSettingsWriteFailure) throw new Error('write failed');
            if (!sets.sets.some(set => set.id === id) || (slot !== null && (!Number.isInteger(slot) || slot < 1 || slot > 10))) throw new Error('invalid assignment');
            if (slot !== null && sets.setShortcuts[slot - 1] && sets.setShortcuts[slot - 1] !== id) throw new Error('occupied');
            sets.setShortcuts = sets.setShortcuts.map(assigned => assigned === id ? null : assigned);
            if (slot !== null) sets.setShortcuts[slot - 1] = id;
            persistSets(); return structuredClone(sets);
          } : undefined,
          resolveWorkspaceSet: ${workspaceSets} ? async (_workspace, _view, id, shortcutSlot) => {
            if (shortcutSlot !== undefined && sets.setShortcuts[shortcutSlot - 1] !== id) throw new Error('stale shortcut');
            (calls.setResolve ||= []).push({id, shortcutSlot});
            const set = structuredClone(sets.sets.find(set => set.id === id));
            return { set, items: set.items.map(item => ({ ...item, status: window.layoutSetStatuses?.[item.document.relativePath] || 'available', reusableTabs: [...paths].filter(([id, path]) => path === item.document.relativePath && [...grants.values()].includes(id)).map(([id]) => id) })) };
          } : undefined,
          getWorkspaceLists: async (_workspace, _view, resolveMoves) => { (calls.listReads ||= []).push({resolveMoves}); return structuredClone(lists || {favorites:[],folderFavorites:[],recent:[],error:null,readOnly:false}); },
          setDocumentFavorite: ${workspaceLists} ? async (_workspace, _view, path, add) => {
            if (window.layoutSettingsWriteFailure) throw new Error('write failed');
            const entry = { relativePath: path, identity: 'fixture:' + path, status: 'available' };
            const target = ['Examples', 'Target'].includes(path) ? lists.folderFavorites : lists.favorites;
            if (add && !target.some(item => item.identity === entry.identity)) { if (lists.favorites.length + lists.folderFavorites.length >= 50) throw new Error('limit'); target.push(entry); }
            if (!add) { lists.favorites = lists.favorites.filter(item => item.relativePath !== path); lists.folderFavorites = lists.folderFavorites.filter(item => item.relativePath !== path); }
            persistLists(); return structuredClone(lists);
          } : undefined,
          validateWorkspaceFolder: ${workspaceLists} ? async (_workspace, _view, entry) => {
            (calls.folderValidations ||= []).push(entry);
            if (!lists.folderFavorites.some(item => item.identity === entry.identity && item.status === 'available') || !['Examples','Target'].includes(entry.relativePath)) throw new Error('missing');
            return entry.relativePath;
          } : undefined,
          validateWorkspaceDocument: ${workspaceLists} ? async (_workspace, _view, entry) => {
            if (!lists.favorites.concat(lists.recent).some(item => item.identity === entry.identity && item.status === 'available')) throw new Error('missing');
            return entry.relativePath;
          } : undefined,
          recordDocumentDisplay: ${workspaceLists} ? async (_workspace, _view, id, url) => {
            if (grants.get(url) !== id) throw new Error('Superseded');
            (calls.viewed ||= []).push({ id, url });
            const entry = { relativePath: paths.get(id), identity: 'fixture:' + paths.get(id), status: 'available' };
            lists.recent = [entry, ...lists.recent.filter(item => item.identity !== entry.identity)].slice(0, 50);
            persistLists();
          } : undefined,
          resolveDocumentLink: async (_workspace, _view, sourceUrl, href) => {
            if (!grants.has(sourceUrl)) throw new Error('DocumentChanged');
            const source = new URL(sourceUrl); const target = new URL(href);
            if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Unsupported link');
            if (source.origin !== target.origin) return { kind: 'external', url: target.href };
            const prefix = '/s/' + source.pathname.split('/')[2] + '/';
            if (!target.pathname.startsWith(prefix)) throw new Error('Outside grant');
            if (source.pathname === target.pathname) return { kind: 'page', fragment: target.hash };
            const relativePath = decodeURIComponent(target.pathname.slice(prefix.length));
            if (!/^Examples\\/\\d+\\.html$/.test(relativePath)) throw new Error('Not a selected HTML');
            return { kind: 'document', relativePath, fragment: target.hash };
          },
          openExternalDocumentLink: async (_workspace, _view, sourceUrl, href) => {
            if (!grants.has(sourceUrl)) throw new Error('DocumentChanged');
            (calls.external ||= []).push(href);
          },
          mutateTree: async (_workspace, _view, mutation) => {
            calls.mutations.push(mutation);
            if (window.layoutMutationFailure) throw new Error('アクセス権または同名の項目');
            const list = (parent) => {
              if (!parent) return snapshot.nodes;
              const find = (nodes) => { for (const node of nodes) { if (node.relativePath === parent && node.kind === 'folder') return node.children; const nested = find(node.children); if (nested) return nested; } };
              return find(snapshot.nodes);
            };
            const parentOf = path => path.split('/').slice(0, -1).join('/');
            const join = (parent, name) => parent ? parent + '/' + name : name;
            let createdPath = null; const moves = [];
            if (mutation.kind === 'createHtml' || mutation.kind === 'createFolder') {
              const name = mutation.kind === 'createHtml' && !mutation.name.toLowerCase().endsWith('.html') ? mutation.name + '.html' : mutation.name;
              const children = list(mutation.parent);
              if (children.some(node => node.name.toLowerCase() === name.toLowerCase())) throw new Error('同じ名前');
              const relativePath = join(mutation.parent, name);
              children.push({ name, relativePath, kind: mutation.kind === 'createHtml' ? 'html' : 'folder', children: [] });
              if (mutation.kind === 'createHtml') createdPath = relativePath;
            } else {
              const old = list(parentOf(mutation.source)); const index = old.findIndex(node => node.relativePath === mutation.source);
              const node = old[index];
              if (mutation.kind === 'reorder') {
                old.splice(index, 1); const at = old.findIndex(node => node.relativePath === mutation.anchor) + Number(mutation.after); old.splice(at, 0, node);
              } else {
                const renaming = mutation.kind === 'renameHtml';
                const extension = node.name.match(/\\.html?$/i)?.[0] || '.html';
                const name = renaming ? mutation.name + extension : node.name;
                const parent = renaming ? parentOf(mutation.source) : mutation.parent;
                const destination = join(parent, name); const target = list(parent);
                if (target.some(item => item !== node && item.name.toLowerCase() === name.toLowerCase())) throw new Error('同じ名前');
                old.splice(index, 1);
                const map = path => path === mutation.source ? destination : path.startsWith(mutation.source + '/') ? destination + path.slice(mutation.source.length) : path;
                node.name = name;
                const walk = node => { node.relativePath = map(node.relativePath); node.children.forEach(walk); }; walk(node);
                const at = renaming ? index : mutation.anchor ? target.findIndex(node => node.relativePath === mutation.anchor) + Number(mutation.after) : target.length; target.splice(at, 0, node);
                for (const [id, path] of paths) { if (map(path) !== path) revoke(id); paths.set(id, map(path)); }
                moves.push({ from: mutation.source, to: destination, revision: snapshot.revision + 1 });
              }
            }
            snapshot.revision++; snapshot.pathMoves = [...(snapshot.pathMoves || []), ...moves];
            return { snapshot: structuredClone(snapshot), createdPath, moves, warning: window.layoutMutationWarning || null };
          },
          performFileAction: async (workspace, view, path, action) => {
            calls.actions.push({workspace, view, path, action});
            if (window.layoutActionDelay) await new Promise(resolve => setTimeout(resolve, window.layoutActionDelay));
            if (window.layoutActionFailure) throw new Error('OS起動失敗');
          },
          beginView: async () => structuredClone(snapshot),
          createTab: async (_workspace, _view, path, expectedIdentity) => { if (expectedIdentity) (calls.createBound ||= []).push({path,expectedIdentity}); const id = String(++serial); paths.set(id, path); (calls.create ||= []).push(path); return id; },
          closeTab: async (_workspace, _view, id) => { revoke(id); paths.delete(id); calls.close++; },
          getTree: async () => { calls.tree++; return structuredClone(snapshot); },
          chooseRoot: async () => { throw new Error('フォルダを開けません'); },
          refresh: async () => { calls.refresh++; return structuredClone(snapshot); },
          listen: async (callback) => { listener = callback; return () => {}; },
          openDocument: async (_id, _view, path) => {
            calls.open++;
            if (window.layoutSetReadFailures?.includes(paths.get(path))) throw new Error('fixture read failed');
            revoke(path);
            const base = ${keyboard} ? '/s/' + calls.open.toString(16).padStart(64, '0') + '/' : '/__layout/';
            const url = 'http://127.0.0.1:1420' + base + paths.get(path) + '?grant=' + path + '-' + calls.open;
            grants.set(new URL(url).href, path);
            return url;
          }
        };
      `,
    }),
  );
  await page.route("**/src/features/document-search/bridge.ts", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `
        const calls = window.layoutSearchCalls = { status: 0, search: 0, rebuild: 0 };
        let generation = 1;
        let rebuilt = false;
        const normalized = value => value.normalize('NFKC').toLowerCase().trim().replace(/\\s+/gu, ' ');
        const documents = () => {
          const output = [];
          const visit = nodes => { for (const node of nodes) { if (node.kind === 'html') output.push(node); visit(node.children); } };
          visit(window.layoutSearchSnapshot.nodes);
          return output;
        };
        const status = workspaceId => {
          const snapshot = window.layoutSearchSnapshot;
          if (workspaceId !== snapshot.workspaceId) throw new Error('WorkspaceChanged');
          return {
            workspaceId, rootId: 'layout-root', phase: 'ready', generation,
            requestRevision: snapshot.revision, indexed: documents().length,
            pending: 0, unavailable: 0, failed: 0, truncated: 0,
            databaseBytes: 8192, complete: true, limited: false, rebuilt, error: null
          };
        };
        export const searchBridge = {
          getStatus: async workspaceId => { calls.status++; return status(workspaceId); },
          search: async (workspaceId, query, limit, offset, mode, scope) => {
            (calls.scopes ||= []).push(scope);
            calls.search++;
            if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 10000)
              throw new Error('Search pagination limit exceeded');
            const normalizedQuery = normalized(query);
            const terms = normalizedQuery ? normalizedQuery.split(' ') : [];
            if (Array.from(query).length > 256 || Array.from(normalizedQuery).length > 256 || terms.length > 8)
              throw new Error('Search query limit exceeded');
            const current = status(workspaceId);
            const matches = terms.length ? documents()
              .filter(node => !scope || node.relativePath.startsWith(scope.relativePath + "/"))
              .filter(node => terms.every(term => normalized(node.relativePath + ' ' + node.name).includes(term)))
              .sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0) : [];
            const hits = matches.slice(offset, offset + limit).map(node => ({
              documentId: 'layout-document:' + node.relativePath, relativePath: node.relativePath,
              title: node.name, snippet: 'Document', truncated: false
            }));
            return { generation: current.generation, requestRevision: current.requestRevision,
              normalizedQuery, hits, hasMore: matches.length > offset + limit };
          },
          rebuild: async workspaceId => { calls.rebuild++; generation++; rebuilt = true; return status(workspaceId); }
        };
      `,
    }),
  );
  await page.route(/http:\/\/127\.0\.0\.1:1420\/(?:__layout|s)\//, async (route) => {
    const valid = await page.evaluate(
      (url) => (window as unknown as { layoutGrants: Map<string, string> }).layoutGrants.has(url),
      route.request().url(),
    );
    if (!valid) return route.fulfill({ status: 403, body: "Expired document grant" });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>${keyboard ? `<script>${documentKeyboard.replace("__MY_KNOWLEDGE_KEYBOARD_TOKEN__", JSON.stringify(new URL(route.request().url()).pathname.split("/")[2]))}</script>` : ""}${links ? `<script>${documentLinks.replace("__MY_KNOWLEDGE_LINK_TOKEN__", JSON.stringify(new URL(route.request().url()).pathname.split("/")[2]))}</script>` : ""}${artifactExport ? `<script>${documentExportBridge.replace("__MY_KNOWLEDGE_EXPORT_TOKEN__", JSON.stringify(new URL(route.request().url()).pathname.split("/")[2]))}${documentExportAdapter}</script>` : ""}<html><head><meta charset="utf-8"><style>
        body { margin: ${new URL(route.request().url()).pathname.endsWith("/0.html") ? 0 : 32}px; }
        </style></head><body><input aria-label="文書入力" value="initial"><button id="draw">Draw</button><canvas width="10" height="10"></canvas><div style="height:1500px">Document</div>${new URL(route.request().url()).pathname.endsWith("/1.html") ? '<h2 id="section">Anchor</h2>' : ""}<script>
          window.runtimeState = { count: 0 };
          ${
            artifactExport
              ? `
          const exportButton = document.createElement('button'); exportButton.textContent='Export text';
          document.body.prepend(exportButton);
          window.exportResults=[];
          exportButton.onclick=()=>MyKnowledgeExport.exportArtifact({blob:new Blob(['generated text'],{type:'text/plain'}),name:'generated',format:'text'})
            .then(result=>window.exportResults.push(result)).catch(error=>window.exportResults.push({error:error.code}));
          `
              : ""
          }
          document.querySelector('#draw').onclick = () => {
            window.runtimeState.count++;
            const context = document.querySelector('canvas').getContext('2d');
            context.fillStyle = '#33aa55'; context.fillRect(0, 0, 10, 10);
          };
        </script></body></html>`,
    });
  });
  await page.goto("/");
  await expect.poll(() => page.evaluate("typeof window.layoutNativeCommand")).toBe("function");
  await expect(page.getByRole("button", { name: "文書検索", exact: true })).toBeVisible();
  await expect(page.getByRole("searchbox")).toHaveCount(0);
  await expect(page.locator(".document-search .search-error")).toHaveCount(0);
  await page.getByRole("treeitem", { name: /Examples/ }).click();
}
async function openDocument(page: Page, index = 0) {
  await page.locator(`[data-path="Examples/${index}.html"]`).click();
  await expect(
    page.frameLocator(`iframe[title="Examples/${index}.html"]`).locator("input"),
  ).toHaveValue("initial");
}

test("sidebar runtime version sits left of reload and settings without a document count", async ({
  page,
}) => {
  await page.route("**/@tauri-apps_api_app.js*", async (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: 'export const getVersion = async () => "0.5.0";',
    }),
  );
  await prepare(page);
  await expect(page.locator(".sidebar-version")).toHaveText("v0.5.0");
  expect((await page.locator(".sidebar-footer").boundingBox())!.height).toBe(32);
  expect(await page.locator(".sidebar-footer").innerText()).not.toContain("documents");
  await expect(page.getByRole("button", { name: "設定", exact: true })).toBeVisible();
  expect((await page.getByRole("tree").boundingBox())!.height).toBeGreaterThan(200);
  const html = page.locator('[data-path="Examples/0.html"]');
  await html.hover();
  await expect(html.locator(".html-label")).toHaveCount(0);
  await expect(html).toHaveAttribute("aria-label", "0 HTML");
  await expect(html).toHaveAttribute("title", "Examples/0.html");
  await page.screenshot({ path: test.info().outputPath("sidebar-runtime-version.png") });
  await page.getByRole("button", { name: "左メニューを閉じる" }).click();
  await expect(page.locator(".sidebar-version")).toBeHidden();
  await page.getByRole("button", { name: "左メニューを開く" }).click();
  await expect(page.locator(".sidebar-version")).toHaveText("v0.5.0");
});

test("document zoom keeps the iframe, reflows its content and pointer targets, and leaves the shell unchanged", async ({
  page,
}) => {
  await prepare(page, false, false, undefined, true);
  await openDocument(page);
  const iframe = page.locator('iframe[title="Examples/0.html"]');
  const original = await iframe.elementHandle();
  const source = await iframe.getAttribute("src");
  const frame = iframe.contentFrame();
  await frame.getByRole("textbox").fill("zoom retained");
  await frame.getByRole("button", { name: "Draw" }).click();
  const sidebar = await page.locator(".sidebar").boundingBox();
  const shellFont = await page.locator(".titlebar").evaluate((e) => getComputedStyle(e).fontSize);
  const zoom = async (label: string) => {
    await page.getByRole("tab", { name: /0.html/ }).click({ button: "right" });
    await page.getByRole("menuitem", { name: label, exact: true }).click();
  };
  await zoom("文書を拡大");
  await expect(page.getByRole("tab", { name: /0.html/ })).toContainText("125%");
  const viewport = await frame.locator("body").evaluate(() => window.innerWidth);
  const rect = await iframe.boundingBox();
  expect(rect!.width / viewport).toBeCloseTo(1, 1);
  await expect(frame.locator("html")).toHaveCSS("zoom", "1.25");
  const viewer = await iframe.locator("..").boundingBox();
  expect(Math.abs(rect!.width - viewer!.width)).toBeLessThan(2);
  expect(Math.abs(rect!.height - viewer!.height)).toBeLessThan(2);
  await frame.getByRole("button", { name: "Draw" }).click();
  await frame.getByRole("textbox").fill("scaled pointer input");
  const live = () =>
    frame.locator("body").evaluate(() => ({
      count: (window as unknown as { runtimeState: { count: number } }).runtimeState.count,
      pixel: [...document.querySelector("canvas")!.getContext("2d")!.getImageData(0, 0, 1, 1).data],
      scroll: window.scrollY,
    }));
  expect(await live()).toMatchObject({ count: 2, pixel: [51, 170, 85, 255] });
  await frame.locator("body").evaluate(() => window.scrollTo(0, 200));
  await zoom("文書を拡大");
  expect((await live()).scroll).toBeGreaterThan(100);
  await zoom("100%に戻す");
  for (let i = 0; i < 4; i++) await zoom("文書を拡大");
  await page.getByRole("tab", { name: /0.html/ }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "文書を拡大", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  for (let i = 0; i < 6; i++) await zoom("文書を縮小");
  await frame.locator("body").evaluate(() => window.scrollTo(0, 0));
  await frame.getByRole("button", { name: "Draw" }).click();
  expect((await live()).count).toBe(3);
  await page.getByRole("tab", { name: /0.html/ }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "文書を縮小", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await zoom("100%に戻す");
  await expect(frame.getByRole("textbox")).toHaveValue("scaled pointer input");
  expect(await iframe.evaluate((e, original) => e === original, original)).toBe(true);
  expect(await iframe.getAttribute("src")).toBe(source);
  expect(await page.locator(".sidebar").boundingBox()).toEqual(sidebar);
  expect(await page.locator(".titlebar").evaluate((e) => getComputedStyle(e).fontSize)).toBe(
    shellFont,
  );
  expect(await page.evaluate("window.layoutCalls.open")).toBe(1);
});

test("document zoom is independent for two views and remains accessible at a narrow viewport", async ({
  page,
}) => {
  await prepare(page, false, false, undefined, true);
  await openDocument(page);
  const tab = () =>
    page.getByRole("tablist", { name: "開いている文書" }).getByRole("tab", { name: /0.html/ });
  await tab().click({ button: "right" });
  await page.getByRole("menuitem", { name: "文書を縮小", exact: true }).click();
  await tab().click({ button: "right" });
  await page.getByRole("menuitem", { name: "右の列で開く", exact: true }).click();
  const panes = page.locator(".document-pane:not([hidden])");
  await expect(panes).toHaveCount(2);
  await expect(panes.nth(0).locator("iframe").contentFrame().locator("html")).toHaveCSS(
    "zoom",
    "0.75",
  );
  await expect(panes.nth(1).locator("iframe").contentFrame().locator("html")).toHaveCSS(
    "zoom",
    "1",
  );
  await page
    .getByRole("tablist", { name: "右列の文書" })
    .getByRole("tab", { name: /0.html/ })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "文書を拡大", exact: true }).click();
  await expect(panes.nth(1).locator("iframe").contentFrame().locator("html")).toHaveCSS(
    "zoom",
    "1.25",
  );
  for (const pane of await panes.all()) {
    const rect = await pane.boundingBox();
    const frame = await pane.locator("iframe").boundingBox();
    expect(Math.abs(rect!.width - frame!.width)).toBeLessThan(2);
  }
  await page.screenshot({ path: test.info().outputPath("document-zoom-split.png") });
  await page.setViewportSize({ width: 320, height: 640 });
  await page.getByRole("button", { name: "左メニューを閉じる" }).click();
  const left = page
    .getByRole("tablist", { name: "左列の文書" })
    .getByRole("tab", { name: /0.html/ });
  await left.click({ button: "right" });
  await expect(page.getByText("文書表示: 75%")).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "文書を縮小", exact: true })).toBeInViewport();
  await page.getByRole("menuitem", { name: "100%に戻す", exact: true }).click();
  await expect(panes.nth(0).locator("iframe").contentFrame().locator("html")).toHaveCSS(
    "zoom",
    "1",
  );
  expect(await page.evaluate("window.layoutCalls.open")).toBe(2);
});

test("document zoom shortcuts follow the focused frame across two views and retain live document state", async ({
  page,
}) => {
  await prepare(page, false, false, undefined, true);
  await openDocument(page);
  const left = page.locator(".document-pane:not([hidden])").nth(0).locator("iframe");
  const original = await left.elementHandle();
  const source = await left.getAttribute("src");
  await left.contentFrame().getByRole("textbox").fill("keyboard retained");
  await left.contentFrame().getByRole("button", { name: "Draw" }).click();
  await left.contentFrame().getByRole("button", { name: "Draw" }).press("Control+Equal");
  await expect(left.contentFrame().locator("html")).toHaveCSS("zoom", "1.25");
  await page.getByRole("tab", { name: /0.html/ }).click({ button: "right" });
  await expect(page.getByText("文書表示: 125%", { exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "文書を拡大", exact: true })).toContainText(
    "Ctrl++",
  );
  await page.getByRole("menuitem", { name: "右の列で開く", exact: true }).click();
  const right = page.locator(".document-pane:not([hidden])").nth(1).locator("iframe");
  await expect(right).toBeVisible();
  const rightOriginal = await right.elementHandle();
  await right.contentFrame().getByRole("button", { name: "Draw" }).click();
  await right.contentFrame().getByRole("button", { name: "Draw" }).press("Control+Minus");
  await expect(right.contentFrame().locator("html")).toHaveCSS("zoom", "0.75");
  await expect(left.contentFrame().locator("html")).toHaveCSS("zoom", "1.25");
  await left.contentFrame().getByRole("button", { name: "Draw" }).click();
  await left.contentFrame().getByRole("button", { name: "Draw" }).press("Control+0");
  await expect(left.contentFrame().locator("html")).toHaveCSS("zoom", "1");
  const bounds = await right.boundingBox();
  await page.mouse.move(bounds!.x + 100, bounds!.y + 150);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  await page.waitForTimeout(180);
  await expect(right.contentFrame().locator("html")).toHaveCSS("zoom", "0.75");
  await right.contentFrame().getByRole("button", { name: "Draw" }).click();
  await page.mouse.move(bounds!.x + 100, bounds!.y + 150);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  await expect(right.contentFrame().locator("html")).toHaveCSS("zoom", "1");
  await expect(left.contentFrame().getByRole("textbox")).toHaveValue("keyboard retained");
  expect(await left.evaluate((element, saved) => element === saved, original)).toBe(true);
  expect(await right.evaluate((element, saved) => element === saved, rightOriginal)).toBe(true);
  expect(await left.getAttribute("src")).toBe(source);
  expect(
    await left
      .contentFrame()
      .locator("body")
      .evaluate(() => [
        ...document.querySelector("canvas")!.getContext("2d")!.getImageData(0, 0, 1, 1).data,
      ]),
  ).toEqual([51, 170, 85, 255]);
  await page.getByRole("button", { name: "文書検索", exact: true }).click();
  await page.getByRole("searchbox", { name: "文書を検索" }).press("Control+Equal");
  await expect(left.contentFrame().locator("html")).toHaveCSS("zoom", "1");
  await expect(right.contentFrame().locator("html")).toHaveCSS("zoom", "1");
});

test("titlebar blanks and left-aligned icons remain reachable after either populated column closes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await prepare(page, false, false, {
    platform: "windows",
    height: 40,
    leftInset: 0,
    rightInset: 138,
  });
  for (let index = 0; index < 8; index++) {
    await openDocument(page, index);
    if (index >= 4) await moveToRight(page, index);
  }
  const captionHit = async (selector: string) =>
    page.locator(selector).evaluate((element) => {
      const r = element.getBoundingClientRect();
      return document
        .elementFromPoint(r.right - 6, r.top + r.height / 2)
        ?.hasAttribute("data-tauri-drag-region");
    });
  expect(await captionHit(".titlebar-controls")).toBe(true);
  const gap = async () => {
    const menu = await page.getByRole("button", { name: "左メニューを閉じる" }).boundingBox();
    const files = await page.getByRole("button", { name: "ファイル", exact: true }).boundingBox();
    return files!.x - menu!.x - menu!.width;
  };
  expect(await gap()).toBe(6);
  await page.getByRole("separator").focus();
  await page.getByRole("separator").press("End");
  expect(await gap()).toBe(6);
  expect(await captionHit(".titlebar-controls")).toBe(true);
  const rightFrame = await page.locator('iframe[title="Examples/7.html"]').getAttribute("src");
  for (const index of [3, 2, 1, 0])
    await page.getByRole("button", { name: `Examples/${index}.htmlを閉じる`, exact: true }).click();
  await expect(page.locator('.tab-strip[data-split="false"]')).toBeVisible();
  expect(await captionHit(".tab-group-drop-target")).toBe(true);
  expect(await page.locator('iframe[title="Examples/7.html"]').getAttribute("src")).toBe(
    rightFrame,
  );
  await page.screenshot({ path: ".tools/titlebar-after-left-close.png" });
  await openDocument(page, 0);
  for (const index of [4, 5, 6, 7]) await moveToRight(page, index);
  for (const index of [4, 5, 6, 7])
    await page.getByRole("button", { name: `Examples/${index}.htmlを閉じる`, exact: true }).click();
  await expect(page.locator('.tab-strip[data-split="false"]')).toBeVisible();
  expect(await captionHit(".tab-group-drop-target")).toBe(true);
  await page.getByRole("button", { name: "Examples/0.htmlを閉じる", exact: true }).click();
  await expect(page.locator(".tab-strip")).toBeHidden();
  expect(await captionHit(".window-drag-region")).toBe(true);
  for (const width of [640, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.getByRole("button", { name: "左メニューを閉じる" }).click();
    await page.getByRole("button", { name: "左メニューを開く" }).click();
    expect(
      await page.locator(".titlebar-controls").getAttribute("data-tauri-drag-region"),
    ).not.toBeNull();
  }
});

test("opaque HTML shortcuts move their own live tab, respect JS cancellation, and keep heap and input", async ({
  page,
}) => {
  await prepare(
    page,
    false,
    false,
    { platform: "windows", height: 40, leftInset: 0, rightInset: 138 },
    true,
  );
  await openDocument(page, 0);
  await openDocument(page, 1);
  const document = page.frameLocator('iframe[title="Examples/1.html"]');
  await document.locator("input").fill("retained");
  await document.locator("#draw").click();
  const original = await page.locator('iframe[title="Examples/1.html"]').getAttribute("src");
  await document.locator("#draw").press("Control+Shift+ArrowRight");
  await expect(
    page
      .getByRole("tablist", { name: "右列の文書" })
      .getByRole("tab", { name: "1.html", exact: true }),
  ).toBeVisible();
  await document.locator("#draw").evaluate(() => {
    window.addEventListener("keydown", (event) => {
      if (event.ctrlKey && event.shiftKey && event.key === "ArrowLeft") event.preventDefault();
    });
  });
  await document.locator("#draw").press("Control+Shift+ArrowLeft");
  await expect(
    page
      .getByRole("tablist", { name: "右列の文書" })
      .getByRole("tab", { name: "1.html", exact: true }),
  ).toBeVisible();
  await document.locator("input").press("Control+Shift+ArrowLeft");
  await expect(
    page
      .getByRole("tablist", { name: "右列の文書" })
      .getByRole("tab", { name: "1.html", exact: true }),
  ).toBeVisible();
  expect(await page.locator('iframe[title="Examples/1.html"]').getAttribute("src")).toBe(original);
  await expect(document.locator("input")).toHaveValue("retained");
  expect(
    await document
      .locator("#draw")
      .evaluate(
        () => (window as unknown as { runtimeState: { count: number } }).runtimeState.count,
      ),
  ).toBe(1);
  const left = page.frameLocator('iframe[title="Examples/0.html"]');
  await left.locator("#draw").click();
  await left.locator("#draw").press("Control+Shift+ArrowRight");
  await expect(
    page
      .getByRole("tablist", { name: "開いている文書" })
      .getByRole("tab", { name: "0.html", exact: true }),
  ).toBeVisible();
  await left.locator("#draw").press("Control+Shift+ArrowLeft");
  await expect(
    page
      .getByRole("tablist", { name: "開いている文書" })
      .getByRole("tab", { name: "0.html", exact: true }),
  ).toBeVisible();
});
async function tabAction(page: Page, tab: Locator, name: string) {
  await tab.click({ button: "right" });
  await page.getByRole("menuitem", { name, exact: true }).click();
}
async function moveToRight(page: Page, index = 0) {
  const tab = page.getByRole("tab", { name: `${index}.html`, exact: true });
  await tab.focus();
  await tab.press("Control+Shift+ArrowRight");
  await expect(
    page
      .getByRole("tablist", { name: "右列の文書" })
      .getByRole("tab", { name: `${index}.html`, exact: true }),
  ).toHaveCount(1);
}
async function expectFullViewer(page: Page) {
  const dimensions = await page.locator(".document-pane:not([hidden]) iframe").evaluate((frame) => {
    const rect = frame.getBoundingClientRect();
    return {
      top: rect.top,
      bottom: rect.bottom,
      viewport: innerHeight,
      scrollHeight: document.documentElement.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth,
      width: innerWidth,
    };
  });
  const titlebar = await page.locator(".titlebar").boundingBox();
  expect(titlebar).not.toBeNull();
  expect(dimensions.top).toBe(titlebar!.y + titlebar!.height);
  expect(dimensions.bottom).toBe(dimensions.viewport);
  expect(dimensions.scrollHeight).toBe(dimensions.viewport);
  expect(dimensions.scrollWidth).toBe(dimensions.width);
}

test("search replaces the sidebar tree, keeps frames and stops hidden work", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await prepare(page);
  await openDocument(page);
  await expect(page.locator(".sidebar .brand, .sidebar .workspace-heading")).toHaveCount(0);
  const treeArea = await page.getByRole("tree").boundingBox();
  const titlebar = await page.locator(".titlebar").boundingBox();
  // The existing creation/favorites header shares this column with the tree.
  expect(treeArea!.y).toBeGreaterThan(titlebar!.height);
  expect(treeArea!.height).toBeGreaterThan(500);
  const frame = page.frameLocator(".document-pane:not([hidden]) iframe");
  await frame.getByRole("textbox").fill("retained");
  const tree = page.getByRole("tree");
  await tree.evaluate((element) => {
    element.scrollTop = 720;
  });
  const before = await page.locator(".document-pane:not([hidden]) iframe").boundingBox();
  await page.getByRole("button", { name: "文書検索", exact: true }).click();
  const input = page.getByRole("searchbox");
  await expect(input).toBeFocused();
  await expect(tree).toBeHidden();
  await expect(page.getByRole("button", { name: "索引を再構築" })).toBeHidden();
  expect(await page.locator(".document-pane:not([hidden]) iframe").boundingBox()).toEqual(before);
  await input.fill("0.html");
  await expect(page.locator('.search-results button[title="Examples/0.html"]')).toBeVisible();
  await page.locator('.search-results button[title="Examples/0.html"]').click();
  await expect(frame.getByRole("textbox")).toHaveValue("retained");
  await page.getByRole("button", { name: "ファイル", exact: true }).click();
  await expect(tree).toBeVisible();
  expect(await tree.evaluate((element) => element.scrollTop)).toBe(720);
  const calls = await page.evaluate(() =>
    JSON.stringify((window as unknown as { layoutSearchCalls: object }).layoutSearchCalls),
  );
  await page.waitForTimeout(1_200);
  expect(
    await page.evaluate(() =>
      JSON.stringify((window as unknown as { layoutSearchCalls: object }).layoutSearchCalls),
    ),
  ).toBe(calls);
  await page.getByRole("button", { name: "文書検索", exact: true }).click();
  await expect(input).toHaveValue("0.html");
  await input.press("Escape");
  await expect(input).toHaveValue("");
  await input.press("Escape");
  await expect(input).toBeHidden();
  await expect(page.getByRole("button", { name: "文書検索", exact: true })).toBeFocused();
  await expect(frame.getByRole("textbox")).toHaveValue("retained");
  await page.setViewportSize({ width: 850, height: 600 });
  await page.getByRole("button", { name: "文書検索", exact: true }).click();
  await expect(input).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(850);
  await page.screenshot({ path: test.info().outputPath("search-ui.png") });
  await page.setViewportSize({ width: 320, height: 600 });
  await expect(input).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await input.press("Escape");
  await expect(tree).toBeVisible();
});

test("compact tree toolbar preserves readable selected names and keyboard access at narrow widths", async ({
  page,
}) => {
  await page.setViewportSize({ width: 850, height: 600 });
  await prepare(page, false, true);
  const row = page.locator(`[data-path="Examples/${LONG_FILE_NAME}"]`);
  await row.click();
  await expect(row).toHaveAttribute("aria-selected", "true");
  await expect(row).toHaveAttribute("title", "Examples/" + LONG_FILE_NAME);
  await expect(row.locator(".filename")).toHaveCSS("text-overflow", "ellipsis");
  const tree = page.getByRole("tree");
  const area = await tree.boundingBox();
  expect((await row.boundingBox())!.height).toBe(32);
  const density = await tree.evaluate((element) => ({
    height: element.clientHeight,
    spacer: (element.querySelector(".tree-spacer") as HTMLElement).style.height,
  }));
  expect(Math.floor(density.height / 32)).toBeGreaterThan(Math.floor(density.height / 36));
  await page.locator('[data-path="Examples"]').click();
  const folderIcon = page.locator('[data-path="Examples"] .file-icon path');
  expect(await page.locator(".workspace-icon path").getAttribute("d")).toBe(
    await folderIcon.getAttribute("d"),
  );
  await page.locator('[data-path="Examples"]').click();
  await expect(page.locator(".workspace-chevron")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator(".workspace-button")).toHaveCSS("height", "32px");
  const titlebar = await page.locator(".titlebar").boundingBox();
  expect(area!.y - titlebar!.height).toBeLessThan(90);
  expect(area!.height).toBeGreaterThan(470 - titlebar!.height);
  await tree.focus();
  await tree.press("ArrowUp");
  await tree.press("ArrowDown");
  await tree.press("Enter");
  await expect(row).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "文書検索", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("searchbox")).toBeFocused();
  await page.getByRole("searchbox").press("Escape");
  await expect(page.getByRole("button", { name: "文書検索", exact: true })).toBeFocused();
  await expect(row).toHaveAttribute("aria-selected", "true");
  await page.screenshot({ path: test.info().outputPath("tree-ui.png") });
});

test("shell refresh keys preserve both columns, the remaining tab and reopen history", async ({
  page,
}) => {
  await prepare(page);
  for (const index of [0, 1, 2]) await openDocument(page, index);
  await page.getByRole("tab", { name: "1.html", exact: true }).click();
  await page.keyboard.press("Control+Shift+ArrowRight");
  await page.getByRole("button", { name: "Examples/2.htmlを閉じる", exact: true }).click();
  const before = await page.evaluate(() => {
    (window as unknown as { batchFrames: Element[] }).batchFrames = [
      ...document.querySelectorAll(".document-pane iframe"),
    ];
    return [...document.querySelectorAll('[role="tab"]')].map((e) =>
      e.getAttribute("aria-controls"),
    );
  });
  await page.getByRole("button", { name: "文書検索", exact: true }).click();
  for (const key of ["Control+r", "Control+Shift+r"]) await page.keyboard.press(key);
  expect(
    await page.evaluate(() =>
      [...document.querySelectorAll('[role="tab"]')].map((e) => e.getAttribute("aria-controls")),
    ),
  ).toEqual(before);
  expect(
    await page.evaluate(() =>
      (window as unknown as { batchFrames: Element[] }).batchFrames.every((e) => e.isConnected),
    ),
  ).toBe(true);
  await page.getByRole("tab", { name: "1.html", exact: true }).click();
  await page.keyboard.press("Control+Shift+t");
  await expect(page.getByRole("tab", { name: "2.html", exact: true })).toBeVisible();
  await expect(page.locator(".tab-group")).toHaveCount(2);
});

test("shell refresh capture protects focused dialogs and both context menus", async ({ page }) => {
  await prepare(page);
  await openDocument(page);
  const frame = page.locator(".document-pane iframe");
  const source = await frame.getAttribute("src");
  const checkFocusedKeys = async (scope: Locator) => {
    await expect(scope).toBeVisible();
    expect(await scope.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    for (const modifier of ["ctrlKey", "metaKey"])
      for (const shiftKey of [false, true]) {
        const result = await page.evaluate(
          ({ modifier, shiftKey }) => {
            const event = new KeyboardEvent("keydown", {
              key: shiftKey ? "R" : "r",
              bubbles: true,
              cancelable: true,
              [modifier]: true,
              shiftKey,
            });
            const dispatched = document.activeElement!.dispatchEvent(event);
            return { dispatched, prevented: event.defaultPrevented };
          },
          { modifier, shiftKey },
        );
        expect(result).toEqual({ dispatched: false, prevented: true });
      }
    await expect(scope).toBeVisible();
    await expect(frame).toHaveAttribute("src", source!);
    await expect(page.getByRole("tab")).toHaveCount(1);
  };
  await page.locator('[data-path="Examples/0.html"]').click({ button: "right" });
  await checkFocusedKeys(page.getByRole("menu"));
  await page.keyboard.press("Escape");
  await page.getByRole("tab").click({ button: "right" });
  await checkFocusedKeys(page.getByRole("menu"));
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "HTMLを作成", exact: true }).click();
  await checkFocusedKeys(page.getByRole("dialog"));
  await page.getByRole("button", { name: "キャンセル", exact: true }).click();
  const frameEvent = await frame
    .contentFrame()
    .locator("input")
    .evaluate((input) => {
      const event = new KeyboardEvent("keydown", {
        key: "r",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      return { dispatched: input.dispatchEvent(event), prevented: event.defaultPrevented };
    });
  expect(frameEvent).toEqual({ dispatched: true, prevented: false });
});

test("viewer fills available height and preserves document-owned margins", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await prepare(page);
  await openDocument(page);
  await expectFullViewer(page);
  await expect(page.frameLocator(".document-pane:not([hidden]) iframe").locator("body")).toHaveCSS(
    "margin",
    "0px",
  );
  await openDocument(page, 1);
  await expectFullViewer(page);
  await expect(page.frameLocator(".document-pane:not([hidden]) iframe").locator("body")).toHaveCSS(
    "margin",
    "32px",
  );
  await expect(page.locator(".document-pane:not([hidden]) iframe")).toHaveAttribute(
    "sandbox",
    "allow-scripts",
  );
});

test("browser-style tabs reorder without moving frames and close with adjacent selection and focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await prepare(page);
  for (const index of [0, 1, 2]) {
    await openDocument(page, index);
    await page
      .frameLocator(`iframe[title="Examples/${index}.html"]`)
      .getByRole("textbox")
      .fill(`state-${index}`);
    await page
      .frameLocator(`iframe[title="Examples/${index}.html"]`)
      .getByRole("button", { name: "Draw" })
      .click();
  }
  await page.evaluate(() => {
    (window as unknown as { retainedTabFrames: Element[] }).retainedTabFrames = Array.from(
      document.querySelectorAll(".document-pane iframe"),
    );
  });
  const calls = await page.evaluate("JSON.stringify(window.layoutCalls)");
  const first = page.getByRole("tab", { name: "0.html", exact: true }).locator("..");
  const last = page.getByRole("tab", { name: "2.html", exact: true }).locator("..");
  const rect = await last.boundingBox();
  await first.dragTo(last, { targetPosition: { x: rect!.width - 3, y: 15 } });
  await expect(page.getByRole("tab")).toHaveText(["1.html", "2.html", "0.html"]);
  expect(
    await page.evaluate(() => {
      const previous = (window as unknown as { retainedTabFrames: Element[] }).retainedTabFrames;
      return Array.from(document.querySelectorAll(".document-pane iframe")).every(
        (frame, index) => frame === previous[index],
      );
    }),
  ).toBe(true);
  expect(await page.evaluate("JSON.stringify(window.layoutCalls)")).toBe(calls);
  const zero = page.getByRole("tab", { name: "0.html", exact: true });
  await zero.click();
  await expect(
    page.frameLocator('iframe[title="Examples/0.html"]').getByRole("textbox"),
  ).toHaveValue("state-0");
  expect(
    await page
      .frameLocator('iframe[title="Examples/0.html"]')
      .locator("body")
      .evaluate(
        () => (window as unknown as { runtimeState: { count: number } }).runtimeState.count,
      ),
  ).toBe(1);
  await zero.focus();
  await zero.press("Control+w");
  const two = page.getByRole("tab", { name: "2.html", exact: true });
  await expect(two).toBeFocused();
  await expect(two).toHaveAttribute("aria-selected", "true");
  await expect(
    page.frameLocator('iframe[title="Examples/2.html"]').getByRole("textbox"),
  ).toHaveValue("state-2");
  await page.getByRole("tab", { name: "1.html", exact: true }).click({ button: "middle" });
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(two).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Examples/2.htmlを閉じる", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "左メニューを閉じる" })).toBeFocused();
});

test("tab groups retain column membership, scroll many tabs and isolate shortcuts from document inputs", async ({
  page,
}) => {
  await page.setViewportSize({ width: 850, height: 600 });
  await prepare(page, false, true);
  await page.locator(`[data-path="Examples/${LONG_FILE_NAME}"]`).click();
  for (let index = 1; index <= 9; index++) await openDocument(page, index);
  const longTab = page.getByRole("tab", { name: LONG_FILE_NAME, exact: true });
  await expect(longTab).toHaveAttribute("title", "Examples/" + LONG_FILE_NAME);
  await expect(longTab.locator(".tab-title")).toHaveCSS("text-overflow", "ellipsis");
  await longTab.click();
  await expect(longTab).toBeInViewport();
  const documentInput = page
    .frameLocator(`iframe[title="Examples/${LONG_FILE_NAME}"]`)
    .getByRole("textbox");
  await documentInput.fill("kept");
  await documentInput.press("ArrowRight");
  await documentInput.evaluate((input) =>
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "w", ctrlKey: true, bubbles: true, cancelable: true }),
    ),
  );
  await expect(page.getByRole("tab")).toHaveCount(10);
  await longTab.focus();
  await longTab.press("Control+Tab");
  await expect(page.getByRole("tab", { name: "1.html", exact: true })).toBeFocused();
  await moveToRight(page, 9);
  await expect(page.getByRole("tablist")).toHaveCount(2);
  await openDocument(page, 10);
  await openDocument(page, 11);
  const right = page.getByRole("tablist", { name: "右列の文書" });
  await expect(right.getByRole("tab", { name: "10.html", exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "Examples/11.htmlを閉じる", exact: true }).click();
  await expect(right.getByRole("tab", { name: "10.html", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const movedInput = page.frameLocator('iframe[title="Examples/10.html"]').getByRole("textbox");
  await movedInput.fill("moved-kept");
  const move = right.getByRole("tab", { name: "10.html", exact: true });
  await move.focus();
  await move.press("Control+Shift+ArrowLeft");
  await expect(
    page
      .getByRole("tablist", { name: "左列の文書" })
      .getByRole("tab", { name: "10.html", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(850);
  await expect(page.getByRole("tab", { name: "10.html", exact: true })).toBeFocused();
  await expect(movedInput).toHaveValue("moved-kept");
  await page.screenshot({ path: test.info().outputPath("tabs-ui.png") });
});

test("10001-document tree retains scroll, selection and live iframe across keyboard toggles", async ({
  page,
}) => {
  await prepare(page);
  await openDocument(page);
  const input = page.frameLocator(".document-pane:not([hidden]) iframe").getByRole("textbox");
  await input.fill("preserved");
  const frame = await page.locator("iframe").elementHandle();
  const tree = page.getByRole("tree");
  await tree.evaluate((element) => {
    element.scrollTop = 720;
  });
  await expect.poll(() => tree.evaluate((element) => element.scrollTop)).toBe(720);
  const calls = await page.evaluate("JSON.stringify(window.layoutCalls)");
  const toggle = page.getByRole("button", { name: "左メニューを閉じる" });
  await toggle.focus();
  for (let index = 0; index < 5; index++) {
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "左メニューを開く" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(tree).toBeHidden();
    await page.keyboard.press("Space");
    await expect(tree).toBeVisible();
    await expect.poll(() => tree.evaluate((element) => element.scrollTop)).toBe(720);
    await expect(input).toHaveValue("preserved");
  }
  expect(await frame!.evaluate((element) => element === document.querySelector("iframe"))).toBe(
    true,
  );
  expect(await page.evaluate("JSON.stringify(window.layoutCalls)")).toBe(calls);
  await tree.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(page.locator('[data-path="Examples"]')).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator('[data-path="Examples/0.html"]')).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await tree.focus();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "左メニューを開く" })).toBeFocused();
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest(".sidebar")))).toBe(
    false,
  );
});

for (const width of [320, 640, 700]) {
  test(`menu remains reachable at ${width}px with errors and watch recovery`, async ({ page }) => {
    await page.setViewportSize({ width, height: 640 });
    await prepare(page, true);
    await page.locator(".workspace-button").click();
    await page.getByRole("button", { name: "左メニューを閉じる" }).click();
    await expect(page.locator('#workspace-feedback-summary[role="alert"]')).toContainText(
      "フォルダを開けません",
    );
    await expect(page.locator(".viewer-content .notice")).toHaveCount(0);
    const show = page.getByRole("button", { name: "左メニューを開く" });
    await expect(show).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await show.press("Enter");
    await expect(page.locator('.workspace-feedback [role="status"]')).toBeVisible();
    await expect(page.locator(".workspace-feedback button")).toBeInViewport();
    await expect(page.getByRole("tree")).toBeVisible();
    await page.getByRole("tree").focus();
    await page.keyboard.press("Escape");
    await expect(show).toBeFocused();
    await show.press("Enter");
    if (width <= 640) {
      await expect(page.locator(".viewer-content")).toHaveCSS("visibility", "hidden");
      let reachedMenu = false;
      for (let step = 0; step < 3; step++) {
        await page.keyboard.press("Tab");
        expect(
          await page.evaluate(() => Boolean(document.activeElement?.closest(".viewer-content"))),
        ).toBe(false);
        reachedMenu ||= await page.evaluate(() =>
          Boolean(document.activeElement?.closest(".sidebar")),
        );
      }
      expect(reachedMenu).toBe(true);
    }
    await openDocument(page);
    await page.getByRole("button", { name: "左メニューを閉じる" }).click();
    await expect(
      page.frameLocator(".document-pane:not([hidden]) iframe").getByRole("textbox"),
    ).toBeVisible();
    await expect(show).toBeInViewport();
  });
}

test("resizing across the overlay boundary keeps the same document and input", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 640 });
  await prepare(page);
  await openDocument(page);
  const input = page.frameLocator(".document-pane:not([hidden]) iframe").getByRole("textbox");
  await input.fill("resize preserved");
  const frame = await page.locator("iframe").elementHandle();
  await page.setViewportSize({ width: 640, height: 640 });
  await expect(page.locator(".viewer-content")).toHaveCSS("visibility", "hidden");
  await page.setViewportSize({ width: 700, height: 640 });
  await expect(input).toBeVisible();
  await expect(input).toHaveValue("resize preserved");
  expect(await frame!.evaluate((element) => element === document.querySelector("iframe"))).toBe(
    true,
  );
});

test("hidden tabs and column moves preserve iframe input, JS heap and Canvas until close", async ({
  page,
}) => {
  await prepare(page);
  await openDocument(page);
  const firstPane = page
    .locator(".document-pane")
    .filter({ has: page.locator('iframe[title="Examples/0.html"]') });
  const firstFrame = page.frameLocator('iframe[title="Examples/0.html"]');
  await firstFrame.getByRole("textbox").fill("retained");
  await firstFrame.locator("#draw").click();
  const handle = await firstPane.locator("iframe").elementHandle();
  const originalUrl = await firstPane.locator("iframe").getAttribute("src");
  await openDocument(page, 1);
  await expect(firstPane).toBeHidden();
  await page.getByRole("tab", { name: "0.html", exact: true }).click();
  await expect(firstFrame.getByRole("textbox")).toHaveValue("retained");
  await moveToRight(page);
  await expect(page.locator(".document-pane:not([hidden]) iframe")).toHaveCount(2);
  const x = await firstPane.evaluate((element) => element.getBoundingClientRect().x);
  await page.getByRole("tab", { name: "0.html", exact: true }).press("Control+Shift+ArrowLeft");
  await expect(page.getByRole("tablist")).toHaveCount(1);
  expect(await firstPane.evaluate((element) => element.getBoundingClientRect().x)).not.toBe(x);
  await expect(firstFrame.getByRole("textbox")).toHaveValue("retained");
  expect(
    await handle!.evaluate(
      (element) => element === document.querySelector('iframe[title="Examples/0.html"]'),
    ),
  ).toBe(true);
  expect(
    await firstFrame.locator("canvas").evaluate((canvas) => ({
      count: (window as unknown as { runtimeState: { count: number } }).runtimeState.count,
      pixel: (canvas as HTMLCanvasElement).getContext("2d")!.getImageData(0, 0, 1, 1).data[0],
    })),
  ).toEqual({ count: 1, pixel: 51 });
  expect(await page.evaluate("window.layoutCalls.open")).toBe(2);
  await page.getByRole("button", { name: "Examples/0.htmlを閉じる", exact: true }).click();
  await expect(page.locator('iframe[title="Examples/0.html"]')).toHaveCount(0);
  expect(await page.evaluate("window.layoutCalls.close")).toBe(1);
  await tabAction(
    page,
    page.getByRole("tab", { name: "1.html", exact: true }),
    "閉じたタブを開き直す",
  );
  await expect(firstFrame.getByRole("textbox")).toHaveValue("initial");
  expect(await firstPane.locator("iframe").getAttribute("src")).not.toBe(originalUrl);
});

test("hidden updates require explicit reload and visible updates refresh both columns", async ({
  page,
}) => {
  await prepare(page);
  await openDocument(page);
  const first = page.frameLocator('iframe[title="Examples/0.html"]');
  await first.getByRole("textbox").fill("keep until reload");
  await openDocument(page, 1);
  await page.evaluate("window.layoutChange(['Examples/0.html'])");
  await expect(page.getByRole("tab", { name: /0.html/ }).getByLabel("更新あり")).toBeVisible();
  await page.getByRole("tab", { name: /0.html/ }).click();
  await expect(first.getByRole("textbox")).toHaveValue("keep until reload");
  expect(await page.evaluate("window.layoutCalls.open")).toBe(2);
  await tabAction(
    page,
    page.getByRole("tab", { name: /^0\.html/ }),
    "状態をリセットして再読み込み",
  );
  await expect(first.getByRole("textbox")).toHaveValue("initial");
  await expect(
    page.getByRole("tab", { name: "0.html", exact: true }).getByLabel("更新あり"),
  ).toHaveCount(0);
  await moveToRight(page);
  await first.getByRole("textbox").fill("reset on visible save");
  await page.evaluate("window.layoutChange(['shared.css'])");
  await expect.poll(() => page.evaluate("window.layoutCalls.open")).toBe(5);
  await expect(first.getByRole("textbox")).toHaveValue("initial");
});

for (const width of [320, 700]) {
  test(`two columns and tab keyboard navigation fit ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 640 });
    await prepare(page);
    await openDocument(page);
    await openDocument(page, 1);
    await page.getByRole("button", { name: "左メニューを閉じる" }).click();
    await moveToRight(page);
    await expect(page.locator(".document-pane:not([hidden]) iframe")).toHaveCount(2);
    const tab = page.getByRole("tab", { name: "0.html", exact: true });
    await tab.focus();
    await page.keyboard.press("End");
    await expect(tab).toBeFocused();
    await expect(page.getByRole("tablist")).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await expect(page.getByRole("button", { name: "左メニューを開く" })).toBeInViewport();
  });
}

test("interacting inside either opaque iframe selects the column used by tree selection", async ({
  page,
}) => {
  await prepare(page);
  await openDocument(page);
  await openDocument(page, 1);
  await moveToRight(page);
  const zero = page.frameLocator('iframe[title="Examples/0.html"]');
  const one = page.frameLocator('iframe[title="Examples/1.html"]');
  await zero.getByRole("textbox").fill("right focused");
  await expect(page.getByRole("tab", { name: "0.html", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await tabAction(
    page,
    page.getByRole("tab", { name: "0.html", exact: true }),
    "状態をリセットして再読み込み",
  );
  await expect(zero.getByRole("textbox")).toHaveValue("initial");
  await one.getByRole("textbox").fill("left focused");
  await expect(page.getByRole("tab", { name: "1.html", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await zero.getByRole("textbox").fill("switch frames");
  await expect(page.getByRole("tab", { name: "0.html", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await openDocument(page, 2);
  await expect(
    page
      .getByRole("tablist", { name: "右列の文書" })
      .getByRole("tab", { name: "2.html", exact: true }),
  ).toHaveCount(1);
  await one.getByRole("textbox").fill("select left");
  await openDocument(page, 3);
  await expect(
    page
      .getByRole("tablist", { name: "左列の文書" })
      .getByRole("tab", { name: "3.html", exact: true }),
  ).toHaveCount(1);
});

test("immediate iframe-to-tree selection targets the child that held focus", async ({ page }) => {
  await prepare(page);
  await openDocument(page);
  await openDocument(page, 1);
  await moveToRight(page);
  const zero = page.frameLocator('iframe[title="Examples/0.html"]');
  const one = page.frameLocator('iframe[title="Examples/1.html"]');
  for (let index = 0; index < 3; index++) {
    await one.getByRole("textbox").fill("left stays");
    await zero.getByRole("textbox").fill("right resets");
    // Intentionally do not wait for aria-selected or the focus interval.
    await openDocument(page, index + 2);
    await expect(
      page
        .getByRole("tablist", { name: "右列の文書" })
        .getByRole("tab", { name: `${index + 2}.html`, exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(one.getByRole("textbox")).toHaveValue("left stays");
    await page.getByRole("tab", { name: "0.html", exact: true }).click();
    await expect(zero.getByRole("textbox")).toHaveValue("right resets");
  }
});

for (const width of [1280, 700]) {
  test(`operation feedback leaves document geometry and live state unchanged at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await prepare(page);
    await openDocument(page, 0);
    await openDocument(page, 1);
    await moveToRight(page, 1);
    const frame = page.locator('iframe[title="Examples/0.html"]');
    const original = await frame.elementHandle();
    const body = frame.contentFrame().locator("body");
    await frame.contentFrame().getByRole("textbox").fill("feedback retains input");
    await frame.contentFrame().getByRole("button", { name: "Draw" }).click();
    await body.evaluate(() => {
      document.scrollingElement!.scrollTop = 200;
    });
    const before = await frame.boundingBox();
    const scroll = await body.evaluate(() => document.scrollingElement!.scrollTop);
    await page.evaluate("window.layoutActionDelay = 300");
    for (const failure of [false, true, false]) {
      await page.evaluate((value) => {
        (window as unknown as { layoutActionFailure: boolean }).layoutActionFailure = value;
      }, failure);
      await page.locator('[data-path="Examples"]').click({ button: "right" });
      await page.getByRole("menuitem", { name: "フルパスをコピー" }).click();
      await body.evaluate(() =>
        document.querySelector<HTMLInputElement>("input")!.focus({ preventScroll: true }),
      );
      await page.waitForTimeout(400);
      await expect(page.locator(".viewer-content .notice")).toHaveCount(0);
      expect(await frame.boundingBox()).toEqual(before);
      expect(await frame.evaluate((node, previous) => node === previous, original)).toBe(true);
      await expect(frame.contentFrame().getByRole("textbox")).toHaveValue("feedback retains input");
      expect(await body.evaluate(() => document.scrollingElement!.scrollTop)).toBe(scroll);
      expect(
        await body.evaluate(
          () => (window as unknown as { runtimeState: { count: number } }).runtimeState.count,
        ),
      ).toBe(1);
      expect(
        await body.evaluate(
          () =>
            document.querySelector("canvas")!.getContext("2d")!.getImageData(0, 0, 1, 1).data[3],
        ),
      ).toBe(255);
      await expect(frame.contentFrame().getByRole("textbox")).toBeFocused();
      if (failure)
        await expect(page.locator('.workspace-feedback [role="alert"]')).toContainText(
          "OS起動失敗",
        );
      else await expect(page.locator(".workspace-feedback")).toHaveCount(0);
    }
    await page.screenshot({ path: `.tools/operation-feedback-${width}.png` });
    await page.evaluate("window.layoutActionFailure = true");
    await page.locator('[data-path="Examples"]').click({ button: "right" });
    await page.getByRole("menuitem", { name: "フルパスをコピー" }).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `.tools/operation-failure-${width}.png` });
  });
}

test("file context menu is lazy, preserves preview, and dispatches only its target", async ({
  page,
}) => {
  await prepare(page);
  await openDocument(page);
  const frame = page.frameLocator('iframe[title="Examples/0.html"]');
  await frame.getByRole("textbox").fill("context preserves input");
  const calls = await page.evaluate("JSON.stringify(window.layoutCalls)");
  const target = page.locator('[data-path="Examples/1.html"]');
  for (let index = 0; index < 3; index++) {
    await target.click({ button: "right" });
    await expect(page.getByRole("menu")).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "お気に入りに追加" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tree")).toBeFocused();
  }
  expect(await page.evaluate("JSON.stringify(window.layoutCalls)")).toBe(calls);
  await target.click({ button: "right" });
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.locator(".viewer-content .notice")).toHaveCount(0);
  expect(await page.evaluate("window.layoutCalls.actions")).toEqual([
    { workspace: "layout", view: "view-layout", path: "Examples/1.html", action: "copyPath" },
  ]);
  expect(await page.evaluate("window.layoutCalls.open")).toBe(1);
  await expect(frame.getByRole("textbox")).toHaveValue("context preserves input");
  await page.getByRole("tree").press("Shift+F10");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator(".viewer-content .notice")).toHaveCount(0);
  expect(await page.evaluate("window.layoutCalls.actions[1].action")).toBe("openFolder");
  await page.getByRole("tree").press("Shift+F10");
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Space");
  await expect(page.locator(".viewer-content .notice")).toHaveCount(0);
  expect(await page.evaluate("window.layoutCalls.actions[2].action")).toBe("openBrowser");
});

test("App loads AI handoff on demand, retains the live HTML and dismisses a replaced root", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (/\/AiHandoffDialog\.tsx|\/ai-handoff\.css/.test(request.url()))
      requests.push(request.url());
  });
  await prepare(page);
  await openDocument(page);
  const frame = page.locator('iframe[title="Examples/0.html"]');
  const original = await frame.elementHandle();
  await frame.contentFrame().getByRole("textbox").fill("AI handoff retains input");
  await frame.contentFrame().getByRole("button", { name: "Draw" }).click();
  const target = page.locator('[data-path="Examples/1.html"]');
  await target.click({ button: "right" });
  expect(requests).toEqual([]);
  expect(await page.evaluate("window.layoutCalls.aiPrepare || []")).toEqual([]);
  await page.getByRole("menuitem", { name: "AIに渡す" }).click();
  const dialog = page.getByRole("dialog", { name: "AIに渡す" });
  await expect(dialog.getByRole("definition")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "依頼文をコピー" })).toBeEnabled();
  await expect(dialog.getByRole("textbox")).toHaveAccessibleDescription(
    /選択パスは依頼文に自動で含まれます/,
  );
  expect(requests.length).toBeGreaterThan(0);
  expect(await page.evaluate("window.layoutCalls.aiPrepare")).toEqual([
    { workspaceId: "layout", viewId: "view-layout", relativePath: "Examples/1.html" },
  ]);
  expect(await page.evaluate("window.layoutCalls.aiPerform || []")).toEqual([]);
  await dialog.getByRole("combobox", { name: "連携先" }).selectOption("codexCli");
  await dialog.getByRole("textbox", { name: "依頼文（任意）" }).fill("確認してください");
  await dialog.getByRole("button", { name: "依頼文をコピー" }).click();
  await expect(dialog.getByRole("status")).toContainText("依頼文をコピーしました");
  expect(await page.evaluate("window.layoutCalls.aiPerform")).toEqual([
    {
      context: { workspaceId: "layout", viewId: "view-layout", relativePath: "Examples/1.html" },
      preview: {
        kind: "file",
        selectedPath: "/knowledge/Examples/1.html",
        workingDirectory: "/knowledge/Examples",
        revision: 1,
      },
      instruction: "確認してください",
      destination: "codexCli",
      copy: true,
    },
  ]);
  await dialog.getByRole("button", { name: "閉じる" }).click();
  await expect(page.getByRole("tree")).toBeFocused();
  expect(await frame.evaluate((element, original) => element === original, original)).toBe(true);
  await expect(frame.contentFrame().getByRole("textbox")).toHaveValue("AI handoff retains input");
  expect(
    await frame
      .contentFrame()
      .getByRole("button", { name: "Draw" })
      .evaluate(
        () => (window as unknown as { runtimeState: { count: number } }).runtimeState.count,
      ),
  ).toBe(1);
  expect(await page.evaluate("window.layoutCalls.open")).toBe(1);
  expect(await page.evaluate("window.layoutCalls.mutations")).toEqual([]);
  await target.click({ button: "right" });
  await page.getByRole("menuitem", { name: "AIに渡す" }).click();
  await expect(dialog).toBeVisible();
  await page.evaluate(
    "window.layoutSearchSnapshot.workspaceId='replaced'; window.layoutSearchSnapshot.viewId='replaced-view'; window.layoutChange([],true);",
  );
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate("window.layoutCalls.aiPerform.length")).toBe(1);
});

test("file menu dismisses when focus moves into an opaque document iframe", async ({ page }) => {
  await prepare(page);
  await page.locator('[data-path="Examples/0.html"]').click();
  await page.locator('[data-path="Examples/1.html"]').click({ button: "right" });
  await expect(page.getByRole("menu")).toHaveCount(1);
  await page.frameLocator(".document-pane.active iframe").locator("input").click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("IFRAME");
  expect(await page.evaluate("window.layoutCalls.actions.length")).toBe(0);
  expect(await page.evaluate("window.layoutCalls.open")).toBe(1);
});

test("file menu dismisses on Tab, outside click, scrolling and handles OS failure", async ({
  page,
}) => {
  await prepare(page);
  const target = page.locator('[data-path="Examples/0.html"]');
  await target.click({ button: "right" });
  await page.keyboard.press("Tab");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.getByRole("tree")).toBeFocused();
  await page.getByRole("tree").press("Shift+F10");
  await page.locator(".titlebar").click({ position: { x: 3, y: 3 } });
  await expect(page.getByRole("menu")).toHaveCount(0);
  await target.click({ button: "right" });
  await page.getByRole("tree").evaluate((element) => {
    element.scrollTop = 360;
  });
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.getByRole("tree").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.evaluate("window.layoutActionFailure = true");
  await target.click({ button: "right" });
  await page.getByRole("menuitem", { name: "元フォルダーを開く" }).click();
  await expect(page.locator('.workspace-feedback [role="alert"]')).toContainText("OS起動失敗");
  expect(await page.evaluate("window.layoutCalls.open")).toBe(0);
});

for (const width of [320, 700]) {
  test(`file menu remains on screen and keyboard reachable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 640 });
    await prepare(page);
    const target = page.locator('[data-path="Examples/0.html"]');
    await target.scrollIntoViewIfNeeded();
    const row = await target.boundingBox();
    expect(row).not.toBeNull();
    // Use the visible row center vertically, near its right edge horizontally.
    // Search/status content can change where the virtualized tree begins.
    await target.click({ button: "right", position: { x: row!.width - 8, y: row!.height / 2 } });
    await expect(page.getByRole("menu")).toBeInViewport();
    const rect = await page.getByRole("menu").boundingBox();
    expect(rect!.x).toBeGreaterThanOrEqual(0);
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
    await page.keyboard.press("End");
    await expect(page.getByRole("menuitem", { name: "別フォルダーへ移動" })).toBeFocused();
    await page.keyboard.press("Home");
    await expect(page.getByRole("menuitem", { name: "左の列で開く" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tree")).toBeFocused();
  });
}

// Mutation tests use the same large, virtualized tree and a faithful bridge
// simulation. Native filesystem guarantees are covered separately by Rust/E2E.
test("creation icons stay in one row at sidebar limits and preserve keyboard targets and document state", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await prepare(page);
  await openDocument(page);
  const frame = page.locator('iframe[title="Examples/0.html"]');
  const original = await frame.elementHandle();
  await frame.contentFrame().getByRole("textbox").fill("creation icons preserve input");
  await frame.contentFrame().getByRole("button", { name: "Draw" }).click();
  const tools = page.locator(".tree-tools");
  const buttons = tools.getByRole("button");
  const names = ["HTMLを作成", "フォルダーを作成", "ルートにフォルダーを作成"];
  await expect(buttons).toHaveCount(3);
  const assertOneRow = async () => {
    const boxes = await buttons.evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }),
    );
    const bounds = await tools.boundingBox();
    expect(bounds!.height).toBe(48);
    for (const box of boxes) {
      expect(box.y).toBe(boxes[0].y);
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(36);
      expect(box.x + box.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
    }
    expect(await tools.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
  };
  const separator = page.getByRole("separator");
  for (const key of ["Home", "End", "Home"]) {
    await separator.focus();
    await separator.press(key);
    await expect(separator).toHaveAttribute("aria-valuenow", key === "End" ? "450" : "230");
    await assertOneRow();
  }
  for (const name of names) {
    await expect(tools.getByRole("button", { name, exact: true })).toHaveAttribute(
      "title",
      new RegExp(name),
    );
  }
  await buttons.nth(0).focus();
  await page.keyboard.press("Tab");
  await expect(buttons.nth(1)).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(buttons.nth(2)).toBeFocused();
  expect(await buttons.nth(2).evaluate((element) => getComputedStyle(element).outlineStyle)).toBe(
    "solid",
  );
  await page.screenshot({ path: test.info().outputPath("creation-icons-230.png") });
  const tree = page.getByRole("tree");
  for (const [index, name] of names.entries()) {
    await tree.press("Home");
    await tools.getByRole("button", { name, exact: true }).press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("textbox", { name: "名前" })).toBeFocused();
    if (index === 0) await expect(dialog).toContainText("作成先: Examples");
    else
      await expect(dialog.getByRole("combobox", { name: "作成先" })).toHaveValue(
        index === 2 ? "knowledge（ルート）" : "Examples",
      );
    await dialog.getByRole("textbox").fill(`icon-${index}`);
    await dialog.getByRole("button", { name: "作成する", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
  expect(await page.evaluate("window.layoutCalls.mutations")).toEqual([
    { kind: "createHtml", parent: "Examples", name: "icon-0" },
    { kind: "createFolder", parent: "Examples", name: "icon-1" },
    { kind: "createFolder", parent: "", name: "icon-2" },
  ]);
  expect(await frame.evaluate((element, original) => element === original, original)).toBe(true);
  await page.getByRole("tab", { name: "0.html", exact: true }).click();
  await expect(frame.contentFrame().getByRole("textbox")).toHaveValue(
    "creation icons preserve input",
  );
  expect(
    await frame
      .contentFrame()
      .getByRole("button", { name: "Draw" })
      .evaluate(
        () => (window as unknown as { runtimeState: { count: number } }).runtimeState.count,
      ),
  ).toBe(1);
  await page.setViewportSize({ width: 320, height: 640 });
  await assertOneRow();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await page.screenshot({ path: test.info().outputPath("creation-icons-320.png") });
  await page.emulateMedia({ forcedColors: "active" });
  await assertOneRow();
  await page.screenshot({ path: test.info().outputPath("creation-icons-forced-colors.png") });
});

test("creates Unicode HTML and folders with keyboard focus, cancellation and retry after Native failure", async ({
  page,
}) => {
  await prepare(page);
  const tree = page.getByRole("tree");
  await tree.press("Control+n");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toHaveAccessibleName("HTMLを作成");
  await expect(dialog.getByRole("textbox", { name: "名前" })).toBeFocused();
  await dialog.getByRole("textbox").fill("日本語 メモ");
  await page.evaluate("window.layoutMutationFailure = true");
  await dialog.getByRole("button", { name: "作成する" }).click();
  await expect(dialog.getByRole("alert")).toContainText("アクセス権");
  await expect(dialog.getByRole("textbox")).toBeFocused();
  await expect(page.locator("iframe")).toHaveCount(0);
  await page.evaluate("window.layoutMutationFailure = false");
  await dialog.getByRole("button", { name: "作成する" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('iframe[title="Examples/日本語 メモ.html"]')).toHaveCount(1);
  await expect(tree).toBeFocused();
  await expect(page.locator('[data-path="Examples/日本語 メモ.html"]')).toBeInViewport();
  await tree.press("Control+Shift+n");
  await expect(dialog).toHaveAccessibleName("フォルダーを作成");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate("window.layoutCalls.mutations.length")).toBe(2);
  await tree.press("Control+Shift+n");
  await dialog.getByRole("textbox").fill("資料");
  await dialog.getByRole("button", { name: "作成する" }).click();
  await expect(page.locator('[data-path="Examples/資料"]')).toBeInViewport();
  expect(await page.evaluate("window.layoutCalls.open")).toBe(1);
  expect(await page.evaluate("window.layoutCalls.actions")).toEqual([]);
  await tree.press("Shift+F10");
  await expect(
    page.getByRole("menuitem", { name: "このフォルダー内を検索", exact: true }),
  ).toBeFocused();
  await expect(page.getByRole("menuitem", { name: "HTMLを作成", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "フルパスをコピー" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "フォルダーを開く", exact: true })).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "既定ブラウザーで表示", exact: true }),
  ).toHaveCount(0);
});

test("10001-document drag hover makes no bridge calls and reorder preserves unrelated iframe state", async ({
  page,
}) => {
  await prepare(page);
  await openDocument(page, 0);
  const frame = page.frameLocator('iframe[title="Examples/0.html"]');
  await frame.getByRole("textbox").fill("unchanged on reorder");
  const before = await page.evaluate("JSON.stringify(window.layoutCalls)");
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  const source = page.locator('[data-path="Examples/2.html"]');
  const target = page.locator('[data-path="Examples/1.html"]');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const beforeMetrics = await cdp.send("Performance.getMetrics");
  await page.waitForTimeout(1000);
  const idleMetrics = await cdp.send("Performance.getMetrics");
  const started = Date.now();
  const handlers = await page.evaluate(async () => {
    const transfer = new DataTransfer();
    const source = document.querySelector<HTMLElement>('[data-path="Examples/2.html"]')!;
    const target = document.querySelector<HTMLElement>('[data-path="Examples/1.html"]')!;
    const start = performance.now();
    source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: transfer }));
    const startMs = performance.now() - start;
    const hoverMs: number[] = [];
    for (let i = 0; i < 20; i++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const start = performance.now();
      target.dispatchEvent(
        new DragEvent("dragover", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
          clientY: target.getBoundingClientRect().top + 2,
        }),
      );
      hoverMs.push(performance.now() - start);
    }
    return { startMs, hoverMs };
  });
  expect(await page.evaluate("JSON.stringify(window.layoutCalls)")).toBe(before);
  expect(await page.getByRole("treeitem").count()).toBeLessThan(50);
  const dropStarted = Date.now();
  await target.dispatchEvent("drop", { dataTransfer: transfer });
  await expect.poll(() => page.evaluate("window.layoutCalls.mutations.length")).toBe(1);
  expect(await page.evaluate("window.layoutCalls.mutations[0]")).toEqual({
    kind: "reorder",
    source: "Examples/2.html",
    anchor: "Examples/1.html",
    after: false,
  });
  await expect(frame.getByRole("textbox")).toHaveValue("unchanged on reorder");
  expect(await page.evaluate("window.layoutCalls.open")).toBe(1);
  await expect(page.getByRole("tree")).toHaveAttribute(
    "aria-activedescendant",
    "tree-Examples%2F2.html",
  );
  const names = await page
    .locator('[data-path^="Examples/"]')
    .evaluateAll((rows) => rows.slice(0, 3).map((row) => row.getAttribute("data-path")));
  expect(names).toEqual(["Examples/0.html", "Examples/2.html", "Examples/1.html"]);
  const afterMetrics = await cdp.send("Performance.getMetrics");
  const metric = (metrics: { metrics: { name: string; value: number }[] }, name: string) =>
    metrics.metrics.find((item) => item.name === name)?.value ?? 0;
  const report = {
    htmlFiles: 10001,
    ...handlers,
    dropIncludingDriverMs: Date.now() - dropStarted,
    rendererTaskMs:
      (metric(afterMetrics, "TaskDuration") - metric(idleMetrics, "TaskDuration")) * 1000,
    idleRendererTaskMsPerSecond:
      (metric(idleMetrics, "TaskDuration") - metric(beforeMetrics, "TaskDuration")) * 1000,
    jsHeapBeforeBytes: metric(beforeMetrics, "JSHeapUsedSize"),
    jsHeapAfterBytes: metric(afterMetrics, "JSHeapUsedSize"),
    scope:
      "Linux Chromium UI mock, includes layout/reorder; heap is renderer JS only, not Native/process-group memory",
  };
  console.log("ISSUE6_UI_PERF " + JSON.stringify(report));
  await test.info().attach("mutation-performance", {
    body: JSON.stringify(report, null, 2),
    contentType: "application/json",
  });
  test.info().annotations.push({
    type: "drag-20-hover-and-drop-ms",
    description: String(Date.now() - started),
  });
  await source.click({ button: "right" });
  await page.getByRole("menuitem", { name: "下へ並べ替え" }).click();
  await expect.poll(() => page.evaluate("window.layoutCalls.mutations.length")).toBe(2);
  await expect(frame.getByRole("textbox")).toHaveValue("unchanged on reorder");
});

const LONG_FOLDER_NAME = "長い日本語の移動先 ".repeat(4).trim();
async function addPickerFolders(page: Page) {
  const folders = [
    {
      name: "日本語",
      relativePath: "日本語",
      kind: "folder",
      children: [
        { name: "共通", relativePath: "日本語/共通", kind: "folder", children: [] },
        {
          name: LONG_FOLDER_NAME,
          relativePath: "日本語/" + LONG_FOLDER_NAME,
          kind: "folder",
          children: [],
        },
      ],
    },
    {
      name: "資料",
      relativePath: "資料",
      kind: "folder",
      children: [{ name: "共通", relativePath: "資料/共通", kind: "folder", children: [] }],
    },
    {
      name: "Source",
      relativePath: "Source",
      kind: "folder",
      children: [{ name: "child", relativePath: "Source/child", kind: "folder", children: [] }],
    },
    { name: "Source2", relativePath: "Source2", kind: "folder", children: [] },
  ];
  await page.evaluate(
    `window.layoutSearchSnapshot.nodes.push(...${JSON.stringify(folders)}); window.layoutChange([],true);`,
  );
  await page.getByRole("treeitem", { name: "Examples", exact: true }).click();
  await expect(page.getByRole("treeitem", { name: "日本語", exact: true })).toBeVisible();
}

test("folder destination picker filters same-name paths and preserves IME, cancel, retry and document state", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await prepare(page);
  await openDocument(page);
  const frame = page.locator('iframe[title="Examples/0.html"]');
  const original = await frame.elementHandle();
  await frame.contentFrame().getByRole("textbox").fill("kept folder picker input");
  await frame.contentFrame().getByRole("button", { name: "Draw" }).click();
  await addPickerFolders(page);
  await page.getByRole("button", { name: "ルートにフォルダーを作成", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const picker = dialog.getByRole("combobox", { name: "作成先" });
  await expect(picker).toHaveValue("knowledge（ルート）");
  const name = dialog.getByRole("textbox", { name: "名前" });
  await expect(name).toBeFocused();
  await name.fill("新しいフォルダー");
  const calls = await page.evaluate("JSON.stringify(window.layoutCalls)");
  await picker.click();
  await picker.fill("共通");
  await expect(dialog.getByRole("option")).toHaveText(["日本語/共通", "資料/共通"]);
  await picker.dispatchEvent("compositionstart", { data: "共通" });
  await picker.press("Enter");
  await expect(dialog.getByRole("listbox")).toBeVisible();
  await picker.dispatchEvent("compositionend", { data: "共通" });
  await picker.dispatchEvent("keydown", {
    key: "Enter",
    keyCode: 229,
    bubbles: true,
    cancelable: true,
  });
  await expect(dialog.getByRole("listbox")).toBeVisible();
  expect(await page.evaluate("JSON.stringify(window.layoutCalls)")).toBe(calls);
  await page.screenshot({ path: test.info().outputPath("folder-picker-create-1000.png") });
  await picker.press("ArrowDown");
  await picker.press("Enter");
  await expect(picker).toHaveValue("資料/共通");
  await picker.click();
  await picker.fill("../../unverified");
  await expect(dialog.getByRole("option")).toHaveCount(0);
  await expect(dialog.getByRole("status")).toContainText("該当するフォルダーがありません");
  await picker.press("Enter");
  expect(await page.evaluate("window.layoutCalls.mutations.length")).toBe(0);
  await picker.press("Escape");
  await expect(picker).toHaveValue("資料/共通");
  await dialog.getByRole("button", { name: "キャンセル" }).click();
  await page.getByRole("button", { name: "ルートにフォルダーを作成", exact: true }).click();
  await expect(picker).toHaveValue("knowledge（ルート）");
  await expect(name).toHaveValue("");
  await picker.fill("資料/共通");
  await picker.press("Enter");
  await name.fill("新しいフォルダー");
  await page.evaluate("window.layoutMutationFailure=true");
  await dialog.getByRole("button", { name: "作成する" }).click();
  await expect(dialog.getByRole("alert")).toContainText("アクセス権");
  await expect(name).toBeFocused();
  await expect(picker).toHaveValue("資料/共通");
  await page.evaluate("window.layoutMutationFailure=false");
  await dialog.getByRole("button", { name: "作成する" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-path="資料/共通/新しいフォルダー"]')).toBeInViewport();
  expect(await page.evaluate("window.layoutCalls.mutations")).toEqual(
    Array.from({ length: 2 }, () => ({
      kind: "createFolder",
      parent: "資料/共通",
      name: "新しいフォルダー",
    })),
  );
  expect(await frame.evaluate((element, original) => element === original, original)).toBe(true);
  await expect(frame.contentFrame().getByRole("textbox")).toHaveValue("kept folder picker input");
  expect(
    await frame
      .contentFrame()
      .getByRole("button", { name: "Draw" })
      .evaluate(
        () => (window as unknown as { runtimeState: { count: number } }).runtimeState.count,
      ),
  ).toBe(1);
  expect(await page.evaluate("window.layoutCalls.open")).toBe(1);
});

test("move destination picker excludes a folder's descendants and requires reselection after destination removal", async ({
  page,
}) => {
  await prepare(page);
  await openDocument(page);
  await addPickerFolders(page);
  const source = page.getByRole("treeitem", { name: "Source", exact: true });
  const open = async () => {
    await source.click({ button: "right" });
    await page.getByRole("menuitem", { name: "別フォルダーへ移動", exact: true }).click();
  };
  await open();
  const dialog = page.getByRole("dialog");
  const picker = dialog.getByRole("combobox", { name: "移動先" });
  await expect(picker).toBeFocused();
  await expect(picker).toHaveValue("knowledge（ルート）");
  await picker.fill("Source");
  await expect(dialog.getByRole("option")).toHaveText(["Source2"]);
  await picker.press("Enter");
  await dialog.getByRole("button", { name: "キャンセル" }).click();
  await open();
  await expect(picker).toHaveValue("knowledge（ルート）");
  await picker.fill("資料/共通");
  await picker.press("Enter");
  await page.evaluate(
    "window.layoutSearchSnapshot.nodes=window.layoutSearchSnapshot.nodes.filter(node=>node.relativePath!=='資料'); window.layoutChange([],true);",
  );
  await expect(dialog.getByRole("button", { name: "移動する" })).toBeDisabled();
  await expect(dialog.getByRole("alert")).toContainText("選び直してください");
  expect(await page.evaluate("window.layoutCalls.mutations.length")).toBe(0);
  await picker.fill("長い日本語");
  await page.setViewportSize({ width: 320, height: 640 });
  await expect(dialog.getByRole("option", { name: "日本語/" + LONG_FOLDER_NAME })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("folder-picker-move-320.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await picker.press("Enter");
  await dialog.getByRole("button", { name: "移動する" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate("window.layoutCalls.mutations")).toEqual([
    { kind: "move", source: "Source", parent: "日本語/" + LONG_FOLDER_NAME },
  ]);
  await expect(page.locator(`[data-path="日本語/${LONG_FOLDER_NAME}/Source"]`)).toBeInViewport();
  expect(await page.evaluate("window.layoutCalls.open")).toBe(1);
});

async function expectSurfaceTheme(surface: Locator, scheme: "light" | "dark") {
  await expect(surface).toHaveCSS("color-scheme", scheme);
  await expect(surface).toHaveCSS(
    "background-color",
    scheme === "dark" ? "rgb(37, 40, 44)" : "rgb(247, 249, 252)",
  );
  const contrast = await surface.evaluate((element) => {
    const luminance = (color: string) => {
      const rgb = color
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map(Number);
      const linear = rgb.map((value) => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    };
    const background = luminance(getComputedStyle(element).backgroundColor);
    return [
      element,
      ...element.querySelectorAll(
        "button, input, textarea, select, small, h2, [role='alert'], .mutation-warning, .context-file-name, .tab-context-name",
      ),
    ].map((target) => {
      let parent: Element | null = target;
      while (parent && getComputedStyle(parent).backgroundColor === "rgba(0, 0, 0, 0)")
        parent = parent.parentElement;
      const fill = parent ? luminance(getComputedStyle(parent).backgroundColor) : background;
      const text = luminance(getComputedStyle(target).color);
      return {
        disabled: target.matches(":disabled, [aria-disabled='true']"),
        ratio: (Math.max(text, fill) + 0.05) / (Math.min(text, fill) + 0.05),
      };
    });
  });
  expect(contrast.every(({ ratio, disabled }) => ratio >= (disabled ? 3 : 4.5))).toBe(true);
}

test("app menus and destination popup follow theme changes while open without changing HTML state", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await prepare(page);
  await openDocument(page);
  const frame = page.locator('iframe[title="Examples/0.html"]');
  const original = await frame.elementHandle();
  await frame.contentFrame().getByRole("textbox").fill("kept theme input");
  await frame.contentFrame().getByRole("button", { name: "Draw" }).click();
  const htmlStyle = await frame
    .contentFrame()
    .locator("body")
    .evaluate((body) => ({
      background: getComputedStyle(body).backgroundColor,
      color: getComputedStyle(body).color,
      styles: body.ownerDocument.querySelectorAll("style").length,
    }));
  const calls = await page.evaluate("JSON.stringify(window.layoutCalls)");
  for (const target of ["file", "tab"] as const) {
    await page.emulateMedia({ colorScheme: "light" });
    if (target === "file")
      await page.getByRole("treeitem", { name: "0 HTML", exact: true }).click({ button: "right" });
    else await page.getByRole("tab").click({ button: "right" });
    const menu = page.getByRole("menu");
    const element = await menu.elementHandle();
    for (const scheme of ["light", "dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await expectSurfaceTheme(menu, scheme);
      const enabled = menu.locator("button:not(:disabled)").first();
      await enabled.focus();
      await enabled.hover();
      await expect(enabled).toHaveCSS("outline-style", "solid");
      await expect(enabled).toHaveCSS(
        "background-color",
        scheme === "dark" ? "rgb(56, 63, 71)" : "rgb(225, 235, 230)",
      );
      await expectSurfaceTheme(menu, scheme);
      expect(await menu.evaluate((current, original) => current === original, element)).toBe(true);
      if (target === "file")
        await page.screenshot({ path: test.info().outputPath(`app-file-menu-${scheme}.png`) });
    }
    if (target === "tab") {
      const disabled = menu.getByRole("menuitem", { name: "右側のタブを全て閉じる", exact: true });
      await expect(disabled).toBeDisabled();
      await disabled.hover();
      await expect(disabled).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(disabled).toHaveCSS("opacity", "1");
    }
    await page.keyboard.press("Escape");
  }
  expect(await page.evaluate("JSON.stringify(window.layoutCalls)")).toBe(calls);
  await addPickerFolders(page);
  await page.getByRole("treeitem", { name: "Source", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "別フォルダーへ移動", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const picker = dialog.getByRole("combobox", { name: "移動先" });
  await picker.fill("日本語");
  await page.setViewportSize({ width: 320, height: 640 });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expectSurfaceTheme(dialog, scheme);
    await expectSurfaceTheme(page.locator(".folder-picker-popup"), scheme);
    await expect(picker).toHaveValue("日本語");
    await expect(picker).toBeFocused();
    await expect(picker).toHaveCSS(
      "background-color",
      scheme === "dark" ? "rgb(28, 31, 35)" : "rgb(255, 255, 255)",
    );
    await expect(dialog.getByRole("option").first()).toHaveCSS(
      "background-color",
      scheme === "dark" ? "rgb(50, 73, 75)" : "rgb(215, 236, 227)",
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    await page.screenshot({ path: test.info().outputPath(`app-folder-picker-${scheme}-320.png`) });
  }
  await page.emulateMedia({ forcedColors: "active" });
  // Forced-colors overrides the computed color-scheme to light dark in the UA.
  await expect(dialog).toHaveCSS("color-scheme", "light dark");
  const system = await dialog.evaluate((element) => {
    const probe = document.createElement("span");
    probe.style.background = "Canvas";
    element.append(probe);
    const result = [
      getComputedStyle(element).backgroundColor,
      getComputedStyle(probe).backgroundColor,
    ];
    probe.remove();
    return result;
  });
  expect(system[0]).toBe(system[1]);
  await page.emulateMedia({ forcedColors: "none" });
  await picker.press("Escape");
  await dialog.getByRole("button", { name: "キャンセル" }).click();
  expect(await frame.evaluate((element, original) => element === original, original)).toBe(true);
  await expect(frame.contentFrame().getByRole("textbox")).toHaveValue("kept theme input");
  expect(
    await frame
      .contentFrame()
      .getByRole("button", { name: "Draw" })
      .evaluate(
        () => (window as unknown as { runtimeState: { count: number } }).runtimeState.count,
      ),
  ).toBe(1);
  expect(
    await frame
      .contentFrame()
      .locator("body")
      .evaluate((body) => ({
        background: getComputedStyle(body).backgroundColor,
        color: getComputedStyle(body).color,
        styles: body.ownerDocument.querySelectorAll("style").length,
      })),
  ).toEqual(htmlStyle);
  expect(await page.evaluate("window.layoutCalls.open")).toBe(1);
  expect(await page.evaluate("window.layoutCalls.mutations.length")).toBe(0);
});

test("app dialogs and reusable controls share light and dark palettes with native select scheme", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await prepare(page, false, false, undefined, true, true, true, true, true);
  await openDocument(page);
  const switchOpen = async (surface: Locator, screenshot?: string) => {
    const original = await surface.elementHandle();
    for (const scheme of ["light", "dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await expectSurfaceTheme(surface, scheme);
      expect(await surface.evaluate((element, original) => element === original, original)).toBe(
        true,
      );
      if (screenshot)
        await page.screenshot({ path: test.info().outputPath(`${screenshot}-${scheme}.png`) });
    }
  };
  await page.getByRole("tab").focus();
  await page.keyboard.press("Control+p");
  await switchOpen(page.getByRole("dialog", { name: "クイックオープン" }));
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "作業セット", exact: true }).click();
  await switchOpen(page.getByRole("dialog", { name: "作業セット" }));
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "機能と使い方", exact: true }).click();
  const helpContent = page.locator(".app-help-frame").contentFrame();
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(helpContent.locator("body")).toHaveCSS(
      "background-color",
      colorScheme === "dark" ? "rgb(37, 40, 44)" : "rgb(247, 249, 252)",
    );
  }
  await page.getByRole("button", { name: "機能と使い方を閉じる", exact: true }).click();
  await page.getByRole("treeitem", { name: "0 HTML", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "保存済み入力を取り込む", exact: true }).click();
  const transfer = page.getByRole("dialog", { name: "保存済み入力を取り込む" });
  await transfer.getByRole("button", { name: "新しいbackup先を選ぶ" }).click();
  await switchOpen(transfer);
  const executeTransfer = transfer.getByRole("button", { name: "確認した内容で取り込む" });
  await expect(executeTransfer).toBeDisabled();
  await page.emulateMedia({ forcedColors: "active" });
  const disabledPair = await executeTransfer.evaluate((button) => {
    const probe = document.createElement("span");
    probe.style.color = "GrayText";
    button.after(probe);
    const colors = [getComputedStyle(button).color, getComputedStyle(probe).color];
    probe.remove();
    return colors;
  });
  expect(disabledPair[0]).toBe(disabledPair[1]);
  await page.emulateMedia({ forcedColors: "none" });
  await transfer.getByRole("button", { name: "取消", exact: true }).click();
  await transfer.getByRole("button", { name: "閉じる", exact: true }).click();
  const frame = page.locator('iframe[title="Examples/0.html"]');
  await frame
    .contentFrame()
    .locator("body")
    .evaluate((body) => {
      const link = document.createElement("a");
      link.href = "https://example.com/theme";
      link.textContent = "Theme external link";
      body.prepend(link);
    });
  await frame.contentFrame().getByRole("link", { name: "Theme external link" }).click();
  const external = page.getByRole("dialog", { name: "外部リンクを開く" });
  await switchOpen(external);
  await external.getByRole("button", { name: "キャンセル" }).click();
  await page.getByRole("button", { name: "文書検索", exact: true }).click();
  await page.getByRole("button", { name: "検索の詳細設定" }).click();
  const searchMode = page.locator(".search-settings");
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(searchMode).toHaveCSS("color-scheme", scheme);
    await expect(searchMode).toHaveCSS(
      "background-color",
      scheme === "dark" ? "rgb(37, 40, 44)" : "rgb(247, 249, 252)",
    );
  }
  // Isolated markup exercises the shared class for the future AI handoff dialog.
  await page.evaluate(() => {
    const dialog = document.createElement("dialog");
    dialog.className = "app-surface";
    dialog.setAttribute("aria-label", "共通配色fixture");
    dialog.innerHTML =
      '<label>依頼<textarea disabled></textarea></label><label>選択<select disabled><option>Codex</option><option>Claude</option></select></label><input aria-label="操作中" aria-disabled="true" readonly><input aria-label="入力可能"><button disabled>実行</button>';
    document.body.append(dialog);
    dialog.showModal();
  });
  const fixture = page.getByRole("dialog", { name: "共通配色fixture" });
  await switchOpen(fixture);
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const control of await fixture.locator("textarea, select, input").all()) {
      await expect(control).toHaveCSS("color-scheme", scheme);
      await expect(control).toHaveCSS(
        "background-color",
        scheme === "dark" ? "rgb(28, 31, 35)" : "rgb(255, 255, 255)",
      );
    }
    for (const control of await fixture.locator(':disabled, [aria-disabled="true"]').all()) {
      await expect(control).toHaveCSS(
        "color",
        scheme === "dark" ? "rgb(163, 172, 183)" : "rgb(105, 117, 128)",
      );
    }
  }
  await page.emulateMedia({ forcedColors: "active" });
  const fieldPair = await fixture.getByRole("textbox", { name: "入力可能" }).evaluate((input) => {
    const probe = document.createElement("input");
    probe.style.color = "FieldText";
    probe.style.background = "Field";
    input.after(probe);
    const result = [input, probe].map((element) => ({
      color: getComputedStyle(element).color,
      background: getComputedStyle(element).backgroundColor,
    }));
    probe.remove();
    return result;
  });
  expect(fieldPair[0]).toEqual(fieldPair[1]);
  await page.emulateMedia({ forcedColors: "none" });
  await fixture.evaluate((element) => element.remove());
  expect(await page.evaluate("window.layoutCalls.open")).toBe(1);
  expect(await page.evaluate("window.layoutCalls.transferConfirm?.length || 0")).toBe(0);
  expect(await page.evaluate("window.layoutCalls.external?.length || 0")).toBe(0);
});

test("cross-folder move confirms relative-link warning and follows an open tab, with cancel preserving original", async ({
  page,
}) => {
  await prepare(page);
  await openDocument(page, 0);
  const source = page.locator('[data-path="Examples/0.html"]');
  await source.click({ button: "right" });
  await page.getByRole("menuitem", { name: "別フォルダーへ移動" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("相対参照");
  await dialog.getByRole("combobox", { name: "移動先" }).fill("Target");
  await dialog.getByRole("option", { name: "Target", exact: true }).click();
  await dialog.getByRole("button", { name: "キャンセル" }).click();
  expect(await page.evaluate("window.layoutCalls.mutations.length")).toBe(0);
  await expect(page.locator('iframe[title="Examples/0.html"]')).toHaveCount(1);
  await source.click({ button: "right" });
  await page.getByRole("menuitem", { name: "別フォルダーへ移動" }).click();
  await dialog.getByRole("combobox").fill("Target");
  await dialog.getByRole("option", { name: "Target", exact: true }).click();
  await dialog.getByRole("button", { name: "移動する" }).click();
  await expect(page.locator('iframe[title="Target/0.html"]')).toHaveCount(1);
  await expect(page.locator('iframe[title="Examples/0.html"]')).toHaveCount(0);
  await expect(page.locator('[data-path="Target/0.html"]')).toBeInViewport();
  await expect(page.getByRole("tree")).toBeFocused();
  expect(await page.evaluate("window.layoutCalls.open")).toBe(2);
  expect(await page.evaluate("window.layoutCalls.actions.length")).toBe(0);
});

test("the same HTML opens independently in each column and closing the final right tab collapses", async ({
  page,
}) => {
  await prepare(page);
  await openDocument(page);
  const original = page.locator('iframe[title="Examples/0.html"]');
  const originalHandle = await original.elementHandle();
  await page.frameLocator('iframe[title="Examples/0.html"]').getByRole("textbox").fill("left only");
  await tabAction(page, page.getByRole("tab", { name: "0.html", exact: true }), "右の列で開く");
  const left = page
    .getByRole("tablist", { name: "左列の文書" })
    .getByRole("tab", { name: "0.html", exact: true });
  const right = page
    .getByRole("tablist", { name: "右列の文書" })
    .getByRole("tab", { name: "0.html", exact: true });
  const leftPanel = "#" + (await left.getAttribute("aria-controls"));
  const rightPanel = "#" + (await right.getAttribute("aria-controls"));
  const leftInput = page.frameLocator(`${leftPanel} iframe`).getByRole("textbox");
  const rightInput = page.frameLocator(`${rightPanel} iframe`).getByRole("textbox");
  await expect(rightInput).toHaveValue("initial");
  await rightInput.fill("right only");
  await expect(leftInput).toHaveValue("left only");
  expect(await page.locator(`${leftPanel} iframe`).getAttribute("src")).not.toBe(
    await page.locator(`${rightPanel} iframe`).getAttribute("src"),
  );
  await tabAction(page, right, "右の列で開く");
  await expect(page.getByRole("tab")).toHaveCount(2);
  expect(await page.evaluate("window.layoutCalls.open")).toBe(2);
  await tabAction(page, right, "状態をリセットして再読み込み");
  await expect(rightInput).toHaveValue("initial");
  await expect(leftInput).toHaveValue("left only");
  await right.focus();
  await right.press("Control+w");
  await expect(page.getByRole("tablist")).toHaveCount(1);
  await expect(page.getByRole("tab", { name: "0.html", exact: true })).toBeFocused();
  await expect(leftInput).toHaveValue("left only");
  expect(
    await originalHandle!.evaluate(
      (element, selector) => element === document.querySelector(selector),
      `${leftPanel} iframe`,
    ),
  ).toBe(true);
  await tabAction(
    page,
    page.getByRole("tab", { name: "0.html", exact: true }),
    "閉じたタブを開き直す",
  );
  await expect(
    page
      .getByRole("tablist", { name: "右列の文書" })
      .getByRole("tab", { name: "0.html", exact: true }),
  ).toHaveCount(1);
  await expect(leftInput).toHaveValue("left only");
  expect(await page.evaluate("window.layoutCalls.open")).toBe(4);
});

test("hidden tabs keep a column populated and reopening restores an empty left column", async ({
  page,
}) => {
  await prepare(page);
  for (const index of [0, 1, 2]) await openDocument(page, index);
  await moveToRight(page, 1);
  await moveToRight(page, 2);
  await page.getByRole("tab", { name: "2.html", exact: true }).press("Control+w");
  await expect(page.getByRole("tablist")).toHaveCount(2);
  await expect(
    page
      .getByRole("tablist", { name: "右列の文書" })
      .getByRole("tab", { name: "1.html", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  const retained = await page.locator('iframe[title="Examples/1.html"]').elementHandle();
  await page
    .frameLocator('iframe[title="Examples/1.html"]')
    .getByRole("textbox")
    .fill("surviving right");
  const left = page.getByRole("tab", { name: "0.html", exact: true });
  await left.focus();
  await left.press("Control+w");
  await expect(page.getByRole("tablist")).toHaveCount(1);
  await tabAction(
    page,
    page.getByRole("tab", { name: "1.html", exact: true }),
    "閉じたタブを開き直す",
  );
  await expect(
    page
      .getByRole("tablist", { name: "左列の文書" })
      .getByRole("tab", { name: "0.html", exact: true }),
  ).toHaveCount(1);
  await expect(
    page
      .getByRole("tablist", { name: "右列の文書" })
      .getByRole("tab", { name: "1.html", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.frameLocator('iframe[title="Examples/1.html"]').getByRole("textbox"),
  ).toHaveValue("surviving right");
  expect(
    await retained!.evaluate(
      (element) => element === document.querySelector('iframe[title="Examples/1.html"]'),
    ),
  ).toBe(true);
});

test("drag-only split target and cross-column drops preserve live frames without bridge work", async ({
  page,
}) => {
  await prepare(page);
  await openDocument(page);
  await openDocument(page, 1);
  const zeroFrame = await page.locator('iframe[title="Examples/0.html"]').elementHandle();
  await page.getByRole("tab", { name: "0.html", exact: true }).click();
  await page
    .frameLocator('iframe[title="Examples/0.html"]')
    .getByRole("textbox")
    .fill("drag preserved");
  const calls = await page.evaluate("JSON.stringify(window.layoutCalls)");
  await expect(page.locator(".tab-split-drop-target")).toHaveCount(0);
  const zeroItem = page.getByRole("tab", { name: "0.html", exact: true }).locator("..");
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await zeroItem.dispatchEvent("dragstart", { dataTransfer: transfer });
  await expect(page.locator(".tab-split-drop-target")).toBeVisible();
  await expect(page.locator(".document-pane:not([hidden]) iframe")).toHaveCount(1);
  await page
    .locator(".tab-split-drop-target")
    .dispatchEvent("dragover", { dataTransfer: transfer });
  await page.locator(".tab-split-drop-target").dispatchEvent("drop", { dataTransfer: transfer });
  await expect(page.getByRole("tablist")).toHaveCount(2);
  await expect(page.locator(".tab-split-drop-target")).toHaveCount(0);
  await expect(
    page.frameLocator('iframe[title="Examples/0.html"]').getByRole("textbox"),
  ).toHaveValue("drag preserved");
  const oneItem = page.getByRole("tab", { name: "1.html", exact: true }).locator("..");
  const rect = await zeroItem.boundingBox();
  await oneItem.dragTo(zeroItem, { targetPosition: { x: 2, y: rect!.height / 2 } });
  await expect(page.getByRole("tablist")).toHaveCount(1);
  await expect(page.getByRole("tab")).toHaveText(["1.html", "0.html"]);
  expect(
    await zeroFrame!.evaluate(
      (element) => element === document.querySelector('iframe[title="Examples/0.html"]'),
    ),
  ).toBe(true);
  expect(await page.evaluate("JSON.stringify(window.layoutCalls)")).toBe(calls);
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`sidebar separator keeps a thin ${colorScheme} line and full grab area without taking document space`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.emulateMedia({ colorScheme });
    await prepare(page);
    await openDocument(page);
    const frame = page.locator('iframe[title="Examples/0.html"]');
    const original = await frame.elementHandle();
    const input = frame.contentFrame().getByRole("textbox");
    await input.fill("thin separator input");
    await frame.contentFrame().getByRole("button", { name: "Draw" }).click();
    const htmlBorder = await frame
      .contentFrame()
      .locator("body")
      .evaluate((body) => getComputedStyle(body).border);
    const calls = await page.evaluate("JSON.stringify(window.layoutCalls)");
    const separator = page.getByRole("separator", { name: "左メニューの幅" });
    const line = () =>
      separator.evaluate((element) => {
        const style = getComputedStyle(element, "::after");
        return { width: style.width, background: style.backgroundColor };
      });
    await page.mouse.move(900, 600);
    expect(await line()).toEqual({
      width: "1px",
      background: colorScheme === "light" ? "rgb(140, 154, 168)" : "rgb(105, 115, 126)",
    });
    const box = (await separator.boundingBox())!;
    const sidebar = (await page.locator(".sidebar").boundingBox())!;
    const content = (await page.locator(".content").boundingBox())!;
    const tree = (await page.getByRole("tree").boundingBox())!;
    expect(box.width).toBe(6);
    expect(content.x - sidebar.x - sidebar.width).toBe(1);
    expect(tree.x + tree.width).toBeLessThan(box.x);
    expect(
      await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.classList.contains("sidebar-separator"),
        { x: box.x + 0.5, y: box.y + box.height / 2 },
      ),
    ).toBe(true);
    expect(
      await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.classList.contains("sidebar-separator"),
        { x: box.x + box.width - 0.5, y: box.y + box.height / 2 },
      ),
    ).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`sidebar-separator-${colorScheme}.png`) });
    await page.mouse.move(box.x + 0.5, box.y + box.height / 2);
    const activeColor = colorScheme === "light" ? "rgb(40, 123, 101)" : "rgb(155, 217, 198)";
    expect(await line()).toEqual({ width: "1px", background: activeColor });
    await separator.focus();
    await separator.press("Home");
    await page.mouse.move(900, 600);
    await expect(separator).toHaveAttribute("aria-valuenow", "230");
    await expect(separator).toHaveCSS("outline-width", "1px");
    expect(await line()).toEqual({ width: "1px", background: activeColor });
    await page.screenshot({
      path: test.info().outputPath(`sidebar-separator-${colorScheme}-focus.png`),
    });
    const minimum = (await separator.boundingBox())!;
    // Grab the transparent sidebar-side edge rather than the one-pixel visible line.
    await page.mouse.move(minimum.x + 0.5, minimum.y + minimum.height / 2);
    await page.mouse.down();
    await expect(page.locator(".app")).toHaveAttribute("data-resizing", "true");
    await expect(frame).toHaveCSS("pointer-events", "none");
    // Begin a continuous drag on the host surface before crossing the iframe.
    await page.mouse.move(minimum.x + 1.5, minimum.y + minimum.height / 2);
    await page.mouse.move(900, minimum.y + minimum.height / 2, { steps: 12 });
    await expect(page.locator(".app")).toHaveAttribute("data-resizing", "true");
    await expect(separator).toHaveAttribute("aria-valuenow", "450");
    await expect(frame).toHaveCSS("pointer-events", "none");
    expect(await line()).toEqual({ width: "1px", background: activeColor });
    await page.screenshot({
      path: test.info().outputPath(`sidebar-separator-${colorScheme}-drag.png`),
    });
    await page.mouse.up();
    await expect(page.locator(".app")).toHaveAttribute("data-resizing", "false");
    await expect(frame).toHaveCSS("pointer-events", "auto");
    await page.setViewportSize({ width: 700, height: 700 });
    await expect(separator).toHaveAttribute("aria-valuenow", "379");
    await expect(page.locator(".content")).toHaveCSS("width", "320px");
    const maximum = (await separator.boundingBox())!;
    await page.mouse.move(maximum.x + maximum.width - 0.5, maximum.y + maximum.height / 2);
    await page.mouse.down();
    await expect(page.locator(".app")).toHaveAttribute("data-resizing", "true");
    await page.mouse.move(maximum.x + maximum.width - 1.5, maximum.y + maximum.height / 2);
    await page.mouse.move(0, maximum.y + maximum.height / 2, { steps: 12 });
    await expect(separator).toHaveAttribute("aria-valuenow", "230");
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(separator).toHaveAttribute("aria-valuenow", "379");
    await expect(page.locator(".app")).toHaveAttribute("data-resizing", "false");
    expect(await frame.evaluate((element, original) => element === original, original)).toBe(true);
    await expect(input).toHaveValue("thin separator input");
    expect(
      await frame
        .contentFrame()
        .getByRole("button", { name: "Draw" })
        .evaluate(
          () => (window as unknown as { runtimeState: { count: number } }).runtimeState.count,
        ),
    ).toBe(1);
    expect(
      await frame
        .contentFrame()
        .locator("body")
        .evaluate((body) => getComputedStyle(body).border),
    ).toBe(htmlBorder);
    expect(await page.evaluate("JSON.stringify(window.layoutCalls)")).toBe(calls);
  });
}

test("explicit sidebar resizing clamps widths and preserves frames, tree and search work", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await prepare(page);
  await openDocument(page);
  await openDocument(page, 1);
  await page.getByRole("tab", { name: "0.html", exact: true }).click();
  const frame = await page.locator('iframe[title="Examples/0.html"]').elementHandle();
  const input = page.frameLocator('iframe[title="Examples/0.html"]').getByRole("textbox");
  await input.fill("sidebar resized");
  const tree = page.getByRole("tree");
  await tree.evaluate((element) => {
    element.scrollTop = 720;
  });
  const calls = await page.evaluate("JSON.stringify(window.layoutCalls)");
  const separator = page.getByRole("separator");
  await expect(separator).toHaveAttribute("aria-orientation", "vertical");
  await separator.focus();
  await separator.press("End");
  await expect(separator).toHaveAttribute("aria-valuenow", "450");
  await separator.press("Home");
  await expect(separator).toHaveAttribute("aria-valuenow", "230");
  const box = await separator.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await expect(page.locator(".app")).toHaveAttribute("data-resizing", "true");
  await expect(page.locator(".document-pane:not([hidden]) iframe")).toHaveCSS(
    "pointer-events",
    "none",
  );
  await page.mouse.move(box!.x + box!.width / 2 + 1, box!.y + box!.height / 2);
  await page.mouse.move(400, box!.y + box!.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => Number(await separator.getAttribute("aria-valuenow")))
    .toBeGreaterThan(350);
  const resizedWidth = await separator.getAttribute("aria-valuenow");
  await separator.focus();
  await separator.press("Control+Shift+ArrowRight");
  await expect(page.getByRole("tablist", { name: "右列の文書" }).getByRole("tab")).toHaveCount(1);
  await expect(
    page
      .getByRole("tablist", { name: "右列の文書" })
      .getByRole("tab", { name: "0.html", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page
      .getByRole("tablist", { name: "左列の文書" })
      .getByRole("tab", { name: "1.html", exact: true }),
  ).toHaveCount(1);
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(page.locator(".document-pane:not([hidden]) iframe")).toHaveCount(2);
  await expect(separator).toHaveAttribute("aria-valuenow", resizedWidth!);
  await expect(input).toHaveValue("sidebar resized");
  expect(
    await frame!.evaluate(
      (element) => element === document.querySelector('iframe[title="Examples/0.html"]'),
    ),
  ).toBe(true);
  expect(await page.evaluate("JSON.stringify(window.layoutCalls)")).toBe(calls);
  await separator.focus();
  await separator.press("Control+Shift+ArrowLeft");
  await expect(page.getByRole("tablist")).toHaveCount(1);
  await expect(page.getByRole("tab", { name: "0.html", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(separator).toHaveAttribute("aria-valuenow", resizedWidth!);
  await expect(input).toHaveValue("sidebar resized");
  expect(await tree.evaluate((element) => element.scrollTop)).toBe(720);
  await page.getByRole("button", { name: "文書検索", exact: true }).click();
  await page.getByRole("searchbox").fill("html");
  await expect(page.getByRole("button", { name: "次の20件" })).toBeVisible();
  const searchScrollbox = page.locator(".document-search");
  expect(
    await searchScrollbox.evaluate((element) => element.scrollHeight > element.clientHeight),
  ).toBe(true);
  const searchBox = (await searchScrollbox.boundingBox())!;
  const resizeBox = (await separator.boundingBox())!;
  expect(searchBox.x + searchBox.width).toBeLessThan(resizeBox.x);
  await page.mouse.move(searchBox.x + searchBox.width - 1, searchBox.y + searchBox.height / 2);
  await page.mouse.wheel(0, 240);
  await expect
    .poll(() => searchScrollbox.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await expect(page.locator(".app")).toHaveAttribute("data-resizing", "false");
  await expect(separator).toHaveAttribute("aria-valuenow", resizedWidth!);
  const searchCalls = await page.evaluate("JSON.stringify(window.layoutSearchCalls)");
  await separator.focus();
  await separator.press("End");
  await expect(page.getByRole("searchbox")).toHaveValue("html");
  expect(await page.evaluate("JSON.stringify(window.layoutSearchCalls)")).toBe(searchCalls);
  await page.setViewportSize({ width: 700, height: 800 });
  await expect
    .poll(async () => (await page.locator(".sidebar").boundingBox())!.width)
    .toBeLessThanOrEqual(380);
  await expect
    .poll(async () => (await page.locator(".content").boundingBox())!.width)
    .toBeGreaterThanOrEqual(320);
  await page.setViewportSize({ width: 640, height: 800 });
  await expect(separator).toBeHidden();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: "ファイル", exact: true }).click();
  await expect(input).toHaveValue("sidebar resized");
  expect(
    await frame!.evaluate(
      (element) => element === document.querySelector('iframe[title="Examples/0.html"]'),
    ),
  ).toBe(true);
  expect(await page.evaluate("JSON.stringify(window.layoutCalls)")).toBe(calls);
});

test("repeated keyboard and Native search focus preserves query and pagination without new requests", async ({
  page,
}) => {
  await prepare(page);
  await page.getByRole("button", { name: "左メニューを閉じる" }).click();
  await page.keyboard.press("Control+Shift+f");
  const query = page.getByRole("searchbox");
  await expect(query).toBeFocused();
  await query.fill("html");
  const results = page.locator(".search-results");
  await expect(results.getByRole("button")).toHaveCount(20);
  const firstPagePath = await results.getByRole("button").first().getAttribute("title");
  await page.getByRole("button", { name: "次の20件" }).click();
  await expect(results.getByRole("button").first()).not.toHaveAttribute("title", firstPagePath!);
  await expect(results.getByRole("button")).toHaveCount(20);
  const paths = await results
    .getByRole("button")
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("title")));
  const calls = await page.evaluate("JSON.stringify(window.layoutSearchCalls)");
  for (let index = 0; index < 3; index++) {
    await page.getByRole("button", { name: "文書検索", exact: true }).focus();
    await page.keyboard.press("Control+Shift+f");
    await expect(query).toBeFocused();
    await page.getByRole("button", { name: "文書検索", exact: true }).focus();
    await page.evaluate("window.layoutNativeCommand('focus-search')");
    await expect(query).toBeFocused();
  }
  await expect(query).toHaveValue("html");
  expect(
    await results
      .getByRole("button")
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("title"))),
  ).toEqual(paths);
  expect(await page.evaluate("JSON.stringify(window.layoutSearchCalls)")).toBe(calls);
});

test("HTML basename rename follows open and closed tabs, search results and grants", async ({
  page,
}) => {
  await prepare(page);
  await openDocument(page);
  const oldUrl = await page.locator("iframe").getAttribute("src");
  await tabAction(page, page.getByRole("tab", { name: "0.html", exact: true }), "右の列で開く");
  const right = page
    .getByRole("tablist", { name: "右列の文書" })
    .getByRole("tab", { name: "0.html", exact: true });
  await right.focus();
  await right.press("Control+w");
  await page.getByRole("button", { name: "文書検索", exact: true }).click();
  await page.getByRole("searchbox").fill("0.html");
  await expect(page.locator('.search-results button[title="Examples/0.html"]')).toBeVisible();
  await page.getByRole("button", { name: "ファイル", exact: true }).click();
  const row = page.locator('[data-path="Examples/0.html"]');
  await expect(row).toHaveAccessibleName(/^0\s*HTML$/);
  await expect(row.locator(".filename")).toHaveText("0");
  await row.click();
  await page.getByRole("tree").press("F2");
  const dialog = page.getByRole("dialog", { name: "HTMLの名前を変更" });
  await expect(dialog.getByRole("textbox")).toHaveValue("0");
  await dialog.getByRole("textbox").fill("日本語 renamed");
  await page.evaluate("window.layoutMutationFailure = true");
  await dialog.getByRole("button", { name: "変更する" }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(page.locator('iframe[title="Examples/0.html"]')).toHaveCount(1);
  await page.evaluate("window.layoutMutationFailure = false");
  await dialog.getByRole("button", { name: "変更する" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("tree")).toBeFocused();
  await expect(page.locator('[data-path="Examples/日本語 renamed.html"]')).toHaveAccessibleName(
    /^日本語 renamed\s*HTML$/,
  );
  await expect(page.locator('[data-path="Examples/日本語 renamed.html"] .filename')).toHaveText(
    "日本語 renamed",
  );
  await expect(
    page.frameLocator('iframe[title="Examples/日本語 renamed.html"]').getByRole("textbox"),
  ).toHaveValue("initial");
  expect(
    await page.evaluate((url) => fetch(url!).then((response) => response.status), oldUrl),
  ).toBe(403);
  await tabAction(
    page,
    page.getByRole("tab", { name: "日本語 renamed.html", exact: true }),
    "閉じたタブを開き直す",
  );
  await expect(page.locator('iframe[title="Examples/日本語 renamed.html"]')).toHaveCount(2);
  expect(await page.evaluate("Array.from(window.layoutTabPaths.values())")).toEqual([
    "Examples/日本語 renamed.html",
    "Examples/日本語 renamed.html",
  ]);
  await page.getByRole("button", { name: "文書検索", exact: true }).click();
  await page.getByRole("searchbox").fill("日本語 renamed");
  await expect(
    page.locator('.search-results button[title="Examples/日本語 renamed.html"]'),
  ).toBeVisible();
  await expect(page.locator('.search-results button[title="Examples/0.html"]')).toHaveCount(0);
  expect(await page.evaluate("window.layoutCalls.mutations")).toEqual([
    { kind: "renameHtml", source: "Examples/0.html", name: "日本語 renamed" },
    { kind: "renameHtml", source: "Examples/0.html", name: "日本語 renamed" },
  ]);
});

for (const chrome of [
  { platform: "windows", height: 40, leftInset: 0, rightInset: 138 },
  { platform: "macos", height: 40, leftInset: 82, rightInset: 0 },
]) {
  test(`${chrome.platform} titlebar starts tabs over the document and separates search hit areas`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await prepare(page, false, false, chrome);
    await openDocument(page);
    const originalFrame = await page.locator(".document-pane.active iframe").getAttribute("src");
    const aligned = async () => {
      const tabs = await page.locator(".tab-strip").boundingBox();
      const documentArea = await page.locator(".content").boundingBox();
      const search = await page
        .getByRole("button", { name: "文書検索", exact: true })
        .boundingBox();
      expect(Math.abs(tabs!.x - documentArea!.x)).toBeLessThanOrEqual(1);
      expect(tabs!.x - search!.x - search!.width).toBeGreaterThanOrEqual(16);
    };
    await aligned();
    const separator = page.getByRole("separator");
    await separator.focus();
    await separator.press("End");
    await aligned();
    await separator.press("Home");
    await aligned();
    await openDocument(page, 1);
    await moveToRight(page, 0);
    await aligned();
    const alignedColumns = async () => {
      await expect
        .poll(async () => {
          const rightTabs = await page.locator('.tab-group[data-column="1"]').boundingBox();
          const rightDocument = await page.locator(".document-pane.active iframe").boundingBox();
          return Math.abs(rightTabs!.x - rightDocument!.x);
        })
        .toBeLessThanOrEqual(1);
    };
    await alignedColumns();
    await page.getByRole("button", { name: "左メニューを閉じる" }).click();
    const compactTabs = await page.locator(".tab-strip").boundingBox();
    const compactSearch = await page
      .getByRole("button", { name: "文書検索", exact: true })
      .boundingBox();
    expect(compactTabs!.x - compactSearch!.x - compactSearch!.width).toBeGreaterThanOrEqual(16);
    await alignedColumns();
    await page.setViewportSize({ width: 640, height: 800 });
    await alignedColumns();
    await page.getByRole("button", { name: "左メニューを開く" }).click();
    await expect(page.locator(".tab-strip")).toBeHidden();
    await page.getByRole("button", { name: "左メニューを閉じる" }).click();
    await expect(page.locator(".tab-strip")).toBeVisible();
    await alignedColumns();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole("button", { name: "左メニューを開く" }).click();
    await aligned();
    await alignedColumns();
    expect(await page.locator(".document-pane.active iframe").getAttribute("src")).toBe(
      originalFrame,
    );
    const frameAreas = await page
      .locator(".document-pane:not([hidden]) iframe")
      .evaluateAll((frames) =>
        frames.map((frame) => ({
          top: frame.getBoundingClientRect().top,
          bottom: frame.getBoundingClientRect().bottom,
          viewport: innerHeight,
        })),
      );
    expect(frameAreas).toHaveLength(2);
    for (const area of frameAreas) {
      expect(area.top).toBe(chrome.height);
      expect(area.bottom).toBe(area.viewport);
    }
  });
  test(`${chrome.platform} titlebar stays dark and readable across system themes and contrast mode`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await prepare(page, false, false, chrome);
    await openDocument(page);
    const originalFrame = await page.locator(".document-pane.active iframe").getAttribute("src");
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme, forcedColors: "none" });
      const palette = await page.locator(".titlebar").evaluate((titlebar) => {
        const luminance = (color: string) => {
          const channels = color
            .match(/[\d.]+/g)!
            .slice(0, 3)
            .map(Number)
            .map((v) => v / 255);
          const linear = channels.map((v) =>
            v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
          );
          return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
        };
        const background = getComputedStyle(titlebar).backgroundColor;
        const elements = Array.from(titlebar.querySelectorAll("button"));
        return {
          background,
          sidebar: getComputedStyle(document.querySelector(".sidebar")!).backgroundColor,
          luminance: luminance(background),
          contrast: elements.map((button) => {
            let surface: Element | null = button;
            while (surface && getComputedStyle(surface).backgroundColor === "rgba(0, 0, 0, 0)")
              surface = surface.parentElement;
            const text = luminance(getComputedStyle(button).color);
            const fill = luminance(getComputedStyle(surface!).backgroundColor);
            return (Math.max(text, fill) + 0.05) / (Math.min(text, fill) + 0.05);
          }),
        };
      });
      expect(palette.background).toBe(palette.sidebar);
      expect(palette.luminance).toBeLessThan(0.15);
      expect(palette.contrast.every((ratio) => ratio >= 4.5)).toBe(true);
      await page.getByRole("button", { name: "文書検索", exact: true }).hover();
      await expect(page.getByRole("button", { name: "文書検索", exact: true })).toHaveCSS(
        "background-color",
        "rgb(34, 48, 67)",
      );
      await page.keyboard.press("Tab");
      await page.getByRole("tab").focus();
      await expect(page.getByRole("tab")).toHaveCSS("outline-style", "solid");
    }
    await page.emulateMedia({ forcedColors: "active" });
    const contrastPalette = await page.locator(".titlebar").evaluate((titlebar) => {
      const probe = document.createElement("span");
      probe.style.cssText = "background:Canvas;color:CanvasText;display:none";
      document.body.append(probe);
      const result = {
        background: getComputedStyle(titlebar).backgroundColor,
        text: getComputedStyle(titlebar).color,
        systemBackground: getComputedStyle(probe).backgroundColor,
        systemText: getComputedStyle(probe).color,
      };
      probe.remove();
      return result;
    });
    expect(contrastPalette.background).toBe(contrastPalette.systemBackground);
    expect(contrastPalette.text).toBe(contrastPalette.systemText);
    const titlebar = await page.locator(".titlebar").boundingBox();
    expect(titlebar!.height).toBe(chrome.height);
    expect(await page.locator(".document-pane.active iframe").getAttribute("src")).toBe(
      originalFrame,
    );
    await expectFullViewer(page);
  });
  test(`${chrome.platform} titlebar reserves window controls and consumes exactly one row`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await prepare(page, false, false, chrome);
    await openDocument(page);
    await expect(page.locator(".titlebar")).toHaveAttribute("data-platform", chrome.platform);
    const titlebar = await page.locator(".titlebar").boundingBox();
    expect(titlebar!.y).toBe(0);
    expect(titlebar!.height).toBe(chrome.height);
    await expect(page.locator(".toolbar")).toHaveCount(0);
    const controls = page.locator(".titlebar button:not(.window-controls button)");
    const bounds = await controls.evaluateAll((buttons) =>
      buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        return { left: rect.left, right: rect.right };
      }),
    );
    expect(
      bounds.every(
        (rect) => rect.left >= chrome.leftInset && rect.right <= 1280 - chrome.rightInset,
      ),
    ).toBe(true);
    if (chrome.platform === "windows") {
      await expect(page.locator(".window-controls button")).toHaveCount(3);
      const windows = await page.locator(".window-controls").boundingBox();
      expect(windows!.x).toBe(1280 - chrome.rightInset);
      expect(windows!.width).toBe(chrome.rightInset);
      expect(windows!.y).toBe(0);
      expect(windows!.height).toBeGreaterThanOrEqual(chrome.height - 1);
      expect(windows!.height).toBeLessThanOrEqual(chrome.height);
    } else await expect(page.locator(".window-controls")).toHaveCount(0);
    await expectFullViewer(page);
  });
}

test("tab labels omit terminal HTML extensions across lazy split views and mock restart", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await prepare(page, false, false, undefined, true, false, true, true);
  const paths = [
    "Left/日本語.名前.HtMl",
    "Left/複数.html.dot.HTML",
    "Right/日本語.名前.HtMl",
    "Right/guide.HTM",
  ];
  await page.evaluate(
    `window.layoutSetsModel.sets = [{ id:'labels', name:'表示名確認', active:[0,2], activeColumn:0, items:${JSON.stringify(paths)}.map((path,i)=>({document:{relativePath:path,identity:'fixture:'+path},column:i<2?0:1,zoom:100})) }]; localStorage.setItem('workspace-set-fixture', JSON.stringify(window.layoutSetsModel));`,
  );
  const saved = await page.evaluate("localStorage.getItem('workspace-set-fixture')");
  const restore = async () => {
    await page.getByRole("button", { name: "作業セット", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^表示名確認 / })
      .click();
    await expect(page.getByRole("tab")).toHaveCount(4);
    await expect(page.locator("iframe")).toHaveCount(2);
  };
  const labels = () =>
    page.getByRole("tab").evaluateAll((buttons) =>
      buttons.map((button) => ({
        path: button.getAttribute("aria-description"),
        label: button.querySelector(".tab-title")?.textContent,
      })),
    );
  const expected = paths.map((path, index) => ({
    path,
    label: ["日本語.名前", "複数.html.dot", "日本語.名前", "guide"][index],
  }));
  await restore();
  expect(await labels()).toEqual(expected);
  await expect(page.getByRole("tab", { name: "複数.html.dot.HTML", exact: true })).toHaveAttribute(
    "title",
    paths[1] + "（選択時に読み込み）",
  );
  expect(await page.evaluate("window.layoutCalls.create.length")).toBe(2);
  const left = page.locator(`iframe[title="${paths[0]}"]`);
  const original = await left.elementHandle();
  await left.contentFrame().getByRole("textbox").fill("保持する入力");
  await left.contentFrame().getByRole("button", { name: "Draw" }).click();
  await page.getByRole("tab", { name: "guide.HTM", exact: true }).click();
  await expect(page.locator(`iframe[title="${paths[3]}"]`)).toBeVisible();
  await page
    .getByRole("tablist", { name: "右列の文書" })
    .getByRole("tab", { name: "日本語.名前.HtMl", exact: true })
    .click();
  expect(await left.evaluate((element, original) => element === original, original)).toBe(true);
  await expect(left.contentFrame().getByRole("textbox")).toHaveValue("保持する入力");
  expect(await page.evaluate("window.layoutCalls.open")).toBe(3);
  await page.screenshot({ path: test.info().outputPath("tab-labels-1000.png") });
  await page.reload();
  expect(await page.evaluate("window.layoutCalls.open")).toBe(0);
  await restore();
  expect(await labels()).toEqual(expected);
  expect(await page.evaluate("localStorage.getItem('workspace-set-fixture')")).toBe(saved);
  expect(await page.evaluate("window.layoutCalls.open")).toBe(2);
  expect(await page.evaluate("[...window.layoutTabPaths.values()]")).toEqual([paths[0], paths[2]]);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.getByRole("button", { name: "左メニューを閉じる", exact: true }).click();
  await expect(page.getByRole("tab").first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("tab-labels-320.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
});

test("workspace sets CRUD survives restart and reuses two live views with input JS and current zoom", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await prepare(page, false, false, undefined, true, false, true, true);
  await openDocument(page);
  const left = page.locator(".document-pane:not([hidden]) iframe").first();
  const original = await left.elementHandle();
  await left.contentFrame().getByRole("textbox").fill("set input retained");
  await left.contentFrame().getByRole("button", { name: "Draw" }).click();
  await page.getByRole("tab", { name: "0.html", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "右の列で開く", exact: true }).click();
  const right = page.locator(".document-pane:not([hidden]) iframe").nth(1);
  await right.contentFrame().getByRole("textbox").fill("independent right input");
  const open = () => page.getByRole("button", { name: "作業セット", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "作業セット" });
  const sets = dialog.getByRole("region", { name: "作業セット" });
  await open();
  await sets.getByRole("textbox", { name: "新しい作業セット名" }).fill("計算と資料");
  await sets.getByRole("button", { name: "現在の配置を保存" }).click();
  await expect(sets.getByRole("button", { name: /^計算と資料 / })).toBeVisible();
  await sets.getByRole("button", { name: "計算と資料の名前を変更" }).click();
  await sets.getByRole("textbox", { name: "変更後のセット名" }).fill("左右の作業");
  await sets.getByRole("button", { name: "変更", exact: true }).click();
  await page.screenshot({ path: test.info().outputPath("workspace-sets-1000.png") });
  await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
  await page
    .getByRole("tablist", { name: "左列の文書" })
    .getByRole("tab", { name: "0.html", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "文書を縮小", exact: true }).click();
  await open();
  await sets.getByRole("button", { name: /^左右の作業 / }).click();
  await expect(dialog).toHaveCount(0);
  expect(await left.evaluate((element, original) => element === original, original)).toBe(true);
  await expect(left.contentFrame().getByRole("textbox")).toHaveValue("set input retained");
  await expect(right.contentFrame().getByRole("textbox")).toHaveValue("independent right input");
  await expect(left.contentFrame().locator("html")).toHaveCSS("zoom", "0.75");
  expect(
    await left
      .contentFrame()
      .locator("body")
      .evaluate(
        () => (window as unknown as { runtimeState: { count: number } }).runtimeState.count,
      ),
  ).toBe(1);
  expect(await page.evaluate("window.layoutCalls.open")).toBe(2);
  await page.reload();
  await open();
  await expect(sets.getByRole("button", { name: /^左右の作業 / })).toBeVisible();
  expect(await page.evaluate("window.layoutCalls.open")).toBe(0);
  await sets.getByRole("button", { name: /^左右の作業 / }).click();
  await expect(page.locator("iframe")).toHaveCount(2);
  expect(await page.evaluate("window.layoutCalls.open")).toBe(2);
  await page.setViewportSize({ width: 320, height: 640 });
  await open();
  await page.screenshot({ path: test.info().outputPath("workspace-sets-320.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await expect(sets.getByRole("button", { name: "左右の作業を削除" })).toBeInViewport();
  await sets.getByRole("button", { name: "左右の作業を削除" }).click();
  await expect(sets.getByRole("button", { name: /^左右の作業 / })).toHaveCount(0);
});

test("workspace sets restore 30 placeholders and read a selected hidden document once with explicit missing status", async ({
  page,
}) => {
  await prepare(page, false, false, undefined, true, false, true, true);
  await page.evaluate(
    `window.layoutSetsModel.sets = [{ id: '30', name: '30文書', active: [0, null], activeColumn: 0, items: Array.from({ length: 30 }, (_, i) => ({ document: { relativePath: 'Examples/' + i + '.html', identity: 'fixture:Examples/' + i + '.html' }, column: 0, zoom: 125 })) }];`,
  );
  const open = () => page.getByRole("button", { name: "作業セット", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "作業セット" });
  await open();
  await dialog.getByRole("button", { name: /^30文書 / }).click();
  await expect(page.getByRole("tab")).toHaveCount(30);
  await expect(page.locator(".tab-update")).toHaveCount(0);
  await expect(page.locator("iframe")).toHaveCount(1);
  expect(await page.evaluate("window.layoutCalls.open")).toBe(1);
  expect(await page.evaluate("window.layoutCalls.create.length")).toBe(1);
  await page.getByRole("tab", { name: /29.html/ }).click();
  await expect(page.locator("iframe")).toHaveCount(2);
  await expect(
    page.locator('iframe[title="Examples/29.html"]').contentFrame().locator("html"),
  ).toHaveCSS("zoom", "1.25");
  await page.getByRole("tab", { name: /29.html/ }).click();
  expect(await page.evaluate("window.layoutCalls.open")).toBe(2);
  await page.evaluate(
    `window.layoutSetStatuses = { 'Examples/1.html': 'missing' }; window.layoutSetsModel.sets[0].active = [1, null];`,
  );
  await open();
  await dialog.getByRole("button", { name: /^30文書 / }).click();
  await expect(page.locator(".document-pane:not([hidden])")).toContainText("見つかりません");
  expect(await page.evaluate("window.layoutCalls.open")).toBe(2);
  await page.evaluate("window.layoutSetStatuses = {}");
  await open();
  await dialog.getByRole("button", { name: /^30文書 / }).click();
  await expect(page.locator('iframe[title="Examples/1.html"]')).toBeVisible();
  expect(await page.evaluate("window.layoutCalls.open")).toBe(3);
  await page.screenshot({ path: test.info().outputPath("workspace-sets-lazy-30.png") });
});

test("document history back/forward reuses input canvas JS and fragment with compact menu and keys", async ({
  page,
}) => {
  await prepare(page, false, false, undefined, true, true);
  await openDocument(page, 0);
  const a = page.locator('iframe[title="Examples/0.html"]');
  const original = await a.elementHandle();
  await a.contentFrame().getByRole("textbox").fill("retained A");
  await a.contentFrame().getByRole("button", { name: "Draw" }).click();
  await a
    .contentFrame()
    .locator("body")
    .evaluate((body) => {
      const link = document.createElement("a");
      link.href = "#chapter";
      link.textContent = "Chapter";
      const target = document.createElement("div");
      target.id = "chapter";
      target.textContent = "Chapter target";
      body.prepend(link);
      body.append(target);
    });
  await a.contentFrame().getByRole("link", { name: "Chapter", exact: true }).click();
  await expect
    .poll(() =>
      a
        .contentFrame()
        .locator("body")
        .evaluate(() => location.hash),
    )
    .toBe("#chapter");
  await openDocument(page, 1);
  await openDocument(page, 2);
  const step = async (name: string) => {
    await page.getByRole("tab", { selected: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name, exact: true }).click();
  };
  await step("文書履歴を戻る");
  await expect(page.locator('iframe[title="Examples/1.html"]')).toBeVisible();
  await step("文書履歴を戻る");
  await expect(a).toBeVisible();
  expect(await a.evaluate((element, original) => element === original, original)).toBe(true);
  await expect(a.contentFrame().getByRole("textbox")).toHaveValue("retained A");
  expect(
    await a
      .contentFrame()
      .locator("canvas")
      .evaluate((canvas) => {
        if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Missing canvas");
        return Array.from(canvas.getContext("2d")!.getImageData(0, 0, 1, 1).data);
      }),
  ).toEqual([51, 170, 85, 255]);
  expect(
    await a
      .contentFrame()
      .locator("body")
      .evaluate(
        () => (window as unknown as { runtimeState: { count: number } }).runtimeState.count,
      ),
  ).toBe(1);
  await a.contentFrame().getByRole("button", { name: "Draw" }).press("Alt+ArrowRight");
  await expect(page.locator('iframe[title="Examples/1.html"]')).toBeVisible();
  expect(await page.evaluate("window.layoutCalls.open")).toBe(3);
  await page.evaluate("window.layoutHistoryFailure=true");
  await step("文書履歴を戻る");
  await expect(page.locator('iframe[title="Examples/1.html"]')).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "履歴を開けません" })).toBeVisible();
  await page.evaluate("window.layoutHistoryFailure=false");
  await step("文書履歴を戻る");
  await expect(a).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("document-history-1000.png") });
  await page.setViewportSize({ width: 320, height: 640 });
  await page.getByRole("button", { name: "左メニューを閉じる", exact: true }).click();
  await page.getByRole("tab", { selected: true }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "文書履歴を進む", exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("document-history-320.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
});

test("live input transfer separates consent, cancels without closing and verifies a lost response before identity-bound reload", async ({
  page,
}) => {
  const transferRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("StateTransferDialog.tsx")) transferRequests.push(request.url());
  });
  await page.setViewportSize({ width: 1000, height: 700 });
  await prepare(page, false, false, undefined, true, false, true, false, true);
  expect(transferRequests).toHaveLength(0);
  await openDocument(page);
  const frame = page.locator('iframe[title="Examples/0.html"]');
  await frame.contentFrame().getByRole("textbox").fill("unconfirmed input");
  const original = await frame.elementHandle();
  const opens = await page.evaluate<number>("window.layoutCalls.open");
  const viewed = await page.evaluate("window.layoutCalls.viewed.length");
  const launch = async () => {
    await page.getByRole("treeitem", { name: "0 HTML", exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "保存済み入力を取り込む", exact: true }).click();
  };
  await launch();
  const dialog = page.getByRole("dialog", { name: "保存済み入力を取り込む" });
  await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeFocused();
  await dialog.getByRole("button", { name: "新しいbackup先を選ぶ" }).click();
  const execute = dialog.getByRole("button", { name: "確認した内容で取り込む" });
  await expect(execute).toBeDisabled();
  await dialog.getByRole("checkbox", { name: /既存の全appId/ }).check();
  await expect(execute).toBeDisabled();
  await dialog.getByRole("button", { name: "選択ファイルと現在値を照合" }).click();
  await expect(dialog.getByRole("status")).toContainText("過去の処理成功");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("取り消しました");
  expect(await page.evaluate("window.layoutCalls.close")).toBe(0);
  expect(await frame.evaluate((element, original) => element === original, original)).toBe(true);
  await expect(frame.contentFrame().getByRole("textbox")).toHaveValue("unconfirmed input");
  await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
  await launch();
  await dialog.getByRole("button", { name: "新しいbackup先を選ぶ" }).click();
  await dialog.getByRole("checkbox", { name: /既存の全appId/ }).check();
  await dialog.getByRole("checkbox", { name: /別の確認:/ }).check();
  await page.setViewportSize({ width: 320, height: 640 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await page.screenshot({ path: test.info().outputPath("live-transfer-preview-320.png") });
  await page.evaluate("window.layoutTransferLost=true");
  await execute.click();
  await expect(dialog.getByRole("button", { name: "処理結果を照会" })).toBeVisible();
  expect(await page.evaluate("window.layoutCalls.transferConfirm.length")).toBe(1);
  expect(await page.evaluate("window.layoutCalls.open")).toBe(opens);
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.screenshot({ path: test.info().outputPath("live-transfer-unknown-1000.png") });
  await dialog.getByRole("button", { name: "処理結果を照会" }).click();
  await expect(dialog.getByRole("status")).toContainText("取り込みました");
  await expect(frame.contentFrame().getByRole("textbox")).toHaveValue("initial");
  expect(await page.evaluate("window.layoutCalls.open")).toBe(opens + 1);
  expect(await page.evaluate("window.layoutCalls.viewed.length")).toBe(viewed);
  expect(await page.evaluate("window.layoutCalls.createBound.at(-1).expectedIdentity")).toBe(
    "fixture:Examples/0.html",
  );
  expect(transferRequests).toHaveLength(1);
  await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("integrated folder search resets scope and returns to the full tree without replacing the live document", async ({
  page,
}) => {
  await prepare(page, false, false, undefined, true);
  await openDocument(page);
  const frame = page.locator('iframe[title="Examples/0.html"]');
  const original = await frame.elementHandle();
  await frame.contentFrame().getByRole("textbox").fill("scope keeps input");
  const tree = page.getByRole("tree");
  const height = await tree.evaluate((element) => element.clientHeight);
  await page.getByRole("treeitem", { name: "Examples", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "このフォルダー内を検索", exact: true }).click();
  const input = page.getByRole("searchbox");
  await expect(input).toBeFocused();
  await expect(page.getByLabel("検索範囲", { exact: true })).toContainText("Examples");
  await input.fill("0.html");
  await expect(page.getByRole("list", { name: "検索結果" })).toBeVisible();
  expect(await page.evaluate("window.layoutSearchCalls.scopes.at(-1).relativePath")).toBe(
    "Examples",
  );
  await page.screenshot({ path: test.info().outputPath("integrated-folder-search-1000.png") });
  await page.getByRole("button", { name: "検索範囲を解除" }).click();
  await expect(page.getByLabel("検索範囲", { exact: true })).toHaveCount(0);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("0.html");
  await page.getByRole("button", { name: "ファイル", exact: true }).click();
  expect(await tree.evaluate((element) => element.clientHeight)).toBe(height);
  await expect(frame.contentFrame().getByRole("textbox")).toHaveValue("scope keeps input");
  expect(await frame.evaluate((element, original) => element === original, original)).toBe(true);
  expect(await page.evaluate("window.layoutCalls.open")).toBe(1);
});

// Exercises the real App wiring; the bridge and OS chrome remain mocks.
test("App routes focused HTML AI shortcuts, root AI and folder favorites without reopening documents", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await prepare(page, false, false, undefined, true, false, true);
  await openDocument(page, 0);
  await openDocument(page, 1);
  await moveToRight(page, 0);
  const frame = page.locator('iframe[title="Examples/0.html"]');
  const original = await frame.elementHandle();
  const input = frame.contentFrame().getByRole("textbox");
  await input.fill("日本語の入力を保持");
  await input.press("Control+Shift+a");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await frame.contentFrame().getByRole("button", { name: "Draw" }).focus();
  await page.keyboard.press("Control+Shift+a");
  const dialog = page.getByRole("dialog", { name: "AIに渡す", exact: true });
  await expect(dialog).toBeVisible();
  expect(await page.evaluate("window.layoutCalls.aiPrepare.at(-1)")).toEqual({
    workspaceId: "layout",
    viewId: "view-layout",
    relativePath: "Examples/0.html",
  });
  expect(await page.evaluate("window.layoutCalls.aiPerform || []")).toEqual([]);
  await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
  const root = page.locator(".workspace-button");
  await root.click({ button: "right" });
  await page.getByRole("menuitem", { name: "AIに渡す", exact: true }).click();
  await expect(dialog).toBeVisible();
  expect(await page.evaluate("window.layoutCalls.aiPrepare.at(-1)")).toEqual({
    workspaceId: "layout",
    viewId: "view-layout",
    target: "root",
  });
  await dialog.getByRole("combobox", { name: "連携先" }).selectOption("codexCli");
  await dialog.getByRole("button", { name: "依頼文をコピー" }).click();
  await expect(dialog.getByRole("status")).toContainText("依頼文をコピーしました");
  expect(await page.evaluate("window.layoutCalls.aiPerform.at(-1).preview")).toEqual({
    kind: "folder",
    selectedPath: "/knowledge",
    workingDirectory: "/knowledge",
    revision: 1,
  });
  await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(root).toBeFocused();
  await page.locator('[data-path="Examples"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: "お気に入りに追加", exact: true }).click();
  const counts = await page.evaluate(
    "JSON.stringify({open:window.layoutCalls.open, viewed:window.layoutCalls.viewed})",
  );
  await page
    .getByRole("region", { name: "お気に入り", exact: true })
    .getByRole("button", { name: "Examplesのフォルダーを表示", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("tree")).toBeFocused();
  await expect(page.getByRole("tree")).toHaveAttribute("aria-activedescendant", /.+/);
  expect(
    await page.evaluate(
      "JSON.stringify({open:window.layoutCalls.open, viewed:window.layoutCalls.viewed})",
    ),
  ).toBe(counts);
  await expect(input).toHaveValue("日本語の入力を保持");
  expect(await frame.evaluate((element, original) => element === original, original)).toBe(true);
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await page.getByRole("combobox", { name: "表示言語を選択" }).selectOption("en");
  await page
    .getByRole("dialog", { name: "Settings", exact: true })
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(page.getByRole("button", { name: "Features and usage", exact: true })).toBeVisible();
  await root.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Send to AI", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(input).toHaveValue("日本語の入力を保持");
  await page.screenshot({ path: test.info().outputPath("app-integrated-en.png") });
  expect(await page.evaluate("localStorage.getItem('my-knowledge.ui-language')")).toBe("en");
  await page.reload();
  await expect(page.getByRole("button", { name: "Features and usage", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Choose display language" })).toHaveValue("en");
  await page
    .getByRole("dialog", { name: "Settings", exact: true })
    .getByRole("button", { name: "Close", exact: true })
    .click();
});

for (const [platform, primary, other] of [
  ["Win32", "Control", "Meta"],
  ["MacIntel", "Meta", "Control"],
]) {
  test(`settings comma shortcut reuses its dialog and returns to the focused HTML or shell on ${platform}`, async ({
    page,
  }) => {
    await page.addInitScript(
      (platform) => Object.defineProperty(navigator, "platform", { value: platform }),
      platform,
    );
    await page.setViewportSize({ width: 1000, height: 700 });
    await prepare(page, false, false, undefined, true);
    await openDocument(page);
    const frame = page.locator('iframe[title="Examples/0.html"]');
    const originalFrame = await frame.elementHandle();
    const input = frame.contentFrame().getByRole("textbox");
    await input.fill("設定を開いても保持する入力");
    const draw = frame.contentFrame().getByRole("button", { name: "Draw" });
    await draw.click();
    const calls = await page.evaluate("JSON.stringify(window.layoutCalls)");
    await input.press(primary + "+,");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await draw.focus();
    await draw.evaluate(() => {
      const cancel = (event: KeyboardEvent) => {
        if (event.key !== ",") return;
        event.preventDefault();
        window.removeEventListener("keydown", cancel);
      };
      window.addEventListener("keydown", cancel);
    });
    await draw.press(primary + "+,");
    await draw.press(other + "+,");
    await draw.press(primary + "+Shift+,");
    await page.waitForTimeout(60);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await draw.press(primary + "+,");
    let dialog = page.getByRole("dialog", { name: "設定", exact: true });
    await expect(dialog).toBeVisible();
    const originalDialog = await dialog.elementHandle();
    const language = dialog.getByRole("combobox");
    await language.focus();
    await language.press(primary + "+,");
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(language).toBeFocused();
    await language.selectOption("en");
    dialog = page.getByRole("dialog", { name: "Settings", exact: true });
    expect(await dialog.evaluate((element, original) => element === original, originalDialog)).toBe(
      true,
    );
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(frame).toBeFocused();
    await expect(input).toHaveValue("設定を開いても保持する入力");
    expect(await frame.evaluate((element, original) => element === original, originalFrame)).toBe(
      true,
    );
    expect(await page.evaluate("JSON.stringify(window.layoutCalls)")).toBe(calls);
    await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
    const show = page.getByRole("button", { name: "Show sidebar", exact: true });
    await show.focus();
    await show.press(primary + "+,");
    dialog = page.getByRole("dialog", { name: "Settings", exact: true });
    await expect(dialog).toBeVisible();
    await page.setViewportSize({ width: 320, height: 640 });
    await page.screenshot({
      path: test.info().outputPath(`settings-shortcut-${platform}-hidden-en-320.png`),
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    await page.keyboard.press("Escape");
    await expect(show).toBeFocused();
    await draw.focus();
    await draw.press(primary + "+,");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("combobox").selectOption("ja");
    await page.screenshot({
      path: test.info().outputPath(`settings-shortcut-${platform}-hidden-ja-320.png`),
    });
    await page.keyboard.press("Escape");
    await expect(frame).toBeFocused();
    await expect(input).toHaveValue("設定を開いても保持する入力");
    expect(await page.evaluate("JSON.stringify(window.layoutCalls)")).toBe(calls);
  });
}

for (const [platform, primary] of [
  ["Win32", "Control"],
  ["MacIntel", "Meta"],
]) {
  test(`workspace shortcut assignments retain stable IDs and live inputs on ${platform}`, async ({
    page,
  }) => {
    await page.addInitScript(
      (platform) => Object.defineProperty(navigator, "platform", { value: platform }),
      platform,
    );
    await page.setViewportSize({ width: 1000, height: 700 });
    await prepare(page, false, false, undefined, true, false, false, true);
    await openDocument(page);
    const frame = page.locator('iframe[title="Examples/0.html"]');
    const original = await frame.elementHandle();
    const input = frame.contentFrame().getByRole("textbox");
    await input.fill("番号切替でも保持する入力");
    await frame.contentFrame().getByRole("button", { name: "Draw" }).click();
    const openSets = () => page.getByRole("button", { name: "作業セット", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "作業セット", exact: true });
    await openSets();
    for (const name of ["A", "B"]) {
      await dialog.getByRole("textbox", { name: "新しい作業セット名" }).fill(name);
      await dialog.getByRole("button", { name: "現在の配置を保存", exact: true }).click();
      await expect(dialog.getByRole("combobox", { name: `${name}のショートカット` })).toBeVisible();
    }
    await dialog.getByRole("combobox", { name: "Aのショートカット" }).selectOption("1");
    const second = dialog.getByRole("combobox", { name: "Bのショートカット" });
    await expect(second.locator('option[value="1"]')).toBeDisabled();
    await second.selectOption("10");
    await expect(second).toHaveValue("10");
    const assigned = await page.evaluate<Array<string | null>>(
      "JSON.parse(localStorage.getItem('workspace-set-fixture')).setShortcuts",
    );
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({
        path: test.info().outputPath(`workspace-shortcuts-${platform}-ja-${scheme}.png`),
      });
    }
    await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
    const draw = frame.contentFrame().getByRole("button", { name: "Draw" });
    await draw.focus();
    await draw.press(`${primary}+Shift+Digit0`);
    await expect.poll(() => page.evaluate("window.layoutCalls.setResolve?.length || 0")).toBe(1);
    expect(await page.evaluate("window.layoutCalls.setResolve[0]")).toEqual({
      id: assigned[9],
      shortcutSlot: 10,
    });
    await expect(input).toHaveValue("番号切替でも保持する入力");
    expect(await frame.evaluate((element, original) => element === original, original)).toBe(true);
    expect(await page.evaluate("window.layoutCalls.open")).toBe(1);
    await input.focus();
    await input.press(`${primary}+Shift+Digit1`);
    await draw.focus();
    await draw.press(`${primary}+Shift+Digit2`);
    await page.waitForTimeout(60);
    expect(await page.evaluate("window.layoutCalls.setResolve.length")).toBe(1);
    await page.getByRole("tree").focus();
    await page.keyboard.press(`${primary}+Shift+Digit1`);
    await expect.poll(() => page.evaluate("window.layoutCalls.setResolve.length")).toBe(2);
    expect(await page.evaluate("window.layoutCalls.setResolve[1]")).toEqual({
      id: assigned[0],
      shortcutSlot: 1,
    });
    await expect(input).toHaveValue("番号切替でも保持する入力");
    await openSets();
    await dialog.getByRole("button", { name: "Aを削除", exact: true }).click();
    await expect(dialog.getByRole("combobox", { name: "Aのショートカット" })).toHaveCount(0);
    expect(
      await page.evaluate(
        "JSON.parse(localStorage.getItem('workspace-set-fixture')).setShortcuts[0]",
      ),
    ).toBeNull();
    await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
    await page.getByRole("tree").focus();
    await page.keyboard.press(`${primary}+Shift+Digit1`);
    await page.waitForTimeout(60);
    expect(await page.evaluate("window.layoutCalls.setResolve.length")).toBe(2);
    await page.getByRole("button", { name: "設定", exact: true }).click();
    await page.getByRole("combobox", { name: "表示言語を選択" }).selectOption("en");
    await page
      .getByRole("dialog", { name: "Settings", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await page.setViewportSize({ width: 320, height: 640 });
    await page.getByRole("button", { name: "Workspace sets", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Workspace sets", exact: true });
    const english = dialog.getByRole("combobox", { name: "Shortcut for B" });
    await expect(english).toHaveValue("10");
    await expect(english.locator('option[value="10"]')).toHaveText(
      `${platform === "MacIntel" ? "Cmd" : "Ctrl"}+Shift+0`,
    );
    await expect(english.locator('option[value=""]')).toHaveText("Unassigned");
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({
        path: test.info().outputPath(`workspace-shortcuts-${platform}-en-320-${scheme}.png`),
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
      const box = await english.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    }
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await page.reload();
    await expect
      .poll(() => page.evaluate("window.layoutSetsModel.setShortcuts[9]"))
      .toBe(assigned[9]);
    await page.getByRole("button", { name: "Workspace sets", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Shortcut for B" })).toHaveValue("10");
  });
}

// Real main receiver + injected adapter; Native picker/writer remains a mock.
for (const language of ["ja", "en"] as const) {
  test(`generated artifact main confirmation preserves HTML state and rejects uncertain saves in ${language}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    // prepare's tree/search labels are Japanese; switch after initial app setup.
    await page.addInitScript(() => localStorage.setItem("my-knowledge.ui-language", "ja"));
    await prepare(page, false, false, undefined, true, false, false, false, false, true);
    await openDocument(page);
    if (language === "en") {
      await page.getByRole("button", { name: "設定", exact: true }).click();
      await page.getByRole("combobox", { name: "表示言語を選択" }).selectOption("en");
      await page
        .getByRole("dialog", { name: "Settings", exact: true })
        .getByRole("button", { name: "Close", exact: true })
        .click();
    }
    // At 320px the open sidebar intentionally hides the document underneath it.
    await page
      .getByRole("button", {
        name: language === "ja" ? "左メニューを閉じる" : "Hide sidebar",
        exact: true,
      })
      .click();
    const frame = page.locator('iframe[title="Examples/0.html"]');
    const original = await frame.elementHandle();
    const html = frame.contentFrame();
    await html.getByRole("textbox").fill("keep generated input");
    await html.getByRole("button", { name: "Draw", exact: true }).click();
    await html.getByRole("button", { name: "Export text", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: language === "ja" ? "生成ファイルを書き出す" : "Export generated file",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    expect(await page.evaluate("window.layoutArtifactCalls.length")).toBe(0);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({
        path: test.info().outputPath(`artifact-export-${language}-${scheme}-320.png`),
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    }
    await dialog
      .getByRole("button", { name: language === "ja" ? "閉じる" : "Close", exact: true })
      .click();
    await expect
      .poll(() =>
        frame
          .contentFrame()
          .getByRole("button", { name: "Export text" })
          .evaluate(() => (window as unknown as { exportResults: unknown[] }).exportResults),
      )
      .toEqual([{ status: "cancelled" }]);
    expect(await page.evaluate("window.layoutArtifactCalls.length")).toBe(0);
    await page.waitForTimeout(1000); // Deliberately cross the documented client/main cooldown.
    await html.getByRole("button", { name: "Export text", exact: true }).click();
    await dialog
      .getByRole("button", {
        name: language === "ja" ? "保存先を選ぶ" : "Choose destination",
        exact: true,
      })
      .click();
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate("window.layoutArtifactCalls[0].context")).toMatchObject({
      workspaceId: "layout",
      viewId: "view-layout",
      tabId: "1",
      request: 1,
      revision: 1,
    });
    expect(await page.evaluate("window.layoutArtifactCalls[0].data")).toBe(
      Buffer.from("generated text").toString("base64"),
    );
    await page.waitForTimeout(1000);
    await page.evaluate("window.layoutArtifactFailure='ArtifactPublishedUnconfirmed'");
    await html.getByRole("button", { name: "Export text", exact: true }).click();
    await dialog
      .getByRole("button", {
        name: language === "ja" ? "保存先を選ぶ" : "Choose destination",
        exact: true,
      })
      .click();
    await expect(dialog.getByRole("alert")).toContainText(
      language === "ja" ? "自動で再試行せず" : "before trying again",
    );
    await expect(
      dialog.getByRole("button", {
        name: language === "ja" ? "保存先を選ぶ" : "Choose destination",
        exact: true,
      }),
    ).toBeDisabled();
    expect(await page.evaluate("window.layoutArtifactCalls.length")).toBe(2);
    await dialog
      .getByRole("button", { name: language === "ja" ? "閉じる" : "Close", exact: true })
      .click();
    await expect(html.getByRole("textbox")).toHaveValue("keep generated input");
    expect(await frame.evaluate((element, old) => element === old, original)).toBe(true);
    expect(await page.evaluate("window.layoutCalls.open")).toBe(1);
  });
}

for (const language of ["ja", "en"] as const) {
  test(`search details persist and reset conditions while keeping live HTML in ${language}`, async ({
    page,
  }) => {
    const text =
      language === "ja"
        ? {
            search: "文書検索",
            options: "検索の詳細設定",
            and: "AND（すべての語）",
            or: "OR（いずれかの語）",
            folder: "検索するフォルダー",
            reset: "検索条件をリセット",
            cancel: "取消",
            files: "ファイル",
          }
        : {
            search: "Document search",
            options: "Search options",
            and: "AND (all terms)",
            or: "OR (any term)",
            folder: "Folder to search",
            reset: "Reset search conditions",
            cancel: "Cancel",
            files: "Files",
          };
    await page.setViewportSize({ width: 1000, height: 700 });
    await prepare(page, false, false, undefined, true);
    await openDocument(page, 0);
    await page.evaluate(async (language) => {
      const modulePath = "/src/lib/i18n.ts";
      (await import(modulePath)).setLanguage(language);
    }, language);
    const frame = page.locator('iframe[title="Examples/0.html"]');
    const original = await frame.elementHandle();
    await frame.contentFrame().getByRole("textbox").fill("search options keep input");
    await frame.contentFrame().getByRole("button", { name: "Draw" }).click();
    const query = page.getByRole("searchbox");
    const toggle = page.getByRole("button", { name: text.options, exact: true });
    await page.getByRole("button", { name: text.search, exact: true }).click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("radio")).toHaveCount(0);
    expect((await query.boundingBox())!.width).toBeGreaterThan(195);
    await toggle.focus();
    await toggle.press("Enter");
    await expect(page.getByRole("radio", { name: text.and, exact: true })).toBeChecked();
    await page.getByRole("radio", { name: text.or, exact: true }).check();
    const folder = page.getByRole("combobox", { name: text.folder, exact: true });
    await expect(folder).toHaveAttribute("aria-disabled", "false");
    await folder.click();
    await folder.fill("Examples");
    await folder.press("Enter");
    await expect(folder).toHaveValue("Examples");
    await query.fill("0.html");
    await expect(
      page.getByRole("list", { name: language === "ja" ? "検索結果" : "Search results" }),
    ).toBeVisible();
    await expect
      .poll(() => page.evaluate("window.layoutSearchCalls.scopes.at(-1)?.relativePath"))
      .toBe("Examples");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".search-active-mode")).toContainText("OR");
    await query.fill("1.html");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const clear = page.locator(".search-clear");
    const qbox = (await query.boundingBox())!,
      cbox = (await clear.boundingBox())!;
    expect(cbox.x + cbox.width).toBeLessThanOrEqual(qbox.x + qbox.width);
    expect(cbox.x).toBeGreaterThan(qbox.x + qbox.width / 2);
    await clear.click();
    await expect(query).toHaveValue("");
    await expect(query).toBeFocused();
    await toggle.focus();
    await toggle.press("Space");
    await expect(page.getByRole("radio", { name: text.or, exact: true })).toBeChecked();
    await query.fill("0.html");
    await page.getByRole("button", { name: text.reset, exact: true }).click();
    await expect(query).toHaveValue("0.html");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("radio", { name: text.and, exact: true })).toBeChecked();
    await expect(page.locator(".search-scope")).toHaveCount(0);
    await folder.click();
    await folder.fill("Examples");
    await folder.press("Enter");
    await page.getByRole("radio", { name: text.or, exact: true }).check();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const stored = JSON.parse(
            localStorage.getItem("my-knowledge.search-preferences") || "{}",
          );
          return [stored.detailsOpen, stored.mode, stored.roots?.[0]?.path];
        }),
      )
      .toEqual([true, "or", "Examples"]);
    await page.getByRole("button", { name: text.files, exact: true }).click();
    await page.getByRole("button", { name: text.search, exact: true }).click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(query).toHaveValue("0.html");
    expect(await frame.evaluate((element, original) => element === original, original)).toBe(true);
    await expect(frame.contentFrame().getByRole("textbox")).toHaveValue(
      "search options keep input",
    );
    expect(
      await frame
        .contentFrame()
        .getByRole("button", { name: "Draw" })
        .evaluate(
          () => (window as unknown as { runtimeState: { count: number } }).runtimeState.count,
        ),
    ).toBe(1);
    await page.getByRole("separator").press("Home");
    expect((await query.boundingBox())!.width).toBeGreaterThan(155);
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      expect(
        await page
          .locator(".document-search")
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      await page.screenshot({
        path: test.info().outputPath(`search-details-${language}-${colorScheme}-230.png`),
      });
    }
    await page.reload();
    await page.getByRole("button", { name: text.search, exact: true }).click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(query).toHaveValue("");
    await expect(folder).toHaveValue("Examples");
    await expect(page.getByRole("radio", { name: text.or, exact: true })).toBeChecked();
    await expect(page.getByRole("radio")).toHaveCount(2);
    await page.setViewportSize({ width: 320, height: 640 });
    await page.screenshot({ path: test.info().outputPath(`search-details-${language}-320.png`) });
  });
}

for (const [platform, primary, other] of [
  ["Win32", "Control", "Meta"],
  ["MacIntel", "Meta", "Control"],
]) {
  test(`Show Files uses ${platform} Shift+E and preserves live HTML and search settings`, async ({
    page,
  }) => {
    await page.addInitScript(
      (platform) => Object.defineProperty(navigator, "platform", { value: platform }),
      platform,
    );
    await page.setViewportSize({ width: 1000, height: 700 });
    await prepare(page, false, false, undefined, true);
    await openDocument(page, 0);
    const tree = page.getByRole("tree");
    const frame = page.locator('iframe[title="Examples/0.html"]');
    const original = await frame.elementHandle();
    await frame.contentFrame().getByRole("textbox").fill("files shortcut preserves input");
    const draw = frame.contentFrame().getByRole("button", { name: "Draw" });
    await draw.click();
    await page.getByRole("button", { name: "文書検索", exact: true }).click();
    const query = page.getByRole("searchbox");
    await query.fill("0.html");
    await page.getByRole("button", { name: "検索の詳細設定" }).click();
    await page.getByRole("radio", { name: "OR（いずれかの語）" }).check();
    await query.press(primary + "+Shift+e");
    await expect(query).toBeFocused();
    await expect(tree).toBeHidden();
    await page.getByRole("button", { name: "文書検索", exact: true }).focus();
    await page.keyboard.press(other + "+Shift+e");
    await expect(tree).toBeHidden();
    await page.getByRole("button", { name: "左メニューを閉じる" }).click();
    await draw.focus();
    await draw.press(primary + "+Shift+e");
    await expect(tree).toBeVisible();
    await expect(tree).toBeFocused();
    await expect(page.getByRole("button", { name: "ファイル", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByRole("button", { name: "ファイル", exact: true })).toHaveAttribute(
      "title",
      new RegExp((platform === "MacIntel" ? "Cmd" : "Ctrl") + "\\+Shift\\+E"),
    );
    await page.getByRole("button", { name: "文書検索", exact: true }).click();
    await expect(query).toHaveValue("0.html");
    await expect(page.getByRole("button", { name: "検索の詳細設定" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await draw.evaluate(() => {
      const cancel = (event: KeyboardEvent) => {
        if (event.key.toLowerCase() === "e") {
          event.preventDefault();
          window.removeEventListener("keydown", cancel);
        }
      };
      window.addEventListener("keydown", cancel);
    });
    await draw.focus();
    await draw.press(primary + "+Shift+e");
    await page.waitForTimeout(80); // Observe rejection after the deferred document proposal.
    await expect(tree).toBeHidden();
    await draw.press(primary + "+Shift+e");
    await expect(tree).toBeFocused();
    expect(await frame.evaluate((element, original) => element === original, original)).toBe(true);
    await expect(frame.contentFrame().getByRole("textbox")).toHaveValue(
      "files shortcut preserves input",
    );
    expect(
      await draw.evaluate(
        () => (window as unknown as { runtimeState: { count: number } }).runtimeState.count,
      ),
    ).toBe(1);
    await page.getByRole("button", { name: "機能と使い方", exact: true }).click();
    const help = page.locator(".app-help-frame").contentFrame();
    await expect(help.getByText("Ctrl+Shift+E", { exact: true })).toBeAttached();
    await expect(help.getByText("Cmd+Shift+E", { exact: true })).toBeAttached();
  });
}

for (const [platform, primary] of [
  ["Win32", "Control"],
  ["MacIntel", "Meta"],
]) {
  test(`active tab close shortcut respects HTML priority and preserves the app on ${platform}`, async ({
    page,
  }) => {
    await page.addInitScript(
      (platform) => Object.defineProperty(navigator, "platform", { value: platform }),
      platform,
    );
    await prepare(page, false, false, undefined, true);
    await openDocument(page, 0);
    await openDocument(page, 1);
    await page.getByRole("tab", { name: "1.html", exact: true }).press("Shift+F10");
    await page.getByRole("menuitem", { name: "右の列へ移動", exact: true }).click();
    const retained = page.locator('iframe[title="Examples/0.html"]');
    const original = await retained.elementHandle();
    const right = page.locator('iframe[title="Examples/1.html"]').contentFrame();
    const input = right.getByRole("textbox");
    await input.fill("protected editor");
    await input.press(primary + "+w");
    await expect(page.getByRole("tab", { name: "1.html", exact: true })).toBeVisible();
    const draw = right.getByRole("button", { name: "Draw" });
    await draw.click();
    await draw.evaluate(() => {
      const cancel = (event: KeyboardEvent) => {
        if (event.key.toLowerCase() !== "w") return;
        event.preventDefault();
        window.removeEventListener("keydown", cancel);
      };
      window.addEventListener("keydown", cancel);
    });
    await draw.press(primary + "+w");
    await page.waitForTimeout(60); // Observe late HTML cancellation across the proposal task.
    await expect(page.getByRole("tab", { name: "1.html", exact: true })).toBeVisible();
    await draw.press(primary + "+w");
    await expect(page.getByRole("tab", { name: "1.html", exact: true })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "0.html", exact: true })).toBeFocused();
    await expect(page.locator(".document-stage")).not.toHaveClass(/split/);
    expect(await retained.evaluate((element, original) => element === original, original)).toBe(
      true,
    );
    expect(await page.evaluate("window.layoutCalls.close")).toBe(1);
    const tree = page.getByRole("tree");
    await tree.focus();
    await tree.press(primary + "+Shift+t");
    await expect(page.getByRole("tab", { name: "1.html", exact: true })).toBeVisible();
    await expect(
      page.locator('iframe[title="Examples/1.html"]').contentFrame().getByRole("textbox"),
    ).toHaveValue("initial");
    await tree.focus();
    await page.keyboard.down(primary);
    await page.keyboard.down("w");
    await expect(page.getByRole("tab", { name: "1.html", exact: true })).toHaveCount(0);
    await page.keyboard.down("w");
    await page.keyboard.up("w");
    await page.keyboard.up(primary);
    await expect(page.getByRole("tab", { name: "0.html", exact: true })).toBeVisible();
    expect(await page.evaluate("window.layoutCalls.close")).toBe(2);
    await page.getByRole("tab", { name: "0.html", exact: true }).press(primary + "+w");
    await expect(page.getByRole("tab")).toHaveCount(0);
    await expect(page.locator(".app")).toBeVisible();
    await expect(page.locator(".titlebar-controls > .menu-toggle")).toBeFocused();
    await page.locator(".titlebar-controls > .menu-toggle").press(primary + "+w");
    expect(await page.evaluate("window.layoutCalls.close")).toBe(3);
  });
}
