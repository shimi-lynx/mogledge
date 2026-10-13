import { expect, test, type Locator } from "@playwright/test";

async function expectFullWidth(root: Locator, longName = false) {
  const geometry = await root.evaluate((element) => {
    const toolbar = element.closest(".sidebar-toolbar")!;
    const parent = element.parentElement!;
    const name = element.querySelector(".workspace-name")!;
    const icon = element.querySelector(".workspace-icon")!;
    const chevron = element.querySelector(".workspace-chevron")!;
    const bounds = element.getBoundingClientRect();
    const available = parent.getBoundingClientRect();
    const toolbarBounds = toolbar.getBoundingClientRect();
    const toolbarStyle = getComputedStyle(toolbar);
    return {
      left: bounds.left,
      right: bounds.right,
      availableLeft: available.left,
      availableRight: available.right,
      toolbarRight: toolbarBounds.right - parseFloat(toolbarStyle.paddingRight),
      height: bounds.height,
      iconLeft: icon.getBoundingClientRect().left,
      iconRight: icon.getBoundingClientRect().right,
      nameLeft: name.getBoundingClientRect().left,
      nameRight: name.getBoundingClientRect().right,
      chevronLeft: chevron.getBoundingClientRect().left,
      chevronRight: chevron.getBoundingClientRect().right,
      textAlign: getComputedStyle(element).textAlign,
      ellipsis: getComputedStyle(name).textOverflow,
      nowrap: getComputedStyle(name).whiteSpace,
      clipped: name.scrollWidth > name.clientWidth,
      toolbarOverflow: toolbar.scrollWidth > toolbar.clientWidth,
    };
  });
  expect(Math.abs(geometry.left - geometry.availableLeft)).toBeLessThan(1);
  expect(Math.abs(geometry.right - geometry.availableRight)).toBeLessThan(1);
  expect(Math.abs(geometry.right - geometry.toolbarRight)).toBeLessThan(1);
  expect(geometry.height).toBe(32);
  expect(geometry.iconLeft - geometry.left).toBe(9);
  expect(geometry.nameLeft).toBeGreaterThan(geometry.iconRight);
  expect(geometry.nameRight).toBeLessThan(geometry.chevronLeft);
  expect(geometry.right - geometry.chevronRight).toBe(9);
  expect(geometry.textAlign).toBe("left");
  expect(geometry.ellipsis).toBe("ellipsis");
  expect(geometry.nowrap).toBe("nowrap");
  expect(geometry.toolbarOverflow).toBe(false);
  if (longName) expect(geometry.clipped).toBe(true);
}

for (const language of ["ja", "en"] as const) {
  test(`root selector fills available width ${language}, long names, resize and existing actions (mock Native)`, async ({
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
        const calls=window.rootWidthCalls={choose:0,actions:[]};
        let snapshot={workspaceId:'root-width',viewId:'root-width-view',rootPath:'/fixture/Short',revision:1,nodes:[],watchError:null};
        export const aiHandoffApi={};
        export const bridge={
          beginView:async()=>snapshot,getTree:async()=>snapshot,listen:async()=>()=>{},
          chooseRoot:async()=>{calls.choose++;if(!window.nextRootPath)return null;snapshot={...snapshot,rootPath:window.nextRootPath,revision:snapshot.revision+1};window.nextRootPath=null;return snapshot;},
          getWorkspaceLists:async()=>({favorites:[],folderFavorites:[],recent:[],error:null,readOnly:false}),
          refresh:async()=>snapshot
        };
        `,
      }),
    );
    await page.route("**/src/lib/rootActions.ts", (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: "export const rootActionsApi={perform:async(context,action)=>window.rootWidthCalls.actions.push({context,action})};",
      }),
    );
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.goto("/");
    const root = page.locator(".workspace-button");
    const separator = page.getByRole("separator");
    await expect(root).toBeEnabled();
    await expect(root).toHaveText("Short");
    await expectFullWidth(root);
    // Left click, chevron click, Enter and Space retain the OS-picker dispatch.
    // Returning null models cancellation; no HTML dropdown is created by this control.
    await root.click();
    await root.locator(".workspace-chevron").click();
    await root.press("Enter");
    await root.press("Space");
    await expect.poll(() => page.evaluate("window.rootWidthCalls.choose")).toBe(4);
    await expect(root).toHaveText("Short");
    const names = [
      "Short",
      "長い日本語のルートフォルダー名と資料".repeat(8),
      "A very long English root folder name with spaces ".repeat(8).trim(),
    ];
    for (const [index, name] of names.entries()) {
      await page.evaluate((name) => {
        (window as unknown as { nextRootPath: string }).nextRootPath = "/fixture/" + name;
      }, name);
      await root.click();
      await expect(root).toHaveText(name);
      await expect(root).toHaveAttribute("title", "/fixture/" + name);
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        for (const key of ["Home", "End"] as const) {
          await separator.press(key);
          await expect(separator).toHaveAttribute("aria-valuenow", key === "Home" ? "230" : "450");
          await expectFullWidth(root, index > 0);
        }
        await separator.press("Home");
        await page.screenshot({
          path: test.info().outputPath(`root-width-${language}-${index}-${colorScheme}.png`),
        });
      }
    }
    await page.setViewportSize({ width: 320, height: 600 });
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await expectFullWidth(root, true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
      const chooseCount = await page.evaluate("window.rootWidthCalls.choose");
      await root.click({ button: "right", position: { x: 190, y: 16 } });
      const labels =
        language === "ja"
          ? ["AIに渡す", "フルパスをコピー", "フォルダーを開く"]
          : ["Send to AI", "Copy full path", "Open folder"];
      await expect(page.getByRole("menuitem")).toHaveText(labels);
      await page.keyboard.press("Escape");
      await expect(root).toBeFocused();
      await root.press("Shift+F10");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await expect(root).toBeFocused();
      await root.press("Shift+F10");
      await page.keyboard.press("End");
      await page.screenshot({
        path: test.info().outputPath(`root-width-${language}-320-${colorScheme}.png`),
      });
      await page.keyboard.press("Space");
      await expect(root).toBeFocused();
      expect(await page.evaluate("window.rootWidthCalls.choose")).toBe(chooseCount);
    }
    expect(await page.evaluate("window.rootWidthCalls.actions")).toEqual(
      ["copyPath", "openFolder", "copyPath", "openFolder"].map((action) => ({
        context: { workspaceId: "root-width", viewId: "root-width-view", target: "root" },
        action,
      })),
    );
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
}
