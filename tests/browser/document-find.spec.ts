import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const keyboard = readFileSync("src-tauri/src/document_server/keyboard.js", "utf8").replace(
  "__MOGLEDGE_KEYBOARD_TOKEN__",
  JSON.stringify("a".repeat(64)),
);

async function documentFrame(page: Page, platform = "MacIntel", language = "en-US") {
  await page.setContent(
    '<iframe sandbox="allow-scripts" style="width:100%;height:600px"></iframe>',
  );
  await page.locator("iframe").evaluate(
    (element, { keyboard, platform, language }) => {
      (element as HTMLIFrameElement).srcdoc = `<!doctype html><html><head><script>
        Object.defineProperty(navigator,'platform',{value:${JSON.stringify(platform)}});
        Object.defineProperty(navigator,'language',{value:${JSON.stringify(language)}});
      </script><script>${keyboard}</script></head><body>
        <button id="plain">Document</button><input id="editor" aria-label="Document input">
        <p id="first">First needle in this document.</p>
        <p style="margin-top:500px" id="second">Second needle in this document.</p>
        <dialog>Authored modal</dialog>
      </body></html>`;
    },
    { keyboard, platform, language },
  );
  const frame = page.frameLocator("iframe");
  await frame.locator("#plain").click();
  return frame;
}

test("Mac document find opens inside the opaque HTML and searches forward/backward with wrap", async ({
  page,
}) => {
  const frame = await documentFrame(page);
  await frame.locator("#plain").press("Meta+f");
  const search = frame.getByRole("searchbox", { name: "Find in this HTML" });
  await expect(search).toBeFocused();
  await search.fill("needle");
  const selected = () => frame.locator("body").evaluate(() => window.getSelection()?.toString());
  const selectedParent = () =>
    frame.locator("body").evaluate(() => window.getSelection()?.anchorNode?.parentElement?.id);
  await expect.poll(selected).toBe("needle");
  await expect.poll(selectedParent).toBe("first");
  await search.press("Enter");
  await expect.poll(selectedParent).toBe("second");
  await search.press("Enter");
  await expect.poll(selectedParent).toBe("first");
  await search.press("Shift+Enter");
  await expect.poll(selectedParent).toBe("second");
  await frame.getByRole("button", { name: "Previous match" }).click();
  await expect.poll(selectedParent).toBe("first");
  await search.press("Enter");
  await expect.poll(selectedParent).toBe("second");
  await search.fill("");
  await search.fill("needle");
  await expect.poll(selectedParent).toBe("first");
  await search.fill("no such visible phrase");
  await expect(frame.getByRole("status")).toHaveText("No match");
  await search.press("Escape");
  await expect(search).toHaveCount(0);
  await expect(frame.locator("#plain")).toBeFocused();
});

test("Mac document find preserves authored cancellation, composition, dialogs and shortcut modifiers", async ({
  page,
}) => {
  const frame = await documentFrame(page);
  const plain = frame.locator("#plain");
  for (const chord of ["Control+f", "Meta+Shift+f", "Meta+Alt+f", "Control+Meta+f"])
    await plain.press(chord);
  await plain.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true }));
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "f") return;
      event.preventDefault();
      window.removeEventListener("keydown", cancel);
    };
    window.addEventListener("keydown", cancel);
  });
  await plain.press("Meta+f");
  await plain.evaluate(() => {
    const stop = (event: KeyboardEvent) => {
      if (event.key !== "f") return;
      event.stopPropagation();
      document.removeEventListener("keydown", stop);
    };
    document.addEventListener("keydown", stop);
  });
  await plain.press("Meta+f");
  await plain.evaluate(() => window.dispatchEvent(new CompositionEvent("compositionstart")));
  await plain.press("Meta+f");
  await plain.evaluate(() => {
    window.dispatchEvent(new CompositionEvent("compositionend"));
    document.querySelector("dialog")!.showModal();
  });
  await frame.locator("dialog").press("Meta+f");
  await page.waitForTimeout(60);
  await expect(frame.getByRole("searchbox", { name: "Find in this HTML" })).toHaveCount(0);
});

test("Mac find works from an input, reuses its bar and fits a narrow HTML viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 720 });
  const frame = await documentFrame(page);
  await frame.locator("#editor").click();
  await frame.locator("#editor").press("Meta+f");
  const search = frame.getByRole("searchbox", { name: "Find in this HTML" });
  await expect(search).toBeFocused();
  await search.fill("needle");
  await search.press("Meta+f");
  await expect(search).toHaveCount(1);
  await expect(search).toBeFocused();
  const bounds = await frame.locator("mogledge-document-find").boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
  await frame.getByRole("button", { name: "Close find" }).click();
  await expect(frame.locator("#editor")).toBeFocused();
});

test("Windows keeps the native Ctrl+F path without an injected find bar", async ({ page }) => {
  const frame = await documentFrame(page, "Win32");
  await frame.locator("#plain").evaluate(() => {
    window.addEventListener("keydown", (event) => {
      if (event.key === "f") document.body.dataset.findPrevented = String(event.defaultPrevented);
    });
  });
  await frame.locator("#plain").press("Control+f");
  await frame.locator("#plain").press("Meta+f");
  await page.waitForTimeout(60);
  await expect(frame.locator("mogledge-document-find")).toHaveCount(0);
  expect(await frame.locator("body").getAttribute("data-find-prevented")).toBe("false");
});

test("closing Mac find discards a queued composition search without stealing focus", async ({
  page,
}) => {
  const frame = await documentFrame(page);
  await frame.locator("#plain").press("Meta+f");
  const search = frame.getByRole("searchbox", { name: "Find in this HTML" });
  await search.fill("needle");
  await search.evaluate((input) => {
    const owner = window as unknown as { find: (...args: unknown[]) => boolean };
    const original = owner.find;
    document.body.dataset.closedFindCalls = "0";
    owner.find = (...args) => {
      document.body.dataset.closedFindCalls = String(
        Number(document.body.dataset.closedFindCalls) + 1,
      );
      return Reflect.apply(original, window, args);
    };
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, composed: true }));
    (input.getRootNode() as ShadowRoot)
      .querySelector<HTMLButtonElement>('[aria-label="Close find"]')!
      .click();
  });
  await page.waitForTimeout(60);
  expect(await frame.locator("body").getAttribute("data-closed-find-calls")).toBe("0");
  await expect(frame.locator("#plain")).toBeFocused();
});

test("Mac document find labels follow the WebView language", async ({ page }) => {
  const frame = await documentFrame(page, "MacIntel", "ja-JP");
  await frame.locator("#plain").press("Meta+f");
  await expect(frame.getByRole("searchbox", { name: "このHTML内を検索" })).toBeFocused();
  await frame.getByRole("button", { name: "検索を閉じる" }).click();
});
