import { expect, test } from "@playwright/test";

for (const variant of [
  { language: "ja", platform: "windows", scheme: "dark" },
  { language: "en", platform: "macos", scheme: "light" },
] as const) {
  test(`manual update settings fit narrow screens (${variant.language}, ${variant.platform})`, async ({
    page,
  }) => {
    await page.addInitScript(
      (language) => localStorage.setItem("my-knowledge.ui-language", language),
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
        import { SettingsDialog } from '/src/app/SettingsDialog.tsx';
        const initial={revision:0,phase:'idle',currentVersion:'0.7.5',disabledReason:null,release:null,downloadedBytes:0,totalBytes:null,error:null};
        window.updateCalls={check:0,download:0,restart:0};
        const release={version:'0.8.0',notes:'Fixture release\\n'+ 'long-note-'.repeat(90) + '\\n<script>window.invalid=true</script>'};
        const api={status:async()=>initial,subscribe:async()=>()=>{},
          check:async()=>{window.updateCalls.check++;return {...initial,revision:1,phase:'available',release};},
          download:async()=>{window.updateCalls.download++;return {...initial,revision:2,phase:'ready',release};},
          cancel:async()=>({...initial,revision:3,phase:'cancelled'}),
          restart:async()=>{window.updateCalls.restart++;return {...initial,revision:4,phase:'installing',release};}};
        export function App(){return React.createElement(SettingsDialog,{platform:${JSON.stringify(variant.platform)},returnFocus:null,onClose:()=>{},updateApi:api});}
      `,
      });
    });
    await page.emulateMedia({ colorScheme: variant.scheme });
    await page.setViewportSize({ width: 760, height: 500 });
    await page.goto("/");
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("button", {
        name: variant.language === "ja" ? "アプリの更新" : "App updates",
        exact: true,
      })
      .click();
    const check = dialog.getByRole("button", {
      name: variant.language === "ja" ? "更新を確認" : "Check for updates",
      exact: true,
    });
    await expect(check).toBeEnabled();
    await page.screenshot({
      path: test.info().outputPath(`updater-${variant.language}-initial.png`),
    });
    expect(await page.evaluate("window.updateCalls")).toEqual({
      check: 0,
      download: 0,
      restart: 0,
    });
    await check.click();
    await dialog
      .getByRole("button", {
        name: variant.language === "ja" ? "ダウンロードして更新" : "Download update",
        exact: true,
      })
      .click();
    const restart = dialog.getByRole("button", {
      name: variant.language === "ja" ? "再起動して更新を適用" : "Restart and apply update",
      exact: true,
    });
    await expect(restart).toBeDisabled();
    for (const size of [
      { width: 760, height: 500 },
      { width: 320, height: 420 },
    ]) {
      await page.setViewportSize(size);
      const panel = dialog.getByRole("region");
      expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      await restart.scrollIntoViewIfNeeded();
      const bounds = (await restart.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(size.width);
      await page.screenshot({
        path: test.info().outputPath(`updater-${variant.language}-${size.width}.png`),
      });
    }
    await dialog.getByRole("checkbox").check();
    await expect(restart).toBeEnabled();
    await restart.click();
    expect(await page.evaluate("window.updateCalls")).toEqual({
      check: 1,
      download: 1,
      restart: 1,
    });
    expect(await page.evaluate("window.invalid")).toBeUndefined();
  });
}
