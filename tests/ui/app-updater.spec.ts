import { expect, test } from "@playwright/test";

for (const variant of [
  { language: "ja", platform: "windows", scheme: "dark" },
  { language: "en", platform: "macos", scheme: "light" },
] as const) {
  test(`manual update settings fit narrow screens (${variant.language}, ${variant.platform})`, async ({
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
        import { SettingsDialog } from '/src/app/SettingsDialog.tsx';
        const initial={revision:0,phase:'idle',currentVersion:'0.7.5',disabledReason:null,release:null,downloadedBytes:0,totalBytes:null,error:null};
        window.updateCalls={check:0,download:0,restart:0,help:[]};
        const release={version:'0.8.0',notes:'Fixture release\\n'+ 'long-note-'.repeat(90) + '\\n<script>window.invalid=true</script>'};
        const api={status:async()=>initial,subscribe:async()=>()=>{},
          check:async()=>{window.updateCalls.check++;return {...initial,revision:1,phase:'available',release};},
          download:async()=>{window.updateCalls.download++;return {...initial,revision:2,phase:'ready',release};},
          cancel:async()=>({...initial,revision:3,phase:'cancelled'}),
          restart:async()=>{window.updateCalls.restart++;return {...initial,revision:4,phase:'error',release,error:'UpdatePreviousAppNotRestored'};},
          openHelp:async(destination)=>{window.updateCalls.help.push(destination);throw new Error('/private/fixture');}};
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
      help: [],
    });
    await check.click();
    await dialog
      .getByRole("button", {
        name: variant.language === "ja" ? "ダウンロードして更新" : "Download update",
        exact: true,
      })
      .click();
    const restart = dialog.getByRole("button", {
      name: variant.language === "ja" ? "更新して再起動" : "Update and restart",
      exact: true,
    });
    await expect(restart).toBeEnabled();
    await expect(dialog.getByRole("checkbox")).toHaveCount(0);
    await expect(
      dialog.getByText(
        variant.language === "ja"
          ? "未保存の入力は失われます。必要な内容を保存してから更新してください。"
          : "Unsaved inputs will be lost. Save what you need before updating.",
      ),
    ).toBeVisible();
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
    await expect(restart).toBeEnabled();
    await restart.click();
    const recovery = dialog.getByRole("alert");
    await expect(recovery).toContainText(
      variant.language === "ja"
        ? "旧アプリを元の場所へ戻せません"
        : "previous app could not be restored",
    );
    await expect(
      dialog.getByRole("button", {
        name: variant.language === "ja" ? "更新して再起動" : "Update and restart",
        exact: true,
      }),
    ).toHaveCount(0);
    const manual = dialog.getByRole("button", {
      name:
        variant.language === "ja"
          ? "手動更新・復旧の案内を開く"
          : "Open manual update and recovery guide",
      exact: true,
    });
    await manual.scrollIntoViewIfNeeded();
    const helpBounds = (await manual.boundingBox())!;
    expect(helpBounds.x).toBeGreaterThanOrEqual(0);
    expect(helpBounds.x + helpBounds.width).toBeLessThanOrEqual(320);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: test.info().outputPath(`updater-${variant.language}-recovery.png`),
    });
    await manual.click();
    await expect(dialog.getByRole("alert")).toHaveCount(2);
    await expect(dialog.getByRole("alert").first()).toContainText(
      variant.language === "ja"
        ? "旧アプリを元の場所へ戻せません"
        : "previous app could not be restored",
    );
    await expect(dialog).not.toContainText("/private/fixture");
    expect(await page.evaluate("window.updateCalls")).toEqual({
      check: 1,
      download: 1,
      restart: 1,
      help: ["manual"],
    });
    expect(await page.evaluate("window.invalid")).toBeUndefined();
  });
}
