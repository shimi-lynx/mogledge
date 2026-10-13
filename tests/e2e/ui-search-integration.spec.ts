import { browser, $ } from "@wdio/globals";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import type { Snapshot } from "../../src/lib/types";
import type { IndexStatus, SearchPage } from "../../src/features/document-search/types";

type ShadowProbeWindow = {
  shadowProbe: {
    focus: (kind: string) => void;
    events: { trusted: boolean; prevented: boolean; editingInPath: boolean }[];
    inputSelection: () => number;
    editorSelection: () => string;
    remove: () => void;
  };
};

async function native<T>(command: string, args: Record<string, unknown> = {}) {
  const response = await browser.executeAsync(
    (command, args, done) => {
      void (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
          };
        }
      ).__TAURI_INTERNALS__
        .invoke(command, args)
        .then(
          (value) => done({ ok: true, value }),
          () => done({ ok: false }),
        );
    },
    command,
    args,
  );
  return response as { ok: true; value: T } | { ok: false; value?: undefined };
}
async function enter(title: string) {
  const index = await browser.execute(
    (title) =>
      Array.from(document.querySelectorAll("iframe")).findIndex((frame) => frame.title === title),
    title,
  );
  assert.ok(index >= 0);
  await browser.switchToFrame(index);
}
async function column(panel: string) {
  return browser.execute(
    (panel) =>
      document
        .querySelector(`[aria-controls="${panel}"][role="tab"]`)
        ?.closest(".tab-group")
        ?.getAttribute("data-column"),
    panel,
  );
}

describe("Integrated Windows UI and search", () => {
  afterEach(async () => {
    await browser.switchToParentFrame();
  });
  it("uses actual Native optional mode and scalar highlight ranges, then renders OR results", async () => {
    const snapshot = await native<Snapshot>("get_knowledge_tree");
    assert.ok(snapshot.ok && snapshot.value.workspaceId);
    const workspaceId = snapshot.value.workspaceId;
    await browser.waitUntil(
      async () =>
        (await native<IndexStatus>("get_index_status", { workspaceId })).value?.phase === "ready",
      { timeout: 30000 },
    );
    const args = { workspaceId, query: "Modules MissingNeverTerm", limit: 20, offset: 0 };
    const omitted = await native<SearchPage>("search_documents", args);
    const and = await native<SearchPage>("search_documents", { ...args, mode: "and" });
    const or = await native<SearchPage>("search_documents", { ...args, mode: "or" });
    assert.ok(omitted.ok && and.ok && or.ok);
    assert.equal(omitted.value.hits.length, 0);
    assert.equal(and.value.hits.length, 0);
    const hit = or.value.hits.find((hit) => hit.relativePath === "Examples/Interactive.html");
    assert.ok(hit && hit.titleMatches.length);
    assert.ok(
      hit.titleMatches.some(
        (range) =>
          Array.from(hit.title).slice(range.start, range.end).join("").toLowerCase() === "modules",
      ),
    );
    assert.equal((await native("search_documents", { ...args, mode: "invalid" })).ok, false);
    const short = await native<SearchPage>("search_documents", {
      ...args,
      query: "Modules 値",
      mode: "or",
    });
    assert.ok(
      short.ok && short.value.hits.some((hit) => hit.relativePath === "Examples/Interactive.html"),
    );
    await $('button[aria-controls="knowledge-search"]').click();
    await $("#document-search-query").setValue(args.query);
    await $('button[aria-label="検索の詳細設定"]').click();
    await $('input[type="radio"][value="or"]').click();
    await $("#document-search-query").click();
    await browser.keys("Enter");
    await $('.search-results button[title="Examples/Interactive.html"] mark').waitForExist();
    await browser.saveScreenshot(resolve(".tools/native-integrated-search-or.png"));
    writeFileSync(
      resolve(".tools/native-integrated-search.json"),
      JSON.stringify({
        optionalModeDefaultAnd: true,
        andCount: and.value.hits.length,
        orCount: or.value.hits.length,
        shortOr: true,
        invalidModeRejected: true,
        titleRanges: hit.titleMatches,
        uiMarkRendered: true,
      }),
    );
  });
  it("moves the focused opaque frame after document JS, preserves its state, and protects input", async () => {
    await $('button[aria-controls="knowledge-files"]').click();
    await $('div[data-path="01-Welcome.html"]').click();
    if (!(await $('div[data-path="Examples/Interactive.html"]').isExisting()))
      await $('div[data-path="Examples"]').click();
    await $('div[data-path="Examples/Interactive.html"]').click();
    await $('iframe[title="Examples/Interactive.html"]').waitForExist();
    const panel = await browser.execute(
      () =>
        document
          .querySelector('iframe[title="Examples/Interactive.html"]')
          ?.closest(".document-pane")?.id,
    );
    assert.ok(panel);
    const url = await $('iframe[title="Examples/Interactive.html"]').getAttribute("src");
    await enter("Examples/Interactive.html");
    await $("#action").waitForExist();
    await $("#text").setValue("retained");
    await $("#action").click();
    await browser.execute(() => {
      (window as unknown as { qaHeap: number }).qaHeap = 37;
    });
    await browser.keys(["Control", "Shift", "ArrowRight"]);
    await browser.switchToParentFrame();
    await browser.waitUntil(async () => (await column(panel)) === "1");
    await enter("Examples/Interactive.html");
    await browser.execute(() => {
      const state = window as unknown as { cancelMove: boolean; cancelled: number };
      state.cancelMove = true;
      state.cancelled = 0;
      window.addEventListener("keydown", (event) => {
        if (event.key === "ArrowLeft" && event.ctrlKey && event.shiftKey && state.cancelMove) {
          state.cancelled++;
          event.preventDefault();
        }
      });
    });
    await $("#action").click();
    await browser.keys(["Control", "Shift", "ArrowLeft"]);
    assert.equal(
      await browser.execute(() => (window as unknown as { cancelled: number }).cancelled),
      1,
    );
    await browser.switchToParentFrame();
    assert.equal(await column(panel), "1");
    await enter("Examples/Interactive.html");
    await browser.execute(() => {
      (window as unknown as { cancelMove: boolean }).cancelMove = false;
    });
    await browser.keys(["Control", "Shift", "ArrowLeft"]);
    await browser.switchToParentFrame();
    await browser.waitUntil(async () => (await column(panel)) === "0");
    assert.equal(await $('iframe[title="Examples/Interactive.html"]').getAttribute("src"), url);
    await enter("Examples/Interactive.html");
    assert.equal(await $("#text").getValue(), "retained");
    assert.equal(await browser.execute(() => (window as unknown as { qaHeap: number }).qaHeap), 37);
    assert.equal(await browser.execute(() => document.documentElement.dataset.canvas), "drawn");
    assert.equal(
      await browser.execute(
        () => typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__,
      ),
      "undefined",
    );
    await $("#text").click();
    await browser.keys(["Control", "Shift", "ArrowRight"]);
    await browser.switchToParentFrame();
    assert.equal(await column(panel), "0");
    await browser.saveScreenshot(resolve(".tools/native-integrated-html-shortcut.png"));
    writeFileSync(
      resolve(".tools/native-integrated-html-shortcut.json"),
      JSON.stringify({
        trustedWebDriverDomKeys: true,
        rightThenLeft: true,
        htmlPreventDefault: true,
        inputProtected: true,
        urlInputCanvasHeapRetained: true,
        documentNativeApiAbsent: true,
        physicalImeAndMacNotTested: true,
      }),
    );
  });
  it("keeps shadow editing and modal keys in the document", async () => {
    await $('button[aria-controls="knowledge-files"]').click();
    await $('div[data-path="Examples/Interactive.html"]').click();
    const panel = await browser.execute(
      () =>
        document
          .querySelector('iframe[title="Examples/Interactive.html"]')
          ?.closest(".document-pane")?.id,
    );
    assert.ok(panel);
    assert.equal(await column(panel), "0");
    await enter("Examples/Interactive.html");
    // Read fixed JS as bytes: serialized callbacks cannot capture transpiler helpers.
    await browser.execute(readFileSync(resolve("tests/e2e/shadow-shortcut-probe.js"), "utf8"));
    await browser.switchToParentFrame();
    for (const kind of ["input", "editor", "native-modal", "aria-modal", "late-modal"]) {
      await enter("Examples/Interactive.html");
      await browser.execute(
        (kind) => (window as unknown as ShadowProbeWindow).shadowProbe.focus(kind),
        kind,
      );
      await browser.keys(["Control", "Shift", "ArrowRight"]);
      const event = await browser.execute(() =>
        (window as unknown as ShadowProbeWindow).shadowProbe.events.at(-1),
      );
      assert.ok(event?.trusted && !event.prevented);
      if (kind === "input") {
        assert.equal(event.editingInPath, false);
        assert.ok(
          (await browser.execute(() =>
            (window as unknown as ShadowProbeWindow).shadowProbe.inputSelection(),
          )) > 0,
        );
      }
      if (kind === "editor") {
        assert.equal(event.editingInPath, false);
        assert.ok(
          (
            await browser.execute(() =>
              (window as unknown as ShadowProbeWindow).shadowProbe.editorSelection(),
            )
          ).length > 0,
        );
      }
      await browser.switchToParentFrame();
      await browser.pause(40);
      assert.equal(await column(panel), "0", kind);
    }
    await enter("Examples/Interactive.html");
    await browser.execute(() =>
      (window as unknown as ShadowProbeWindow).shadowProbe.focus("plain"),
    );
    await browser.keys(["Control", "Shift", "ArrowRight"]);
    await browser.switchToParentFrame();
    await browser.waitUntil(async () => (await column(panel)) === "1");
    await enter("Examples/Interactive.html");
    // Separate deliberate moves beyond the receiver's documented 120ms repeat guard.
    await browser.pause(140);
    await browser.keys(["Control", "Shift", "ArrowLeft"]);
    await browser.switchToParentFrame();
    await browser.waitUntil(async () => (await column(panel)) === "0");
    await enter("Examples/Interactive.html");
    await browser.execute(() => (window as unknown as ShadowProbeWindow).shadowProbe.remove());
    writeFileSync(
      resolve(".tools/native-shadow-keyboard.json"),
      JSON.stringify({
        closedInputSelection: true,
        nestedClosedEditableSelection: true,
        openNativeModal: true,
        openAriaModalWithOutsideFocus: true,
        deferredModalRecheck: true,
        openPlainButtonMoves: true,
        trustedDomKeys: true,
        preventDefaultNotRequiredForEditing: true,
        physicalImeAndMacNotTested: true,
      }),
    );
  });
});
