import { expect, test } from "@playwright/test";

for (const language of ["ja", "en"] as const) {
  test(`startup root recovery ${language} nonmodal, cancel, retry and restart (mock Native)`, async ({
    page,
  }) => {
    await page.addInitScript(
      (value) => localStorage.setItem("my-knowledge.ui-language", value),
      language,
    );
    await page.route("**/@tauri-apps_api_app.js*", (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: 'export const getVersion = async () => "0.6.0";',
      }),
    );
    await page.route("**/src/lib/bridge.ts", (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: `
        const calls=window.recoveryCalls={retry:[],choose:0,open:0};
        window.recoveryRootReturned=false;
        const empty={workspaceId:null,rootPath:null,viewId:'startup-view',revision:0,nodes:[],watchError:null};
        const selected={...empty,workspaceId:'same-physical-root',rootPath:'/fixture/日本語 空白 root',viewId:'restored-view',revision:1};
        let snapshot=localStorage.getItem('recovery-fixture-restored')?selected:{...empty,startupRecovery:{reason:'pathUnavailable',canRetry:true}};
        export const aiHandoffApi={};
        export const bridge={
          beginView:async()=>snapshot,getTree:async()=>snapshot,listen:async()=>()=>{},
          chooseRoot:async()=>{throw Error("unexpected free picker");},
          getManagedFolders:async()=>({revision:"1",selectedId:null,folders:[{id:"missing",name:"Missing folder",path:"/fixture/missing",status:"missing",kitUpdate:"current",error:null}]}),
          registerManagedFolder:async()=>{calls.choose++;return null;},
          retrySavedRoot:async(viewId)=>{calls.retry.push(viewId);if(window.recoveryRootReturned){snapshot=selected;localStorage.setItem('recovery-fixture-restored','yes');}return snapshot;},
          getWorkspaceLists:async()=>({favorites:[],folderFavorites:[],recent:[],error:null,readOnly:false}),
          createTab:async()=>{calls.open++;throw Error('unexpected document open');},
          getDocumentStorageHold:async()=>{throw Error('unexpected admitted-document probe');},
          refresh:async()=>snapshot
        };
      `,
      }),
    );
    await page.goto("/");
    const retry = page.getByRole("button", {
      name: language === "ja" ? "保存フォルダーを再試行" : "Retry saved folder",
      exact: true,
    });
    const choose = page.locator(".workspace-feedback").getByRole("button", {
      name: language === "ja" ? "Mogledge 専用フォルダーを管理" : "Manage Mogledge folders",
      exact: true,
    });
    const reason = page.locator(".workspace-feedback [role=status]");
    await expect(reason).toContainText(language === "ja" ? "ドライブ接続" : "drive connection");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.locator("iframe")).toHaveCount(0);
    expect(await page.evaluate("window.recoveryCalls")).toEqual({ retry: [], choose: 0, open: 0 });
    await choose.focus();
    await page.keyboard.press("Enter");
    const settings = page.getByRole("dialog");
    await expect(settings).toContainText(language === "ja" ? "見つかりません" : "Folder not found");
    expect(await page.evaluate("window.recoveryCalls.choose")).toBe(0);
    await settings
      .getByRole("button", {
        name: language === "ja" ? "既存フォルダーを登録" : "Register an existing folder",
        exact: true,
      })
      .click();
    await expect(settings).toBeVisible();
    await settings
      .getByRole("button", { name: language === "ja" ? "閉じる" : "Close", exact: true })
      .click();
    await expect(retry).toBeVisible();
    expect(await page.evaluate("window.recoveryCalls.choose")).toBe(1);
    await retry.focus();
    await page.keyboard.press("Enter");
    await expect(reason).toBeVisible();
    await expect(retry).toBeFocused();
    expect(await page.evaluate("window.recoveryCalls.retry")).toEqual(["startup-view"]);
    await page.setViewportSize({ width: 320, height: 640 });
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(choose).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
      await page.screenshot({
        path: test.info().outputPath(`startup-recovery-${language}-${colorScheme}.png`),
      });
    }
    await page.evaluate("window.recoveryRootReturned=true");
    await retry.click();
    await expect(reason).toHaveCount(0);
    await expect(page.getByRole("button", { name: "日本語 空白 root", exact: true })).toBeVisible();
    await expect(page.locator("iframe")).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("button", { name: "日本語 空白 root", exact: true })).toBeVisible();
    await expect(reason).toHaveCount(0);
    expect(await page.evaluate("window.recoveryCalls.open")).toBe(0);
  });
}
