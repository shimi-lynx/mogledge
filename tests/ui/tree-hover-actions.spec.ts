import { expect, test } from "@playwright/test";

for (const colorScheme of ["light", "dark"] as const) {
  test(`tree inline actions stay in deep narrow rows and isolate input on ${colorScheme}`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 900, height: 500 });
    await page.route("**/src/app/App.tsx", async (route) => {
      const source = await (await route.fetch()).text();
      const reactModule = source.match(/from\s+["']([^"']*\/react\.js[^"']*)["']/)?.[1];
      if (!reactModule) throw new Error("Vite did not resolve React");
      await route.fulfill({
        contentType: "application/javascript",
        body: `
          import React from ${JSON.stringify(reactModule)};
          import { KnowledgeTree } from '/src/features/knowledge-tree/KnowledgeTree.tsx';
          import { setLanguage } from '/src/lib/i18n.ts';
          const calls = window.inlineTreeCalls = { favorites: [], ai: [], selected: [], mutations: [] };
          const deepParts = Array.from({length:20}, (_, index) => '長い日本語の階層' + (index+1));
          const deepPath = deepParts.join('/');
          let deepNode = { name: deepParts.at(-1), relativePath: deepPath, kind:'folder', children:[{ name:'非常に長い日本語の小さなアプリケーション.html', relativePath:deepPath+'/非常に長い日本語の小さなアプリケーション.html', kind:'html', children:[] }] };
          for (let index=18; index>=0; index--) deepNode = { name:deepParts[index], relativePath:deepParts.slice(0,index+1).join('/'), kind:'folder', children:[deepNode] };
          const nodes = [{ name:'資料フォルダー', relativePath:'資料フォルダー', kind:'folder', children:[{ name:'子供.html', relativePath:'資料フォルダー/子供.html', kind:'html', children:[] }] }, { name:'長い日本語アプリ.html', relativePath:'長い日本語アプリ.html', kind:'html', children:[] }, deepNode, ...Array.from({length:300},(_,index)=>({name:'app-'+index+'.html',relativePath:'app-'+index+'.html',kind:'html',children:[]}))];
          export function App() {
            const [favorites, setFavorites] = React.useState(['長い日本語アプリ.html']);
            const [busy, setBusy] = React.useState(false);
            const [error, setError] = React.useState('');
            const [request, setRequest] = React.useState(undefined);
            return React.createElement('div', { className:'app', style:{display:'flex', flexDirection:'row'} },
              React.createElement('aside', { className:'sidebar', style:{width:230, minWidth:230, height:500} },
                React.createElement(KnowledgeTree, {nodes,workspaceId:'fixture',viewId:'fixture-view',revision:1,selected:null,favoritePaths:favorites,actionBusy:busy,focusRequest:request,
                  onSelect:path=>calls.selected.push(path),
                  onFavorite:(path,add)=>{ calls.favorites.push({path,add}); if(window.inlineFavoriteError) {setError('お気に入りを更新できません');return;} setError('');setFavorites(previous=>add?[...previous,path]:previous.filter(value=>value!==path)); },
                  onAiHandoff:(path,returnFocus)=>calls.ai.push({path,returnFocus:returnFocus?.getAttribute('aria-label')}),
                  onMutation:async mutation=>{calls.mutations.push(mutation);return null;}
                })),
              React.createElement('main', {className:'app-surface',style:{padding:16,flex:1}},
                React.createElement('button',{onClick:()=>setLanguage('ja')},'日本語'),
                React.createElement('button',{onClick:()=>setLanguage('en')},'English'),
                React.createElement('button',{onClick:()=>setRequest(previous=>({path:deepPath,id:(previous?.id??0)+1,workspaceId:'fixture',viewId:'fixture-view',revision:1}))},'深いフォルダーへ戻る'),
                React.createElement('button',{onClick:()=>setBusy(previous=>!previous)},'操作中を切替'),
                error&&React.createElement('p',{role:'alert'},error),
                React.createElement('input',{'aria-label':'次の入力'})));
          }
        `,
      });
    });
    await page.goto("/");
    const tree = page.getByRole("tree");
    const folder = page.getByRole("treeitem", { name: "資料フォルダー", exact: true });
    const file = page.getByRole("treeitem", { name: "長い日本語アプリ HTML", exact: true });
    const folderFavorite = folder.getByRole("button", { name: "お気に入りに追加" });
    const folderAi = folder.getByRole("button", { name: "AIに渡す" });
    await page.mouse.move(850, 450);
    await expect(folderFavorite).toHaveCSS("opacity", "0");
    await expect(file.getByRole("button", { name: "お気に入りから解除" })).toHaveCSS(
      "opacity",
      "1",
    );
    await folder.hover();
    await expect(folderFavorite).toHaveCSS("opacity", "1");
    await expect(folderAi).toHaveCSS("opacity", "1");
    await folderFavorite.click();
    const removeFolder = folder.getByRole("button", { name: "お気に入りから解除" });
    await expect(removeFolder).toHaveAttribute("aria-pressed", "true");
    await expect(folder).toHaveAttribute("aria-expanded", "false");
    await removeFolder.click();
    await folderAi.click();
    expect(await page.evaluate(() => Reflect.get(window, "inlineTreeCalls"))).toEqual({
      favorites: [
        { path: "資料フォルダー", add: true },
        { path: "資料フォルダー", add: false },
      ],
      ai: [{ path: "資料フォルダー", returnFocus: "AIに渡す" }],
      selected: [],
      mutations: [],
    });
    await folderAi.press("Escape");
    await expect(tree).toBeFocused();
    await tree.press("Tab");
    await expect(folderFavorite).toBeFocused();
    await folderFavorite.press("Enter");
    await folder.getByRole("button", { name: "お気に入りから解除" }).press("Tab");
    await expect(folderAi).toBeFocused();
    await folderAi.press("Space");
    await expect(folder).toHaveAttribute("aria-expanded", "false");
    await folderAi.press("ArrowRight");
    await expect(folder).toHaveAttribute("aria-expanded", "false");
    await folderAi.dispatchEvent("keydown", { key: "Enter", isComposing: true, keyCode: 229 });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.evaluate(() => Reflect.set(window, "inlineFavoriteError", true));
    await folder.getByRole("button", { name: "お気に入りから解除" }).click();
    await expect(page.getByRole("alert")).toHaveText("お気に入りを更新できません");
    await expect(folder.getByRole("button", { name: "お気に入りから解除" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.evaluate(() => Reflect.set(window, "inlineFavoriteError", false));
    await folder.getByRole("button", { name: "お気に入りから解除" }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.getByRole("button", { name: "操作中を切替" }).click();
    await folder.hover();
    await expect(folderFavorite).toBeDisabled();
    await expect(folderAi).toBeDisabled();
    await page.getByRole("button", { name: "操作中を切替" }).click();
    await page.getByRole("button", { name: "深いフォルダーへ戻る" }).click();
    await expect(tree).toBeFocused();
    const deepFolder = page.getByRole("treeitem", { name: "長い日本語の階層20", exact: true });
    const deepFile = page.getByRole("treeitem", {
      name: "非常に長い日本語の小さなアプリケーション HTML",
      exact: true,
    });
    await expect(deepFolder).toBeVisible();
    await expect(deepFolder).toHaveAttribute("aria-expanded", "true");
    await deepFolder.hover();
    const measurements = await deepFolder.evaluate((row) => {
      const bounds = row.getBoundingClientRect();
      const filename = row.querySelector<HTMLElement>(".filename")!;
      const actions = row.querySelector<HTMLElement>(".tree-row-actions")!;
      return {
        height: bounds.height,
        rowRight: bounds.right,
        actionsRight: actions.getBoundingClientRect().right,
        actionsWidth: actions.getBoundingClientRect().width,
        filenameWidth: filename.getBoundingClientRect().width,
        filenameRight: filename.getBoundingClientRect().right,
        actionsLeft: actions.getBoundingClientRect().left,
        overflow: getComputedStyle(filename).textOverflow,
        scrollWidth: row.closest(".tree")!.scrollWidth,
        clientWidth: row.closest(".tree")!.clientWidth,
      };
    });
    expect(measurements.height).toBe(32);
    expect(measurements.actionsWidth).toBe(56);
    expect(measurements.filenameWidth).toBeGreaterThan(20);
    expect(measurements.actionsRight).toBeLessThanOrEqual(measurements.rowRight);
    expect(measurements.filenameRight).toBeLessThanOrEqual(measurements.actionsLeft);
    expect(measurements.overflow).toBe("ellipsis");
    expect(measurements.scrollWidth).toBe(measurements.clientWidth);
    await deepFolder.getByRole("button", { name: "お気に入りに追加" }).click();
    await deepFolder.getByRole("button", { name: "AIに渡す" }).click();
    await deepFile.hover();
    await deepFile.getByRole("button", { name: "AIに渡す" }).click();
    const dragButton = deepFile.getByRole("button", { name: "お気に入りに追加" });
    const origin = await dragButton.boundingBox();
    await page.mouse.move(origin!.x + 13, origin!.y + 13);
    await page.mouse.down();
    await page.mouse.move(origin!.x + 13, origin!.y - 60, { steps: 12 });
    await expect(page.locator(".tree-row.dragged")).toHaveCount(0);
    await page.mouse.up();
    await expect(page.locator(".tree-row.dragged")).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const finalCalls = await page.evaluate(() => Reflect.get(window, "inlineTreeCalls"));
    expect(finalCalls.selected).toEqual([]);
    expect(finalCalls.mutations).toEqual([]);
    expect(finalCalls.ai.map((entry: { path: string }) => entry.path).slice(-2)).toEqual([
      Array.from({ length: 20 }, (_, index) => "長い日本語の階層" + (index + 1)).join("/"),
      Array.from({ length: 20 }, (_, index) => "長い日本語の階層" + (index + 1)).join("/") +
        "/非常に長い日本語の小さなアプリケーション.html",
    ]);
    await deepFolder.hover();
    await page.screenshot({ path: test.info().outputPath(`tree-inline-${colorScheme}.png`) });
    await deepFile.evaluate((element) => {
      Reflect.set(window, "inlineRowBeforeLanguage", element);
      Reflect.set(window, "inlineFilenameBeforeLanguage", element.querySelector(".filename"));
    });
    await page.getByRole("button", { name: "English", exact: true }).click();
    await expect(tree).toHaveAccessibleName("knowledge file tree");
    const englishAi = deepFolder.getByRole("button", { name: "Send to AI" });
    await deepFolder.hover();
    await expect(englishAi).toHaveAttribute("title", "Send to AI");
    await expect(deepFolder.getByRole("button", { name: "Remove from favorites" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      await deepFile.evaluate(
        (element) =>
          element === Reflect.get(window, "inlineRowBeforeLanguage") &&
          element.querySelector(".filename") ===
            Reflect.get(window, "inlineFilenameBeforeLanguage"),
      ),
    ).toBe(true);
    await englishAi.click();
    await englishAi.press("Escape");
    await expect(tree).toBeFocused();
    await tree.press("Tab");
    await expect(deepFolder.getByRole("button", { name: "Remove from favorites" })).toBeFocused();
    await deepFolder.getByRole("button", { name: "Remove from favorites" }).press("Tab");
    await expect(englishAi).toBeFocused();
    const englishCall = (await page.evaluate(() => Reflect.get(window, "inlineTreeCalls"))).ai.at(
      -1,
    );
    expect(englishCall).toEqual({
      path: Array.from({ length: 20 }, (_, index) => "長い日本語の階層" + (index + 1)).join("/"),
      returnFocus: "Send to AI",
    });
    await deepFolder.click({ button: "right" });
    const englishMenu = page.getByRole("menu");
    await expect(englishMenu.getByRole("menuitem").first()).toHaveText("Send to AI");
    await expect(
      englishMenu.getByRole("menuitem", { name: "Remove from favorites" }),
    ).toBeVisible();
    const menuBounds = await englishMenu.boundingBox();
    expect(menuBounds!.x + menuBounds!.width).toBeLessThanOrEqual(892);
    expect(menuBounds!.y + menuBounds!.height).toBeLessThanOrEqual(492);
    await page.screenshot({ path: test.info().outputPath(`tree-inline-en-${colorScheme}.png`) });
    await englishMenu.press("Escape");
    await page.getByRole("button", { name: "日本語", exact: true }).click();
    await expect(tree).toHaveAccessibleName("knowledge ファイルツリー");
    await expect(deepFolder.getByRole("button", { name: "AIに渡す" })).toHaveAttribute(
      "title",
      "AIに渡す",
    );
    await tree.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(page.getByRole("treeitem", { name: "app-299 HTML" })).toBeVisible();
    expect(await page.getByRole("treeitem").count()).toBeLessThan(35);
    await page
      .getByRole("treeitem", { name: "app-299 HTML" })
      .dragTo(page.getByRole("treeitem", { name: "app-298 HTML" }), {
        targetPosition: { x: 35, y: 2 },
      });
    expect((await page.evaluate(() => Reflect.get(window, "inlineTreeCalls"))).mutations).toEqual([
      { kind: "reorder", source: "app-299.html", anchor: "app-298.html", after: false },
    ]);
  });
}
