import { browser, $ } from "@wdio/globals";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";

describe("Native cross-column pointer drag", () => {
  it("moves a retained view left to right and back with trusted pointer input", async () => {
    await $('div[data-path="Examples"]').waitForExist();
    if (!(await $('div[data-path="Examples/Interactive.html"]').isExisting()))
      await $('div[data-path="Examples"]').click();
    await $('div[data-path="Examples/Interactive.html"]').click();
    await $(".document-pane.active iframe").waitForExist();
    const retainedId = await $(".document-pane.active").getAttribute("id");
    const retainedUrl = await $(".document-pane.active iframe").getAttribute("src");
    await browser.execute((id) => {
      (window as unknown as { __retainedDragFrame: Element | null }).__retainedDragFrame =
        document.querySelector('[id="' + id + '"] iframe');
    }, retainedId!);
    const frameIndex = await browser.execute(
      (id) =>
        Array.from(document.querySelectorAll("iframe")).indexOf(
          document.querySelector('[id="' + id + '"] iframe')!,
        ),
      retainedId!,
    );
    await browser.switchToFrame(frameIndex);
    await $("#module-result").waitForDisplayed();
    await $("#text").setValue("retained across native dragging");
    await $("#action").click();
    await browser.execute(() => {
      (window as unknown as { __dragHeap: string }).__dragHeap = "retained";
    });
    await browser.switchToParentFrame();
    const tabId = await $('button[role="tab"][aria-controls="' + retainedId + '"]').getAttribute(
      "id",
    );
    await $('div[data-path="01-Welcome.html"]').click();
    const panel = await $(".document-pane.active").getAttribute("id");
    await $('button[role="tab"][aria-controls="' + panel + '"]').click({ button: "right" });
    await $('button[role="menuitem"]=右の列で開く').click();
    await $('.tab-group[data-column="1"]').waitForExist();
    await browser.execute(() => {
      const evidence: unknown[] = [];
      (window as unknown as { __pointerDragEvidence: unknown[] }).__pointerDragEvidence = evidence;
      for (const type of ["dragstart", "dragover", "drop", "dragend"])
        document.addEventListener(
          type,
          (e) =>
            evidence.push({
              type,
              trusted: e.isTrusted,
              column: (e.target as Element)
                .closest("[data-drop-column]")
                ?.getAttribute("data-drop-column"),
            }),
          true,
        );
    });
    const drag = async (column: number, body = false, sourceId = tabId!) => {
      const points = await browser.execute(
        (id, column, body) => {
          const from = document.getElementById(id)!.getBoundingClientRect();
          const to = document
            .querySelector(body ? ".document-stage" : '.tab-group[data-column="' + column + '"]')!
            .getBoundingClientRect();
          const headerTarget = document
            .getElementById(id)!
            .closest(".tab-group")!
            .querySelector(".tab-group-drop-target")!
            .getBoundingClientRect();
          return {
            x: Math.round(from.left + from.width / 2),
            y: Math.round(from.top + from.height / 2),
            tx: Math.round(to.left + to.width * (body ? (column === 0 ? 0.25 : 0.75) : 0.5)),
            ty: Math.round(to.top + to.height / 2),
            hx: Math.round(headerTarget.left + headerTarget.width / 2),
            hy: Math.round(headerTarget.top + headerTarget.height / 2),
          };
        },
        sourceId,
        column,
        body,
      );
      const pointer = browser
        .action("pointer", { id: "tab-drag", parameters: { pointerType: "mouse" } })
        .move({ origin: "viewport", x: points.x, y: points.y, duration: 0 })
        .down({ button: 0 })
        .pause(150);
      // Start HTML dragging in the main frame before crossing the iframe boundary.
      if (body) {
        await pointer
          .move({ origin: "viewport", x: points.hx, y: points.hy, duration: 400 })
          .pause(250)
          .perform(true);
        assert.equal(
          await browser.execute(
            (x, y) =>
              document
                .elementFromPoint(x, y)
                ?.closest("[data-drop-column]")
                ?.getAttribute("data-drop-column"),
            points.tx,
            points.ty,
          ),
          String(column),
        );
        if (column === 1)
          await browser.saveScreenshot(resolve(".tools/native-tab-drop-overlay.png"));
      }
      const finish = body
        ? browser.action("pointer", { id: "tab-drag", parameters: { pointerType: "mouse" } })
        : pointer;
      await finish
        .move({ origin: "viewport", x: points.tx, y: points.ty, duration: 1200 })
        .move({ origin: "viewport", x: points.tx + 1, y: points.ty, duration: 100 })
        .pause(250)
        .up({ button: 0 })
        .perform();
    };
    await drag(1);
    const after = await browser.execute(
      (id) => document.getElementById(id)?.closest(".tab-group")?.getAttribute("data-column"),
      tabId!,
    );
    writeFileSync(
      resolve(".tools/native-pointer-drag.json"),
      JSON.stringify({
        leftToRight: after,
        events: await browser.execute(
          () => (window as unknown as { __pointerDragEvidence: unknown[] }).__pointerDragEvidence,
        ),
      }),
    );
    await browser.saveScreenshot(resolve(".tools/native-pointer-drag.png"));
    assert.equal(after, "1", "Trusted Native pointer drag must move the view to the right column");
    await drag(0);
    assert.equal(
      await browser.execute(
        (id) => document.getElementById(id)?.closest(".tab-group")?.getAttribute("data-column"),
        tabId!,
      ),
      "0",
    );
    assert.equal(await $('[id="' + retainedId + '"] iframe').getAttribute("src"), retainedUrl);
    await drag(1, true);
    assert.equal(
      await browser.execute(
        (id) => document.getElementById(id)?.closest(".tab-group")?.getAttribute("data-column"),
        tabId!,
      ),
      "1",
    );
    await drag(0, true);
    assert.equal(
      await browser.execute(
        (id) => document.getElementById(id)?.closest(".tab-group")?.getAttribute("data-column"),
        tabId!,
      ),
      "0",
    );
    // Move the last right view to an existing same-path left view without merging either.
    const rightTab = await browser.execute(
      () => document.querySelector('.tab-group[data-column="1"] [role="tab"]')!.id,
    );
    await drag(0, true, rightTab);
    assert.equal(
      await browser.execute(() => document.querySelector(".tab-strip")!.getAttribute("data-split")),
      "false",
    );
    // Dropping on shell controls is not a move target and must remove the overlay.
    const signature = () =>
      browser.execute(() =>
        Array.from(document.querySelectorAll('[role="tab"]')).map((e) => [
          e.id,
          e.closest(".tab-group")?.getAttribute("data-column"),
        ]),
      );
    const beforeCancel = await signature();
    const cancelPoints = await browser.execute((id) => {
      const a = document.getElementById(id)!.getBoundingClientRect(),
        h = document
          .getElementById(id)!
          .closest(".tab-group")!
          .querySelector(".tab-group-drop-target")!
          .getBoundingClientRect(),
        c = document.querySelector(".titlebar-controls")!.getBoundingClientRect();
      return {
        x: Math.round(a.left + a.width / 2),
        y: Math.round(a.top + a.height / 2),
        hx: Math.round(h.left + h.width / 2),
        hy: Math.round(h.top + h.height / 2),
        cx: Math.round(c.left + 10),
        cy: Math.round(c.top + c.height / 2),
      };
    }, tabId!);
    await browser
      .action("pointer", { id: "tab-cancel", parameters: { pointerType: "mouse" } })
      .move({ origin: "viewport", x: cancelPoints.x, y: cancelPoints.y })
      .down({ button: 0 })
      .pause(150)
      .move({ origin: "viewport", x: cancelPoints.hx, y: cancelPoints.hy, duration: 400 })
      .pause(250)
      .perform(true);
    assert.equal(
      await browser.execute(() => document.querySelectorAll(".document-drop-columns").length),
      1,
    );
    await browser
      .action("pointer", { id: "tab-cancel", parameters: { pointerType: "mouse" } })
      .move({ origin: "viewport", x: cancelPoints.cx, y: cancelPoints.cy, duration: 500 })
      .up({ button: 0 })
      .perform();
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => document.querySelectorAll(".document-drop-columns").length,
        )) === 0,
    );
    assert.deepEqual(await signature(), beforeCancel);
    assert.equal(await browser.execute(() => document.querySelectorAll('[role="tab"]').length), 3);
    await drag(1, true);
    assert.equal(
      await browser.execute(() => document.querySelector(".tab-strip")!.getAttribute("data-split")),
      "true",
    );
    await drag(0, true);
    assert.equal(
      await browser.execute(() => document.querySelector(".tab-strip")!.getAttribute("data-split")),
      "false",
    );
    assert.equal(
      await browser.execute(
        (id) =>
          document.querySelector('[id="' + id + '"] iframe') ===
          (window as unknown as { __retainedDragFrame: Element }).__retainedDragFrame,
        retainedId!,
      ),
      true,
    );
    assert.equal(
      await browser.execute(() => document.querySelectorAll(".document-drop-columns").length),
      0,
    );
    const retainedIndex = await browser.execute(
      (id) =>
        Array.from(document.querySelectorAll("iframe")).indexOf(
          document.querySelector('[id="' + id + '"] iframe')!,
        ),
      retainedId!,
    );
    // The moved view remains mounted even if a different view is currently active.
    await browser.switchToFrame(retainedIndex);
    assert.equal(
      await browser.execute(() => document.querySelector<HTMLInputElement>("#text")!.value),
      "retained across native dragging",
    );
    assert.equal(
      await browser.execute(() => (window as unknown as { __dragHeap: string }).__dragHeap),
      "retained",
    );
    assert.equal(await browser.execute(() => document.documentElement.dataset.canvas), "drawn");
    await browser.switchToParentFrame();
    writeFileSync(
      resolve(".tools/native-pointer-drag-final.json"),
      JSON.stringify({
        tabstripBothDirections: true,
        documentBothDirections: true,
        emptyRightCreation: true,
        lastViewCollapse: true,
        samePathViewsRetained: true,
        iframeInputCanvasHeapRetained: true,
        unsupportedDropCancelled: true,
        events: await browser.execute(
          () => (window as unknown as { __pointerDragEvidence: unknown[] }).__pointerDragEvidence,
        ),
      }),
    );
    await browser.saveScreenshot(resolve(".tools/native-pointer-drag-final.png"));
  });
});
