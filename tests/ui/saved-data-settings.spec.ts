import { expect, test, type Page } from "@playwright/test";

const sourceName = "日本語 <img onerror=fail> $& {path} " + "長い名前".repeat(18) + ".html";
async function prepare(page: Page) {
  await page.route("**/src/app/App.tsx", async (route) => {
    const source = await (await route.fetch()).text();
    const react = source.match(/from\s+["']([^"']*\/react\.js[^"']*)["']/)?.[1];
    if (!react) throw new Error("Vite did not resolve React");
    await route.fulfill({
      contentType: "application/javascript",
      body: `
        import React from ${JSON.stringify(react)};
        import { SettingsDialog } from '/src/app/SettingsDialog.tsx';
        import { ManagementSession } from '/src/lib/stateManagement.ts';
        const context = {workspaceId:'root',viewId:'view'};
        const name = ${JSON.stringify(sourceName)};
        const id = 'a'.repeat(64);
        window.managementCalls = {list:0,prepare:0,confirm:0};
        let phase = 'active', generation = 1;
        const usage = () => ({logicalBytes:phase==='quarantined'?0:80, records:phase==='quarantined'?0:1, recoveryLogicalBytes:phase==='active'?0:80, recoveryRecords:phase==='active'?0:1, databaseBytes:8192,journalBytes:0,freeDatabasePageBytes:4096});
        const common = () => ({snapshotId:'snapshot-'+generation,databaseSchemaVersion:2,usage:usage(),offset:0,limit:20,hasMore:false});
        const api = {
          list:async request => {window.managementCalls.list++; return {...common(),entries:phase==='quarantined'?[]:[{documentIdentity:id,rootIdentity:'b'.repeat(64),relativePath:name,logicalBytes:80,revision:generation,sourceAvailability:'same_identity_present',lastViewedAt:null,eligible:true,holdReason:null}]};},
          recoveryList:async request => ({...common(),entries:phase==='active'?[]:[{recoveryId:'quarantine',documentIdentity:id,rootIdentity:'b'.repeat(64),relativePath:name,sourceRevision:1,logicalBytes:80,status:phase==='restored'?'restored':'quarantined',restoredRevision:phase==='restored'?generation:null,restorable:phase==='quarantined',holdReason:phase==='restored'?'restore_conflict_or_quota':null}]}),
          prepare:async request => {window.managementCalls.prepare++; return {planId:request.operation,operation:request.operation,snapshotId:request.snapshotId,candidateId:request.candidateId,documentIdentity:id,relativePath:name,logicalBytes:80,appCount:2,canConfirm:true,blockedReason:null,expiresInMs:300000};},
          confirm:async confirmation => {window.managementCalls.confirm++; phase=confirmation.planId==='quarantine'?'quarantined':'restored'; generation++; return {operationId:confirmation.planId,operation:confirmation.planId,documentIdentity:id,recoveryId:'quarantine',revision:generation,recoverable:true,permanentDeletion:false};},
          cancel:async () => ({status:'cancelled',verifyRequired:true}),
          verify:async () => ({status:'cancelled'})
        };
        const session = new ManagementSession(api);
        export function App() {
          const [open,setOpen] = React.useState(false);
          const origin = React.useRef(null);
          return React.createElement('main',{},
            React.createElement('input',{'aria-label':'kept input',defaultValue:'保持する入力 $& {root}'}),
            React.createElement('button',{ref:origin,onClick:()=>setOpen(true)},'Open settings'),
            open && React.createElement(SettingsDialog,{returnFocus:origin.current,managementContext:context,managementSession:session,onClose:()=>setOpen(false)}));
        }
      `,
    });
  });
}
for (const [language, scheme] of [
  ["ja", "dark"],
  ["en", "light"],
] as const) {
  test(`saved data requires explicit selection, preserves source/input and retains recovery copy (${language}/${scheme}, synthetic Native API)`, async ({
    page,
  }) => {
    await prepare(page);
    await page.addInitScript(
      (value) => localStorage.setItem("mogledge.ui-language", value),
      language,
    );
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto("/");
    const input = page.getByRole("textbox", { name: "kept input" });
    const original = await input.elementHandle();
    const settings = page.getByRole("button", { name: "Open settings" });
    await settings.click();
    const dialog = page.getByRole("dialog");
    expect(await page.evaluate("window.managementCalls.list")).toBe(0);
    await dialog
      .getByRole("button", { name: language === "ja" ? "保存データ" : "Saved data", exact: true })
      .click();
    const radio = dialog.getByRole("checkbox", { name: sourceName + " " + sourceName });
    await expect(radio).not.toBeChecked();
    await expect(dialog.locator("img")).toHaveCount(0);
    expect(await page.evaluate("window.managementCalls.prepare")).toBe(0);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    await page.screenshot({
      path: test.info().outputPath(`saved-data-list-${language}-${scheme}-320.png`),
    });
    await radio.check();
    await dialog
      .getByRole("button", {
        name:
          language === "ja" ? "選択した1件の削除を確認" : "Review removal of 1 selected records",
      })
      .click();
    const run = dialog.getByRole("button", {
      name: language === "ja" ? "確認した内容で実行" : "Run the reviewed operation",
    });
    await expect(run).toBeDisabled();
    await dialog.getByRole("checkbox").check();
    await page.screenshot({
      path: test.info().outputPath(`saved-data-preview-${language}-${scheme}-320.png`),
    });
    await run.click();
    const backName = language === "ja" ? "一覧へ戻る" : "Return to list";
    await dialog.getByRole("button", { name: backName, exact: true }).click();
    await expect(dialog.getByRole("radio")).toHaveCount(0);
    await dialog
      .getByRole("button", {
        name: language === "ja" ? "隔離と回復の一覧" : "Quarantine and recovery list",
      })
      .click();
    await dialog.getByRole("radio", { name: sourceName + " " + sourceName }).check();
    await dialog
      .getByRole("button", {
        name:
          language === "ja" ? "選択した対象の影響を確認" : "Review impact on the selected record",
      })
      .click();
    await dialog.getByRole("checkbox").check();
    await run.click();
    await dialog.getByRole("button", { name: backName, exact: true }).click();
    await expect(dialog.getByRole("radio", { name: sourceName + " " + sourceName })).toBeDisabled();
    expect(await page.evaluate("window.managementCalls.confirm")).toBe(2);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(settings).toBeFocused();
    await expect(input).toHaveValue("保持する入力 $& {root}");
    expect(await input.evaluate((element, before) => element === before, original)).toBe(true);
  });
}
