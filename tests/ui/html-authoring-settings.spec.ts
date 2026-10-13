import { expect, test, type Page } from "@playwright/test";
async function prepare(page: Page) {
  await page.route("**/src/app/App.tsx", async (route) => {
    const source = await (await route.fetch()).text();
    const react = source.match(/from\s+["']([^"']*\/react\.js[^"']*)["']/)?.[1];
    if (!react) throw new Error("React resolution missing");
    await route.fulfill({
      contentType: "application/javascript",
      body: `
      import React from ${JSON.stringify(react)};
      import AiHandoffDialog from '/src/app/AiHandoffDialog.tsx';
      const guide='Before creating HTML read .my-knowledge/html-authoring/GUIDE.md.';
      window.kitCalls={status:[],preview:[],install:[],cancel:[],prefs:[],ai:[]};
      const states={};const state=context=>states[context.workspaceId] ||= {rootIdentity:context.workspaceId,enabled:false,preferenceHash:null,readOnly:false,guideAvailable:false,error:null};
      const kitApi={
        status:async context=>{window.kitCalls.status.push(context);return {...state(context)};},
        preview:async context=>{window.kitCalls.preview.push(context);const value={planId:'plan-'+window.kitCalls.preview.length,kitVersion:1,readOnly:!!window.kitReadonly,error:window.kitReadonly?'制作キットの所有記録を読み取れません。元の内容を保持します':null,files:[{path:'.my-knowledge/html-authoring/GUIDE.md',action:'create'},{path:'.my-knowledge/html-authoring/template.html',action:'create'},{path:'.agents/skills/my-knowledge-html-authoring/SKILL.md',action:'conflict'}]};if(window.holdKitPreview)return new Promise(resolve=>{window.resolveKitPreview=()=>resolve(value);});return value;},
        cancel:async(context,id)=>{window.kitCalls.cancel.push({context,id});},
        install:async(context,id)=>{window.kitCalls.install.push({context,id});state(context).guideAvailable=true;return {written:['GUIDE.md','template.html'],skipped:['SKILL.md'],error:null};},
        setEnabled:async(context,hash,enabled)=>{window.kitCalls.prefs.push({context,hash,enabled});state(context).enabled=enabled;state(context).preferenceHash='saved';return {...state(context)};}
      };
      export function App(){
        const [context,setContext]=React.useState({workspaceId:'日本語 root',viewId:'view',revision:1});
        const [settings,setSettings]=React.useState(false);const[ai,setAi]=React.useState(false);
        window.changeKitRoot=()=>setContext({workspaceId:'other',viewId:'other-view',revision:1});
        return React.createElement(React.Fragment,null,
          React.createElement('button',{onClick:()=>setSettings(true)},'Setup fixture'),
          React.createElement('button',{onClick:()=>setAi(true)},'AI fixture'),
          settings?React.createElement(SettingsDialog,{returnFocus:null,onClose:()=>setSettings(false),rootContext:context,kitApi}):null,
          ai?React.createElement(AiHandoffDialog,{context:{workspaceId:context.workspaceId,viewId:context.viewId,target:'root'},onClose:()=>setAi(false),api:{prepare:async()=>({selectedPath:'/fixture/'+context.workspaceId,workingDirectory:'/fixture/'+context.workspaceId,revision:1,kind:'folder',...(state(context).enabled?{guideInstruction:guide}:{})}),perform:async request=>{window.kitCalls.ai.push(request);}}}):null);
      }
      import { SettingsDialog } from '/src/app/SettingsDialog.tsx';
    `,
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Setup fixture" }).click();
  await page.getByRole("button", { name: "AIによるHTML制作", exact: true }).click();
}
test("authoring settings preview cancel install guide preference and raw AI request use only explicit mock operations", async ({
  page,
}) => {
  await prepare(page);
  const dialog = page.getByRole("dialog", { name: "設定", exact: true });
  const preference = dialog.getByRole("checkbox");
  await expect(preference).not.toBeChecked();
  await expect(preference).toBeDisabled();
  await dialog.getByRole("button", { name: "配置内容を確認" }).click();
  await expect(dialog.getByRole("region", { name: "配置内容", exact: true })).toBeVisible();
  expect(await page.evaluate("window.kitCalls.install.length")).toBe(0);
  await expect(dialog.getByText("既存の内容を保持")).toBeVisible();
  await dialog.getByRole("button", { name: "キャンセル", exact: true }).click();
  expect(await page.evaluate("window.kitCalls.cancel.length")).toBe(1);
  await dialog.getByRole("button", { name: "配置内容を確認" }).click();
  await dialog.getByRole("button", { name: "確認した内容を配置" }).click();
  await expect(dialog.getByRole("status")).toContainText("2件を配置し、1件を保持しました");
  await expect(preference).toBeEnabled();
  await preference.check();
  expect(await page.evaluate("window.kitCalls.prefs.at(-1).enabled")).toBe(true);
  await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
  await page.getByRole("button", { name: "AI fixture" }).click();
  const ai = page.getByRole("dialog", { name: "AIに渡す", exact: true });
  await expect(ai.getByText(/この作業フォルダーの設定に従い/)).toBeVisible();
  const input = ai.getByRole("textbox");
  const raw = " 日本語 $& {path}\n\t ";
  await input.fill(raw);
  await ai.getByRole("button", { name: "依頼文をコピー", exact: true }).click();
  await expect(input).toHaveValue(raw);
  expect(await page.evaluate("window.kitCalls.ai[0].instruction")).toBe(raw);
  await ai.getByRole("button", { name: "閉じる", exact: true }).click();
  await page.getByRole("button", { name: "Setup fixture" }).click();
  await dialog.getByRole("button", { name: "AIによるHTML制作", exact: true }).click();
  await preference.uncheck();
  await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
  await page.getByRole("button", { name: "AI fixture" }).click();
  await expect(ai.getByText(/この作業フォルダーの設定に従い/)).toHaveCount(0);
  await ai.getByRole("button", { name: "AIに渡す", exact: true }).click();
  expect(await page.evaluate("window.kitCalls.ai.at(-1).instruction")).toBe("");
  expect(await page.evaluate("window.kitCalls.ai.at(-1).preview.guideInstruction")).toBeUndefined();
});
test("authoring settings reject stale previews and keep long fixed paths within JA EN light dark narrow layouts", async ({
  page,
}) => {
  await prepare(page);
  const dialog = page.getByRole("dialog");
  await page.evaluate("window.holdKitPreview=true");
  await dialog.getByRole("button", { name: "配置内容を確認" }).click();
  await page.evaluate("window.changeKitRoot();window.resolveKitPreview()");
  await expect.poll(() => page.evaluate("window.kitCalls.cancel.length")).toBe(1);
  await expect(dialog.getByRole("region", { name: "配置内容", exact: true })).toHaveCount(0);
  await page.evaluate("window.holdKitPreview=false;window.kitReadonly=true");
  await dialog.getByRole("button", { name: "配置内容を確認" }).click();
  await expect(dialog.getByRole("button", { name: "確認した内容を配置" })).toBeDisabled();
  expect(await page.evaluate("window.kitCalls.install.length")).toBe(0);
  for (const language of ["ja", "en"] as const) {
    if (language === "en") {
      await dialog.getByRole("button", { name: "表示言語を選択", exact: true }).click();
      await dialog.getByRole("combobox").selectOption("en");
      await dialog.getByRole("button", { name: "HTML authoring with AI", exact: true }).click();
      await dialog.getByRole("button", { name: "Preview setup" }).click();
    }
    for (const colorScheme of ["light", "dark"] as const) {
      await page.setViewportSize({ width: 320, height: 600 });
      await page.emulateMedia({ colorScheme });
      expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
      await page.screenshot({
        path: test
          .info()
          .outputPath("html-authoring-settings-" + language + "-" + colorScheme + "-320.png"),
      });
    }
  }
});
