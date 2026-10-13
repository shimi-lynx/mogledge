import { expect, test } from "@playwright/test";

for (const platform of ["Win32", "MacIntel"]) {
  test(`root creation, folder menu and guarded trash on ${platform}`, async ({ page }) => {
    await page.addInitScript(
      (platform) => Object.defineProperty(navigator, "platform", { get: () => platform }),
      platform,
    );
    await page.route("**/src/app/App.tsx", async (route) => {
      const source = await (await route.fetch()).text();
      const reactModule = source.match(/from\s+["']([^"']*\/react\.js[^"']*)["']/)?.[1];
      if (!reactModule) throw new Error("Vite did not resolve React");
      await route.fulfill({
        contentType: "application/javascript",
        body: `
        import React from ${JSON.stringify(reactModule)};
        import { KnowledgeTree } from '/src/features/knowledge-tree/KnowledgeTree.tsx';
        const calls = window.treeActionCalls = { mutations: [], actions: [], trash: [] };
        export function App() {
          const [nodes, setNodes] = React.useState([{name: '日本語 folder &', relativePath: '日本語 folder &', kind: 'folder', children: [{name:'child.html', relativePath:'日本語 folder &/child.html', kind:'html', children:[]}]}]);
          const [revision, setRevision] = React.useState(1);
          return React.createElement('div', { style: { width: 'min(240px,100%)', height: '100vh', background: '#263645', color: 'white', display:'flex', flexDirection:'column' } },
            React.createElement('input', { 'aria-label': '編集入力' }),
            React.createElement(KnowledgeTree, { nodes, workspaceId:'fixture', revision, selected:null, onSelect:()=>{},
              onFileAction:(path,action)=>calls.actions.push({path,action}),
              onMutation:async mutation=>{ calls.mutations.push(mutation); setNodes(previous=>[...previous,{name:mutation.name,relativePath:mutation.name,kind:'folder',children:[]}]);setRevision(value=>value+1);return null; },
              onTrash:async(source, revision)=>{calls.trash.push({source,revision});if(window.treeTrashError)return 'ごみ箱を利用できません';setNodes(previous=>previous.filter(node=>node.relativePath!==source));setRevision(value=>value+1);return null;}
            }));
        }
      `,
      });
    });
    await page.setViewportSize({ width: 450, height: 400 });
    await page.goto("/");
    const tree = page.getByRole("tree");
    const folder = page.getByRole("treeitem", { name: "日本語 folder &", exact: true });
    await folder.click();
    await page.getByRole("button", { name: "ルートにフォルダーを作成" }).click();
    await expect(page.getByRole("combobox", { name: "作成先" })).toHaveValue("knowledge（ルート）");
    await page.getByRole("textbox", { name: "名前", exact: true }).fill("ルート追加");
    await page.getByRole("button", { name: "作成する" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("treeitem", { name: "ルート追加", exact: true })).toBeVisible();
    await expect(tree).toHaveAttribute(
      "aria-activedescendant",
      "tree-" + encodeURIComponent("ルート追加"),
    );
    await folder.click({ button: "right" });
    const menu = page.getByRole("menu");
    await expect(
      menu.getByRole("menuitem", { name: "フォルダーを開く", exact: true }),
    ).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "既定ブラウザーで表示" })).toHaveCount(0);
    await expect(
      menu.getByRole("menuitem", { name: "ごみ箱に移動", exact: true }).locator("kbd"),
    ).toHaveText(platform === "MacIntel" ? "⌘+Delete（⌫）" : "Delete / Backspace");
    const bounds = await menu.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(442);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(392);
    await page.screenshot({ path: test.info().outputPath(`folder-menu-${platform}.png`) });
    await menu.getByRole("menuitem", { name: "フォルダーを開く", exact: true }).click();
    const input = page.getByRole("textbox", { name: "編集入力" });
    await input.fill("abc");
    await input.press("Backspace");
    await expect(input).toHaveValue("ab");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await tree.focus();
    if (platform === "MacIntel") {
      await tree.press("Backspace");
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }
    await tree.press(platform === "MacIntel" ? "Meta+Backspace" : "Delete");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("日本語 folder &");
    await expect(dialog).toContainText("非HTML資料");
    await expect(dialog.getByRole("button", { name: "キャンセル" })).toBeFocused();
    await page.screenshot({ path: test.info().outputPath(`trash-dialog-${platform}.png`) });
    await dialog.getByRole("button", { name: "キャンセル" }).click();
    await folder.click({ button: "right" });
    await menu.getByRole("menuitem", { name: "ごみ箱に移動", exact: true }).click();
    await page.evaluate(() => Reflect.set(window, "treeTrashError", true));
    await dialog.getByRole("button", { name: "ごみ箱に移動する" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("ごみ箱を利用できません");
    await expect(folder).toBeVisible();
    await page.evaluate(() => Reflect.set(window, "treeTrashError", false));
    await dialog.getByRole("button", { name: "ごみ箱に移動する" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(folder).toHaveCount(0);
    await expect(tree).toBeFocused();
    expect(await page.evaluate(() => Reflect.get(window, "treeActionCalls"))).toEqual({
      mutations: [{ kind: "createFolder", parent: "", name: "ルート追加" }],
      actions: [{ path: "日本語 folder &", action: "openFolder" }],
      trash: [
        { source: "日本語 folder &", revision: 2 },
        { source: "日本語 folder &", revision: 2 },
      ],
    });
  });
}
