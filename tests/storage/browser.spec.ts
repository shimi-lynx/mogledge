import { test, expect, type Page, type FrameLocator, type CDPSession } from "@playwright/test";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, copyFile, readFile, rm, writeFile, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface Urls {
  documentUrl: string;
  shellUrl: string;
  origin: string;
  tab: string;
}
interface Adapter {
  read(): Promise<unknown>;
  write(value: unknown): Promise<number>;
  remove(): Promise<number>;
  flush(): Promise<void>;
}
interface StorageGlobal {
  MyKnowledgeStorage: { create(options: { appId: string; schemaVersion: number }): Adapter };
  __MY_KNOWLEDGE_STORAGE_V1__: {
    version: number;
    available: boolean;
    endpoint: string;
    maximumDocumentBytes?: number;
  };
}
interface LimitsSnapshot {
  documentMiB: number;
  totalMiB: number;
  revision: number;
  generation: number;
  usageBytes: number;
  largestDocumentBytes: number;
  requiresCompatibilityAcknowledgement: boolean;
}
interface LimitsFailure {
  limitsError: { code: string; message: string };
}
const fixtureDirectory = resolve("tests/fixtures/knowledge/Storage");
const executable = resolve(
  "tests/backend/target/debug/document-state-harness" +
    (process.platform === "win32" ? ".exe" : ""),
);

async function files() {
  const directory = await mkdtemp(join(tmpdir(), "knowledge-state-browser-"));
  for (const name of ["Generated", "Converted"])
    await copyFile(join(fixtureDirectory, name + ".html"), join(directory, name + ".html"));
  await copyFile(join(directory, "Generated.html"), join(directory, "Copy.html"));
  return directory;
}
async function harness(root: string, state: string, entry: string) {
  const child = spawn(executable, [root, state, entry], { stdio: "pipe" });
  const lines = createInterface({ input: child.stdout });
  const responses: Array<(value: unknown) => void> = [];
  let stderr = "";
  child.stderr.on("data", (data: Buffer) => {
    stderr += data.toString();
  });
  lines.on("line", (line) => {
    const response = responses.shift();
    if (response) response(JSON.parse(line));
  });
  function next<T = Urls>(): Promise<T> {
    return new Promise((done, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        child.removeListener("error", failed);
        child.removeListener("exit", exited);
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      const exited = (code: number | null) =>
        failed(new Error("Harness exited " + code + ": " + stderr));
      const timer = setTimeout(() => failed(new Error("Harness timed out: " + stderr)), 10000);
      responses.push((value) => {
        cleanup();
        const error = (value as unknown as { error?: string }).error;
        if (error) reject(new Error("Harness command failed: " + error));
        else done(value as T);
      });
      child.once("error", failed);
      child.once("exit", exited);
    });
  }
  const urls = await next();
  return {
    child,
    urls,
    async command<T = Urls>(value: object) {
      const response = next<T>();
      child.stdin.write(JSON.stringify(value) + "\n");
      return response;
    },
    async stop() {
      lines.close();
      await stop(child);
    },
  };
}
async function stop(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((done) => {
    child.once("exit", () => done());
    child.kill();
  });
}
async function http(root: string) {
  const server = createServer(async (request, response) => {
    const name = new URL(request.url || "/", "http://localhost").pathname.slice(1);
    if (!["Generated.html", "Converted.html", "Copy.html"].includes(name)) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(await readFile(join(root, name)));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No HTTP address");
  return { server, origin: "http://127.0.0.1:" + address.port };
}
async function closeServer(server: Server) {
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
}
async function save(target: Page | FrameLocator, amount: string, mode: string, enabled: boolean) {
  await target.locator("#amount").fill(amount);
  await target.locator("#mode").selectOption(mode);
  await target.locator("#enabled").setChecked(enabled);
  await target.locator("#save").click();
  await expect(target.locator("#status")).toHaveText("保存済み");
}
async function restored(
  target: Page | FrameLocator,
  amount: string,
  mode: string,
  enabled: boolean,
) {
  await expect(target.locator("#status")).toHaveText("復元済み");
  await expect(target.locator("#amount")).toHaveValue(amount);
  await expect(target.locator("#mode")).toHaveValue(mode);
  await expect(target.locator("#enabled")).toBeChecked({ checked: enabled });
  await expect(target.locator("#result")).toHaveText(
    enabled ? String(mode === "double" ? Number(amount) * 2 : Number(amount) ** 2) : "無効",
  );
}

for (const name of ["Generated", "Converted"]) {
  test(
    name +
      " Native opaque frame saves, reloads, closes/reopens, restarts and renames without source changes",
    async ({ page, request }) => {
      const directory = await files();
      const stateDirectory = await mkdtemp(join(tmpdir(), "knowledge-state-db-"));
      const original = await readFile(join(directory, name + ".html"));
      let native = await harness(directory, stateDirectory, name + ".html");
      try {
        await page.goto(native.urls.shellUrl);
        let frame = page.frameLocator("#document");
        await expect(frame.locator("#save")).toBeEnabled();
        expect(
          await frame.locator("body").evaluate(() => {
            const api = (globalThis as unknown as StorageGlobal).__MY_KNOWLEDGE_STORAGE_V1__;
            let parentAccessible = false;
            try {
              parentAccessible = Boolean(parent.document);
            } catch {
              /* opaque frame */
            }
            let browserStorage = false;
            try {
              browserStorage = Boolean(localStorage);
            } catch {
              /* opaque frame */
            }
            return {
              available: api.available,
              frozen: Object.isFrozen(api),
              parentAccessible,
              browserStorage,
              nativeIPC: "__TAURI_INTERNALS__" in globalThis,
            };
          }),
        ).toEqual({
          available: true,
          frozen: true,
          parentAccessible: false,
          browserStorage: false,
          nativeIPC: false,
        });
        await save(frame, "7", "square", false);
        const endpoint = await frame
          .locator("body")
          .evaluate(
            () => (globalThis as unknown as StorageGlobal).__MY_KNOWLEDGE_STORAGE_V1__.endpoint,
          );
        const otherApp = await frame.locator("body").evaluate(async () => {
          const api = (globalThis as unknown as StorageGlobal).MyKnowledgeStorage.create({
            appId: "second-app",
            schemaVersion: 1,
          });
          const before = await api.read();
          await api.write({ selected: "separate" });
          await api.flush();
          return { before, after: await api.read() };
        });
        expect(otherApp).toEqual({ before: null, after: { selected: "separate" } });
        let urls = await native.command({ op: "reload", tab: native.urls.tab });
        const revoked = await request.post(endpoint, {
          data: {
            version: 1,
            op: "write",
            key: "second-app",
            value: { schemaVersion: 1, data: { selected: "forged" } },
          },
        });
        expect(revoked.status()).toBe(403);
        expect((await revoked.json()).error).toBe("Revoked");
        await page.goto(urls.shellUrl);
        await restored(page.frameLocator("#document"), "7", "square", false);
        urls = await native.command({ op: "close-reopen", tab: urls.tab });
        await page.goto(urls.shellUrl);
        await restored(page.frameLocator("#document"), "7", "square", false);
        await native.stop();
        native = await harness(directory, stateDirectory, name + ".html");
        expect(native.urls.origin).not.toBe(urls.origin);
        await page.goto(native.urls.shellUrl);
        await restored(page.frameLocator("#document"), "7", "square", false);
        urls = await native.command({ op: "rename", tab: native.urls.tab, name: "Renamed" });
        await page.goto(urls.shellUrl);
        frame = page.frameLocator("#document");
        await restored(frame, "7", "square", false);
        expect(await readFile(join(directory, "Renamed.html"))).toEqual(original);
        if (name === "Generated") {
          const copied = await native.command({ op: "open", entry: "Copy.html" });
          const copyPage = await page.context().newPage();
          try {
            await copyPage.goto(copied.shellUrl);
            await expect(copyPage.frameLocator("#document").locator("#status")).toHaveText(
              "保存値なし",
            );
            await save(copyPage.frameLocator("#document"), "11", "double", true);
            await page.reload();
            await restored(page.frameLocator("#document"), "7", "square", false);
          } finally {
            await copyPage.close();
          }
        }
      } finally {
        await native.stop();
        await rm(directory, { recursive: true, force: true });
        await rm(stateDirectory, { recursive: true, force: true });
      }
    },
  );

  for (const scheme of ["http", "file"]) {
    test(name + " standalone outside repository restores through " + scheme, async ({ page }) => {
      const directory = await files();
      const ordinary = scheme === "http" ? await http(directory) : null;
      const url = ordinary
        ? ordinary.origin + "/" + name + ".html"
        : pathToFileURL(join(directory, name + ".html")).href;
      try {
        try {
          await page.goto(url);
        } catch (error) {
          if (scheme === "file" && String(error).includes("ERR_BLOCKED_BY_ADMINISTRATOR"))
            test.skip(
              true,
              "Managed Chromium policy blocks file navigation; verify file storage separately on the target browser",
            );
          throw error;
        }
        expect(await page.evaluate(() => "__MY_KNOWLEDGE_STORAGE_V1__" in globalThis)).toBe(false);
        await save(page, "4.5", "square", true);
        await expect(page.locator("#result")).toHaveText("20.25");
        await page.locator("#reload").click();
        await restored(page, "4.5", "square", true);
        const reopened = await page.context().newPage();
        try {
          await reopened.goto(url);
          await restored(reopened, "4.5", "square", true);
        } finally {
          await reopened.close();
        }
      } finally {
        if (ordinary) await closeServer(ordinary.server);
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}

test("Native descriptor precedes source scripts and preserves original doctype modes", async ({
  page,
}) => {
  for (const [prefix, mode] of [
    ["\uFEFF<!-- > leading comment -->\n<!doctype html>", "CSS1Compat"],
    ["<!-- comment --!><!doctype html SYSTEM 'about:legacy-compat'>", "CSS1Compat"],
    ["<?ignored><!bogus><!doctype html>", "CSS1Compat"],
    ["<!--><!---><!doctype html>", "CSS1Compat"],
    [
      "<!doctype html SYSTEM 'a><script>globalThis.seenEarly=!!globalThis.__MY_KNOWLEDGE_STORAGE_V1__;</script>b'>",
      "BackCompat",
    ],
  ]) {
    const directory = await files();
    const stateDirectory = await mkdtemp(join(tmpdir(), "knowledge-state-doctype-"));
    const sourcePath = join(directory, "Generated.html");
    const source = (await readFile(sourcePath, "utf8")).replace(/<!doctype html>/i, prefix);
    await writeFile(sourcePath, source);
    const native = await harness(directory, stateDirectory, "Generated.html");
    try {
      await page.goto(native.urls.shellUrl);
      const frame = page.frameLocator("#document");
      await expect(frame.locator("#save")).toBeEnabled();
      expect(await frame.locator("body").evaluate(() => document.compatMode), prefix).toBe(mode);
      if (prefix.includes("seenEarly")) {
        expect(
          await frame.locator("body").evaluate(() => Reflect.get(globalThis, "seenEarly")),
        ).toBe(true);
      }
      expect(
        await frame
          .locator("body")
          .evaluate(
            () => (globalThis as unknown as StorageGlobal).__MY_KNOWLEDGE_STORAGE_V1__.available,
          ),
      ).toBe(true);
      await save(frame, "5", "square", true);
      expect(await readFile(sourcePath, "utf8")).toBe(source);
    } finally {
      await native.stop();
      await rm(directory, { recursive: true, force: true });
      await rm(stateDirectory, { recursive: true, force: true });
    }
  }
});

test("ordinary browser explicitly converts legacy data and document/app keys remain separate", async ({
  page,
}) => {
  const directory = await files();
  const ordinary = await http(directory);
  try {
    await page.goto(ordinary.origin + "/Converted.html");
    await page.evaluate(() =>
      localStorage.setItem(
        "legacy-calculator-state",
        JSON.stringify({ number: 9, operation: "square", active: true }),
      ),
    );
    await page.locator("#import-legacy").click();
    await expect(page.locator("#status")).toHaveText("保存済み");
    await expect(page.locator("#result")).toHaveText("81");
    expect(
      await page.evaluate(() => localStorage.getItem("legacy-calculator-state")),
    ).not.toBeNull();
    await page.reload();
    await restored(page, "9", "square", true);
    await page.goto(ordinary.origin + "/Generated.html");
    await expect(page.locator("#status")).toHaveText("保存値なし");
    await save(page, "3", "double", true);
    await page.goto(ordinary.origin + "/Copy.html");
    await expect(page.locator("#status")).toHaveText("保存値なし");
    const full = await page.evaluate(async () => {
      const api = (globalThis as unknown as StorageGlobal).MyKnowledgeStorage.create({
        appId: "quota-probe",
        schemaVersion: 1,
      });
      await api.write({ amount: 7 });
      const before = Object.entries(localStorage).find(([key]) =>
        key.endsWith(":quota-probe"),
      )?.[1];
      let browserQuota = false;
      // Fill only this temporary HTTP origin; never a user profile. A bounded
      // number of chunks verifies real Chromium quota failure beneath 5MiB.
      for (let index = 0; index < 16; index++) {
        try {
          localStorage.setItem("quota-filler-" + index, "x".repeat(1024 * 1024));
        } catch (error) {
          browserQuota = (error as Error).name === "QuotaExceededError";
          break;
        }
      }
      let code = "";
      try {
        await api.write({ text: "x".repeat(2 * 1024 * 1024) });
      } catch (error) {
        code = (error as { code: string }).code;
      }
      let flush = "";
      try {
        await api.flush();
      } catch (error) {
        flush = (error as { code: string }).code;
      }
      const after = Object.entries(localStorage).find(([key]) => key.endsWith(":quota-probe"))?.[1];
      return { browserQuota, code, flush, unchanged: before === after, saved: await api.read() };
    });
    expect(full).toEqual({
      browserQuota: true,
      code: "quota_exceeded",
      flush: "quota_exceeded",
      unchanged: true,
      saved: { amount: 7 },
    });
  } finally {
    await closeServer(ordinary.server);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Native quota, queued writes and revoked requests preserve calculations and reported failure", async ({
  page,
}) => {
  const directory = await files();
  const stateDirectory = await mkdtemp(join(tmpdir(), "knowledge-state-errors-"));
  const native = await harness(directory, stateDirectory, "Generated.html");
  try {
    await page.goto(native.urls.shellUrl);
    const frame = page.frameLocator("#document");
    await expect(frame.locator("#save")).toBeEnabled();
    const result = await frame.locator("body").evaluate(async () => {
      const api = (globalThis as unknown as StorageGlobal).MyKnowledgeStorage.create({
        appId: "ordered-app",
        schemaVersion: 1,
      });
      await Promise.all(Array.from({ length: 50 }, (_, index) => api.write({ index })));
      await api.flush();
      const latest = await api.read();
      let quota = "";
      try {
        await api.write({ text: "あ".repeat(Math.ceil((5 * 1024 * 1024) / 3)) });
      } catch (error) {
        quota = (error as { code: string }).code;
      }
      let flush = "";
      try {
        await api.flush();
      } catch (error) {
        flush = (error as { code: string }).code;
      }
      return { latest, quota, flush };
    });
    expect(result).toEqual({
      latest: { index: 49 },
      quota: "QuotaExceeded",
      flush: "QuotaExceeded",
    });
    await save(frame, "8", "double", true);
    await frame.locator("body").evaluate(async () => {
      const global = globalThis as unknown as StorageGlobal;
      const empty = {
        "ordered-app": { schemaVersion: 1, data: { index: 49 } },
        "generated-calculator": {
          schemaVersion: 1,
          data: { amount: 8, mode: "double", enabled: true },
        },
        filler: { schemaVersion: 1, data: { text: "" } },
      };
      const remaining =
        5 * 1024 * 1024 - new TextEncoder().encode(JSON.stringify(empty)).byteLength;
      await global.MyKnowledgeStorage.create({ appId: "filler", schemaVersion: 1 }).write({
        text: "x".repeat(remaining),
      });
    });
    await frame.locator("#enabled").uncheck();
    await frame.locator("#save").click();
    await expect(frame.locator("#status")).toContainText("QuotaExceeded");
    await expect(frame.locator("#result")).toHaveText("無効");
    await frame.locator("body").evaluate(async () => {
      await (globalThis as unknown as StorageGlobal).MyKnowledgeStorage.create({
        appId: "filler",
        schemaVersion: 1,
      }).remove();
    });
    await save(frame, "8", "double", true);
    await native.command({ op: "close", tab: native.urls.tab });
    await frame.locator("#amount").fill("10");
    await frame.locator("#save").click();
    await expect(frame.locator("#status")).toContainText("保存できません");
    await expect(frame.locator("#result")).toHaveText("20");
  } finally {
    await native.stop();
    await rm(directory, { recursive: true, force: true });
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("unavailable Native storage and schema mismatch retain computation without overwriting saved state", async ({
  page,
}) => {
  const directory = await files();
  const stateDirectory = await mkdtemp(join(tmpdir(), "knowledge-state-schema-"));
  let native = await harness(directory, "-", "Generated.html");
  try {
    await page.goto(native.urls.shellUrl);
    let frame = page.frameLocator("#document");
    await expect(frame.locator("#status")).toContainText("storage_unavailable");
    await expect(frame.locator("#save")).toBeDisabled();
    await frame.locator("#amount").fill("8");
    await expect(frame.locator("#result")).toHaveText("16");
    await native.stop();
    native = await harness(directory, stateDirectory, "Generated.html");
    await page.goto(native.urls.shellUrl);
    frame = page.frameLocator("#document");
    await expect(frame.locator("#save")).toBeEnabled();
    await frame.locator("body").evaluate(async () => {
      const api = (globalThis as unknown as StorageGlobal).MyKnowledgeStorage.create({
        appId: "generated-calculator",
        schemaVersion: 2,
      });
      await api.write({ amount: 99, mode: "square", enabled: true });
      await api.flush();
    });
    await page.reload();
    frame = page.frameLocator("#document");
    await expect(frame.locator("#status")).toContainText("schema_mismatch");
    await expect(frame.locator("#save")).toBeDisabled();
    await frame.locator("#amount").fill("8");
    await expect(frame.locator("#result")).toHaveText("16");
    expect(
      await frame.locator("body").evaluate(async () =>
        (globalThis as unknown as StorageGlobal).MyKnowledgeStorage.create({
          appId: "generated-calculator",
          schemaVersion: 2,
        }).read(),
      ),
    ).toEqual({ amount: 99, mode: "square", enabled: true });
  } finally {
    await native.stop();
    await rm(directory, { recursive: true, force: true });
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("profile limits apply to an existing opaque frame, persist on restart and bound 16MiB one/three-view storage", async ({
  page,
  browser,
}) => {
  test.setTimeout(90000);
  const mib = 1024 * 1024;
  const directory = await files();
  const stateDirectory = await mkdtemp(join(tmpdir(), "knowledge-state-limits-"));
  const original = await readFile(join(directory, "Generated.html"));
  let native = await harness(directory, stateDirectory, "Generated.html");
  const extraViews: Page[] = [];
  const measurements: object[] = [];
  try {
    await page.goto(native.urls.shellUrl);
    let frame = page.frameLocator("#document");
    await expect(frame.locator("#save")).toBeEnabled();
    const endpoint = await frame.locator("body").evaluate(() => {
      document.body.dataset.limitsFrame = "original";
      const descriptor = (globalThis as unknown as StorageGlobal).__MY_KNOWLEDGE_STORAGE_V1__;
      return descriptor.endpoint;
    });
    let requests = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url() === endpoint) requests++;
    });
    const initial = await frame.locator("body").evaluate(async () => {
      const scope = globalThis as unknown as StorageGlobal & { limitsProbe: Adapter };
      scope.limitsProbe = scope.MyKnowledgeStorage.create({
        appId: "limits-probe",
        schemaVersion: 1,
      });
      await scope.limitsProbe.write("original value");
      let code = "";
      try {
        await scope.limitsProbe.write("x".repeat(9 * 1024 * 1024));
      } catch (error) {
        code = (error as { code: string }).code;
      }
      let parentAccessible = false;
      try {
        parentAccessible = Boolean(parent.document);
      } catch {
        // Production sandbox keeps this document opaque to its test-only shell.
      }
      return {
        code,
        saved: await scope.limitsProbe.read(),
        maximumDocumentBytes: scope.__MY_KNOWLEDGE_STORAGE_V1__.maximumDocumentBytes,
        frozen: Object.isFrozen(scope.__MY_KNOWLEDGE_STORAGE_V1__),
        parentAccessible,
        nativeIPC: "__TAURI_INTERNALS__" in scope,
      };
    });
    expect(initial).toMatchObject({
      code: "QuotaExceeded",
      saved: "original value",
      frozen: true,
      parentAccessible: false,
      nativeIPC: false,
    });
    expect(Number.isSafeInteger(initial.maximumDocumentBytes)).toBe(true);
    expect(initial.maximumDocumentBytes).toBeGreaterThan(16 * mib + 1);
    expect(requests).toBe(3); // The default 5MiB failure reached Native HTTP.
    const defaults = await native.command<LimitsSnapshot>({ op: "get-limits" });
    expect(defaults).toMatchObject({ documentMiB: 5, totalMiB: 512, revision: 0 });
    const request = {
      op: "set-limits",
      documentMiB: 16,
      totalMiB: 1536,
      expectedRevision: defaults.revision,
      expectedGeneration: defaults.generation,
      acknowledgeCompatibility: false,
    };
    expect(await native.command<LimitsFailure>(request)).toMatchObject({
      limitsError: { code: "limits_compatibility_required" },
    });
    expect(await native.command<LimitsSnapshot>({ op: "get-limits" })).toEqual(defaults);
    const raised = await native.command<LimitsSnapshot>({
      ...request,
      acknowledgeCompatibility: true,
    });
    expect(raised).toMatchObject({ documentMiB: 16, totalMiB: 1536, revision: 1 });
    const retry = await frame.locator("body").evaluate(async () => {
      const api = (globalThis as unknown as { limitsProbe: Adapter }).limitsProbe;
      await api.write("x".repeat(9 * 1024 * 1024));
      await api.flush();
      const saved = await api.read();
      return typeof saved === "string" ? saved.length : 0;
    });
    expect(retry).toBe(9 * mib);
    await expect(frame.locator("body")).toHaveAttribute("data-limits-frame", "original");
    expect(
      await frame
        .locator("body")
        .evaluate(
          () => (globalThis as unknown as StorageGlobal).__MY_KNOWLEDGE_STORAGE_V1__.endpoint,
        ),
    ).toBe(endpoint);

    async function measure(views: Page[]) {
      const before = await backendMetrics(native.child.pid!);
      let peak = before?.rssBytes ?? 0;
      let samples = 0;
      let pending = Promise.resolve();
      let sampling = false;
      const timer = setInterval(() => {
        if (sampling) return;
        sampling = true;
        pending = backendMetrics(native.child.pid!)
          .then((metrics) => {
            peak = Math.max(peak, metrics?.rssBytes ?? 0);
            samples++;
          })
          .finally(() => {
            sampling = false;
          });
      }, 20);
      let values;
      try {
        values = await Promise.all(
          views.map((view) =>
            view
              .frameLocator("#document")
              .locator("body")
              .evaluate(async () => {
                const scope = globalThis as unknown as StorageGlobal & { limitsProbe?: Adapter };
                const api =
                  scope.limitsProbe ??
                  scope.MyKnowledgeStorage.create({ appId: "limits-probe", schemaVersion: 1 });
                scope.limitsProbe = api;
                const encoder = new TextEncoder();
                const prefix = '日本語\n"\\';
                const map = (data: string) => ({ "limits-probe": { schemaVersion: 1, data } });
                const remaining =
                  16 * 1024 * 1024 - encoder.encode(JSON.stringify(map(prefix))).byteLength;
                const data =
                  prefix + "あ".repeat(Math.floor(remaining / 3)) + "x".repeat(remaining % 3);
                const logicalBytes = encoder.encode(JSON.stringify(map(data))).byteLength;
                let eventGapMs = 0;
                let previous = performance.now();
                const timer = setInterval(() => {
                  const now = performance.now();
                  eventGapMs = Math.max(eventGapMs, now - previous);
                  previous = now;
                }, 10);
                const started = performance.now();
                try {
                  const revision = await api.write(data);
                  await api.flush();
                  const writeMs = performance.now() - started;
                  const readStarted = performance.now();
                  const saved = await api.read();
                  return {
                    logicalBytes,
                    revision,
                    writeMs,
                    readMs: performance.now() - readStarted,
                    eventGapMs,
                    matches: saved === data,
                  };
                } finally {
                  clearInterval(timer);
                }
              }),
          ),
        );
      } finally {
        clearInterval(timer);
        await pending;
      }
      const after = await backendMetrics(native.child.pid!);
      for (const value of values) {
        expect(value.logicalBytes).toBe(16 * mib);
        expect(value.matches).toBe(true);
      }
      measurements.push({
        views: views.length,
        values,
        samples,
        backendRssBeforeBytes: before?.rssBytes ?? null,
        backendRssAfterBytes: after?.rssBytes ?? null,
        sampledPeakBackendRssBytes: before ? peak : null,
      });
    }
    await measure([page]);
    const beforeOversize = requests;
    const oversize = await frame.locator("body").evaluate(async () => {
      const api = (globalThis as unknown as { limitsProbe: Adapter }).limitsProbe;
      const saved = await api.read();
      if (typeof saved !== "string") throw new Error("Missing boundary data");
      let code = "";
      try {
        await api.write(saved + "x");
      } catch (error) {
        code = (error as { code: string }).code;
      }
      let flush = "";
      try {
        await api.flush();
      } catch (error) {
        flush = (error as { code: string }).code;
      }
      return { code, flush, preserved: (await api.read()) === saved };
    });
    expect(oversize).toEqual({ code: "QuotaExceeded", flush: "QuotaExceeded", preserved: true });
    // Both reads and the rejected write reach Native; the technical adapter
    // capacity is separate from the profile's current 16MiB logical quota.
    expect(requests).toBe(beforeOversize + 3);
    const boundary = await native.command<LimitsSnapshot>({ op: "get-limits" });
    expect(boundary).toMatchObject({ usageBytes: 16 * mib, largestDocumentBytes: 16 * mib });
    expect(
      await native.command<LimitsFailure>({
        op: "set-limits",
        documentMiB: 5,
        totalMiB: 512,
        expectedRevision: boundary.revision,
        expectedGeneration: boundary.generation,
        acknowledgeCompatibility: false,
      }),
    ).toMatchObject({ limitsError: { code: "limits_below_usage" } });
    expect(await native.command<LimitsSnapshot>({ op: "get-limits" })).toEqual(boundary);

    for (let index = 0; index < 2; index++) {
      const view = await page.context().newPage();
      extraViews.push(view);
      const urls = await native.command({ op: "open", entry: "Generated.html" });
      await view.goto(urls.shellUrl);
      await expect(view.frameLocator("#document").locator("#save")).toBeEnabled();
    }
    await measure([page, ...extraViews]);
    for (const view of extraViews) await view.close();
    extraViews.length = 0;
    const beforeRestart = await native.command<LimitsSnapshot>({ op: "get-limits" });
    await native.stop();
    native = await harness(directory, stateDirectory, "Generated.html");
    expect(await native.command<LimitsSnapshot>({ op: "get-limits" })).toEqual(beforeRestart);
    await page.goto(native.urls.shellUrl);
    frame = page.frameLocator("#document");
    await expect(frame.locator("#save")).toBeEnabled();
    const afterRestart = await frame.locator("body").evaluate(async () => {
      const scope = globalThis as unknown as StorageGlobal & { limitsProbe: Adapter };
      scope.limitsProbe = scope.MyKnowledgeStorage.create({
        appId: "limits-probe",
        schemaVersion: 1,
      });
      const saved = await scope.limitsProbe.read();
      const encoder = new TextEncoder();
      const prefix = '日本語\n"\\';
      const map = (data: string) => ({ "limits-probe": { schemaVersion: 1, data } });
      const remaining = 16 * 1024 * 1024 - encoder.encode(JSON.stringify(map(prefix))).byteLength;
      const expected = prefix + "あ".repeat(Math.floor(remaining / 3)) + "x".repeat(remaining % 3);
      document.body.dataset.limitsFrame = "restarted";
      await scope.limitsProbe.remove();
      await scope.limitsProbe.write("preserved below one MiB");
      await scope.limitsProbe.flush();
      return saved === expected;
    });
    expect(afterRestart).toBe(true);
    const cleared = await native.command<LimitsSnapshot>({ op: "get-limits" });
    const lowered = await native.command<LimitsSnapshot>({
      op: "set-limits",
      documentMiB: 1,
      totalMiB: 512,
      expectedRevision: cleared.revision,
      expectedGeneration: cleared.generation,
      acknowledgeCompatibility: false,
    });
    expect(lowered).toMatchObject({ documentMiB: 1, totalMiB: 512, revision: 2 });
    const rejected = await frame.locator("body").evaluate(async () => {
      const api = (globalThis as unknown as { limitsProbe: Adapter }).limitsProbe;
      let code = "";
      try {
        await api.write("x".repeat(2 * 1024 * 1024));
      } catch (error) {
        code = (error as { code: string }).code;
      }
      let flush = "";
      try {
        await api.flush();
      } catch (error) {
        flush = (error as { code: string }).code;
      }
      return { code, flush, saved: await api.read() };
    });
    expect(rejected).toEqual({
      code: "QuotaExceeded",
      flush: "QuotaExceeded",
      saved: "preserved below one MiB",
    });
    await expect(frame.locator("body")).toHaveAttribute("data-limits-frame", "restarted");
    expect(await readFile(join(directory, "Generated.html"))).toEqual(original);
    await writeFile(
      process.env.MY_KNOWLEDGE_LIMITS_STORAGE_REPORT ||
        join(tmpdir(), "my-knowledge-limits-storage-benchmark.json"),
      JSON.stringify(
        {
          browser: browser.version(),
          note: "Single bounded smoke: exact 16MiB UTF-8 string map, one then three independent opaque views of the same document, one production debug backend and owned temporary DB. Explicit 16/1536MiB user quotas exceed the former application ceilings without allocating total capacity. The SQLite technical descriptor capacity is inspected without allocating a value near that limit. 20ms /proc RSS sampling misses shorter peaks; 10ms renderer event-gap timer includes scheduling/network waits. No dense-object matrix, full app/browser memory, release comparison, Native WebView, OS disk-full or performance guarantee. Backend allocator retention from the one-view case remains in the three-view baseline.",
          measurements,
        },
        null,
        2,
      ),
    );
  } finally {
    for (const view of extraViews) await view.close();
    await native.stop();
    await rm(directory, { recursive: true, force: true });
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

async function backendMetrics(pid: number) {
  if (process.platform !== "linux") return null;
  const [stat, status] = await Promise.all([
    readFile("/proc/" + pid + "/stat", "utf8"),
    readFile("/proc/" + pid + "/status", "utf8"),
  ]);
  const fields = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/);
  return {
    cpuTicks: Number(fields[11]) + Number(fields[12]),
    rssBytes: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] || 0) * 1024,
  };
}
async function nativeRevision(page: Page) {
  return page
    .frameLocator("#document")
    .locator("body")
    .evaluate(async () => {
      const endpoint = (globalThis as unknown as StorageGlobal).__MY_KNOWLEDGE_STORAGE_V1__
        .endpoint;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: 1, op: "read", key: "generated-calculator" }),
        credentials: "omit",
      });
      return Number((await response.json()).revision);
    });
}

test("records ordinary, continuous and three-view storage cost against calculation-only baseline", async ({
  page,
  browser,
}) => {
  const directory = await files();
  const stateDirectory = await mkdtemp(join(tmpdir(), "knowledge-state-measure-"));
  const native = await harness(directory, stateDirectory, "Generated.html");
  const report: Array<object> = [];
  const tickResult = spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" });
  const ticksPerSecond = tickResult.status === 0 ? Number(tickResult.stdout.trim()) : null;
  try {
    for (const baseline of [true, false]) {
      for (const scenario of ["ordinary", "continuous", "three-views"]) {
        const pages: Page[] = [];
        const writes = new Map<Page, number>();
        const latencies = new Map<Page, number[]>();
        try {
          for (let index = 0; index < (scenario === "three-views" ? 3 : 1); index++) {
            const view = index === 0 ? page : await page.context().newPage();
            pages.push(view);
            writes.set(view, 0);
            latencies.set(view, []);
            const requests = new Map<object, number>();
            view.on("request", (request) => {
              if (request.method() === "POST" && request.postDataJSON()?.op === "write") {
                requests.set(request, performance.now());
                writes.set(view, (writes.get(view) || 0) + 1);
              }
            });
            view.on("response", (response) => {
              const start = requests.get(response.request());
              if (start !== undefined) latencies.get(view)!.push(performance.now() - start);
            });
            const urls = await native.command({ op: "open", entry: "Generated.html" });
            await view.goto(urls.shellUrl);
            await expect(view.frameLocator("#document").locator("#save")).toBeEnabled();
            if (baseline)
              await view
                .frameLocator("#document")
                .locator("body")
                .evaluate(() => {
                  // Test-only baseline: same controls/calculation, with persistence event listeners removed.
                  for (const id of ["amount", "mode", "enabled"]) {
                    const control = document.getElementById(id)!;
                    control.replaceWith(control.cloneNode(true));
                  }
                  document.getElementById("amount")!.addEventListener("input", () => {
                    const amount = Number(
                      (document.getElementById("amount") as HTMLInputElement).value,
                    );
                    const mode = (document.getElementById("mode") as HTMLSelectElement).value;
                    const enabled = (document.getElementById("enabled") as HTMLInputElement)
                      .checked;
                    (document.getElementById("result") as HTMLOutputElement).value = !enabled
                      ? "無効"
                      : String(mode === "double" ? amount * 2 : amount ** 2);
                  });
                });
          }
          const sessions = await Promise.all(
            pages.map(async (view) => {
              const frame = view.frames().find((frame) => frame.parentFrame());
              if (!frame) throw new Error("Missing document frame");
              const session = await view.context().newCDPSession(frame);
              await session.send("Performance.enable");
              return session;
            }),
          );
          const metrics = async () =>
            Promise.all(
              sessions.map(async (session) => {
                const result = await session.send("Performance.getMetrics");
                return Object.fromEntries(
                  result.metrics.map((metric: { name: string; value: number }) => [
                    metric.name,
                    metric.value,
                  ]),
                );
              }),
            );
          const beforeRevision = await nativeRevision(pages[0]);
          const backendBefore = await backendMetrics(native.child.pid!);
          const before = await metrics();
          const started = performance.now();
          const eventTimes = await Promise.all(
            pages.map((view) =>
              view
                .frameLocator("#document")
                .locator("body")
                .evaluate(
                  async (_, options) => {
                    const amount = document.getElementById("amount") as HTMLInputElement;
                    const times: number[] = [];
                    for (let index = 0; index < options.count; index++) {
                      const start = performance.now();
                      amount.value = String(index);
                      amount.dispatchEvent(new Event("input", { bubbles: true }));
                      times.push(performance.now() - start);
                      if (options.interval)
                        await new Promise((done) => setTimeout(done, options.interval));
                    }
                    return times;
                  },
                  {
                    count: scenario === "ordinary" ? 10 : 100,
                    interval: scenario === "ordinary" ? 120 : 0,
                  },
                ),
            ),
          );
          if (!baseline)
            for (const view of pages)
              await expect(view.frameLocator("#document").locator("#status")).toHaveText(
                "保存済み",
              );
          const elapsedMs = performance.now() - started;
          const after = await metrics();
          const backendAfter = await backendMetrics(native.child.pid!);
          const committedOperations = (await nativeRevision(pages[0])) - beforeRevision;
          const sortedTimes = eventTimes.flat().sort((a, b) => a - b);
          const savedOperations = [...writes.values()].reduce((sum, count) => sum + count, 0);
          expect(savedOperations).toBeLessThanOrEqual(scenario === "ordinary" ? 10 : pages.length);
          if (baseline) expect(savedOperations).toBe(0);
          else expect(savedOperations).toBeGreaterThan(0);
          expect(committedOperations).toBe(savedOperations);
          const acknowledgements = [...latencies.values()].flat().sort((a, b) => a - b);
          report.push({
            scenario,
            baseline,
            views: pages.length,
            inputEvents: scenario === "ordinary" ? 10 : 100 * pages.length,
            elapsedMs,
            eventP50Ms: sortedTimes[Math.floor(sortedTimes.length * 0.5)],
            eventP95Ms: sortedTimes[Math.floor(sortedTimes.length * 0.95)],
            nativeAcknowledgementP50Ms:
              acknowledgements[Math.floor(acknowledgements.length * 0.5)] ?? null,
            nativeAcknowledgementP95Ms:
              acknowledgements[Math.floor(acknowledgements.length * 0.95)] ?? null,
            savedOperations,
            committedOperations,
            backendCpuMs:
              backendBefore && backendAfter && ticksPerSecond
                ? ((backendAfter.cpuTicks - backendBefore.cpuTicks) * 1000) / ticksPerSecond
                : null,
            backendRssDeltaBytes:
              backendBefore && backendAfter ? backendAfter.rssBytes - backendBefore.rssBytes : null,
            backendRssAfterBytes: backendAfter?.rssBytes ?? null,
            taskCpuMs: after.reduce(
              (sum, metric, index) =>
                sum + (metric.TaskDuration - before[index].TaskDuration) * 1000,
              0,
            ),
            jsHeapDeltaBytes: after.reduce(
              (sum, metric, index) => sum + metric.JSHeapUsedSize - before[index].JSHeapUsedSize,
              0,
            ),
            jsHeapAfterBytes: after.reduce((sum, metric) => sum + metric.JSHeapUsedSize, 0),
          });
          for (const session of sessions) await session.detach();
        } finally {
          for (const view of pages) if (view !== page) await view.close();
          page.removeAllListeners("request");
          page.removeAllListeners("response");
        }
      }
    }
    await writeFile(
      join(tmpdir(), "my-knowledge-storage-browser-benchmark.json"),
      JSON.stringify(
        {
          browser: browser.version(),
          note: "Single smoke run, not a performance guarantee. Per-frame CDP renderer TaskDuration/JS heap and input-handler timing; no browser process total. Backend /proc CPU ticks/RSS include production Core/server/state plus test-only shell, not the complete app. Native write request and document revision deltas verify committed operations; HTTP acknowledgement timing follows durable commit. Ordinary: 10 events 120ms apart. Continuous: 100 immediate events per view. Baseline replaces input listeners with calculation only. No WebView or OS comparison.",
          backendClockTicksPerSecond: ticksPerSecond,
          measurements: report,
        },
        null,
        2,
      ),
    );
  } finally {
    await native.stop();
    await rm(directory, { recursive: true, force: true });
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("large UTF-8 state records one/three-view cost and survives a process restart", async ({
  page,
  browser,
}) => {
  test.setTimeout(120000);
  const directory = await files();
  const stateDirectory = await mkdtemp(join(tmpdir(), "knowledge-state-large-"));
  let native = await harness(directory, stateDirectory, "Generated.html");
  const report: object[] = [];
  const tickResult = spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" });
  const ticksPerSecond = tickResult.status === 0 ? Number(tickResult.stdout.trim()) : null;
  const diskBytes = async (name: string) => {
    try {
      return (await stat(join(stateDirectory, name))).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
  };
  try {
    for (const bytes of [1024 * 1024, 5 * 1024 * 1024]) {
      for (const kind of ["japanese", "objects"] as const) {
        for (const views of [1, 3]) {
          // Fresh backend and empty owned DB for every condition. Prior array
          // allocations/allocator retention must not become the next baseline.
          await native.stop();
          await rm(stateDirectory, { recursive: true, force: true });
          native = await harness(directory, stateDirectory, "Generated.html");
          const pages: Page[] = [];
          const sessions: CDPSession[] = [];
          try {
            for (let index = 0; index < views; index++) {
              const view = index === 0 ? page : await page.context().newPage();
              pages.push(view);
              const urls = await native.command({ op: "open", entry: "Generated.html" });
              await view.goto(urls.shellUrl);
              await expect(view.frameLocator("#document").locator("#save")).toBeEnabled();
              const documentFrame = view.frames().find((frame) => frame.parentFrame());
              if (!documentFrame) throw new Error("Document iframe missing");
              const session = await page.context().newCDPSession(documentFrame);
              sessions.push(session);
              await session.send("Performance.enable");
            }
            const heap = async () => {
              const values = await Promise.all(
                sessions.map(async (session) => {
                  const result = await session.send("Performance.getMetrics");
                  return Number(
                    result.metrics.find(
                      (metric: { name: string }) => metric.name === "JSHeapUsedSize",
                    )?.value || 0,
                  );
                }),
              );
              return values.reduce((sum, value) => sum + value, 0);
            };
            const before = await backendMetrics(native.child.pid!);
            const heapBefore = await heap();
            let sampledPeakBackendRssBytes = before?.rssBytes ?? 0;
            let sampledPeakJsHeapBytes = heapBefore;
            const databaseBeforeBytes = await diskBytes("state.sqlite");
            let sampledPeakJournalBytes = 0;
            let sampleRunning = false;
            let pendingSample = Promise.resolve();
            let samples = 0;
            const timer = setInterval(() => {
              if (sampleRunning) return;
              sampleRunning = true;
              pendingSample = (async () => {
                const [backend, jsHeap, journalBytes] = await Promise.all([
                  backendMetrics(native.child.pid!),
                  heap(),
                  diskBytes("state.sqlite-journal"),
                ]);
                sampledPeakBackendRssBytes = Math.max(
                  sampledPeakBackendRssBytes,
                  backend?.rssBytes ?? 0,
                );
                sampledPeakJsHeapBytes = Math.max(sampledPeakJsHeapBytes, jsHeap);
                sampledPeakJournalBytes = Math.max(sampledPeakJournalBytes, journalBytes);
                samples++;
              })().finally(() => {
                sampleRunning = false;
              });
            }, 20);
            let measurements;
            try {
              measurements = await Promise.all(
                pages.map((view) =>
                  view
                    .frameLocator("#document")
                    .locator("body")
                    .evaluate(
                      async (_, options) => {
                        const api = (
                          globalThis as unknown as StorageGlobal
                        ).MyKnowledgeStorage.create({ appId: "large", schemaVersion: 1 });
                        const encoder = new TextEncoder();
                        const overhead = encoder.encode(
                          JSON.stringify({ large: { schemaVersion: 1, data: "" } }),
                        ).byteLength;
                        let data: string | Array<{ n: number; text: string }>;
                        if (options.kind === "japanese") {
                          const remaining = options.bytes - overhead;
                          data = "あ".repeat(Math.floor(remaining / 3)) + "x".repeat(remaining % 3);
                        } else {
                          // Dense small objects stress parse/clone allocation, rather than just string bytes.
                          const item = { n: 1, text: "あ" };
                          const itemBytes = encoder.encode(JSON.stringify(item)).byteLength + 1;
                          data = Array.from(
                            { length: Math.floor((options.bytes - overhead - 1) / itemBytes) },
                            () => ({ ...item }),
                          );
                        }
                        const logicalBytes = encoder.encode(
                          JSON.stringify({ large: { schemaVersion: 1, data } }),
                        ).byteLength;
                        let maxEventLoopGapMs = 0;
                        let previousTick = performance.now();
                        const timer = setInterval(() => {
                          const now = performance.now();
                          maxEventLoopGapMs = Math.max(maxEventLoopGapMs, now - previousTick);
                          previousTick = now;
                        }, 10);
                        const started = performance.now();
                        const writing = api.write(data);
                        const snapshotMs = performance.now() - started;
                        const revision = await writing;
                        await api.flush();
                        const writeMs = performance.now() - started;
                        const readStarted = performance.now();
                        const restored = await api.read();
                        const readMs = performance.now() - readStarted;
                        clearInterval(timer);
                        const matches = JSON.stringify(restored) === JSON.stringify(data);
                        return {
                          logicalBytes,
                          elements: Array.isArray(data) ? data.length : 1,
                          snapshotMs,
                          writeMs,
                          readMs,
                          maxEventLoopGapMs,
                          revision,
                          matches,
                        };
                      },
                      { bytes, kind },
                    ),
                ),
              );
            } finally {
              clearInterval(timer);
              await pendingSample;
            }
            const after = await backendMetrics(native.child.pid!);
            const heapAfter = await heap();
            for (const measurement of measurements) {
              expect(measurement.matches).toBe(true);
              expect(measurement.logicalBytes).toBeLessThanOrEqual(bytes);
              if (kind === "japanese") expect(measurement.logicalBytes).toBe(bytes);
            }
            report.push({
              bytes,
              kind,
              views,
              measurements,
              samples,
              heapBeforeBytes: heapBefore,
              heapAfterBytes: heapAfter,
              sampledPeakJsHeapBytes,
              backendRssBeforeBytes: before?.rssBytes,
              backendRssAfterBytes: after?.rssBytes,
              sampledPeakBackendRssBytes,
              databaseBeforeBytes,
              databaseAfterBytes: await diskBytes("state.sqlite"),
              sampledPeakJournalBytes,
              backendCpuMs:
                before && after && ticksPerSecond
                  ? ((after.cpuTicks - before.cpuTicks) * 1000) / ticksPerSecond
                  : null,
            });
          } finally {
            for (const session of sessions) await session.detach();
            for (const view of pages) if (view !== page) await view.close();
          }
        }
      }
    }
    await native.stop();
    native = await harness(directory, stateDirectory, "Generated.html");
    await page.goto(native.urls.shellUrl);
    await expect(page.frameLocator("#document").locator("#save")).toBeEnabled();
    const restored = await page
      .frameLocator("#document")
      .locator("body")
      .evaluate(async () => {
        const data = await (globalThis as unknown as StorageGlobal).MyKnowledgeStorage.create({
          appId: "large",
          schemaVersion: 1,
        }).read();
        return Array.isArray(data)
          ? { length: data.length, first: data[0], last: data[data.length - 1] }
          : null;
      });
    expect(restored?.length).toBeGreaterThan(200000);
    expect(restored?.first).toEqual({ n: 1, text: "あ" });
    expect(restored?.last).toEqual(restored?.first);
    await writeFile(
      process.env.MY_KNOWLEDGE_LARGE_STORAGE_REPORT ||
        join(tmpdir(), "my-knowledge-large-storage-benchmark.json"),
      JSON.stringify(
        {
          browser: browser.version(),
          note: "Linux Chromium sandboxed iframe + production Core/HTTP/SQLite debug harness. Fresh backend process and empty owned DB per condition; 1/3 independent views write the same appId concurrently, then read/flush. Single smoke per case. Input construction and equality checks are included in sampled memory. 20ms sampling misses shorter peaks; CDP document-target metrics may overlap shared renderer processes and are not total browser memory. Event loop gaps include network wait/scheduling and 10ms timer granularity. No release comparison, Native WebView2/IPC/main UI, host disk-full, or performance guarantee. No 512MiB fixture or full-app memory measurement.",
          measurements: report,
        },
        null,
        2,
      ),
    );
  } finally {
    await native.stop();
    await rm(directory, { recursive: true, force: true });
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
