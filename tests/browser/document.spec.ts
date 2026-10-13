import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
let process: ChildProcess;
let urls: { shellUrl: string; documentUrl: string; origin: string };
test.beforeAll(async () => {
  process = spawn(
    resolve(
      "src-tauri/target/debug/document-harness" +
        (globalThis.process.platform === "win32" ? ".exe" : "") +
        "",
    ),
    [resolve("tests/fixtures/knowledge")],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  urls = await new Promise((done, reject) => {
    const lines = createInterface({ input: process.stdout! });
    lines.once("line", (line) => {
      try {
        done(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
      lines.close();
    });
    process.once("error", reject);
    process.once("exit", (code) => reject(new Error("Harness exited " + code)));
  });
});
test.afterAll(() => process?.kill());
test("loads local assets in an opaque sandbox", async ({ page }) => {
  await page.goto(urls.shellUrl);
  const frame = page.frameLocator("#document");
  await expect(frame.locator("#module-result")).toHaveText("Module ready: local JSON");
  await expect(frame.locator("html")).toHaveAttribute("data-classic", "ready");
  await frame.locator("#action").click();
  await expect(frame.locator("html")).toHaveAttribute("data-canvas", "drawn");
  expect(
    await frame
      .locator("#local-image")
      .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
  ).toBe(true);
  expect(
    await frame.locator("body").evaluate(() => {
      try {
        return Boolean(parent.document);
      } catch {
        return false;
      }
    }),
  ).toBe(false);
});
test("blocks foreign fetches and parent navigation", async ({ page }) => {
  const forbidden: string[] = [];
  page.on("request", (request) => {
    if (!request.url().startsWith(urls.origin) && !request.url().startsWith(urls.shellUrl))
      forbidden.push(request.url());
  });
  await page.goto(urls.shellUrl);
  const frame = page.frameLocator("#document");
  const blocked = await frame.locator("body").evaluate(async () => {
    try {
      await fetch("https://example.com");
      return false;
    } catch {
      return true;
    }
  });
  expect(blocked).toBe(true);
  await frame.locator("body").evaluate(() => {
    try {
      parent.location.href = "https://example.com";
    } catch {
      /* opaque sandbox */
    }
  });
  await page.waitForTimeout(200);
  expect(forbidden).toEqual([]);
});
test("top-level browser display keeps the HTTP sandbox and local assets without Native APIs", async ({
  page,
}) => {
  const response = await page.goto(urls.documentUrl);
  expect(response!.headers()["content-security-policy"]).toContain("sandbox allow-scripts");
  await expect(page.locator("#module-result")).toHaveText("Module ready: local JSON");
  await page.locator("#action").click();
  await expect(page.locator("html")).toHaveAttribute("data-canvas", "drawn");
  expect(
    await page.evaluate(() => {
      let storage = false;
      try {
        localStorage.setItem("sandbox-probe", "x");
        storage = true;
      } catch {
        // HTTP sandbox keeps the top-level document's origin opaque too.
      }
      return {
        storage,
        native: "__TAURI_INTERNALS__" in window || "__TAURI__" in window,
      };
    }),
  ).toEqual({ storage: false, native: false });
});
