import { browser, $ } from "@wdio/globals";
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { resolve, toNamespacedPath } from "node:path";
import { spawn } from "node:child_process";

interface StorageWorld {
  MyKnowledgeStorage: {
    create(options: { appId: string; schemaVersion: number }): {
      read(): Promise<unknown>;
      write(value: unknown): Promise<number>;
      remove(): Promise<number>;
      flush(): Promise<void>;
    };
  };
  __MY_KNOWLEDGE_STORAGE_V1__: { endpoint: string; available: boolean };
}
const fixture = resolve(".tools/e2e-knowledge");
const source = resolve("tests/fixtures/knowledge/Storage/Generated.html");
async function status() {
  return browser.execute(() => document.querySelector("#status")?.textContent ?? "");
}

async function guardFixture() {
  const root = await browser.executeAsync((done) => {
    void (
      window as unknown as {
        __TAURI_INTERNALS__: { invoke(cmd: string): Promise<{ rootPath: string }> };
      }
    ).__TAURI_INTERNALS__
      .invoke("get_knowledge_tree")
      .then((s) => done(s.rootPath));
  });
  assert.equal(toNamespacedPath(String(root)), toNamespacedPath(realpathSync.native(fixture)));
}
async function folder(path: string) {
  const row = $('div[data-path="' + path + '"]');
  await row.waitForExist();
  if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
}
async function select(path: string) {
  await $('div[data-path="' + path + '"]').waitForExist();
  await $('div[data-path="' + path + '"]').click();
  await browser.waitUntil(
    async () => (await $(".document-pane.active iframe").getAttribute("title")) === path,
  );
}
async function enter() {
  await browser.switchToFrame(null);
  await $(".document-pane.active iframe").waitForExist();
  await browser.waitUntil(
    async () => (await $(".document-pane.active .viewer").getAttribute("aria-busy")) === "false",
  );
  const expectedUrl = await $(".document-pane.active iframe").getAttribute("src");
  const count = await browser.execute(() => document.querySelectorAll("iframe").length);
  await browser.waitUntil(
    async () => {
      for (let index = 0; index < count; index++) {
        await browser.switchToFrame(null);
        try {
          await browser.switchToFrame(index);
          if ((await browser.execute(() => location.href)) === expectedUrl) return true;
        } catch {
          /* A replaced frame may still be detaching. */
        }
      }
      return false;
    },
    { timeoutMsg: "The Native driver must select the active grant URL after iframe replacement" },
  );
  await browser.waitUntil(
    async () => await browser.execute(() => Boolean(document.querySelector("#save"))),
  );
  await browser.waitUntil(async () => {
    const text = await status();
    return text !== "" && text !== "保存状態を読込中…";
  });
}
async function leave() {
  await browser.switchToFrame(null);
}
async function save(amount: string) {
  await browser.execute((amount) => {
    document.querySelector<HTMLInputElement>("#amount")!.value = amount;
    document.querySelector<HTMLSelectElement>("#mode")!.value = "double";
    document.querySelector<HTMLInputElement>("#enabled")!.checked = true;
    document.querySelector("#amount")!.dispatchEvent(new Event("input", { bubbles: true }));
  }, amount);
  await $("#save").click();
  await browser.waitUntil(async () => (await status()) === "保存済み");
  assert.equal(await $("#result").getText(), String(Number(amount) * 2));
}
async function restored(amount: string) {
  try {
    await browser.waitUntil(async () => (await status()) === "復元済み");
  } catch (error) {
    const diagnostic = await browser.execute(() => ({
      file: location.pathname.split("/").pop(),
      status: document.querySelector("#status")?.textContent,
      controls: document.querySelectorAll("input,select,button").length,
      ready: document.readyState,
    }));
    writeFileSync(resolve(".tools/native-storage-frame-failure.json"), JSON.stringify(diagnostic));
    throw error;
  }
  assert.deepEqual(await sampleValues(), {
    amount,
    mode: "double",
    enabled: true,
    result: String(Number(amount) * 2),
  });
}
async function sampleValues() {
  // Read one current document snapshot; legacy driver element references may
  // survive an iframe replacement and refer to controls in the previous frame.
  return browser.execute(() => ({
    amount: document.querySelector<HTMLInputElement>("#amount")!.value,
    mode: document.querySelector<HTMLSelectElement>("#mode")!.value,
    enabled: document.querySelector<HTMLInputElement>("#enabled")!.checked,
    result: document.querySelector("#result")!.textContent,
  }));
}
async function reloaded(path: string, oldUrl: string | null) {
  let observedUrl: string | null = null;
  let observedAt = Date.now();
  await browser.waitUntil(async () => {
    const frame = $(".document-pane.active iframe");
    const current = await frame.getAttribute("src");
    if (current !== observedUrl) {
      observedUrl = current;
      observedAt = Date.now();
    }
    // Native move/rename and the filesystem watcher can both refresh a grant.
    // Wait beyond the 250ms watcher debounce before inspecting the new frame.
    return (
      (await frame.getAttribute("title")) === path &&
      current !== oldUrl &&
      Date.now() - observedAt >= 600
    );
  });
}
async function menu(path: string, label: string) {
  await $('div[data-path="' + path + '"]').click({ button: "right" });
  await $('button[role="menuitem"]=' + label).click();
}

describe("Native document state lifecycle", () => {
  afterEach(async () => {
    await browser.switchToFrame(null);
    await browser.execute(() => {
      const qa = window as unknown as { __storageQaOriginalConfirm?: typeof window.confirm };
      if (qa.__storageQaOriginalConfirm) {
        window.confirm = qa.__storageQaOriginalConfirm;
        delete qa.__storageQaOriginalConfirm;
      }
    });
  });
  it("preserves acknowledged state across process restart, rename and move; verifies trusted UI recovery confirmation callbacks", async () => {
    await guardFixture();
    if (process.env.MY_KNOWLEDGE_STORAGE_RESTART_PHASE === "seed") {
      const disposable = resolve(fixture, "StorageNative");
      assert.equal(disposable, resolve(".tools/e2e-knowledge/StorageNative"));
      rmSync(disposable, { recursive: true, force: true });
      mkdirSync(resolve(fixture, "StorageNative/Destination"), { recursive: true });
      copyFileSync(source, resolve(fixture, "StorageNative/Original.html"));
      copyFileSync(source, resolve(fixture, "StorageNative/Copy.html"));
      await folder("StorageNative");
      await select("StorageNative/Original.html");
      await enter();
      await save("22");
      await leave();
      const firstOrigin = new URL((await $(".document-pane.active iframe").getAttribute("src"))!)
        .origin;
      await select("StorageNative/Copy.html");
      await enter();
      assert.equal(
        await status(),
        "保存値なし",
        "A copy with the same appId must not inherit physical identity state",
      );
      await leave();
      writeFileSync(resolve(".tools/native-storage-restart.json"), JSON.stringify({ firstOrigin }));
      return;
    }
    await folder("StorageNative");
    await select("StorageNative/Original.html");
    const { firstOrigin } = JSON.parse(
      readFileSync(resolve(".tools/native-storage-restart.json"), "utf8"),
    );
    assert.notEqual(
      new URL((await $(".document-pane.active iframe").getAttribute("src"))!).origin,
      firstOrigin,
    );
    await enter();
    await restored("22");
    await leave();
    const beforeRename = await $(".document-pane.active iframe").getAttribute("src");
    await menu("StorageNative/Original.html", "名前を変更");
    await $("dialog input").setValue("Renamed");
    await $('dialog button[type="submit"]').click();
    await reloaded("StorageNative/Renamed.html", beforeRename);
    await enter();
    await restored("22");
    await leave();
    const beforeMove = await $(".document-pane.active iframe").getAttribute("src");
    await menu("StorageNative/Renamed.html", "別フォルダーへ移動");
    await $("dialog select").selectByAttribute("value", "StorageNative/Destination");
    await $('dialog button[type="submit"]').click();
    const moved = "StorageNative/Destination/Renamed.html";
    await reloaded(moved, beforeMove);
    await enter();
    await restored("22");
    await leave();
    assert.deepEqual(readFileSync(resolve(fixture, moved)), readFileSync(source));
    const oldUrl = await $(".document-pane.active iframe").getAttribute("src");
    copyFileSync(source, resolve(fixture, moved + ".tmp"));
    renameSync(resolve(fixture, moved + ".tmp"), resolve(fixture, moved));
    await browser.waitUntil(
      async () => (await $(".document-pane.active iframe").getAttribute("src")) !== oldUrl,
    );
    await enter();
    assert.equal(await status(), "保存値なし");
    await leave();
    const replacementUrl = await $(".document-pane.active iframe").getAttribute("src");
    await folder("StorageNative/Destination");
    // WebView2's host script dialog is not exposed by this external driver:
    // alert/text returned "no such alert". Exercise the real bundled UI and
    // Native candidate/commit with controlled confirmation callbacks; do not
    // claim the physical host dialog was clicked or mock the Native transport.
    await browser.execute(() => {
      const qa = window as unknown as {
        __storageQaOriginalConfirm: typeof window.confirm;
        __storageQaAnswer: boolean;
        __storageQaMessages: string[];
      };
      qa.__storageQaOriginalConfirm = window.confirm;
      qa.__storageQaAnswer = false;
      qa.__storageQaMessages = [];
      window.confirm = (message) => {
        qa.__storageQaMessages.push(String(message));
        return qa.__storageQaAnswer;
      };
    });
    await menu(moved, "以前の入力状態を引き継ぐ");
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => (window as unknown as { __storageQaMessages: string[] }).__storageQaMessages.length,
        )) === 1,
    );
    assert.match(
      await browser.execute(
        () => (window as unknown as { __storageQaMessages: string[] }).__storageQaMessages[0],
      ),
      /置換後のHTML/,
    );
    await enter();
    assert.equal(await status(), "保存値なし");
    await leave();
    await browser.execute(() => {
      (window as unknown as { __storageQaAnswer: boolean }).__storageQaAnswer = true;
    });
    await menu(moved, "以前の入力状態を引き継ぐ");
    await reloaded(moved, replacementUrl);
    await enter();
    await restored("22");
    await save("31");
    await leave();
    await menu(moved, "以前の入力状態を引き継ぐ");
    await $('[role="alert"]').waitForDisplayed();
    assert.match(await $('[role="alert"]').getText(), /既に保存|上書きできません/);
    await enter();
    await restoredOrSaved("31");
    await browser.saveScreenshot(resolve(".tools/native-storage-recovery.png"));
    await leave();
    assert.deepEqual(readFileSync(resolve(fixture, moved)), readFileSync(source));
  });

  it("keeps computation and durable values after quota failure without Native fallback", async () => {
    await guardFixture();
    await folder("Storage");
    await select("Storage/Generated.html");
    await enter();
    assert.equal(
      await browser.executeAsync((done) => {
        const sdk = (window as unknown as StorageWorld).MyKnowledgeStorage;
        void Promise.all(
          ["native-ordered", "filler", "generated-calculator", "native-boundary"].map((appId) =>
            sdk.create({ appId, schemaVersion: 1 }).remove(),
          ),
        ).then(
          () => done(true),
          (e) => done({ failure: String(e) }),
        );
      }),
      true,
    );
    await save("8");
    const result = (await browser.executeAsync((done) => {
      const global = window as unknown as StorageWorld;
      void (async () => {
        const ordered = global.MyKnowledgeStorage.create({
          appId: "native-ordered",
          schemaVersion: 1,
        });
        await Promise.all(Array.from({ length: 50 }, (_, index) => ordered.write({ index })));
        await ordered.flush();
        const latest = await ordered.read();
        let quota = "",
          flush = "";
        try {
          await ordered.write({ text: "あ".repeat(Math.ceil((5 * 1024 * 1024) / 3)) });
        } catch (e) {
          quota = (e as { code: string }).code;
        }
        try {
          await ordered.flush();
        } catch (e) {
          flush = (e as { code: string }).code;
        }
        const current = {
          "generated-calculator": {
            schemaVersion: 1,
            data: { amount: 8, mode: "double", enabled: true },
          },
          "native-ordered": { schemaVersion: 1, data: { index: 49 } },
          filler: { schemaVersion: 1, data: { text: "" } },
        };
        const remaining =
          5 * 1024 * 1024 - new TextEncoder().encode(JSON.stringify(current)).byteLength;
        await global.MyKnowledgeStorage.create({ appId: "filler", schemaVersion: 1 }).write({
          text: "x".repeat(remaining),
        });
        let localStorageBlocked = false;
        try {
          localStorage.setItem("native-forbidden", "value");
        } catch {
          localStorageBlocked = true;
        }
        done({
          latest,
          quota,
          flush,
          localStorageBlocked,
          available: global.__MY_KNOWLEDGE_STORAGE_V1__.available,
        });
      })().catch((e) =>
        done({
          failure: String(e),
          latest: null,
          quota: "",
          flush: "",
          localStorageBlocked: false,
          available: false,
        }),
      );
    })) as {
      latest: unknown;
      quota: string;
      flush: string;
      localStorageBlocked: boolean;
      available: boolean;
      failure?: string;
    };
    assert.equal(result.failure, undefined);
    assert.deepEqual(result.latest, { index: 49 });
    assert.equal(result.quota, "quota_exceeded");
    assert.equal(result.flush, "quota_exceeded");
    assert.equal(result.localStorageBlocked, true);
    assert.equal(result.available, true);
    await browser.execute(() => {
      document.querySelector<HTMLInputElement>("#enabled")!.checked = false;
      document.querySelector("#enabled")!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await $("#save").click();
    await browser.waitUntil(async () => (await status()).includes("QuotaExceeded"));
    assert.equal(await $("#result").getText(), "無効");
    await browser.saveScreenshot(resolve(".tools/native-storage-quota.png"));
    const durable = await browser.executeAsync((done) => {
      void (window as unknown as StorageWorld).MyKnowledgeStorage.create({
        appId: "generated-calculator",
        schemaVersion: 1,
      })
        .read()
        .then(done);
    });
    assert.deepEqual(durable, { amount: 8, mode: "double", enabled: true });
    const clean = await browser.executeAsync((done) => {
      const sdk = (window as unknown as StorageWorld).MyKnowledgeStorage;
      void Promise.all(
        ["filler", "native-ordered"].map((appId) =>
          sdk.create({ appId, schemaVersion: 1 }).remove(),
        ),
      ).then(() => done(true));
    });
    assert.equal(clean, true);
    await save("8");
    await leave();
  });

  it("enforces the real storage endpoint and shares state only between views of one physical document", async () => {
    await guardFixture();
    await folder("Storage");
    await select("Storage/Generated.html");
    const firstPanel = await $(".document-pane.active").getAttribute("id");
    await enter();
    const firstEndpoint = await browser.execute(
      () => (window as unknown as StorageWorld).__MY_KNOWLEDGE_STORAGE_V1__.endpoint,
    );
    const boundary = (await browser.executeAsync((done) => {
      void (async () => {
        const world = window as unknown as StorageWorld;
        const store = world.MyKnowledgeStorage.create({
          appId: "native-boundary",
          schemaVersion: 1,
        });
        await store.write({ owner: "first" });
        await store.flush();
        const endpoint = world.__MY_KNOWLEDGE_STORAGE_V1__.endpoint;
        const request = async (body: string, method = "POST", suffix = "") => {
          let response: Response;
          try {
            response = await fetch(endpoint + suffix, {
              method,
              headers: { "Content-Type": "application/json" },
              ...(method === "POST" ? { body } : {}),
            });
          } catch {
            return { status: 0, error: "CORS rejected", cache: null, type: null };
          }
          return {
            status: response.status,
            error: (await response.json()).error as string | undefined,
            cache: response.headers.get("Cache-Control"),
            type: response.headers.get("X-Content-Type-Options"),
          };
        };
        const valid = JSON.stringify({ version: 1, op: "read", key: "native-boundary" });
        const results = await Promise.all([
          request("{"),
          request(
            JSON.stringify({ version: 1, op: "read", key: "native-boundary", path: "other.html" }),
          ),
          request(JSON.stringify({ version: 1, op: "read", key: "../escape" })),
          request(valid, "GET"),
          request(valid, "POST", "?path=other.html"),
          request(
            JSON.stringify({
              version: 1,
              op: "write",
              key: "native-boundary",
              value: { schemaVersion: 1, data: "x".repeat(131073) },
            }),
          ),
        ]);
        done({ results, missingIPC: !("__TAURI_INTERNALS__" in window) });
      })().catch((e) => done({ results: [], missingIPC: false, failure: String(e) }));
    })) as {
      results: Array<{ status: number; error?: string; cache: string | null; type: string | null }>;
      missingIPC: boolean;
      failure?: string;
    };
    assert.equal(boundary.failure, undefined);
    assert.equal(boundary.missingIPC, true);
    assert.deepEqual(
      boundary.results.map((result) => result.status),
      [400, 400, 400, 0, 0, 413],
    );
    for (const result of boundary.results) {
      if (result.status === 0) {
        assert.equal(result.error, "CORS rejected");
        continue;
      }
      assert.equal(result.cache, "no-store");
      assert.equal(result.type, null, "Custom response headers are not exposed through CORS");
    }
    await leave();
    const validRead = JSON.stringify({ version: 1, op: "read", key: "native-boundary" });
    const methodDenied = await fetch(firstEndpoint, { headers: { Origin: "null" } });
    assert.equal(methodDenied.status, 405);
    assert.equal(methodDenied.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(
      (
        await fetch(firstEndpoint + "?path=other.html", {
          method: "POST",
          headers: { Origin: "null", "Content-Type": "application/json" },
          body: validRead,
        })
      ).status,
      400,
    );
    const forged = await fetch(firstEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://foreign.invalid" },
      body: JSON.stringify({ version: 1, op: "read", key: "native-boundary" }),
    });
    assert.equal(forged.status, 403);
    await $('div[data-path="Storage/Generated.html"]').click({ button: "right" });
    await $('button[role="menuitem"]=右の列で開く').click();
    await browser.waitUntil(
      async () => (await $(".document-pane.active").getAttribute("id")) !== firstPanel,
    );
    await enter();
    const second = await browser.executeAsync((done) => {
      const store = (window as unknown as StorageWorld).MyKnowledgeStorage.create({
        appId: "native-boundary",
        schemaVersion: 1,
      });
      void (async () => {
        const before = await store.read();
        await store.write({ owner: "second" });
        await store.flush();
        done({ before, after: await store.read() });
      })();
    });
    assert.deepEqual(second, { before: { owner: "first" }, after: { owner: "second" } });
    await leave();
    await $('button[role="tab"][aria-controls="' + firstPanel + '"]').click();
    await enter();
    const shared = await browser.executeAsync((done) => {
      void (window as unknown as StorageWorld).MyKnowledgeStorage.create({
        appId: "native-boundary",
        schemaVersion: 1,
      })
        .read()
        .then(done);
    });
    assert.deepEqual(shared, { owner: "second" });
    await leave();
    await folder("StorageNative");
    await select("StorageNative/Copy.html");
    await enter();
    const other = await browser.executeAsync((done) => {
      void (window as unknown as StorageWorld).MyKnowledgeStorage.create({
        appId: "native-boundary",
        schemaVersion: 1,
      })
        .read()
        .then(done);
    });
    assert.equal(other, null);
    await leave();
    await select("Storage/Generated.html");
    await enter();
    assert.equal(
      await browser.executeAsync((done) => {
        void (window as unknown as StorageWorld).MyKnowledgeStorage.create({
          appId: "native-boundary",
          schemaVersion: 1,
        })
          .remove()
          .then(() => done(true));
      }),
      true,
    );
    await leave();
  });

  it("reports real SQLite busy and schema failures, retains calculation and permits retry", async () => {
    await guardFixture();
    await folder("Storage");
    await select("Storage/Generated.html");
    await enter();
    await save("13");
    const identifier = JSON.parse(readFileSync(resolve(".tools/storage-qa.conf.json"), "utf8"))
      .identifier as string;
    assert.equal(
      identifier,
      "com.shimilynx.aiwiki.storage-qa-integrated",
      "Fault injection must never target the formal profile",
    );
    assert.ok(process.env.LOCALAPPDATA);
    const database = resolve(process.env.LOCALAPPDATA!, identifier, "document-state/state.sqlite");
    assert.ok(readFileSync(database).subarray(0, 16).toString().startsWith("SQLite format 3"));
    const locker = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import {DatabaseSync} from "node:sqlite";const db=new DatabaseSync(process.argv[1]);db.exec("BEGIN EXCLUSIVE");process.stdout.write("LOCKED\\n");process.stdin.once("data",()=>{db.exec("ROLLBACK");db.close();process.exit(0)});',
        database,
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    try {
      await new Promise<void>((done, reject) => {
        const timeout = setTimeout(() => reject(Error("Dedicated SQLite lock timeout")), 5000);
        locker.once("error", reject);
        locker.once("exit", (code) => reject(Error("SQLite lock exited " + code)));
        locker.stdout.once("data", (data) => {
          clearTimeout(timeout);
          assert.match(String(data), /LOCKED/);
          done();
        });
      });
      await browser.execute(() => {
        const tracked = window as unknown as { __busyPending: number };
        tracked.__busyPending = 0;
        const original = window.fetch;
        window.fetch = async (...args: Parameters<typeof fetch>) => {
          const write =
            args[1]?.method === "POST" &&
            typeof args[1].body === "string" &&
            JSON.parse(args[1].body).op === "write";
          if (write) tracked.__busyPending++;
          try {
            return await original(...args);
          } finally {
            if (write) tracked.__busyPending--;
          }
        };
      });
      await browser.execute(() => {
        const input = document.querySelector<HTMLInputElement>("#amount")!;
        input.value = "17";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await $("#save").click();
      await browser.waitUntil(async () => (await status()).includes("StorageBusy"));
      await browser.waitUntil(
        async () =>
          await browser.execute(
            () => (window as unknown as { __busyPending: number }).__busyPending === 0,
          ),
      );
      assert.match(await status(), /StorageBusy/);
      assert.equal((await sampleValues()).result, "34");
      await browser.saveScreenshot(resolve(".tools/native-storage-busy.png"));
    } finally {
      locker.stdin.end("release\n");
      if (locker.exitCode === null)
        await new Promise<void>((done, reject) => {
          const timeout = setTimeout(() => {
            locker.kill();
            reject(Error("Owned SQLite lock did not exit"));
          }, 5000);
          locker.once("exit", () => {
            clearTimeout(timeout);
            done();
          });
        });
    }
    const durable = await browser.executeAsync((done) => {
      void (window as unknown as StorageWorld).MyKnowledgeStorage.create({
        appId: "generated-calculator",
        schemaVersion: 1,
      })
        .read()
        .then(done);
    });
    assert.deepEqual(durable, { amount: 13, mode: "double", enabled: true });
    await save("17");
    await browser.executeAsync((done) => {
      void (window as unknown as StorageWorld).MyKnowledgeStorage.create({
        appId: "generated-calculator",
        schemaVersion: 2,
      })
        .write({ amount: 99, mode: "square", enabled: true })
        .then(() => done(true));
    });
    await leave();
    const panel = await $(".document-pane.active").getAttribute("id");
    const oldUrl = await $(".document-pane.active iframe").getAttribute("src");
    await $('button[role="tab"][aria-controls="' + panel + '"]').click({ button: "right" });
    await $('button[role="menuitem"]=状態をリセットして再読み込み').click();
    await reloaded("Storage/Generated.html", oldUrl);
    // A schema failure is an expected terminal initial-read state.
    await enter();
    assert.match(await status(), /schema_mismatch/);
    assert.equal(await $("#save").isEnabled(), false);
    await browser.execute(() => {
      const input = document.querySelector<HTMLInputElement>("#amount")!;
      input.value = "8";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    assert.equal((await sampleValues()).result, "16");
    const mismatch = await browser.executeAsync((done) => {
      void (window as unknown as StorageWorld).MyKnowledgeStorage.create({
        appId: "generated-calculator",
        schemaVersion: 2,
      })
        .read()
        .then(done);
    });
    assert.deepEqual(mismatch, { amount: 99, mode: "square", enabled: true });
    await browser.executeAsync((done) => {
      void (window as unknown as StorageWorld).MyKnowledgeStorage.create({
        appId: "generated-calculator",
        schemaVersion: 2,
      })
        .remove()
        .then(() => done(true));
    });
    await leave();
  });
});
async function restoredOrSaved(amount: string) {
  assert.ok(["保存済み", "復元済み"].includes(await status()));
  assert.deepEqual(await sampleValues(), {
    amount,
    mode: "double",
    enabled: true,
    result: String(Number(amount) * 2),
  });
}
