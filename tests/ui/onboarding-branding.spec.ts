import { expect, test } from "@playwright/test";

for (const density of [1, 2]) {
  test.describe(`welcome image at ${density}x`, () => {
    test.use({ deviceScaleFactor: density });
    test("loads the light D2 welcome image at the display density (component fixture)", async ({
      page,
    }) => {
      await page.route("**/src/app/App.tsx", async (route) => {
        const source = await (await route.fetch()).text();
        const reactModule = source.match(/from\s+["']([^"']*\/react\.js[^"']*)["']/)?.[1];
        if (!reactModule) throw new Error("Vite did not resolve React");
        await route.fulfill({
          contentType: "application/javascript",
          body: `
            import React from ${JSON.stringify(reactModule)};
            import { DocumentViewer } from '/src/features/document-viewer/DocumentViewer.tsx';
            export function App() {
              return React.createElement('main', {style:{height:'100dvh'}},
                React.createElement(DocumentViewer, {url:null,loading:false}));
            }
          `,
        });
      });
      await page.goto("/");
      const image = page.locator(".welcome-symbol");
      await expect(image).toBeVisible();
      await expect(image).toHaveCSS("width", "92px");
      await expect(image).toHaveCSS("height", "92px");
      // natural dimensions are density-corrected for srcset's 2x candidate.
      await expect(image).toHaveJSProperty("naturalWidth", 128);
      await expect(image).toHaveJSProperty("naturalHeight", 128);
      await expect(image).toHaveAttribute("alt", "");
      await expect(page.locator("iframe")).toHaveCount(0);
      const currentSource = await image.evaluate((element: HTMLImageElement) => element.currentSrc);
      const response = await page.request.get(currentSource);
      expect(response.ok()).toBe(true);
      const bytes = await response.body();
      expect(bytes.length).toBe(density === 1 ? 15_930 : 51_794);
      expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(bytes.readUInt32BE(16)).toBe(density === 1 ? 128 : 256);
      expect(bytes.readUInt32BE(20)).toBe(density === 1 ? 128 : 256);
      await page.screenshot({ path: test.info().outputPath(`d2-welcome-${density}x.png`) });
    });
  });
}
