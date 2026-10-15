import { expect, test } from "@playwright/test";

for (const language of ["ja", "en"] as const) {
  test(`managed folders setup, cancellation, missing location and unregister ${language} (mock Native)`, async ({
    page,
  }) => {
    await page.addInitScript(
      (value) => localStorage.setItem("my-knowledge.ui-language", value),
      language,
    );
    await page.route("**/@tauri-apps_api_app.js*", (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: 'export const getVersion=async()=>"0.8.4";',
      }),
    );
    await page.route("**/src/lib/bridge.ts", (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: `
      const calls=window.managedFolderCalls={freePicker:0,create:[],register:0,remove:[]};
      let snapshot={workspaceId:'tools',viewId:'tools-view',rootPath:'/fixture/Tools',revision:1,nodes:[{name:'Child',relativePath:'Child',kind:'folder',children:[]}],watchError:null};
      let folders={revision:'1',selectedId:'tools',folders:[
        {id:'tools',name:'Tools',path:'/fixture/Tools',status:'ready',kitUpdate:'current',error:null},
        {id:'moved',name:'Moved',path:'/fixture/Moved',status:'missing',kitUpdate:'current',error:null}]};
      export const aiHandoffApi={};
      export const bridge={beginView:async()=>snapshot,getTree:async()=>snapshot,listen:async()=>()=>{},
        chooseRoot:async()=>{calls.freePicker++;throw 'unexpected free picker';},
        getManagedFolders:async()=>folders,
        createManagedFolder:async(name,revision)=>{calls.create.push({name,revision});return null;},
        registerManagedFolder:async()=>{calls.register++;if(calls.register===1)throw 'Setup conflict';return null;},
        selectManagedFolder:async()=>snapshot,
        unregisterManagedFolder:async(id,revision)=>{calls.remove.push({id,revision});folders={...folders,revision:'2',selectedId:null,folders:folders.folders.filter(f=>f.id!==id)};snapshot={...snapshot,workspaceId:null,rootPath:null,viewId:'empty-view',nodes:[]};return folders;},
        getWorkspaceLists:async()=>({favorites:[],folderFavorites:[],recent:[],error:null,readOnly:false}),refresh:async()=>snapshot};
    `,
      }),
    );
    await page.setViewportSize({ width: 1000, height: 760 });
    await page.goto("/");
    await page.locator(".workspace-button").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("/fixture/Tools", { exact: true })).toBeVisible();
    const moved = dialog.locator("li").filter({ hasText: "/fixture/Moved" });
    await expect(
      moved.getByRole("button", {
        name: language === "ja" ? "このフォルダーを開く" : "Open this folder",
        exact: true,
      }),
    ).toBeDisabled();
    const name = dialog.getByRole("textbox", {
      name: language === "ja" ? "新しいフォルダー名" : "New folder name",
    });
    await name.fill("New tools");
    await dialog
      .getByRole("button", {
        name: language === "ja" ? "保存先を選んで新規作成" : "Choose a location and create",
        exact: true,
      })
      .click();
    await expect(name).toHaveValue("New tools");
    const register = dialog.getByRole("button", {
      name: language === "ja" ? "既存フォルダーを登録" : "Register an existing folder",
      exact: true,
    });
    await register.click();
    await expect(dialog.getByRole("alert")).toHaveText("Setup conflict");
    await register.click();
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await expect(dialog).toBeVisible();
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await dialog.locator(".managed-folders").evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.screenshot({
        path: test.info().outputPath(`managed-folders-${language}-${scheme}.png`),
      });
    }
    await dialog
      .getByRole("button", { name: language === "ja" ? "登録解除" : "Unregister", exact: true })
      .first()
      .click();
    await expect(dialog).toContainText(
      language === "ja"
        ? "フォルダー、HTML、保存データはすべて残ります"
        : "The folder, HTML files and saved data are all retained",
    );
    await dialog
      .getByRole("button", {
        name: language === "ja" ? "この登録を解除" : "Remove this registration",
        exact: true,
      })
      .click();
    await expect(dialog.getByText("/fixture/Tools", { exact: true })).toHaveCount(0);
    await expect(dialog.getByText("/fixture/Moved", { exact: true })).toBeVisible();
    expect(await page.evaluate("window.managedFolderCalls")).toEqual({
      freePicker: 0,
      create: [{ name: "New tools", revision: "1" }],
      register: 2,
      remove: [{ id: "tools", revision: "1" }],
    });
  });
}
