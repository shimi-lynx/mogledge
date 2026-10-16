import { expect, test } from "@playwright/test";

// Chromium renders both platform variants; this does not simulate Native OS behavior.
test.use({ deviceScaleFactor: 2 });

for (const variant of [
  { platform: "windows", language: "ja", scheme: "dark" },
  { platform: "windows", language: "en", scheme: "light" },
  { platform: "macos", language: "ja", scheme: "light" },
  { platform: "macos", language: "en", scheme: "dark" },
] as const) {
  test(`settings layout follows the viewport (${variant.platform}, ${variant.language}, ${variant.scheme}, Chromium 2x)`, async ({
    page,
  }) => {
    await page.addInitScript(
      (language) => localStorage.setItem("mogledge.ui-language", language),
      variant.language,
    );
    await page.route("**/src/app/App.tsx", async (route) => {
      const source = await (await route.fetch()).text();
      const reactModule = source.match(/from\s+["']([^"']*\/react\.js[^"']*)["']/)?.[1];
      if (!reactModule) throw new Error("Vite did not resolve React");
      await route.fulfill({
        contentType: "application/javascript",
        body: `
          import React from ${JSON.stringify(reactModule)};
          import { SidebarFooter } from '/src/app/SidebarFooter.tsx';
          window.settingsReloadCalls=0;
          export function App(){return React.createElement(SidebarFooter,{
            platform:${JSON.stringify(variant.platform)},version:'0.6.0',reloadDisabled:true,
            onReload:()=>{window.settingsReloadCalls++;}
          });}
        `,
      });
    });
    await page.emulateMedia({ colorScheme: variant.scheme });
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.goto("/");
    const settings = page.getByRole("button", {
      name: variant.language === "ja" ? "設定" : "Settings",
      exact: true,
    });
    await settings.click();
    const dialog = page.getByRole("dialog");
    const originalDialog = await dialog.elementHandle();
    const select = dialog.getByRole("combobox");
    const originalSelect = await select.elementHandle();
    const first = dialog.getByRole("navigation").getByRole("button").first();
    const close = dialog.getByRole("button", {
      name: variant.language === "ja" ? "閉じる" : "Close",
      exact: true,
    });
    await expect(first).toBeFocused();
    if (variant.platform === "macos") {
      await first.press("Shift+Tab");
      await expect(close).toBeFocused();
      await close.press("Tab");
      await expect(first).toBeFocused();
    }
    const normal = (await dialog.boundingBox())!;
    expect(normal.width).toBeGreaterThan(660);
    expect(normal.height).toBeGreaterThan(420);

    for (const viewport of [
      { width: 1280, height: 820 },
      { width: 2560, height: 1440 },
      { width: 760, height: 500 },
      { width: 320, height: 360 },
    ]) {
      await page.setViewportSize(viewport);
      const bounds = (await dialog.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(15);
      expect(bounds.y).toBeGreaterThanOrEqual(15);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width - 15);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height - 15);
      expect(bounds.width).toBeLessThanOrEqual(960);
      expect(bounds.height).toBeLessThanOrEqual(720);
      if (viewport.width === 1280) {
        expect(bounds.width).toBeGreaterThan(normal.width);
        expect(bounds.height).toBeGreaterThan(normal.height);
      }
      const nav = (await dialog.getByRole("navigation").boundingBox())!;
      const panel = (await dialog.getByRole("region").boundingBox())!;
      expect(nav.x + nav.width).toBeLessThanOrEqual(panel.x + 1);
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      const closeBounds = (await close.boundingBox())!;
      expect(closeBounds.y).toBeGreaterThanOrEqual(bounds.y);
      expect(closeBounds.y + closeBounds.height).toBeLessThanOrEqual(bounds.y + bounds.height);
      if (variant.platform === "windows") {
        const icon = (await close.locator("svg").boundingBox())!;
        expect(
          Math.abs(icon.x + icon.width / 2 - (closeBounds.x + closeBounds.width / 2)),
        ).toBeLessThan(1);
        expect(
          Math.abs(icon.y + icon.height / 2 - (closeBounds.y + closeBounds.height / 2)),
        ).toBeLessThan(1);
      } else {
        await expect(dialog.locator("header button")).toHaveCount(0);
        await expect(close).toHaveText(variant.language === "ja" ? "閉じる" : "Close");
      }
      if (viewport.width === 1280 || viewport.width === 320)
        await page.screenshot({
          path: test
            .info()
            .outputPath(
              `settings-${variant.platform}-${variant.language}-${viewport.width}-2x.png`,
            ),
        });
    }
    expect(await page.evaluate(() => devicePixelRatio)).toBe(2);
    expect(await dialog.evaluate((element, original) => element === original, originalDialog)).toBe(
      true,
    );
    expect(await select.evaluate((element, original) => element === original, originalSelect)).toBe(
      true,
    );
    await close.focus();
    await close.press("Tab");
    // Header close is first on Windows; footer close is last on Mac.
    await expect(first).toBeFocused();
    await select.focus();
    await select.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(settings).toBeFocused();
    await settings.click();
    await close.click();
    await expect(dialog).toHaveCount(0);
    await expect(settings).toBeFocused();
    expect(await page.evaluate("window.settingsReloadCalls")).toBe(0);
  });
}
