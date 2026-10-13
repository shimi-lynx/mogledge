import { browser, $ } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";

function processMetrics() {
  const command = String.raw`
    $all = @(Get-CimInstance Win32_Process)
    $app = $all | Where-Object { $_.ExecutablePath -eq $env:MY_KNOWLEDGE_E2E_BINARY } | Sort-Object CreationDate -Descending | Select-Object -First 1
    if (-not $app) { throw 'Dedicated QA app not found' }
    $ids = [Collections.Generic.HashSet[uint32]]::new(); $ids.Add([uint32]$app.ProcessId) | Out-Null
    do { $changed=$false; foreach ($child in $all) { if ($ids.Contains($child.ParentProcessId) -and $child.CreationDate -ge $app.CreationDate -and $ids.Add([uint32]$child.ProcessId)) { $changed=$true } } } while ($changed)
    $cpu=0; $working=0; $private=0; $count=0
    foreach ($id in $ids) { $p=Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p) { $cpu+=$p.TotalProcessorTime.TotalMilliseconds; $working+=$p.WorkingSet64; $private+=$p.PrivateMemorySize64; $count++ } }
    @{cpuMs=$cpu; workingSetBytes=$working; privateBytes=$private; processCount=$count} | ConvertTo-Json -Compress
  `;
  return JSON.parse(
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      encoding: "utf8",
      windowsHide: true,
    }),
  );
}

describe("Native storage small performance smoke", () => {
  it("records calculation-only and persistent ordinary/continuous cost in the real app", async () => {
    const folder = $('div[data-path="Storage"]');
    await folder.waitForExist();
    if ((await folder.getAttribute("aria-expanded")) !== "true") await folder.click();
    const report = [];
    for (const baseline of [true, false])
      for (const ordinary of [true, false]) {
        await $('div[data-path="Storage/Generated.html"]').click();
        const panel = await $(".document-pane.active").getAttribute("id");
        const oldUrl = await $(".document-pane.active iframe").getAttribute("src");
        await $('button[role="tab"][aria-controls="' + panel + '"]').click({ button: "right" });
        await $('button[role="menuitem"]=状態をリセットして再読み込み').click();
        await browser.waitUntil(
          async () => (await $(".document-pane.active iframe").getAttribute("src")) !== oldUrl,
        );
        await browser.waitUntil(
          async () =>
            (await $(".document-pane.active .viewer").getAttribute("aria-busy")) === "false",
        );
        const expected = await $(".document-pane.active iframe").getAttribute("src");
        const index = await browser.execute(() =>
          Array.from(document.querySelectorAll("iframe")).indexOf(
            document.querySelector(".document-pane.active iframe")!,
          ),
        );
        await browser.switchToFrame(index);
        await browser.waitUntil(
          async () => (await browser.execute(() => location.href)) === expected,
        );
        await browser.waitUntil(async () =>
          ["保存値なし", "復元済み"].includes(await $("#status").getText()),
        );
        const before = processMetrics();
        const measurement = (await browser.executeAsync(
          (options, done) => {
            void (async () => {
              const originalFetch = window.fetch;
              const ack: number[] = [];
              window.fetch = async (...args: Parameters<typeof fetch>) => {
                const start = performance.now();
                const response = await originalFetch(...args);
                if (
                  args[1]?.method === "POST" &&
                  typeof args[1].body === "string" &&
                  JSON.parse(args[1].body).op === "write" &&
                  response.ok
                )
                  ack.push(performance.now() - start);
                return response;
              };
              if (options.baseline) {
                for (const id of ["amount", "mode", "enabled"]) {
                  const node = document.getElementById(id)!;
                  node.replaceWith(node.cloneNode(true));
                }
                document.getElementById("amount")!.addEventListener("input", () => {
                  const amount = Number(document.querySelector<HTMLInputElement>("#amount")!.value);
                  const mode = document.querySelector<HTMLSelectElement>("#mode")!.value;
                  const enabled = document.querySelector<HTMLInputElement>("#enabled")!.checked;
                  document.querySelector<HTMLOutputElement>("#result")!.value = enabled
                    ? String(mode === "double" ? amount * 2 : amount ** 2)
                    : "無効";
                });
              }
              const heapBefore =
                  (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
                    ?.usedJSHeapSize ?? null,
                started = performance.now(),
                events: number[] = [];
              const input = document.querySelector<HTMLInputElement>("#amount")!;
              for (let i = 0; i < options.count; i++) {
                const start = performance.now();
                input.value = String(i);
                input.dispatchEvent(new Event("input", { bubbles: true }));
                events.push(performance.now() - start);
                if (options.interval) await new Promise((r) => setTimeout(r, options.interval));
              }
              if (!options.baseline) {
                const deadline = performance.now() + 5000;
                while (document.querySelector("#status")!.textContent !== "保存済み") {
                  if (performance.now() > deadline) throw Error("Commit acknowledgement timeout");
                  await new Promise((r) => setTimeout(r, 20));
                }
              }
              const elapsedMs = performance.now() - started,
                heapAfter =
                  (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
                    ?.usedJSHeapSize ?? null;
              window.fetch = originalFetch;
              events.sort((a, b) => a - b);
              ack.sort((a, b) => a - b);
              done({
                elapsedMs,
                eventP95Ms: events[Math.floor(events.length * 0.95)],
                writes: ack.length,
                ackP95Ms: ack.length ? ack[Math.floor(ack.length * 0.95)] : null,
                heapBefore,
                heapAfter,
              });
            })().catch((e) => done({ failure: String(e), writes: -1 }));
          },
          { baseline, count: ordinary ? 10 : 100, interval: ordinary ? 120 : 0 },
        )) as {
          failure?: string;
          writes: number;
          elapsedMs?: number;
          eventP95Ms?: number;
          ackP95Ms?: number | null;
          heapBefore?: number | null;
          heapAfter?: number | null;
        };
        const after = processMetrics();
        await browser.switchToParentFrame();
        assert.equal(measurement.failure, undefined);
        assert.equal(measurement.writes, baseline ? 0 : ordinary ? 10 : 1);
        report.push({
          baseline,
          scenario: ordinary ? "ordinary" : "continuous",
          views: 1,
          inputEvents: ordinary ? 10 : 100,
          ...measurement,
          cpuDeltaMs: after.cpuMs - before.cpuMs,
          workingSetDeltaBytes: after.workingSetBytes - before.workingSetBytes,
          privateDeltaBytes: after.privateBytes - before.privateBytes,
          processCountBefore: before.processCount,
          processCountAfter: after.processCount,
        });
      }
    writeFileSync(
      resolve(".tools/native-storage-performance.json"),
      JSON.stringify(
        {
          note: "Single Windows WebView2 smoke, not a performance or leak guarantee. Process totals cover the dedicated app and its descendants, include driver/measurement overhead between snapshots, and are not normalized to CPU percentage. Heap is optional/coarse, GC is uncontrolled. One view only; prior three-view harness measurements remain separate.",
          measurements: report,
        },
        null,
        2,
      ),
    );
  });

  it("records three retained document views with and without continuous persistence", async () => {
    const fixture = resolve(".tools/e2e-knowledge/Storage/Generated.html");
    const original = readFileSync(fixture);
    const report: object[] = [];
    for (const baseline of [true, false]) {
      const existing = await browser.execute(() =>
        Array.from(
          document.querySelectorAll<HTMLButtonElement>(
            '[role="tab"][title="Storage/Generated.html"]',
          ),
        ).map((tab) => tab.id),
      );
      for (const id of existing) {
        await $('[id="' + id + '"]').click();
        await $('button[aria-label="Storage/Generated.htmlを閉じる"]').click();
      }
      await $('div[data-path="Storage/Generated.html"]').click();
      await $(".document-pane.active iframe").waitForExist();
      for (let i = 0; i < 2; i++) {
        await $('div[data-path="Storage/Generated.html"]').click({ button: "right" });
        await $('button[role="menuitem"]=右の列で開く').click();
        await browser.waitUntil(
          async () =>
            (await browser.execute(
              () => document.querySelectorAll('iframe[title="Storage/Generated.html"]').length,
            )) ===
            i + 2,
        );
        if (i === 0) {
          const panel = await $(".document-pane.active").getAttribute("id");
          await $('button[role="tab"][aria-controls="' + panel + '"]').click();
          await browser.keys(["Control", "Shift", "ArrowLeft"]);
          await browser.waitUntil(
            async () => (await $(".tab-strip").getAttribute("data-split")) === "false",
          );
        }
      }
      const frames = await browser.execute(() =>
        Array.from(document.querySelectorAll("iframe"))
          .map((frame, index) => ({ title: frame.title, index }))
          .filter((frame) => frame.title === "Storage/Generated.html")
          .map((frame) => frame.index),
      );
      assert.equal(frames.length, 3);
      for (const index of frames) {
        await browser.switchToFrame(index);
        await $("#save").waitForExist();
        await browser.waitUntil(async () =>
          ["保存値なし", "復元済み"].includes(await $("#status").getText()),
        );
        await browser.execute((baseline) => {
          const global = window as unknown as {
            __threePerf: {
              writes: number;
              ack: number[];
              eventP95: number;
              heapBefore: number | null;
              heapAfter: number | null;
            };
          };
          global.__threePerf = {
            writes: 0,
            ack: [],
            eventP95: 0,
            heapBefore:
              (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
                ?.usedJSHeapSize ?? null,
            heapAfter: null,
          };
          const originalFetch = window.fetch;
          window.fetch = async (...args: Parameters<typeof fetch>) => {
            const start = performance.now();
            const response = await originalFetch(...args);
            if (
              args[1]?.method === "POST" &&
              typeof args[1].body === "string" &&
              JSON.parse(args[1].body).op === "write" &&
              response.ok
            ) {
              global.__threePerf.writes++;
              global.__threePerf.ack.push(performance.now() - start);
              global.__threePerf.heapAfter =
                (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
                  ?.usedJSHeapSize ?? null;
            }
            return response;
          };
          if (baseline) {
            for (const id of ["amount", "mode", "enabled"]) {
              const control = document.getElementById(id)!;
              control.replaceWith(control.cloneNode(true));
            }
            document.getElementById("amount")!.addEventListener("input", () => {
              const amount = Number(document.querySelector<HTMLInputElement>("#amount")!.value);
              const mode = document.querySelector<HTMLSelectElement>("#mode")!.value;
              const enabled = document.querySelector<HTMLInputElement>("#enabled")!.checked;
              document.querySelector<HTMLOutputElement>("#result")!.value = enabled
                ? String(mode === "double" ? amount * 2 : amount ** 2)
                : "無効";
            });
          }
        }, baseline);
        await browser.switchToParentFrame();
      }
      const before = processMetrics(),
        started = performance.now();
      for (const index of frames) {
        await browser.switchToFrame(index);
        await browser.execute(() => {
          const events: number[] = [],
            input = document.querySelector<HTMLInputElement>("#amount")!;
          for (let i = 0; i < 100; i++) {
            const start = performance.now();
            input.value = String(i);
            input.dispatchEvent(new Event("input", { bubbles: true }));
            events.push(performance.now() - start);
          }
          events.sort((a, b) => a - b);
          (window as unknown as { __threePerf: { eventP95: number } }).__threePerf.eventP95 =
            events[95];
        });
        await browser.switchToParentFrame();
      }
      const measurements = [];
      for (const index of frames) {
        await browser.switchToFrame(index);
        if (!baseline)
          await browser.waitUntil(async () => (await $("#status").getText()) === "保存済み");
        const result = await browser.execute(() => {
          const result = (
            window as unknown as {
              __threePerf: {
                writes: number;
                ack: number[];
                eventP95: number;
                heapBefore: number | null;
                heapAfter: number | null;
              };
            }
          ).__threePerf;
          result.heapAfter ??=
            (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
              ?.usedJSHeapSize ?? null;
          return result;
        });
        assert.equal(result.writes, baseline ? 0 : 1);
        measurements.push(result);
        await browser.switchToParentFrame();
      }
      const after = processMetrics();
      report.push({
        baseline,
        scenario: "three-views",
        views: 3,
        inputEvents: 300,
        elapsedIncludingDriverMs: performance.now() - started,
        measurements,
        cpuDeltaMs: after.cpuMs - before.cpuMs,
        workingSetDeltaBytes: after.workingSetBytes - before.workingSetBytes,
        privateDeltaBytes: after.privateBytes - before.privateBytes,
        processCountBefore: before.processCount,
        processCountAfter: after.processCount,
      });
    }
    assert.deepEqual(readFileSync(fixture), original);
    writeFileSync(
      resolve(".tools/native-storage-three-view-performance.json"),
      JSON.stringify(
        {
          note: "Single real WebView2 sample. Three independent retained views of one document, including a hidden view, started sequentially; no simultaneous-start guarantee. Identical controls/calculation with persistence listeners removed for baseline. App/descendant CPU and working/private memory deltas include app work during WebDriver/measurement overhead. Heap is optional/coarse; GC uncontrolled. No performance or leak guarantee.",
          measurements: report,
        },
        null,
        2,
      ),
    );
  });
});
