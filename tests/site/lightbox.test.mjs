import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";

const site = fileURLToPath(new URL("../../site/", import.meta.url));
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".webp": "image/webp",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
let server;
let browser;
let url;

before(async () => {
  server = createServer((request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (!pathname.startsWith("/mogledge/")) {
      response.writeHead(404).end();
      return;
    }
    let relative = pathname.slice("/mogledge/".length);
    if (!relative || relative.endsWith("/")) relative += "index.html";
    const file = path.resolve(site, relative);
    if (!file.startsWith(site) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": mime[path.extname(file)] || "application/octet-stream",
    });
    createReadStream(file).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}/mogledge/`;
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

async function openScreenshot(page, language = "en") {
  const pageURL = url + (language === "ja" ? "ja/" : "");
  await page.goto(pageURL);
  const link = page.locator(".screenshot a").nth(2);
  await link.scrollIntoViewIfNeeded();
  // Finish the site's smooth scrolling before measuring the return position.
  await page.evaluate(() => {
    document.documentElement.style.scrollBehavior = "auto";
    scrollTo(
      0,
      document.querySelectorAll(".screenshot a")[2].getBoundingClientRect().top + scrollY - 80,
    );
  });
  const scroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
  await link.focus();
  await link.click();
  assert.equal(page.url(), pageURL, "opening a screenshot must not navigate to the raw image");
  const dialog = page.getByRole("dialog", {
    name: language === "ja" ? "画像プレビュー" : "Screenshot preview",
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: language === "ja" ? "画像を閉じる" : "Close image" }),
  ).toBeFocused();
  assert.equal(
    await dialog.locator("img").getAttribute("alt"),
    await link.locator("img").getAttribute("alt"),
  );
  return { dialog, link, scroll, pageURL };
}

async function expectRestored(page, state) {
  await expect(state.dialog).not.toBeVisible();
  await expect(state.link).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => scrollY), {
      message: "restore the original vertical scroll position",
    })
    .toBeCloseTo(state.scroll.y, 0);
  await expect
    .poll(() => page.evaluate(() => scrollX), {
      message: "restore the original horizontal scroll position",
    })
    .toBeCloseTo(state.scroll.x, 0);
  assert.equal(page.url(), state.pageURL);
}

test("desktop close button returns to the screenshot and scroll position", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    const state = await openScreenshot(page);
    await state.dialog.getByRole("button", { name: "Close image" }).click();
    await expectRestored(page, state);
  } finally {
    await page.close();
  }
});

test("Escape closes after keyboard opening and permits reopening", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    const state = await openScreenshot(page);
    await page.keyboard.press("Escape");
    await expectRestored(page, state);
    await page.keyboard.press("Enter");
    await expect(state.dialog).toBeVisible();
    await page.keyboard.press("Tab");
    assert.equal(
      await state.dialog.evaluate((element) => element.contains(document.activeElement)),
      true,
    );
    await page.keyboard.press("Escape");
    await expectRestored(page, state);
  } finally {
    await page.close();
  }
});

test("mobile touch close restores the page without background scrolling", async () => {
  const page = await browser.newPage({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const state = await openScreenshot(page);
    const bounds = await state.dialog.getByRole("button", { name: "Close image" }).boundingBox();
    assert.ok(bounds && bounds.height >= 44 && bounds.x >= 0 && bounds.y >= 0);
    assert.ok(bounds.x + bounds.width <= 375 && bounds.y + bounds.height <= 812);
    const lockedScroll = await page.evaluate(() => scrollY);
    await page.mouse.wheel(0, 500);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    assert.equal(await page.evaluate(() => scrollY), lockedScroll);
    await state.dialog.getByRole("button", { name: "Close image" }).tap();
    await expectRestored(page, state);
  } finally {
    await page.close();
  }
});

test("backdrop close restores focus and content clicks keep the dialog open", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    const state = await openScreenshot(page);
    await state.dialog.locator("img").click();
    await expect(state.dialog).toBeVisible();
    await page.mouse.click(2, 2);
    await expectRestored(page, state);
  } finally {
    await page.close();
  }
});

for (const width of [375, 1440]) {
  test(`Japanese viewer closes and restores focus/scroll at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      const state = await openScreenshot(page, "ja");
      const bounds = await state.dialog.getByRole("button", { name: "画像を閉じる" }).boundingBox();
      assert.ok(bounds && bounds.height >= 44 && bounds.x >= 0 && bounds.y >= 0);
      assert.ok(bounds.x + bounds.width <= width && bounds.y + bounds.height <= 900);
      await page.keyboard.press("Escape");
      await expectRestored(page, state);
      await page.keyboard.press("Enter");
      await expect(state.dialog).toBeVisible();
      await state.dialog.getByRole("button", { name: "画像を閉じる" }).click();
      await expectRestored(page, state);
    } finally {
      await page.close();
    }
  });
}
