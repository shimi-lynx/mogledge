// Compiled frontend + production Rust HTTP responses/CSP; IPC is a controlled
// fixture. This does not execute WebView2 or WKWebView navigation callbacks.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const documentOrigin = process.env.HELP_DOCUMENT_ORIGIN;
const documentUrl = process.env.HELP_USER_DOCUMENT_URL;
assert.ok(documentOrigin && documentUrl);
const nativeSource = await readFile("src-tauri/src/lib.rs", "utf8");
const shellTemplate = nativeSource.match(/format!\("(default-src 'self';[^\n]+)"\)/)?.[1];
assert.ok(shellTemplate, "read the actual Native shell CSP template");
const shellCsp = shellTemplate.replace("{dev_connect}", "").replace("{origin}", documentOrigin);
const ui = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, "http://127.0.0.1:1420").pathname;
    if (path === "/favicon.ico") {
      response.writeHead(204).end();
      return;
    }
    assert.match(path, /^(?:\/(?:index\.html)?|\/assets\/[\w.-]+)$/);
    const bytes = await readFile(`dist${path === "/" ? "/index.html" : path}`);
    response.writeHead(200, {
      "Content-Type": path.endsWith(".js")
        ? "text/javascript"
        : path.endsWith(".css")
          ? "text/css"
          : "text/html; charset=utf-8",
      "Content-Security-Policy": shellCsp,
    });
    response.end(bytes);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve, reject) => {
  ui.once("error", reject);
  ui.listen(1420, "127.0.0.1", resolve);
});
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
});
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  // This regression exercises both help translations from an explicit locale.
  await page.addInitScript(() => {
    if (window === window.top) localStorage.setItem("my-knowledge.ui-language", "ja");
  });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const helpRequests = [];
  page.on("request", (request) => {
    if (request.url().includes("/__app/help/")) helpRequests.push(request.url());
  });
  await page.addInitScript(
    ({ documentOrigin, documentUrl }) => {
      let rootIndex = 0;
      const roots = ["/fixture/別フォルダー", "/fixture/日本語 空白/深い/フォルダー/root 空白"];
      const snapshot = () => ({
        workspaceId: rootIndex ? `root-${rootIndex}` : null,
        viewId: `view-${rootIndex}`,
        rootPath: rootIndex ? roots[rootIndex - 1] : null,
        revision: 1,
        documentOrigin,
        nodes: rootIndex
          ? [{ kind: "html", name: "index.html", relativePath: "index.html", children: [] }]
          : [],
        watchError: null,
      });
      let callback = 0;
      window.__TAURI_INTERNALS__ = {
        transformCallback: () => ++callback,
        unregisterCallback: () => {},
        invoke: async (command) => {
          switch (command) {
            case "plugin:event|listen":
              return ++callback;
            case "plugin:event|unlisten":
              return;
            case "plugin:app|version":
              return "0.6.0";
            case "begin_document_view":
            case "get_knowledge_tree":
              return snapshot();
            case "choose_knowledge_root":
              rootIndex++;
              return snapshot();
            case "get_workspace_lists":
              return {
                favorites: [],
                folderFavorites: [],
                recent: [],
                error: null,
                readOnly: false,
              };
            case "get_workspace_sets":
              return { sets: [], error: null, readOnly: false };
            case "create_document_tab":
              return "fixture-native-tab";
            case "open_document":
              return documentUrl;
            case "record_document_display":
            case "close_document_tab":
              return;
            default:
              throw new Error(`unexpected fixture IPC: ${command}`);
          }
        },
      };
    },
    { documentOrigin, documentUrl },
  );
  await page.goto("http://127.0.0.1:1420");
  await page.getByRole("button", { name: "機能と使い方", exact: true }).click();
  const help = page.locator(".app-help-frame");
  await help.waitFor();
  assert.equal(await help.getAttribute("srcdoc"), null);
  assert.equal(await help.getAttribute("src"), `${documentOrigin}/__app/help/ja.html`);
  assert.equal(await help.getAttribute("sandbox"), "");
  const heading = (name) => help.contentFrame().getByRole("heading", { name, exact: true });
  await heading("機能と使い方").waitFor();
  const originalHelp = await help.elementHandle();
  await help.contentFrame().getByRole("radio", { name: "使い方", exact: true }).focus();
  await help.contentFrame().getByRole("radio", { name: "使い方", exact: true }).press("Space");
  await page.getByRole("button", { name: "機能と使い方", exact: true }).click();
  assert.equal(
    await help.contentFrame().getByRole("radio", { name: "使い方", exact: true }).isChecked(),
    true,
  );
  assert.equal(helpRequests.length, 1, "reuse does not refetch help");
  await page.locator(".workspace-button").click();
  await heading("機能と使い方").waitFor();
  assert.equal(
    await help.evaluate((element, original) => element === original, originalHelp),
    true,
  );
  assert.equal(helpRequests.length, 1, "root selection does not reload help");
  await page.getByRole("treeitem", { name: "index HTML", exact: true }).click();
  const user = page.locator('iframe[title="index.html"]');
  const input = user.contentFrame().getByRole("textbox", { name: "Retained input" });
  await input.fill("日本語 / unchanged input");
  const originalUser = await user.elementHandle();
  await page.getByRole("button", { name: "機能と使い方", exact: true }).click();
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await page.locator(".language-picker select").selectOption("en");
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await heading("Features and usage").waitFor();
  assert.equal(await help.getAttribute("src"), `${documentOrigin}/__app/help/en.html`);
  await help.contentFrame().getByRole("radio", { name: "Shortcuts", exact: true }).focus();
  await help.contentFrame().getByRole("radio", { name: "Shortcuts", exact: true }).press("Space");
  await page.screenshot({ path: "/tmp/help-production-en.png" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator(".language-picker select").selectOption("ja");
  await page.getByRole("dialog").getByRole("button", { name: "閉じる", exact: true }).click();
  await heading("機能と使い方").waitFor();
  await page.getByRole("tab", { name: "index.html", exact: true }).click();
  assert.equal(await input.inputValue(), "日本語 / unchanged input");
  assert.equal(
    await user.evaluate((element, original) => element === original, originalUser),
    true,
  );
  assert.deepEqual(
    await user
      .contentFrame()
      .locator("body")
      .evaluate(() => ({
        count: window.retainedState.count,
        pixel: [...document.querySelector("canvas").getContext("2d").getImageData(0, 0, 1, 1).data],
      })),
    { count: 7, pixel: [51, 170, 85, 255] },
  );
  await page.locator(".workspace-button").click();
  await page.getByRole("button", { name: "機能と使い方", exact: true }).click();
  await heading("機能と使い方").waitFor();
  assert.equal(
    await help.evaluate((element, original) => element === original, originalHelp),
    true,
  );
  assert.equal(await help.getAttribute("src"), `${documentOrigin}/__app/help/ja.html`);
  await page.screenshot({ path: "/tmp/help-production-ja.png" });
  assert.deepEqual(errors, []);
  console.log(
    "production help contract: PASS (compiled UI, Native HTTP/CSP, no-root/root switches, JA/EN, reuse, user input/JS/Canvas; IPC fixture, Native WebView unverified)",
  );
} finally {
  await browser.close();
  await new Promise((resolve) => ui.close(resolve));
}
