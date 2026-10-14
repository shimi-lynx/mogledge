import { expect, test, type Page } from "@playwright/test";

async function prepareLimits(page: Page) {
  await page.route("**/src/app/App.tsx", async (route) => {
    const source = await (await route.fetch()).text();
    const react = source.match(/from\s+["']([^"']*\/react\.js[^"']*)["']/)?.[1];
    if (!react) throw new Error("Vite did not resolve React");
    await route.fulfill({
      contentType: "application/javascript",
      body: `
      import React from ${JSON.stringify(react)};
      import { SidebarFooter } from '/src/app/SidebarFooter.tsx';
      import { storageLimitsApi } from '/src/lib/storageLimits.ts';
      import { managementApi } from '/src/lib/stateManagement.ts';
      window.limitsCalls = {get:0,set:[]};
      let limits = {documentBytes:5242880,totalBytes:536870912,documentMiB:5,totalMiB:512,revision:3,generation:7,usageBytes:80,largestDocumentBytes:80,recoveryBytes:20,largestRecoveryDocumentBytes:20,requiresCompatibilityAcknowledgement:true,capabilities:{maximumDocumentBytes:1000000000,maximumRequestBytes:1000001024,maximumDatabaseBytes:17592186036224,recoveryBudgetBytes:536870912}};
      storageLimitsApi.get = async context => { window.limitsCalls.get++; return {...limits}; };
      storageLimitsApi.set = async request => {
        window.limitsCalls.set.push({...request});
        limits = {...limits,documentMiB:Math.floor(request.documentMiB),totalMiB:Math.floor(request.totalMiB),documentBytes:request.documentMiB*1048576,totalBytes:request.totalMiB*1048576,revision:request.expectedRevision+1,generation:request.expectedGeneration+1,requiresCompatibilityAcknowledgement:false};
        throw {code:'/private/transport/state.db'};
      };
      managementApi.list = async request => ({snapshotId:'inspection',databaseSchemaVersion:2,usage:{logicalBytes:80,records:0,recoveryLogicalBytes:20,recoveryRecords:0,databaseBytes:8192,journalBytes:0,freeDatabasePageBytes:4096},entries:[],offset:0,limit:20,hasMore:false});
      const state = {snapshot:{workspaceId:null,viewId:'quota-view'}};
      export function App() {
        return React.createElement('aside',{className:'sidebar',style:{width:230,height:'100dvh'}},
          React.createElement('input',{'aria-label':'kept input',defaultValue:'保持する入力 $& {root}',style:{margin:12,width:190}}),
          React.createElement('div',{style:{flex:1}}),
          React.createElement(SidebarFooter,{state,version:'0.6.0',reloadDisabled:true,onReload:()=>{}}));
      }
    `,
    });
  });
}
for (const language of ["ja", "en"] as const) {
  test(`storage limits use explicit edits and verification without restarting or retrying (${language}, synthetic Native API)`, async ({
    page,
  }) => {
    await prepareLimits(page);
    await page.addInitScript(
      (value) => localStorage.setItem("my-knowledge.ui-language", value),
      language,
    );
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto("/");
    const label = (ja: string, en: string) => (language === "ja" ? ja : en);
    const input = page.getByRole("textbox", { name: "kept input" });
    const original = await input.elementHandle();
    const settings = page.getByRole("button", { name: label("設定", "Settings"), exact: true });
    await settings.click();
    const dialog = page.getByRole("dialog");
    expect(await page.evaluate("window.limitsCalls.get")).toBe(0);
    const category = dialog.getByRole("button", {
      name: label("保存データ", "Saved data"),
      exact: true,
    });
    await category.click();
    const limits = dialog.getByRole("group", {
      name: label("保存入力の容量上限", "Saved-input storage limits"),
      exact: true,
    });
    await expect(limits).toContainText(
      label("文書5.243 MB・全体536.871 MB", "5.243 MB per document · 536.871 MB total"),
    );
    await expect(limits.getByRole("textbox")).toHaveCount(0);
    await expect(limits).toContainText(label("文書保存の技術上限", "Technical document capacity"));
    await expect(limits).toContainText("1 GB");
    expect(await page.evaluate("window.limitsCalls.set")).toEqual([]);
    await limits
      .getByRole("button", { name: label("保存上限を編集", "Edit storage limits"), exact: true })
      .click();
    const apply = limits.getByRole("button", {
      name: label("保存上限を適用", "Apply storage limits"),
      exact: true,
    });
    await expect(apply).toBeDisabled();
    await expect(limits.getByRole("checkbox")).toHaveCount(0);
    const documentLimit = limits.getByRole("textbox", {
      name: label("文書上限", "Document limit"),
    });
    const total = limits.getByRole("textbox", {
      name: label("全体上限", "Total limit"),
    });
    // Narrow layouts stack amount/unit fields instead of shrinking the amount
    // into a few clipped digits or overlapping their accessible labels.
    expect((await documentLimit.boundingBox())!.width).toBeGreaterThan(90);
    await documentLimit.fill("1.0000001");
    await expect(apply).toBeDisabled();
    await expect(documentLimit).not.toHaveAttribute("max", /.+/);
    await expect(total).not.toHaveAttribute("max", /.+/);
    await documentLimit.fill("2147.483648");
    await total.fill("20971520");
    await expect(limits).toContainText(
      label("大きい上限ではメモリ", "Larger limits may require more memory"),
    );
    await expect(limits).toContainText(
      label(
        "設定値が文書またはDBの技術上限を超えています",
        "Your limits exceed a technical document or database capacity",
      ),
    );
    await expect(apply).toBeDisabled();
    await limits.getByRole("checkbox").check();
    await expect(apply).toBeEnabled();
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await limits
        .getByRole("group", { name: label("変更する保存上限", "Storage limits to change") })
        .evaluate((element) => element.scrollIntoView({ block: "start" }));
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
      await page.screenshot({
        path: test.info().outputPath(`storage-limits-${language}-${scheme}-320.png`),
      });
    }
    await apply.click();
    await expect(limits).toContainText(
      label("保存上限の変更結果は不明です", "The limit-change outcome is unknown"),
    );
    await expect(limits).not.toContainText("/private/");
    await expect(apply).toBeDisabled();
    expect(await page.evaluate("window.limitsCalls.set")).toEqual([
      {
        context: { workspaceId: null, viewId: "quota-view" },
        expectedRevision: 3,
        expectedGeneration: 7,
        documentMiB: 2048,
        totalMiB: 20000000,
        acknowledgeCompatibility: true,
      },
    ]);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(settings).toBeFocused();
    await settings.click();
    await category.click();
    await expect(limits).toContainText(
      label("保存上限の変更結果は不明です", "The limit-change outcome is unknown"),
    );
    expect(await page.evaluate("window.limitsCalls.get")).toBe(1);
    expect(await page.evaluate("window.limitsCalls.set.length")).toBe(1);
    await limits
      .getByRole("button", { name: label("適用値を確認", "Check effective limits"), exact: true })
      .click();
    await expect(limits).toContainText(
      label("現在の適用値を確認しました", "Current effective limits checked"),
    );
    await expect(limits).toContainText(
      label("文書2.147 GB・全体20,971.52 GB", "2.147 GB per document · 20,971.52 GB total"),
    );
    await expect(apply).toBeDisabled();
    await limits
      .getByRole("button", { name: label("既定値を入力", "Fill in defaults"), exact: true })
      .click();
    await expect(documentLimit).toHaveValue("5.24288");
    await expect(total).toHaveValue("536.870912");
    expect(await page.evaluate("window.limitsCalls.set.length")).toBe(1);
    await limits
      .getByRole("button", {
        name: label("上限の編集を取り消す", "Cancel limit edits"),
        exact: true,
      })
      .click();
    await expect(limits.getByRole("textbox")).toHaveCount(0);
    await expect(dialog).not.toContainText(
      label(
        "変更を適用するには、アプリの再起動が必要です",
        "Restart the app to apply the changes.",
      ),
    );
    await page.keyboard.press("Escape");
    await expect(input).toHaveValue("保持する入力 $& {root}");
    expect(await input.evaluate((element, before) => element === before, original)).toBe(true);
  });
}
