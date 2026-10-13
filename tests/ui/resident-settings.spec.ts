import { expect, test, type Page } from "@playwright/test";

const pinnedName = "日本語 <img onerror=fail> $& {path} " + "長い名前".repeat(10) + ".html";

async function prepareResidentSettings(page: Page) {
  await page.route("**/src/app/App.tsx", async (route) => {
    const source = await (await route.fetch()).text();
    const react = source.match(/from\s+["']([^"']*\/react\.js[^"']*)["']/)?.[1];
    if (!react) throw new Error("Vite did not resolve React");
    await route.fulfill({
      contentType: "application/javascript",
      body: `
        import React from ${JSON.stringify(react)};
        import { SidebarFooter } from '/src/app/SidebarFooter.tsx';
        import { residentApi } from '/src/lib/resident.ts';
        const name = ${JSON.stringify(pinnedName)};
        const document = {identity:'a'.repeat(64),relativePath:name};
        const state = {selectedPath:name,loading:false,actionBusy:false,snapshot:{workspaceId:'root',viewId:'view',revision:7}};
        let status = {enabled:false,trayAvailable:false,startupEnabled:false,startupRegistered:false,target:{kind:'current'},shortcut:{kind:'standard'},monitorStatus:'off',supported:true,readOnly:false,error:null};
        window.residentCalls = {status:0,actions:[],resolve:0};
        residentApi.status = async () => {window.residentCalls.status++; return {...status};};
        residentApi.update = async action => {
          window.residentCalls.actions.push({...action});
          if (action.kind === 'enabled') status = {...status,enabled:action.enabled,trayAvailable:action.enabled,monitorStatus:action.enabled?'permission-required':'off',error:null};
          else if (action.kind === 'checkPermission') status = {...status,monitorStatus:'active'};
          else if (action.kind === 'startup') status = {...status,startupEnabled:action.enabled,startupRegistered:action.enabled?true:null};
          else if (action.kind === 'pin') status = {...status,target:{kind:'pinned',rootIdentity:'b'.repeat(64),document}};
          else if (action.kind === 'current') status = {...status,target:{kind:'current'}};
          else if (action.kind === 'shortcut') status = window.residentShortcutError
            ? {...status,error:'ResidentShortcutUnavailable'}
            : {...status,shortcut:action.shortcut,error:null};
          return {...status};
        };
        residentApi.resolve = async () => {window.residentCalls.resolve++; throw new Error('Settings must not open an HTML');};
        export function App() {
          return React.createElement('aside',{className:'sidebar',style:{width:230,height:'100dvh'}},
            React.createElement('input',{'aria-label':'kept input',defaultValue:'保持する入力 $& {root}',style:{margin:12,width:190}}),
            React.createElement('div',{style:{flex:1}}),
            React.createElement(SidebarFooter,{version:'0.6.0',reloadDisabled:false,onReload:()=>{},state}));
        }
      `,
    });
  });
}

test("recording acquires focus after a pointer click and keeps Cmd distinct from Ctrl", async ({
  page,
}) => {
  await prepareResidentSettings(page);
  await page.addInitScript(() => localStorage.setItem("my-knowledge.ui-language", "en"));
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Resident mode and recall" }).click();
  const customMode = dialog.getByRole("radio", { name: "Custom simultaneous shortcut" });
  await customMode.check();
  await customMode.focus();
  const record = dialog.getByRole("button", {
    name: /^(?:Record recall shortcut|Recording… Escape to cancel)$/,
  });
  // Model macOS pointer focus policy while using a real browser key dispatch.
  await record.evaluate((button) =>
    button.addEventListener("mousedown", (event) => event.preventDefault()),
  );
  await record.click();
  await expect(record).toBeFocused();
  await page.keyboard.press("Meta+m");
  await expect(dialog.getByText("Shortcut to apply: Cmd/Win + M")).toBeVisible();
  await record.click();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await record.click();
  await page.keyboard.press("Control+m");
  await expect(dialog.getByText("Shortcut to apply: Ctrl + M")).toBeVisible();
  expect(await page.evaluate("window.residentCalls.actions")).toEqual([]);
  await record.click();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Apply recall shortcut" })).toBeFocused();
  await page.keyboard.press("Control+n");
  await expect(dialog.getByText("Shortcut to apply: Ctrl + M")).toBeVisible();
});

for (const language of ["ja", "en"] as const) {
  test(`resident preferences mount on demand and require explicit permission/startup/pin actions (${language}, synthetic Native API)`, async ({
    page,
  }) => {
    await prepareResidentSettings(page);
    await page.addInitScript(
      (value) => localStorage.setItem("my-knowledge.ui-language", value),
      language,
    );
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto("/");
    const label = (ja: string, en: string) => (language === "ja" ? ja : en);
    const input = page.getByRole("textbox", { name: "kept input" });
    const originalInput = await input.elementHandle();
    const settings = page.getByRole("button", { name: label("設定", "Settings"), exact: true });
    expect(await page.evaluate("window.residentCalls.status")).toBe(0);
    await settings.click();
    const dialog = page.getByRole("dialog");
    expect(await page.evaluate("window.residentCalls.status")).toBe(0);
    const residentCategory = dialog.getByRole("button", {
      name: label("常駐と呼び出し", "Resident mode and recall"),
      exact: true,
    });
    await residentCategory.click();
    const resident = dialog.getByRole("checkbox", {
      name: label("アプリを常駐させる", "Keep the app running"),
    });
    const startup = dialog.getByRole("checkbox", {
      name: label("OSへのログイン時にアプリを起動する", "Start the app when signing in to the OS"),
    });
    await expect(resident).toBeEnabled();
    await expect(resident).not.toBeChecked();
    await expect(startup).not.toBeChecked();
    expect(await page.evaluate("window.residentCalls.status")).toBe(1);
    expect(await page.evaluate("window.residentCalls.actions")).toEqual([]);
    const openPermission = dialog.getByRole("button", {
      name: label("入力監視の設定を開く", "Open Input Monitoring settings"),
    });
    await expect(openPermission).toHaveCount(0);
    expect(await dialog.evaluate((element) => element.parentElement === document.body)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 820 });
    await expect(
      dialog.getByRole("heading", {
        name: label("キー操作で呼び出す", "Recall with a key sequence"),
      }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("heading", { name: label("呼び出したときの表示", "View on recall") }),
    ).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`resident-${language}-1280.png`) });
    await page.setViewportSize({ width: 320, height: 700 });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
      await page.screenshot({
        path: test.info().outputPath(`resident-${language}-${scheme}-320.png`),
      });
    }
    await resident.check();
    await expect(openPermission).toBeEnabled();
    expect(await page.evaluate("window.residentCalls.actions")).toEqual([
      { kind: "enabled", enabled: true },
    ]);
    await expect(startup).not.toBeChecked();
    await openPermission.click();
    await dialog
      .getByRole("button", {
        name: label("許可後に再確認", "Check after granting permission"),
      })
      .click();
    await expect(
      dialog.getByText(label("順次キー操作を待機しています", "Waiting for the modifier sequence")),
    ).toBeVisible();
    await resident.uncheck();
    await expect(openPermission).toHaveCount(0);
    await startup.check();
    await expect(startup).toBeChecked();
    await expect(resident).not.toBeChecked();
    await startup.uncheck();
    await expect(
      dialog.getByText(
        label("OSの自動起動登録状態は不明です", "The OS autostart registration state is unknown"),
      ),
    ).toBeVisible();
    await expect(startup).not.toBeChecked();
    await dialog.getByRole("button", { name: label("このHTMLを固定", "Pin this HTML") }).click();
    await expect(dialog.locator(".resident-target")).toHaveText(
      label("固定したHTML: ", "Pinned HTML: ") + pinnedName,
    );
    expect(
      await dialog
        .getByRole("region")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await expect(dialog.locator("img")).toHaveCount(0);
    await dialog
      .getByRole("button", {
        name: label("固定を解除", "Unpin"),
      })
      .click();
    await expect(dialog.locator(".resident-target")).toHaveText(
      label("呼び出し時の表示を保持", "Keep the view on recall"),
    );
    expect(await page.evaluate("window.residentCalls.actions")).toEqual([
      { kind: "enabled", enabled: true },
      { kind: "openPermissionSettings" },
      { kind: "checkPermission" },
      { kind: "enabled", enabled: false },
      { kind: "startup", enabled: true },
      { kind: "startup", enabled: false },
      { kind: "pin", workspaceId: "root", viewId: "view", revision: 7, relativePath: pinnedName },
      { kind: "current" },
    ]);
    await dialog
      .getByRole("radio", { name: label("カスタムの同時押し", "Custom simultaneous shortcut") })
      .check();
    const record = dialog.getByRole("button", {
      name: label("呼び出しキーを記録", "Record recall shortcut"),
    });
    await record.click();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(record).toBeVisible();
    await record.click();
    await page.keyboard.press("Control+Alt+m");
    await expect(
      dialog.getByText(label("適用するキー: Ctrl + Alt + M", "Shortcut to apply: Ctrl + Alt + M")),
    ).toBeVisible();
    expect(await page.evaluate("window.residentCalls.actions.length")).toBe(8);
    await page.evaluate("window.residentShortcutError = true");
    const applyShortcut = dialog.getByRole("button", {
      name: label("呼び出しキーを適用", "Apply recall shortcut"),
    });
    await applyShortcut.click();
    await expect(
      dialog.getByText(
        label(
          "呼び出しキーを登録できません。別の組み合わせを選んでください",
          "Cannot register the recall shortcut. Choose a different combination.",
        ),
      ),
    ).toBeVisible();
    await expect(
      dialog.getByText(
        label(
          "有効な呼び出しキー: 標準の順次押し",
          "Effective shortcut: standard modifier sequence",
        ),
      ),
    ).toBeVisible();
    await page.evaluate("window.residentShortcutError = false");
    await applyShortcut.click();
    await expect(
      dialog.getByText(
        label("有効な呼び出しキー: Ctrl + Alt + M", "Effective shortcut: Ctrl + Alt + M"),
      ),
    ).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`resident-custom-${language}-320.png`) });
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await dialog
      .getByRole("radio", { name: label("標準の順次押し", "Standard modifier sequence") })
      .check();
    await dialog
      .getByRole("button", { name: label("標準の順次押しに戻す", "Restore standard sequence") })
      .click();
    await expect(
      dialog.getByText(
        label(
          "有効な呼び出しキー: 標準の順次押し",
          "Effective shortcut: standard modifier sequence",
        ),
      ),
    ).toBeVisible();
    expect(await page.evaluate("window.residentCalls.resolve")).toBe(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(settings).toBeFocused();
    await expect(input).toHaveValue("保持する入力 $& {root}");
    expect(await input.evaluate((element, before) => element === before, originalInput)).toBe(true);
  });
}
