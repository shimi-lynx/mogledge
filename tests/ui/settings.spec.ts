import { expect, test, type Page } from "@playwright/test";

async function prepareSettings(page: Page) {
  await page.route("**/src/app/App.tsx", async (route) => {
    const source = await (await route.fetch()).text();
    const reactModule = source.match(/from\s+["']([^"']*\/react\.js[^"']*)["']/)?.[1];
    if (!reactModule) throw new Error("Vite did not resolve React");
    await route.fulfill({
      contentType: "application/javascript",
      body: `
        import React from ${JSON.stringify(reactModule)};
        import { SidebarFooter } from '/src/app/SidebarFooter.tsx';
        window.settingsReloadCalls = 0;
        export function App() {
          return React.createElement('aside', {className:'sidebar', style:{width:230,height:'100dvh'}},
            React.createElement('input',{ 'aria-label':'利用者入力', defaultValue:'',style:{margin:12,width:190} }),
            React.createElement('div',{style:{flex:1}}),
            React.createElement(SidebarFooter,{version:'0.6.0',reloadDisabled:false,onReload:()=>{window.settingsReloadCalls++;}}));
        }
      `,
    });
  });
}

test("settings uses English for missing or invalid preferences on a Japanese navigator and preserves saved Japanese (component fixture)", async ({
  page,
}) => {
  await prepareSettings(page);
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "language", { value: "ja-JP", configurable: true }),
  );
  await page.goto("/");
  const dialog = page.getByRole("dialog");
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await expect(dialog.getByRole("combobox")).toHaveValue("ja");
  await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await expect(dialog.getByRole("combobox")).toHaveValue("ja");
  for (const invalid of ["invalid", ""]) {
    await page.evaluate(
      (value) => localStorage.setItem("my-knowledge.ui-language", value),
      invalid,
    );
    await page.reload();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(dialog.getByRole("combobox")).toHaveValue("en");
  }
  await page.evaluate(() => localStorage.removeItem("my-knowledge.ui-language"));
  await page.reload();
  expect(await page.evaluate(() => navigator.language)).toBe("ja-JP");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(dialog.getByRole("combobox")).toHaveValue("en");
});

for (const scheme of ["light", "dark"] as const) {
  test(`settings footer and two-column language dialog keep state and keyboard focus (${scheme}, component fixture)`, async ({
    page,
  }) => {
    await prepareSettings(page);
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/");
    await page.evaluate(() => localStorage.removeItem("my-knowledge.ui-language"));
    await page.reload();
    const input = page.getByRole("textbox", { name: "利用者入力" });
    await input.fill("日本語の入力 $& {path}");
    const originalInput = await input.elementHandle();
    const footer = page.locator(".sidebar-footer");
    await expect(footer.locator(".sidebar-version")).toHaveText("v0.6.0");
    await expect(page.getByText("v0.6.0", { exact: true })).toHaveCount(1);
    await expect(footer).not.toContainText("documents");
    const versionBounds = (await footer.locator(".sidebar-version").boundingBox())!;
    const reloadBounds = (await footer
      .getByRole("button", { name: "Rescan", exact: true })
      .boundingBox())!;
    const settingsButton = footer.locator("button").last();
    await expect(settingsButton).toHaveAccessibleName("Settings");
    const settingsBounds = (await settingsButton.boundingBox())!;
    expect(versionBounds.x + versionBounds.width).toBeLessThan(reloadBounds.x);
    expect(reloadBounds.x + reloadBounds.width).toBeLessThanOrEqual(settingsBounds.x);
    await settingsButton.focus();
    await settingsButton.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toHaveAccessibleName("Settings");
    await expect(dialog.getByRole("button", { name: "Choose display language" })).toBeFocused();
    const categories = dialog.getByRole("navigation").getByRole("button");
    for (let index = 1; index < (await categories.count()); index++) {
      await page.keyboard.press("Tab");
      await expect(categories.nth(index)).toBeFocused();
    }
    await page.keyboard.press("Tab");
    const select = dialog.getByRole("combobox");
    await expect(select).toBeFocused();
    await expect(select).toHaveValue("en");
    await select.selectOption("ja");
    await page.screenshot({ path: test.info().outputPath(`settings-ja-${scheme}-1000.png`) });
    const originalDialog = await dialog.elementHandle();
    await select.selectOption("en");
    await expect(dialog).toHaveAccessibleName("Settings");
    await expect(select).toHaveAccessibleName("Choose display language");
    await expect(select).toBeFocused();
    expect(await dialog.evaluate((element, original) => element === original, originalDialog)).toBe(
      true,
    );
    expect(await page.evaluate("window.settingsReloadCalls")).toBe(0);
    await expect(input).toHaveValue("日本語の入力 $& {path}");
    expect(await input.evaluate((element, original) => element === original, originalInput)).toBe(
      true,
    );
    await page.screenshot({ path: test.info().outputPath(`settings-en-${scheme}-1000.png`) });
    await page.setViewportSize({ width: 320, height: 500 });
    const nav = dialog.getByRole("navigation");
    const panel = dialog.getByRole("region");
    const navBounds = (await nav.boundingBox())!;
    const panelBounds = (await panel.boundingBox())!;
    expect(navBounds.x + navBounds.width).toBeLessThanOrEqual(panelBounds.x + 1);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    await page.screenshot({ path: test.info().outputPath(`settings-en-${scheme}-320.png`) });
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(select).toBeFocused();
    await select.selectOption("ja");
    await page.screenshot({ path: test.info().outputPath(`settings-ja-${scheme}-320.png`) });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(settingsButton).toBeFocused();
    await settingsButton.click();
    await expect(dialog).toBeVisible();
    await page.mouse.click(2, 2);
    await expect(dialog).toHaveCount(0);
    await expect(settingsButton).toBeFocused();
    expect(await page.evaluate("window.settingsReloadCalls")).toBe(0);
    await settingsButton.click();
    await dialog.getByRole("combobox").selectOption("en");
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await page.reload();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(dialog.getByRole("combobox", { name: "Choose display language" })).toHaveValue(
      "en",
    );
  });
}
