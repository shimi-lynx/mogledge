import { test, expect } from "@playwright/test";

// Isolated search feature with an explicit bridge mock; no native success is
// inferred from this rendering / contrast / keyboard check.
test("compact search controls and safe highlights remain usable at minimum sidebar width", async ({
  page,
}) => {
  // Use Vite's resolved imports so the preview and transformed feature share
  // one React dispatcher, including optimizer query/version parameters.
  const mainSource = await (await page.request.get("/src/main.tsx")).text();
  const featureSource = await (
    await page.request.get("/src/features/document-search/SearchPanel.tsx")
  ).text();
  const reactModule = featureSource.match(/from\s+["']([^"']*\/react\.js[^"']*)["']/)?.[1];
  const clientModule = mainSource.match(/from\s+["']([^"']*\/react-dom_client\.js[^"']*)["']/)?.[1];
  if (!reactModule || !clientModule)
    throw new Error("Vite did not resolve the preview React imports");
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>
      body {margin:0;background:#172333;color:#eef5fc;font:14px sans-serif;display:flex;height:100vh}
      #root {width:230px;display:flex;flex-direction:column;border-right:1px solid #425165;padding-top:16px}
      main {padding:24px}
      </style></head><body><div id="root"></div><main>文書表示領域</main>
      <script type="module">
      import RefreshRuntime from "/@react-refresh";
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      </script>
      <script type="module">
      import React from ${JSON.stringify(reactModule)};
      import ReactDOM from ${JSON.stringify(clientModule)};
      const {createRoot} = ReactDOM;
      import {SearchPanel} from '/src/features/document-search/SearchPanel.tsx';
      const status = {workspaceId:'preview',rootId:'preview-root',phase:'ready',generation:1,requestRevision:1,indexed:2,pending:0,unavailable:0,failed:0,truncated:0,databaseBytes:8192,complete:true,limited:false,rebuilt:false,error:null};
      const bridge = {
        getStatus: async () => status,
        rebuild: async () => status,
        search: async (_workspace, query, _limit, _offset, mode, scope) => {
          window.previewSearches = (window.previewSearches || 0) + 1;
          window.previewMode = mode;
          window.previewScope = scope;
          return {generation:1,requestRevision:1,normalizedQuery:query,hits:[{
            documentId:'preview-document',relativePath:'Search/Guide.html',title:'東京のＲＵＳＴ資料',
            snippet:'…検索に一致した東京の情報。<script> は文字列です。',truncated:false,
            titleMatches:[{start:0,end:2},{start:3,end:7}],snippetMatches:[{start:8,end:10}]
          }],hasMore:false};
        }
      };
      function Preview() {
        const [scope, setScope] = React.useState({relativePath:'資料/とても長いフォルダー名/100%_計画',viewId:'preview-view'});
        return React.createElement(SearchPanel,{workspaceId:'preview',viewId:'preview-view',revision:1,bridge,scope,onResetScope:()=>setScope(undefined),onSelect:()=>{window.previewSelected=true}});
      }
      createRoot(document.getElementById('root')).render(React.createElement(Preview));
      </script></body></html>`,
    }),
  );
  await page.goto("/");
  await expect
    .poll(async () => {
      if (pageErrors.length) throw new Error(pageErrors.join("\n"));
      return page.locator("input[type=search]").count();
    })
    .toBe(1);
  expect(pageErrors).toEqual([]);
  const input = page.getByRole("searchbox");
  await expect(page.locator('.search-form button[type="submit"]')).toHaveCount(0);
  expect((await input.boundingBox())!.width).toBeGreaterThan(95);
  const scope = page.getByLabel("検索範囲", { exact: true });
  await expect(scope).toBeVisible();
  await expect(scope.locator("span")).toHaveAttribute(
    "title",
    "資料/とても長いフォルダー名/100%_計画",
  );
  await input.fill("東京 rust");
  await expect(page.getByRole("list", { name: "検索結果" })).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { previewScope: { relativePath: string } }).previewScope.relativePath,
    ),
  ).toBe("資料/とても長いフォルダー名/100%_計画");
  const count = await page.evaluate(
    () => (window as unknown as { previewSearches: number }).previewSearches,
  );
  await input.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { previewSearches: number }).previewSearches),
    )
    .toBe(count + 1);
  await input.dispatchEvent("compositionstart");
  await input.press("Enter");
  await page.waitForTimeout(300);
  expect(
    await page.evaluate(() => (window as unknown as { previewSearches: number }).previewSearches),
  ).toBe(count + 1);
  await input.dispatchEvent("compositionend");
  await page.getByRole("button", { name: "検索の詳細設定" }).click();
  await page.getByRole("radio", { name: "OR（いずれかの語）" }).check();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { previewMode: string }).previewMode))
    .toBe("or");
  await expect(page.locator("mark")).toHaveCount(3);
  await expect(page.locator(".search-result-title")).toHaveText("東京のＲＵＳＴ資料");
  await expect(page.locator(".search-result-snippet")).toContainText("<script>");
  await expect(page.locator(".search-results script")).toHaveCount(0);
  expect(
    await page.locator("#root").evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: ".tools/search-preview-dark.png" });
  await page.screenshot({ path: ".tools/folder-search-preview-dark.png" });
  const contrast = await page
    .locator("mark")
    .first()
    .evaluate((element) => {
      const style = getComputedStyle(element);
      const luminance = (color: string) => {
        const components = color
          .match(/\d+/g)!
          .slice(0, 3)
          .map(Number)
          .map((value) => {
            const component = value / 255;
            return component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4;
          });
        return components[0] * 0.2126 + components[1] * 0.7152 + components[2] * 0.0722;
      };
      const foreground = luminance(style.color);
      const background = luminance(style.backgroundColor);
      return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
    });
  expect(contrast).toBeGreaterThan(4.5);
  const result = page.getByRole("list").getByRole("button");
  await result.focus();
  await page.keyboard.press("Enter");
  expect(
    await page.evaluate(() => (window as unknown as { previewSelected: boolean }).previewSelected),
  ).toBe(true);
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("mark").first()).toHaveCSS("font-weight", "700");
  await page.emulateMedia({ forcedColors: "active" });
  await page.screenshot({ path: ".tools/search-preview-forced-colors.png" });
  await page.screenshot({ path: ".tools/folder-search-preview-forced-colors.png" });
  await expect(page.locator("mark").first()).toHaveCSS("text-decoration-line", "underline");
  await page.getByRole("button", { name: "検索範囲を解除" }).click();
  await expect(scope).toHaveCount(0);
  await expect(input).toHaveValue("東京 rust");
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { previewScope?: unknown }).previewScope))
    .toBeUndefined();
});
