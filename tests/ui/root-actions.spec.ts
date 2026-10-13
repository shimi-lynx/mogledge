import { expect, test } from "@playwright/test";

for (const language of ["ja", "en"] as const) {
  test(`root copy/open ${language} keyboard, themes and stale context (mock Native)`, async ({
    page,
  }) => {
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
        import {KnowledgeController} from '/src/lib/controller.ts';
        import {rootActionsApi} from '/src/lib/rootActions.ts';
        import {useLanguage,translateUiMessage,setLanguage} from '/src/lib/i18n.ts';
        window.setRootLanguage=setLanguage; window.rootActionCalls=[]; window.rootChooseCount=0; window.rootAiCount=0;
        let fail=false;
        let snapshot={workspaceId:'workspace',viewId:'view',rootPath:'/fixture/日本語 空白 root',nodes:[],revision:1,watchError:null};
        rootActionsApi.perform=async(context,action)=>{window.rootActionCalls.push({context,action});if(fail)throw Error('permission denied: 日本語 空白 root');};
        const controller=new KnowledgeController({beginView:async()=>snapshot,getTree:async()=>snapshot,listen:async()=>()=>{},chooseRoot:async()=>{window.rootChooseCount++;return snapshot;},refresh:async()=>snapshot});
        export function App(){
          const state=React.useSyncExternalStore(controller.subscribe,controller.getSnapshot);
          const lang=useLanguage().language;
          React.useEffect(()=>{void controller.start();return()=>controller.stop();},[]);
          return React.createElement(React.Fragment,null,
            React.createElement('aside',{className:'sidebar',style:{width:220}},
              React.createElement('div',{className:'sidebar-toolbar'},
                React.createElement(RootAiHandoffMenu,{disabled:!state.snapshot.workspaceId||state.loading||state.actionBusy,contextKey:JSON.stringify([state.snapshot.workspaceId,state.snapshot.viewId]),onAiHandoff:()=>window.rootAiCount++,onRootAction:action=>void controller.performRootAction(action)},
                  React.createElement('button',{className:'workspace-button',onClick:()=>void controller.choose()},'日本語 空白 root')))),
            React.createElement('div',{style:{marginLeft:230}},
              React.createElement('input',{defaultValue:'入力を保持', 'aria-label':'保持する入力'}),
              React.createElement('button',{onClick:()=>{fail=true;}},'Fail next OS request'),
              React.createElement('button',{onClick:()=>{snapshot={...snapshot,workspaceId:'new-root',viewId:'new-view'};void controller.refresh();}},'Change root'),
              React.createElement('button',{onClick:()=>{snapshot={...snapshot,workspaceId:null};void controller.refresh();}},'Clear root'),
              React.createElement('output',{role:'status'},state.actionMessage?translateUiMessage(state.actionMessage,lang):''),
              state.error&&React.createElement('output',{role:'alert'},translateUiMessage(state.error,lang))));
        }
      `,
      });
    });
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    const text =
      language === "ja"
        ? {
            ai: "AIに渡す",
            copy: "フルパスをコピー",
            open: "フォルダーを開く",
            copied: "フルパスをコピーしました",
            opened: "OSへフォルダーの表示を依頼しました",
          }
        : {
            ai: "Send to AI",
            copy: "Copy full path",
            open: "Open folder",
            copied: "Full path copied",
            opened: "Asked the operating system to show the folder",
          };
    const root = page.getByRole("button", { name: "日本語 空白 root", exact: true });
    await root.click();
    expect(
      await page.evaluate(() => (window as unknown as { rootChooseCount: number }).rootChooseCount),
    ).toBe(1);
    await root.click({ button: "right" });
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("menuitem")).toHaveText([text.ai, text.copy, text.open]);
    await expect(page.getByRole("menuitem", { name: text.ai, exact: true })).toBeFocused();
    await page.screenshot({
      path: test.info().outputPath(`root-actions-${language}-light-mock.png`),
    });
    const background = await page
      .getByRole("menu")
      .evaluate((e) => getComputedStyle(e).backgroundColor);
    await page.emulateMedia({ colorScheme: "dark" });
    await expect
      .poll(() => page.getByRole("menu").evaluate((e) => getComputedStyle(e).backgroundColor))
      .not.toBe(background);
    await page.screenshot({
      path: test.info().outputPath(`root-actions-${language}-dark-mock.png`),
    });
    await page.keyboard.press("ArrowDown");
    const copy = page.getByRole("menuitem", { name: text.copy, exact: true });
    await expect(copy).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status")).toContainText(text.copied);
    await expect(root).toBeFocused();
    await root.press("Shift+F10");
    await page.keyboard.press("End");
    await expect(page.getByRole("menuitem", { name: text.open, exact: true })).toBeFocused();
    await page.keyboard.press("Space");
    await expect(page.getByRole("status")).toContainText(text.opened);
    expect(
      await page.evaluate(
        () => (window as unknown as { rootActionCalls: unknown[] }).rootActionCalls,
      ),
    ).toEqual([
      { context: { workspaceId: "workspace", viewId: "view", target: "root" }, action: "copyPath" },
      {
        context: { workspaceId: "workspace", viewId: "view", target: "root" },
        action: "openFolder",
      },
    ]);
    await page.getByRole("button", { name: "Fail next OS request" }).click();
    await root.click({ button: "right" });
    await page.getByRole("menuitem", { name: text.open, exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("permission denied: 日本語 空白 root");
    await expect(root).toBeFocused();
    await page.setViewportSize({ width: 320, height: 500 });
    await root.click({ button: "right" });
    const menu = page.getByRole("menu");
    const bounds = await menu.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
    await page.keyboard.press("ArrowDown");
    await page.evaluate(
      (value) =>
        (window as unknown as { setRootLanguage: (language: string) => void }).setRootLanguage(
          value,
        ),
      language === "ja" ? "en" : "ja",
    );
    await expect(page.getByRole("menuitem").nth(1)).toBeFocused();
    await expect(page.getByRole("textbox", { name: "保持する入力" })).toHaveValue("入力を保持");
    await page.keyboard.press("Escape");
    await expect(root).toBeFocused();
    await root.press("Shift+F10");
    await page.keyboard.press("Tab");
    await expect(menu).toBeHidden();
    await expect(root).toBeFocused();
    await root.click({ button: "right" });
    // Change the native context without clicking outside first, exercising context invalidation.
    await page
      .getByRole("button", { name: "Change root" })
      .evaluate((button: HTMLButtonElement) => button.click());
    await expect(menu).toBeHidden();
    await page.getByRole("button", { name: "Clear root" }).click();
    await root.click({ button: "right" });
    await expect(menu).toBeHidden();
    expect(
      await page.evaluate(
        () => (window as unknown as { rootActionCalls: unknown[] }).rootActionCalls,
      ),
    ).toHaveLength(3);
    expect(
      await page.evaluate(() => (window as unknown as { rootAiCount: number }).rootAiCount),
    ).toBe(0);
  });
}
