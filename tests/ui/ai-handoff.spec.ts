import { expect, test } from "@playwright/test";

test("AI handoff review, safe failures, copy flow and live shared themes (mock Native)", async ({
  page,
}) => {
  await page.route("**/src/app/App.tsx", async (route) => {
    const source = await (await route.fetch()).text();
    const reactModule = source.match(/from\s+["']([^"']*\/react\.js[^"']*)["']/)?.[1];
    if (!reactModule) throw new Error("Vite did not resolve React");
    await route.fulfill({
      contentType: "application/javascript",
      body: `
      import React from ${JSON.stringify(reactModule)};
      import { KnowledgeTree } from '/src/features/knowledge-tree/KnowledgeTree.tsx';
      import AiHandoffDialog from '/src/app/AiHandoffDialog.tsx';
      const nodes = [{name:'日本語 &', relativePath:'日本語 &', kind:'folder', children:[{name:'a.html', relativePath:'日本語 &/a.html', kind:'html', children:[]}]}];
      window.aiFixtureCalls = [];
      const api = {
        prepare: async context => ({selectedPath:'/fixture/'+context.relativePath, workingDirectory: context.relativePath.endsWith('.html')? '/fixture/日本語 &' : '/fixture/'+context.relativePath, revision:1, kind:context.relativePath.endsWith('.html')?'file':'folder'}),
        perform: async request => {window.aiFixtureCalls.push(request); if(window.aiFixtureFail) throw new Error('codex://new?prompt=fixture-secret');}
      };
      export function App() {
        const [context,setContext] = React.useState(null);
        return React.createElement(React.Fragment,null,
          React.createElement(KnowledgeTree,{nodes,workspaceId:'fixture',selected:null,onSelect:()=>{},onAiHandoff: (relativePath,returnFocus)=>setContext({context:{workspaceId:'fixture',viewId:'view',relativePath},returnFocus})}),
          context && React.createElement(AiHandoffDialog,{...context,api,onClose:()=>setContext(null)}));
      }
    `,
    });
  });
  await page.setViewportSize({ width: 1000, height: 950 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  const folder = page.getByRole("treeitem", { name: "日本語 &", exact: true });
  await folder.click();
  const file = page.getByRole("treeitem", { name: "a HTML", exact: true });
  await file.click({ button: "right" });
  await page.getByRole("menuitem", { name: "AIに渡す" }).click();
  const dialog = page.getByRole("dialog", { name: "AIに渡す" });
  await expect(dialog.getByRole("definition")).toHaveCount(0);
  await expect(dialog.getByRole("textbox")).toHaveCount(1);
  await expect(dialog).not.toContainText("/fixture/");
  await expect(dialog.getByRole("button", { name: "依頼文をコピー" })).toBeEnabled();
  await expect(dialog.getByRole("textbox")).toHaveAccessibleDescription(
    /選択パスは依頼文に自動で含まれます/,
  );
  expect(
    await page.evaluate(
      () => (window as unknown as { aiFixtureCalls: unknown[] }).aiFixtureCalls.length,
    ),
  ).toBe(0);
  const instruction = dialog.getByRole("textbox", { name: "依頼文（任意）" });
  await expect(dialog.getByRole("combobox")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(instruction).toBeFocused();
  expect((await instruction.boundingBox())!.height).toBeGreaterThanOrEqual(160);
  await instruction.fill("日本語の依頼 & ? # %\n改善してください");
  await instruction.focus();
  await page.screenshot({ path: test.info().outputPath("ai-handoff-light-mock.png") });
  const light = await dialog.evaluate((element) => getComputedStyle(element).backgroundColor);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect
    .poll(() => dialog.evaluate((element) => getComputedStyle(element).backgroundColor))
    .not.toBe(light);
  await expect(instruction).toHaveValue("日本語の依頼 & ? # %\n改善してください");
  await expect(instruction).toBeFocused();
  await page.screenshot({ path: test.info().outputPath("ai-handoff-dark-mock.png") });
  await page.evaluate(() => {
    (window as unknown as { aiFixtureFail: boolean }).aiFixtureFail = true;
  });
  await dialog.getByRole("button", { name: "AIに渡す" }).click();
  await expect(
    dialog.getByRole("alert").filter({ hasText: "受け渡しできませんでした" }),
  ).toContainText("受け渡しできませんでした");
  await expect(dialog).not.toContainText("fixture-secret");
  await page.evaluate(() => {
    (window as unknown as { aiFixtureFail: boolean }).aiFixtureFail = false;
  });
  await dialog.getByRole("combobox", { name: "連携先" }).selectOption("claudeApp");
  await expect(dialog.getByRole("button", { name: "AIに渡す" })).toBeEnabled();
  await expect(dialog).toContainText("未送信の下書き");
  await dialog.getByRole("combobox", { name: "連携先" }).selectOption("claudeCli");
  await instruction.fill("語".repeat(5000));
  await expect(dialog.getByRole("button", { name: "AIに渡す" })).toBeDisabled();
  await expect(instruction).toHaveValue("語".repeat(5000));
  await page.evaluate(() => {
    (window as unknown as { aiFixtureFail: boolean }).aiFixtureFail = true;
  });
  await dialog.getByRole("button", { name: "依頼文をコピー" }).click();
  await expect(
    dialog.getByRole("alert").filter({ hasText: "受け渡しできませんでした" }),
  ).toContainText("受け渡しできませんでした");
  await expect(dialog).not.toContainText("fixture-secret");
  await expect(dialog.getByRole("status")).toHaveCount(0);
  await page.evaluate(() => {
    (window as unknown as { aiFixtureFail: boolean }).aiFixtureFail = false;
  });
  await dialog.getByRole("button", { name: "依頼文をコピー" }).click();
  await expect(dialog.getByRole("status")).toContainText("依頼文をコピーしました");
  await dialog.getByRole("combobox", { name: "連携先" }).selectOption("codexCli");
  await expect(dialog.getByRole("button", { name: "AIに渡す" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "閉じる" }).click();
  await expect(page.getByRole("tree")).toBeFocused();
  await folder.click({ button: "right" });
  await page.getByRole("menuitem", { name: "AIに渡す" }).click();
  await expect(dialog.getByRole("button", { name: "AIに渡す" })).toBeEnabled();
  await expect(dialog.getByRole("textbox", { name: "依頼文（任意）" })).toHaveValue("");
  await expect(dialog.getByRole("definition")).toHaveCount(0);
  await dialog.getByRole("button", { name: "AIに渡す" }).click();
  await expect(dialog.getByRole("status")).toContainText("受信・表示は確認できません");
  const last = await page.evaluate(() =>
    (
      window as unknown as {
        aiFixtureCalls: {
          context: { relativePath: string };
          instruction: string;
          destination: string;
          copy: boolean;
        }[];
      }
    ).aiFixtureCalls.at(-1),
  );
  expect(last).toMatchObject({
    context: { relativePath: "日本語 &" },
    instruction: "",
    destination: "codexApp",
    copy: false,
    preview: {
      selectedPath: "/fixture/日本語 &",
      workingDirectory: "/fixture/日本語 &",
      revision: 1,
      kind: "folder",
    },
  });
  await expect(dialog.getByRole("textbox")).toHaveAccessibleDescription(/本文なしで開きます/);
  const textarea = dialog.getByRole("textbox", { name: "依頼文（任意）" });
  await textarea.scrollIntoViewIfNeeded();
  const beforeResize = (await textarea.boundingBox())!;
  await page.mouse.move(
    beforeResize.x + beforeResize.width - 3,
    beforeResize.y + beforeResize.height - 3,
  );
  await page.mouse.down();
  await page.mouse.move(
    beforeResize.x + beforeResize.width - 3,
    beforeResize.y + beforeResize.height + 37,
    { steps: 4 },
  );
  await page.mouse.up();
  await expect
    .poll(async () => (await textarea.boundingBox())!.height)
    .toBeGreaterThan(beforeResize.height + 10);
  await page.setViewportSize({ width: 400, height: 500 });
  const bounds = await dialog.boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(400);
  expect(bounds!.height).toBeLessThanOrEqual(500);
  const copy = dialog.getByRole("button", { name: "依頼文をコピー" });
  await copy.scrollIntoViewIfNeeded();
  const copyBounds = (await copy.boundingBox())!;
  expect(copyBounds.y).toBeGreaterThanOrEqual(0);
  expect(copyBounds.y + copyBounds.height).toBeLessThanOrEqual(500);
  await copy.focus();
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("status")).toContainText("依頼文をコピーしました");
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { aiFixtureCalls: { instruction: string; copy: boolean }[] }
      ).aiFixtureCalls.at(-1),
    ),
  ).toMatchObject({ instruction: "", copy: true });
  await page.screenshot({ path: test.info().outputPath("ai-handoff-narrow-mock.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("tree")).toBeFocused();
});
