import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const html = await readFile("src-tauri/html-authoring-kit/template.html", "utf8");
const templateUrl = "https://kit-fixture.test/template.html";

test("bundled complete HTML saves and restores in a normal browser without repo resources", async ({
  page,
}) => {
  await page.route(templateUrl, (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: html }),
  );
  await page.goto(templateUrl);
  await expect(page.locator("#status")).toHaveText("保存値なし");
  expect(await page.locator("script[src],link[href]").count()).toBe(0);
  await page.locator("#amount").fill("7");
  await page.locator("#mode").selectOption("square");
  await page.locator("#enabled").uncheck();
  await page.locator("#save").click();
  await expect(page.locator("#status")).toHaveText("保存済み");
  await page.reload();
  await expect(page.locator("#status")).toHaveText("復元済み");
  await expect(page.locator("#amount")).toHaveValue("7");
  await expect(page.locator("#mode")).toHaveValue("square");
  await expect(page.locator("#enabled")).not.toBeChecked();
  await expect(page.locator("#result")).toHaveText("無効");
});

test("complete HTML fake Native waits for restore and preserves values on read/write errors without fallback", async ({
  page,
}) => {
  let value: unknown = { schemaVersion: 1, data: { amount: 9, mode: "square", enabled: true } };
  let revision = 1;
  let failRead = false;
  let failWrite = false;
  let releaseRead!: () => void;
  const pendingRead = new Promise<void>((done) => {
    releaseRead = done;
  });
  const calls: string[] = [];
  await page.addInitScript(() => {
    Object.defineProperty(window, "__MY_KNOWLEDGE_STORAGE_V1__", {
      value: Object.freeze({
        version: 1,
        available: true,
        endpoint: "https://kit-fixture.test/storage",
      }),
    });
    let localAccesses = 0;
    Object.defineProperty(window, "localStorage", {
      get() {
        localAccesses++;
        throw Error("Unexpected fallback");
      },
    });
    Object.defineProperty(window, "fixtureLocalAccesses", { get: () => localAccesses });
  });
  await page.route(templateUrl, (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: html }),
  );
  await page.route("https://kit-fixture.test/storage", async (route) => {
    const request = route.request().postDataJSON() as { op: string; value?: unknown };
    calls.push(request.op);
    if (calls.length === 1) await pendingRead;
    if ((request.op === "read" && failRead) || (request.op === "write" && failWrite)) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          version: 1,
          error: request.op === "read" ? "StorageUnavailable" : "QuotaExceeded",
        }),
      });
      return;
    }
    if (request.op === "write") {
      value = request.value;
      revision++;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ version: 1, value, revision }),
    });
  });
  await page.goto(templateUrl, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#amount")).toBeDisabled();
  await expect(page.locator("#save")).toBeDisabled();
  await expect(page.locator("#result")).toHaveText("—");
  await expect.poll(() => calls).toEqual(["read"]);
  releaseRead();
  await expect(page.locator("#status")).toHaveText("復元済み");
  await expect(page.locator("#amount")).toHaveValue("9");
  await expect(page.locator("#result")).toHaveText("81");
  await page.locator("#amount").fill("12");
  await page.locator("#save").click();
  await expect(page.locator("#status")).toHaveText("保存済み");
  await page.reload();
  await expect(page.locator("#amount")).toHaveValue("12");
  await expect(page.locator("#result")).toHaveText("144");
  const saved = structuredClone(value);
  failWrite = true;
  await page.locator("#amount").fill("20");
  await page.locator("#save").click();
  await expect(page.locator("#status")).toContainText("QuotaExceeded");
  await expect(page.locator("#amount")).toHaveValue("20");
  expect(value).toEqual(saved);
  failRead = true;
  await page.reload();
  await expect(page.locator("#status")).toContainText("StorageUnavailable");
  await expect(page.locator("#save")).toBeDisabled();
  await page.locator("#amount").fill("3");
  await expect(page.locator("#result")).toHaveText("6");
  await page.waitForTimeout(150);
  expect(calls.at(-1)).toBe("read");
  expect(value).toEqual(saved);
  expect(
    await page.evaluate(
      () => (window as unknown as { fixtureLocalAccesses: number }).fixtureLocalAccesses,
    ),
  ).toBe(0);
});
