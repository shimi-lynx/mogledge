import { browser, $ } from "@wdio/globals";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Native viewer performance", () => {
  it("renders 10,001 HTML tree and measures 100KB document load and save", async () => {
    await $("[role=tree]").waitForExist();
    const nativeScan = (await browser.executeAsync((done) => {
      void (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (cmd: string) => Promise<{ scanDurationMs: number }> };
        }
      ).__TAURI_INTERNALS__
        .invoke("get_knowledge_tree")
        .then((snapshot) => done(snapshot.scanDurationMs));
    })) as number;
    const rendererReady = await browser.execute(
      () => performance.getEntriesByName("knowledge-tree-ready")[0]?.startTime,
    );
    assert.ok(Number.isFinite(nativeScan) && Number.isFinite(rendererReady));
    const initial = nativeScan + rendererReady;
    assert.ok(initial < 3000, "Scan and initial renderer tree must be within 3 seconds");
    await browser.execute(() => {
      const tree = document.querySelector<HTMLElement>("[role=tree]")!;
      tree.scrollTop = tree.scrollHeight;
      tree.dispatchEvent(new Event("scroll"));
    });
    await $("div[data-path='Benchmark.html']").waitForExist();
    const durations: number[] = [];
    for (let index = 0; index < 30; index++) {
      durations.push(
        (await browser.executeAsync((repeat, done) => {
          const previous = document.querySelector<HTMLIFrameElement>(
            ".document-pane.active iframe",
          );
          const start = performance.now();
          const observer = new MutationObserver(() => {
            const frame = document.querySelector<HTMLIFrameElement>(".document-pane.active iframe");
            if (!frame || frame === previous) return;
            observer.disconnect();
            frame.addEventListener("load", () => done(performance.now() - start), { once: true });
          });
          observer.observe(document.querySelector("main")!, { childList: true, subtree: true });
          document
            .querySelector<HTMLElement>(
              repeat ? 'button[aria-label="文書を再読み込み"]' : "div[data-path='Benchmark.html']",
            )!
            .click();
        }, index > 0)) as number,
      );
    }
    const loadDurations = [...durations];
    const previous = await $(".document-pane.active iframe").getAttribute("src");
    const saveStart = performance.now();
    await browser.execute(() => {
      const started = performance.now();
      const previous = document.querySelector<HTMLIFrameElement>(".document-pane.active iframe");
      const state = window as unknown as { __wikiSave?: Promise<number> };
      state.__wikiSave = new Promise((done) => {
        const observer = new MutationObserver(() => {
          const frame = document.querySelector<HTMLIFrameElement>(".document-pane.active iframe");
          if (!frame || frame === previous) return;
          observer.disconnect();
          frame.addEventListener("load", () => done(performance.now() - started), { once: true });
        });
        observer.observe(document.querySelector("main")!, { childList: true, subtree: true });
      });
    });
    writeFileSync(
      resolve(process.env.MOGLEDGE_BENCH_ROOT!, "Benchmark.html"),
      "<h1 id=ready>Saved</h1><!--" + "x".repeat(100000) + "-->",
    );
    await browser.waitUntil(
      async () => (await $(".document-pane.active iframe").getAttribute("src")) !== previous,
      {
        interval: 30,
      },
    );
    const save = (await browser.executeAsync((done) => {
      void (window as unknown as { __wikiSave: Promise<number> }).__wikiSave.then(done);
    })) as number;
    await browser.switchToFrame($(".document-pane.active iframe"));
    await $("#ready").waitForExist();
    assert.equal(await $("#ready").getText(), "Saved");
    const saveWallClock = performance.now() - saveStart;
    durations.sort((a, b) => a - b);
    const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
    const report = {
      platform: process.platform,
      htmlFiles: 10001,
      nativeScanMs: nativeScan,
      initialRendererMs: rendererReady,
      initialPipelineMs: initial,
      loadP95Ms: p95,
      loadDurationsMs: loadDurations,
      saveReflectionMs: save,
      saveIncludingDriverMs: saveWallClock,
    };
    writeFileSync(resolve(".tools/performance.json"), JSON.stringify(report, null, 2));
    console.log(report);
    assert.ok(p95 < 300, "100KB load p95 must be below 300ms");
    assert.ok(save < 1000, "Save reflection must be within 1 second");
  });
});
