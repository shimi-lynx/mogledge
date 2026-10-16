import { expect, test } from "@playwright/test";

const rootName = "日本語 <img onerror=fail>&$1{root} " + "長い名前".repeat(20);
for (const language of ["ja", "en"] as const) {
  test(`creation labels show actual roots as safe text in ${language} with narrow light/dark UI`, async ({
    page,
  }) => {
    await page.addInitScript(
      (value) => localStorage.setItem("mogledge.ui-language", value),
      language,
    );
    // Actual creation components and styles; no Native IPC or filesystem writes.
    await page.route("**/src/app/App.tsx", async (route) => {
      const source = await (await route.fetch()).text();
      const reactModule = source.match(/from\s+["']([^"']*\/react\.js[^"']*)["']/)?.[1];
      if (!reactModule) throw new Error("Vite did not resolve React");
      await route.fulfill({
        contentType: "application/javascript",
        body: `
          import React from ${JSON.stringify(reactModule)};
          import {KnowledgeTree} from '/src/features/knowledge-tree/KnowledgeTree.tsx';
          const name=${JSON.stringify(rootName)};
          const roots=${JSON.stringify(["C:\\fixture\\" + rootName + "\\", "/Volumes/New root/", "C:\\", "/"])};
          window.creationMutations=[];
          export function App(){
            const [index,setIndex]=React.useState(0);
            return React.createElement(React.Fragment,null,
              React.createElement('button',{style:{marginLeft:240,width:120},onClick:()=>setIndex(value=>(value+1)%roots.length)},'Change fixture root'),
              React.createElement('aside',{className:'sidebar',style:{width:220,height:500}},
                React.createElement(KnowledgeTree,{rootPath:roots[index],workspaceId:'root-'+index,
                  nodes:[{name,relativePath:name,kind:'folder',children:[]}],selected:null,onSelect:()=>{},
                  onMutation:async mutation=>{window.creationMutations.push(mutation);return null;}})));
          }
        `,
      });
    });
    await page.setViewportSize({ width: 380, height: 650 });
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    const names =
      language === "ja"
        ? {
            root: "ルートにフォルダーを作成",
            suffix: "（ルート）",
            destination: "作成先",
            cancel: "キャンセル",
          }
        : {
            root: "Create a folder in the root",
            suffix: " (root)",
            destination: "Create in",
            cancel: "Cancel",
          };
    const root = page.getByRole("button", { name: names.root, exact: true });
    await expect(root).toHaveAttribute("aria-description", new RegExp("日本語"));
    await root.click();
    const picker = page.getByRole("combobox", { name: names.destination });
    await expect(picker).toHaveValue(rootName + names.suffix);
    await expect(picker).toHaveAttribute("title", rootName + names.suffix);
    await picker.press("ArrowDown");
    await expect(page.getByRole("option")).toHaveText([rootName + names.suffix, rootName]);
    await expect(page.getByRole("option").first()).toHaveAttribute(
      "title",
      rootName + names.suffix,
    );
    await expect(page.locator("dialog img")).toHaveCount(0);
    await expect(page.locator("dialog")).toBeInViewport();
    const light = await page
      .locator("dialog")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    await page.emulateMedia({ colorScheme: "dark" });
    await expect
      .poll(() =>
        page.locator("dialog").evaluate((element) => getComputedStyle(element).backgroundColor),
      )
      .not.toBe(light);
    await page.screenshot({
      path: test.info().outputPath(`root-creation-${language}-dark-narrow-mock.png`),
    });
    await picker.press("Enter");
    await page.getByRole("button", { name: names.cancel, exact: true }).click();
    await expect(page.getByRole("tree")).toBeFocused();
    for (const next of ["New root", "C:\\", "/"]) {
      await page.getByRole("button", { name: "Change fixture root" }).click();
      await expect(root).toHaveAttribute("title", new RegExp(next === "C:\\" ? "C:" : next));
      await root.click();
      await expect(picker).toHaveValue(next + names.suffix);
      await page.getByRole("button", { name: names.cancel, exact: true }).click();
    }
    expect(await page.evaluate("window.creationMutations")).toEqual([]);
  });
}
