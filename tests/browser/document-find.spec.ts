import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const keyboard = readFileSync("src-tauri/src/document_server/keyboard.js", "utf8").replace(
  "__MOGLEDGE_KEYBOARD_TOKEN__",
  JSON.stringify("a".repeat(64)),
);

async function documentFrame(
  page: Page,
  platform = "MacIntel",
  language = "en-US",
  legacy = false,
) {
  await page.setContent(
    '<iframe sandbox="allow-scripts" style="width:100%;height:600px"></iframe>',
  );
  await page.locator("iframe").evaluate(
    (element, { keyboard, platform, language, legacy }) => {
      (element as HTMLIFrameElement).srcdoc = `<!doctype html><html><head><script>
        Object.defineProperty(navigator,'platform',{value:${JSON.stringify(platform)}});
        Object.defineProperty(navigator,'language',{value:${JSON.stringify(language)}});
        if (${legacy}) Object.defineProperty(window,'Highlight',{value:undefined});
      </script><script>${keyboard}</script></head><body>
        <button id="plain">Document</button><input id="editor" aria-label="Document input">
        <p id="first">First needle in this document.</p>
        <p style="margin-top:500px" id="second">Second needle in this document.</p>
        <dialog>Authored modal</dialog>
      </body></html>`;
    },
    { keyboard, platform, language, legacy },
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
  await expect(frame.getByRole("status")).toHaveText("1 of 2 matches");
  const highlightedText = () =>
    frame.locator("body").evaluate(() => {
      const active = [...CSS.highlights].find(([name]) => name.endsWith("-current"))?.[1];
      return active ? [...active][0]?.toString() : undefined;
    });
  const highlightedParent = () =>
    frame.locator("body").evaluate(() => {
      const active = [...CSS.highlights].find(([name]) => name.endsWith("-current"))?.[1];
      return active ? ([...active][0] as Range)?.startContainer.parentElement?.id : undefined;
    });
  await expect.poll(highlightedText).toBe("needle");
  await expect.poll(highlightedParent).toBe("first");
  await search.press("Enter");
  await expect(frame.getByRole("status")).toHaveText("2 of 2 matches");
  await expect.poll(highlightedParent).toBe("second");
  await search.press("Enter");
  await expect.poll(highlightedParent).toBe("first");
  await search.press("Shift+Enter");
  await expect.poll(highlightedParent).toBe("second");
  await frame.getByRole("button", { name: "Previous match" }).click();
  await expect.poll(highlightedParent).toBe("first");
  await search.press("Enter");
  await expect.poll(highlightedParent).toBe("second");
  await search.fill("");
  await search.fill("needle");
  await expect.poll(highlightedParent).toBe("first");
  await search.fill("no such visible phrase");
  await expect(frame.getByRole("status")).toHaveText("0 matches (No match)");
  await expect(frame.getByRole("button", { name: "Next match" })).toBeDisabled();
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
    const original = (input as HTMLInputElement).focus;
    document.body.dataset.closedFindCalls = "0";
    (input as HTMLInputElement).focus = (...args) => {
      document.body.dataset.closedFindCalls = String(
        Number(document.body.dataset.closedFindCalls) + 1,
      );
      return Reflect.apply(original, input, args);
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
  await frame.getByRole("searchbox").fill("needle");
  await expect(frame.getByRole("status")).toHaveText("2 件中 1 件目");
  await frame.getByRole("button", { name: "検索を閉じる" }).click();
});

test("Mac find paints all matches and current match while input owns focus", async ({
  page,
}, testInfo) => {
  const frame = await documentFrame(page);
  await frame.locator("#second").evaluate((element) => {
    (element as HTMLElement).style.marginTop = "40px";
  });
  const original = await frame.locator("body").innerHTML();
  await frame.locator("#plain").press("Meta+f");
  const search = frame.getByRole("searchbox");
  await search.fill("needle");
  await expect(search).toBeFocused();
  const highlights = () =>
    frame.locator("body").evaluate(() => [...CSS.highlights.values()].map((value) => value.size));
  await expect.poll(highlights).toEqual([2, 1]);
  const colors = await frame
    .locator("#first")
    .evaluate((element) =>
      [...CSS.highlights.keys()].map(
        (name) => getComputedStyle(element, `::highlight(${name})`).backgroundColor,
      ),
    );
  expect(colors).toEqual(["rgb(255, 224, 102)", "rgb(255, 150, 50)"]);
  await page.screenshot({ path: testInfo.outputPath("find-count-highlights.png") });
  expect(await frame.locator("body").innerHTML()).toBe(original);
  await search.fill("document");
  await expect(frame.getByRole("status")).toHaveText("1 of 3 matches");
  await expect.poll(highlights).toEqual([3, 1]);
  await search.fill("no such phrase");
  await expect.poll(highlights).toEqual([0, 0]);
  await search.fill("");
  await expect(frame.getByRole("status")).toBeEmpty();
  await search.fill("needle");
  await search.press("Escape");
  await expect.poll(highlights).toEqual([]);
  expect(await frame.locator("body").innerHTML()).toBe(original);
});

test("Mac find tracks dynamic visible text, inline matches, literal queries and composition", async ({
  page,
}) => {
  const frame = await documentFrame(page);
  await frame.locator("#first").evaluate((element) => {
    element.innerHTML =
      "First nee<strong>dle</strong>. <span hidden>needle</span><span style='visibility:hidden'>needle</span> A+B\n      日本語";
  });
  await frame.locator("#plain").press("Meta+f");
  const search = frame.getByRole("searchbox");
  const status = frame.getByRole("status");
  await search.fill("NEEDLE");
  await expect(status).toHaveText("1 of 2 matches");
  await frame.locator("#second").evaluate((element) => {
    element.textContent = "changed";
  });
  await expect(status).toHaveText("1 of 1 matches");
  await frame.locator("#first").evaluate((element) => {
    element.setAttribute("hidden", "");
  });
  await expect(status).toHaveText("0 matches (No match)");
  await frame.locator("#first").evaluate((element) => {
    element.removeAttribute("hidden");
  });
  await expect(status).toHaveText("1 of 1 matches");
  await search.fill("a+b");
  await expect(status).toHaveText("1 of 1 matches");
  await search.fill("a+b 日本語");
  await expect(status).toHaveText("1 of 1 matches");
  await search.evaluate((element) => {
    const input = element as HTMLInputElement;
    input.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true, composed: true }),
    );
    input.value = "日本語";
    input.dispatchEvent(
      new InputEvent("input", { isComposing: true, bubbles: true, composed: true }),
    );
  });
  await expect(status).toHaveText("1 of 1 matches");
  await search.press("Enter");
  await search.evaluate((element) =>
    element.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, composed: true }),
    ),
  );
  await expect(status).toHaveText("1 of 1 matches");
  await search.press("Escape");
  await expect(frame.locator("#plain")).toBeFocused();
});

test("legacy Mac find rectangles remain visible on scroll and disappear on clear and close", async ({
  page,
}, testInfo) => {
  const frame = await documentFrame(page, "MacIntel", "en-US", true);
  await frame.locator("#second").evaluate((element) => {
    (element as HTMLElement).style.marginTop = "40px";
  });
  await frame.locator("#plain").press("Meta+f");
  const search = frame.getByRole("searchbox");
  const text = frame.locator("#first");
  const before = await text.screenshot();
  await search.fill("needle");
  await expect(frame.getByRole("status")).toHaveText("1 of 2 matches");
  await expect(frame.locator("mogledge-find-highlights")).toHaveCSS("pointer-events", "none");
  expect((await text.screenshot()).equals(before)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath("find-legacy-highlights.png") });
  await frame.locator("body").evaluate(() => window.scrollBy(0, 20));
  await search.press("Enter");
  await expect(frame.getByRole("status")).toHaveText("2 of 2 matches");
  await search.fill("");
  expect((await text.screenshot()).equals(before)).toBe(true);
  await search.fill("needle");
  await search.press("Escape");
  await expect(frame.locator("mogledge-find-highlights")).toHaveCount(0);
});

test("Mac find scans a large document without persisting highlights", async ({
  page,
}, testInfo) => {
  const frame = await documentFrame(page);
  await frame.locator("#second").evaluate((element) => {
    element.replaceChildren(
      ...Array.from({ length: 1000 }, (_, index) => {
        const paragraph = document.createElement("p");
        paragraph.textContent = `Entry ${index}: performance fixture`;
        return paragraph;
      }),
    );
  });
  await frame.locator("#plain").press("Meta+f");
  const search = frame.getByRole("searchbox");
  const elapsedMs = await search.evaluate((element) => {
    const start = performance.now();
    (element as HTMLInputElement).value = "performance fixture";
    element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
    return performance.now() - start;
  });
  await expect(frame.getByRole("status")).toContainText("search limited");
  const matchCount = await frame
    .locator("body")
    .evaluate(() => [...CSS.highlights.values()][0].size);
  expect(matchCount).toBeLessThanOrEqual(1000);
  await testInfo.attach("find-scan-measurement", {
    body: JSON.stringify({ paragraphs: 1000, matchCount, elapsedMs }),
    contentType: "application/json",
  });
  await search.press("Escape");
  await expect.poll(() => frame.locator("body").evaluate(() => CSS.highlights.size)).toBe(0);
});

test("Mac find reveals the matching range inside a tall scrolling paragraph", async ({ page }) => {
  const frame = await documentFrame(page);
  await frame.locator("#second").evaluate((element) => {
    const scroller = document.createElement("div");
    scroller.id = "scroller";
    scroller.style.cssText = "height:100px;width:250px;overflow:auto;margin-top:20px";
    const paragraph = document.createElement("p");
    paragraph.textContent = `${"filler ".repeat(3000)}deepmatch`;
    scroller.append(paragraph);
    element.replaceWith(scroller);
  });
  await frame.locator("#plain").press("Meta+f");
  await frame.getByRole("searchbox").fill("deepmatch");
  await expect(frame.getByRole("status")).toHaveText("1 of 1 matches");
  const visible = await frame.locator("#scroller").evaluate((element) => {
    const active = [...CSS.highlights].find(([name]) => name.endsWith("-current"))![1];
    const rect = ([...active][0] as Range).getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    return (
      rect.top >= bounds.top &&
      rect.bottom <= bounds.bottom &&
      rect.top >= 0 &&
      rect.bottom <= innerHeight
    );
  });
  expect(visible).toBe(true);
});

test("Mac find bounds oversized text and reuses ranges during navigation and frequent mutations", async ({
  page,
}) => {
  const frame = await documentFrame(page);
  await frame.locator("#second").evaluate((element) => {
    element.textContent = "needle ".repeat(100000);
    const original = window.getComputedStyle;
    const state = window as unknown as { scanStyleReads: number };
    state.scanStyleReads = 0;
    window.getComputedStyle = (...args) => {
      if (args[0].id === "plain") state.scanStyleReads++;
      return Reflect.apply(original, window, args);
    };
  });
  await frame.locator("#plain").press("Meta+f");
  const search = frame.getByRole("searchbox");
  await search.fill("needle");
  await expect(frame.getByRole("status")).toContainText("search limited");
  const matches = await frame.locator("body").evaluate(() => [...CSS.highlights.values()][0].size);
  expect(matches).toBeGreaterThan(0);
  expect(matches).toBeLessThanOrEqual(1000);
  await frame.locator("body").evaluate(() => {
    (window as unknown as { scanStyleReads: number }).scanStyleReads = 0;
  });
  await search.press("Enter");
  await expect(frame.getByRole("status")).toContainText("2 of at least");
  // The unmatched button is visited by a scan, but not by range navigation.
  const readsAfterNext = await frame
    .locator("body")
    .evaluate(() => (window as unknown as { scanStyleReads: number }).scanStyleReads);
  expect(readsAfterNext).toBe(0);
  const mutationReads = await frame.locator("body").evaluate(async () => {
    const state = window as unknown as { scanStyleReads: number };
    state.scanStyleReads = 0;
    let updates = 0;
    const timer = setInterval(
      () => document.body.setAttribute("data-clock", String(updates++)),
      10,
    );
    await new Promise((resolve) => setTimeout(resolve, 650));
    clearInterval(timer);
    return state.scanStyleReads;
  });
  expect(mutationReads).toBeGreaterThan(0);
  expect(mutationReads).toBeLessThanOrEqual(6);
  await search.fill("text beyond scanned prefix");
  await expect(frame.getByRole("status")).toHaveText("Search limited; no match in scanned text");
  await search.press("Escape");
  await expect(frame.locator("mogledge-document-find")).toHaveCount(0);
});

test("Mac find refreshes media-query visibility counts after resize", async ({ page }) => {
  const frame = await documentFrame(page);
  await frame.locator("body").evaluate(() => {
    const style = document.createElement("style");
    style.textContent = "@media (max-width:900px) { #second { display:none } }";
    document.head.append(style);
  });
  await frame.locator("#plain").press("Meta+f");
  await frame.getByRole("searchbox").fill("needle");
  await expect(frame.getByRole("status")).toHaveText("1 of 2 matches");
  await page.setViewportSize({ width: 800, height: 720 });
  await expect(frame.getByRole("status")).toHaveText("1 of 1 matches");
  await page.setViewportSize({ width: 1200, height: 720 });
  await expect(frame.getByRole("status")).toHaveText("1 of 2 matches");
});
