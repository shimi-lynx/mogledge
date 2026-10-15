import { expect, test } from "@playwright/test";

for (const language of ["ja", "en"] as const) {
  test(`registered folder, displayed child, restart and outer storage hold ${language} (mock Native)`, async ({
    page,
  }) => {
    await page.addInitScript(
      (value) => localStorage.setItem("my-knowledge.ui-language", value),
      language,
    );
    await page.route("**/@tauri-apps_api_app.js*", (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: 'export const getVersion=async()=>"0.8.2";',
      }),
    );
    await page.route("**/src/lib/bridge.ts", (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: `
      const calls=window.registeredFolderCalls={register:0,display:0,paths:[],storageHolds:0};
      let snapshot={workspaceId:'registered-parent',viewId:'same-view',rootPath:'/fixture/Parent',revision:1,displayRevision:0,watchError:null,
        storageHold:{reason:'StorageIdentityConfirmationRequired'},
        nodes:[{name:'Child',relativePath:'Child',kind:'folder',children:[{name:'tool.html',relativePath:'Child/tool.html',kind:'html',children:[]}]},
          {name:'parent.html',relativePath:'parent.html',kind:'html',children:[]}],
        ...(localStorage.getItem('displayed-child')?{displayFolder:{relativePath:'Child',identity:'physical-child'}}:{})};
      export const aiHandoffApi={};
      export const bridge={
        beginView:async()=>snapshot,getTree:async()=>snapshot,listen:async()=>()=>{},
        chooseRoot:async()=>{calls.register++;return null;},
        chooseDisplayFolder:async(workspace,view)=>{if(workspace!==snapshot.workspaceId||view!==snapshot.viewId)throw 'ViewChanged';calls.display++;if(window.chooseOutside)throw 'DisplayFolderOutsideRegisteredRoot';snapshot={...snapshot,displayRevision:snapshot.displayRevision+1,displayFolder:{relativePath:'Child',identity:'physical-child'}};localStorage.setItem('displayed-child','yes');return snapshot;},
        setDisplayFolder:async(workspace,view,path,expectedDisplayRevision)=>{if(workspace!==snapshot.workspaceId||view!==snapshot.viewId)throw 'ViewChanged';if(expectedDisplayRevision!==snapshot.displayRevision)throw 'DisplayFolderChanged';calls.paths.push(path);snapshot={...snapshot,displayRevision:snapshot.displayRevision+1,displayFolder:undefined};localStorage.removeItem('displayed-child');return snapshot;},
        getDocumentStorageHold:async()=>{calls.storageHolds++;throw Error('unexpected admitted-document probe');},
        getWorkspaceLists:async()=>({favorites:[],folderFavorites:[],recent:[],error:null,readOnly:false}),refresh:async()=>snapshot
      };
      `,
      }),
    );
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.goto("/");
    const root = page.locator(".workspace-button");
    await expect(root).toHaveText("Parent");
    await root.click();
    await expect(root).toHaveText("Child");
    await expect(page.locator(".registered-folder-summary")).toContainText(
      language === "ja" ? "登録フォルダー：Parent" : "Registered folder: Parent",
    );
    await expect(page.getByRole("treeitem", { name: "tool HTML", exact: true })).toHaveAttribute(
      "data-path",
      "Child/tool.html",
    );
    await expect(page.getByRole("treeitem", { name: "parent HTML", exact: true })).toHaveCount(0);
    expect(await page.evaluate("window.registeredFolderCalls.register")).toBe(0);
    await page.reload();
    await expect(root).toHaveText("Child");
    await expect(page.locator(".registered-folder-summary")).toContainText("Parent");
    expect(await page.evaluate("window.registeredFolderCalls.register")).toBe(0);
    await page.screenshot({ path: test.info().outputPath(`registered-child-${language}.png`) });
    const hide = language === "ja" ? "左メニューを閉じる" : "Hide sidebar";
    await page.getByRole("button", { name: hide, exact: true }).click();
    const hold = page.locator(".storage-hold-notice");
    await expect(hold).toBeVisible();
    await expect(hold).toContainText(language === "ja" ? "独立したバックアップ" : "independently");
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 320, height: 640 });
      await expect(hold).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
      await page.screenshot({
        path: test.info().outputPath(`storage-hold-${language}-${scheme}.png`),
      });
    }
    await page.setViewportSize({ width: 1000, height: 700 });
    await page
      .getByRole("button", {
        name: language === "ja" ? "左メニューを開く" : "Show sidebar",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", {
        name: language === "ja" ? "登録範囲をすべて表示" : "Show the entire registered folder",
        exact: true,
      })
      .click();
    await expect(root).toHaveText("Parent");
    await expect(page.getByRole("treeitem", { name: "parent HTML", exact: true })).toBeVisible();
    await page.evaluate("window.chooseOutside=true");
    await root.click();
    await expect(page.getByRole("alert")).toContainText(
      language === "ja" ? "登録範囲外" : "outside the registered folder",
    );
    expect(await page.evaluate("window.registeredFolderCalls.register")).toBe(0);
    await page
      .locator(".workspace-feedback")
      .getByRole("button", {
        name: language === "ja" ? "登録フォルダーを管理" : "Manage registered folder",
        exact: true,
      })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("button", {
        name: language === "ja" ? "登録フォルダー" : "Registered folder",
        exact: true,
      })
      .click();
    await expect(dialog).toContainText("/fixture/Parent");
    await expect(dialog).toContainText(
      language === "ja" ? "削除・移行・統合されません" : "does not delete, transfer or combine",
    );
    await page.screenshot({ path: test.info().outputPath(`registered-settings-${language}.png`) });
    await dialog
      .getByRole("button", {
        name: language === "ja" ? "登録フォルダーを変更" : "Change registered folder",
        exact: true,
      })
      .click();
    expect(await page.evaluate("window.registeredFolderCalls.register")).toBe(1);
    expect(await page.evaluate("window.registeredFolderCalls.storageHolds")).toBe(0);
  });
}
