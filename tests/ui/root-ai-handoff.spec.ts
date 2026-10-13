import { expect, test } from "@playwright/test";

for (const language of ["ja", "en"] as const) {
  test(`root AI context and live language ${language} preserve paths and input (mock Native)`, async ({
    page,
  }) => {
    const text =
      language === "ja"
        ? {
            action: "AIに渡す",
            copy: "依頼文をコピー",
            copied: "依頼文をコピーしました",
            input: "依頼文（任意）",
            destination: "連携先",
          }
        : {
            action: "Send to AI",
            copy: "Copy request",
            copied: "Request copied",
            input: "Request (optional)",
            destination: "Destination",
          };
    await page.addInitScript(
      (value) => localStorage.setItem("my-knowledge.ui-language", value),
      language,
    );
    await page.route("**/src/app/App.tsx", async (route) => {
      const source = await (await route.fetch()).text();
      const reactModule = source.match(/from\s+["']([^"']*\/react\.js[^"']*)["']/)?.[1];
      if (!reactModule) throw new Error("Vite did not resolve React");
      await route.fulfill({
        contentType: "application/javascript",
        body: `
      import React from ${JSON.stringify(reactModule)};
      import {RootAiHandoffMenu} from '/src/app/RootAiHandoffMenu.tsx';
      import AiHandoffDialog from '/src/app/AiHandoffDialog.tsx';
      import {setLanguage} from '/src/lib/i18n.ts';
      window.setRootLanguage=setLanguage;
      window.rootAiCalls=[]; window.rootChooseCount=0;
      const api={prepare:async context=>{window.rootAiCalls.push({prepare:context});return{selectedPath:'/fixture/日本語ルート',workingDirectory:'/fixture/日本語ルート',revision:1,kind:'folder'};},perform:async request=>window.rootAiCalls.push({perform:request})};
      export function App(){
        const [context,setContext]=React.useState(null);
        const [disabled,setDisabled]=React.useState(false);
        const [view,setView]=React.useState('view');
        React.useEffect(()=>setContext(null),[view]);
        return React.createElement(React.Fragment,null,
          React.createElement('aside',{className:'sidebar',style:{width:220}},
            React.createElement('div',{className:'sidebar-toolbar'},
              React.createElement(RootAiHandoffMenu,{disabled,contextKey:'workspace:'+view,onAiHandoff:returnFocus=>setContext({context:{workspaceId:'workspace',viewId:view,target:'root'},returnFocus})},
                React.createElement('button',{className:'workspace-button',onClick:()=>window.rootChooseCount++},'日本語ルート')))),
          React.createElement('div',{style:{marginLeft:350}},
            React.createElement('button',{onClick:()=>setDisabled(!disabled)},'操作可否を切替'),
            React.createElement('button',{onClick:()=>setView('new-view')},'ルート切替')),
          context&&React.createElement(AiHandoffDialog,{...context,api,onClose:()=>setContext(null)}));
      }
      `,
      });
    });
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    const root = page.getByRole("button", { name: "日本語ルート", exact: true });
    await root.click();
    expect(
      await page.evaluate(() => (window as unknown as { rootChooseCount: number }).rootChooseCount),
    ).toBe(1);
    await root.click({ button: "right" });
    const action = page.getByRole("menuitem", { name: text.action, exact: true });
    await expect(action).toBeFocused();
    await page.screenshot({ path: test.info().outputPath(`root-ai-${language}-light-mock.png`) });
    const light = await page
      .getByRole("menu")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    await page.emulateMedia({ colorScheme: "dark" });
    await expect
      .poll(() =>
        page.getByRole("menu").evaluate((element) => getComputedStyle(element).backgroundColor),
      )
      .not.toBe(light);
    await page.screenshot({ path: test.info().outputPath(`root-ai-${language}-dark-mock.png`) });
    await action.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: text.copy })).toBeEnabled();
    await expect(dialog.getByRole("textbox")).toHaveAccessibleDescription(
      language === "ja" ? /本文なしで開きます/ : /open an empty draft/,
    );
    await expect(dialog).not.toContainText("/fixture/");
    await dialog.getByRole("button", { name: text.copy }).click();
    await expect(dialog.getByRole("status")).toContainText(text.copied);
    const calls = await page.evaluate(
      () =>
        (window as unknown as { rootAiCalls: { prepare?: unknown; perform?: unknown }[] })
          .rootAiCalls,
    );
    expect(calls).toEqual([
      { prepare: { workspaceId: "workspace", viewId: "view", target: "root" } },
      {
        perform: {
          context: { workspaceId: "workspace", viewId: "view", target: "root" },
          preview: {
            selectedPath: "/fixture/日本語ルート",
            workingDirectory: "/fixture/日本語ルート",
            revision: 1,
            kind: "folder",
          },
          instruction: "",
          destination: "codexApp",
          copy: true,
        },
      },
    ]);
    for (const destination of ["codexApp", "claudeApp", "claudeCli"]) {
      await dialog.getByRole("combobox", { name: text.destination }).selectOption(destination);
      const send = dialog.getByRole("button", { name: text.action, exact: true });
      await expect(send).toBeEnabled();
      await send.click();
      await expect(dialog.getByRole("status")).toContainText(
        language === "ja" ? "OSに開く操作を依頼" : "An open request was sent to the OS",
      );
      const last = await page.evaluate(() =>
        (window as unknown as { rootAiCalls: { perform?: unknown }[] }).rootAiCalls.at(-1),
      );
      expect(last).toEqual({
        perform: {
          context: { workspaceId: "workspace", viewId: "view", target: "root" },
          preview: {
            selectedPath: "/fixture/日本語ルート",
            workingDirectory: "/fixture/日本語ルート",
            revision: 1,
            kind: "folder",
          },
          instruction: "",
          destination,
          copy: false,
        },
      });
    }
    await dialog.getByRole("combobox", { name: text.destination }).selectOption("codexCli");
    await expect(dialog.getByRole("button", { name: text.action, exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("textbox")).toHaveAccessibleDescription(
      language === "ja" ? /コピーにはフォルダーパスを含めます/ : /Copies include the folder path/,
    );
    const input = dialog.getByRole("textbox", { name: text.input });
    const instruction =
      " /fixture/日本語ルート\n日本語の依頼 & ? # %\n入力と空白を維持してください ";
    await input.fill(instruction);
    await dialog.getByRole("button", { name: text.copy }).click();
    await expect(dialog.getByRole("status")).toContainText(text.copied);
    const lastCopy = await page.evaluate(() =>
      (window as unknown as { rootAiCalls: { perform?: unknown }[] }).rootAiCalls.at(-1),
    );
    expect(lastCopy).toEqual({
      perform: {
        context: { workspaceId: "workspace", viewId: "view", target: "root" },
        preview: {
          selectedPath: "/fixture/日本語ルート",
          workingDirectory: "/fixture/日本語ルート",
          revision: 1,
          kind: "folder",
        },
        instruction,
        destination: "codexCli",
        copy: true,
      },
    });
    await dialog.getByRole("combobox", { name: text.destination }).selectOption("codexApp");
    await input.focus();
    await page.emulateMedia({ colorScheme: "light" });
    await page.screenshot({
      path: test.info().outputPath(`root-ai-dialog-${language}-light-mock.png`),
    });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(input).toHaveValue(instruction);
    await expect(input).toBeFocused();
    await page.screenshot({
      path: test.info().outputPath(`root-ai-dialog-${language}-dark-mock.png`),
    });
    await page.evaluate(
      (next) => {
        (window as unknown as { setRootLanguage: (value: string) => void }).setRootLanguage(next);
      },
      language === "ja" ? "en" : "ja",
    );
    await expect(dialog.getByRole("textbox")).toHaveValue(instruction);
    await expect(dialog.getByRole("textbox")).toBeFocused();
    expect(
      await page.evaluate(
        () => (window as unknown as { rootAiCalls: unknown[] }).rootAiCalls.length,
      ),
    ).toBe(6);
    await page.evaluate((next) => {
      (window as unknown as { setRootLanguage: (value: string) => void }).setRootLanguage(next);
    }, language);
    await expect(input).toBeFocused();
    await dialog.getByRole("combobox", { name: text.destination }).selectOption("claudeCli");
    await input.fill("a".repeat(5000));
    await expect(dialog.getByRole("button", { name: text.action, exact: true })).toBeEnabled();
    await input.fill("a".repeat(5001));
    await expect(dialog.getByRole("button", { name: text.action, exact: true })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: text.copy })).toBeEnabled();
    await expect(dialog.getByRole("alert")).toContainText(
      language === "ja" ? "文字数上限" : "character limit",
    );
    await expect(input).toHaveValue("a".repeat(5001));
    await input.fill(instruction);
    await dialog.getByRole("combobox", { name: text.destination }).selectOption("codexApp");
    await page.setViewportSize({ width: 400, height: 500 });
    await dialog.getByRole("button", { name: text.copy }).scrollIntoViewIfNeeded();
    for (const button of await dialog.getByRole("button").all()) {
      const bounds = (await button.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(400);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(500);
    }
    await page.screenshot({
      path: test.info().outputPath(`root-ai-dialog-${language}-narrow-mock.png`),
    });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.keyboard.press("Escape");
    await expect(root).toBeFocused();
    await page.setViewportSize({ width: 400, height: 500 });
    await root.click({ button: "right" });
    await page.evaluate(
      (next) => {
        (window as unknown as { setRootLanguage: (value: string) => void }).setRootLanguage(next);
      },
      language === "ja" ? "en" : "ja",
    );
    await expect(page.getByRole("menuitem")).toBeFocused();
    const menuBounds = (await page.getByRole("menu").boundingBox())!;
    expect(menuBounds.x).toBeGreaterThanOrEqual(0);
    expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(400);
    expect(menuBounds.y + menuBounds.height).toBeLessThanOrEqual(500);
    await page.evaluate((next) => {
      (window as unknown as { setRootLanguage: (value: string) => void }).setRootLanguage(next);
    }, language);
    await expect(action).toBeFocused();
    await page.screenshot({ path: test.info().outputPath(`root-ai-${language}-narrow-mock.png`) });
    await page.keyboard.press("Escape");
    await expect(root).toBeFocused();
    await page.setViewportSize({ width: 1280, height: 720 });
    // Let the resize event finish before opening a new keyboard menu.
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    await root.press("Shift+F10");
    await expect(action).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(root).toBeFocused();
    await root.click({ button: "right" });
    await page.getByRole("button", { name: "ルート切替", exact: true }).click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.getByRole("button", { name: "操作可否を切替", exact: true }).click();
    await root.click({ button: "right" });
    await expect(page.getByRole("menu")).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as { rootChooseCount: number }).rootChooseCount),
    ).toBe(1);
  });
}
