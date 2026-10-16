import { browser, $ } from "@wdio/globals";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve, toNamespacedPath } from "node:path";
import type { MutationResult, Snapshot, TreeMutation, TreeNode } from "../../src/lib/types";
import type { IndexStatus, SearchPage } from "../../src/features/document-search/types";

const ordinaryFixture =
  !process.env.MY_KNOWLEDGE_CLOUD_FIXTURE_ROOT && !process.env.MY_KNOWLEDGE_BENCH_ROOT;
const fixture = resolve(".tools/e2e-knowledge");
const qualityPath = "Search/Quality.html";
const querySelector = "#document-search-query";

async function nativeCall<T>(command: string, args: Record<string, unknown> = {}) {
  const response = (await browser.executeAsync(
    (name, parameters, done) => {
      void (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
          };
        }
      ).__TAURI_INTERNALS__
        .invoke(name, parameters)
        .then(
          (value) => done({ ok: true, value }),
          () => done({ ok: false }),
        );
    },
    command,
    args,
  )) as { ok: boolean; value?: unknown };
  return response as { ok: boolean; value?: T };
}

async function native<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const response = await nativeCall<T>(command, args);
  assert.ok(response.ok, "Native " + command + " must succeed");
  return response.value as T;
}

async function workspace() {
  const snapshot = await native<Snapshot>("get_knowledge_tree");
  assert.ok(snapshot.workspaceId, "Native fixture workspace must exist");
  return snapshot.workspaceId;
}

async function ready(afterRevision = -1) {
  const workspaceId = await workspace();
  await browser.waitUntil(
    async () => {
      const response = await nativeCall<IndexStatus>("get_index_status", { workspaceId });
      return (
        response.ok &&
        response.value?.phase === "ready" &&
        response.value.requestRevision > afterRevision
      );
    },
    { timeout: 30000, timeoutMsg: "Native search index must become ready" },
  );
  return native<IndexStatus>("get_index_status", { workspaceId });
}

async function nativeSearch(query: string) {
  return native<SearchPage>("search_documents", {
    workspaceId: await workspace(),
    query,
    limit: 20,
    offset: 0,
  });
}

async function waitPage(query: string, expectedPath: string | null) {
  let matching: SearchPage | undefined;
  await browser.waitUntil(
    async () => {
      const response = await nativeCall<SearchPage>("search_documents", {
        workspaceId: await workspace(),
        query,
        limit: 20,
        offset: 0,
      });
      const hits = response.value?.hits;
      const matched =
        response.ok &&
        !!hits &&
        (expectedPath === null
          ? hits.length === 0
          : hits.length === 1 && hits[0].relativePath === expectedPath);
      if (matched) matching = response.value;
      return matched;
    },
    { timeout: 30000, timeoutMsg: "File changes must reach the real search index" },
  );
  assert.ok(matching, "Matching Native search results must be available");
  return matching;
}

async function mutate(mutation: TreeMutation) {
  const snapshot = await native<Snapshot>("get_knowledge_tree");
  assert.ok(snapshot.workspaceId && snapshot.viewId && snapshot.rootPath);
  assert.ok(
    toNamespacedPath(realpathSync.native(snapshot.rootPath)) ===
      toNamespacedPath(realpathSync.native(fixture)),
    "Mutation must stay in the dedicated default fixture",
  );
  return native<MutationResult>("mutate_tree", {
    workspaceId: snapshot.workspaceId,
    viewId: snapshot.viewId,
    mutation,
  });
}

function findNode(nodes: TreeNode[], path: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.relativePath === path) return node;
    const child = findNode(node.children, path);
    if (child) return child;
  }
}

async function openSearch() {
  const menu = $('button[aria-controls="knowledge-sidebar"]');
  if ((await menu.getAttribute("aria-expanded")) === "false") await menu.click();
  if (!(await $(querySelector).isDisplayed())) {
    await $('button[aria-controls="knowledge-search"]').click();
  }
}

async function enterQuery(query: string) {
  await openSearch();
  // WebDriver clear can leave React's controlled value unchanged, causing the
  // next insertion to append the previous query. Use normal editing keys.
  await $(querySelector).click();
  await browser.keys([process.platform === "darwin" ? "Meta" : "Control", "a"]);
  await browser.keys("Backspace");
  await $(querySelector).addValue(query);
  try {
    await browser.waitUntil(async () => (await $(querySelector).getValue()) === query);
  } catch (failure) {
    const state = await browser.execute(() => {
      const input = document.querySelector<HTMLInputElement>("#document-search-query");
      const value = input?.value ?? "";
      const active = document.activeElement;
      return {
        actual: value,
        characters: Array.from(value),
        codePoints: Array.from(value, (character) => character.codePointAt(0)),
        active: { tag: active?.tagName, id: active?.id, label: active?.getAttribute("aria-label") },
      };
    });
    console.error(
      "NATIVE_SEARCH_INPUT_FAILURE " +
        JSON.stringify({
          expected: query,
          expectedCharacters: Array.from(query),
          expectedCodePoints: Array.from(query, (character) => character.codePointAt(0)),
          ...state,
        }),
    );
    throw failure;
  }
  // Search starts from the debounced input; there is no submit button.
  await browser.keys("Enter");
}

function result(path: string) {
  // All paths here are controlled fixture names, never user input in selectors.
  return $('.search-results button[title="' + path + '"]');
}

async function chooseResult(path: string) {
  try {
    await result(path).waitForExist({ timeout: 30000 });
  } catch (failure) {
    const state = await browser.execute(() => ({
      query: document.querySelector<HTMLInputElement>("#document-search-query")?.value,
      status: document.querySelector(".search-index-status")?.textContent,
      searchError: document.querySelector(".search-error")?.textContent,
      progress: document.querySelector(".search-progress")?.textContent,
      paths: Array.from(document.querySelectorAll(".search-results button"), (button) =>
        button.getAttribute("title"),
      ),
    }));
    console.error(
      "NATIVE_SEARCH_RESULT_FAILURE " + JSON.stringify({ expectedPath: path, ...state }),
    );
    throw failure;
  }
  await result(path).click();
  await browser.waitUntil(
    async () =>
      (await $(".document-pane.active iframe").isExisting()) &&
      (await $(".document-pane.active iframe").getAttribute("title")) === path,
  );
}

async function stampFrames() {
  return browser.execute(() =>
    Array.from(
      document.querySelectorAll<HTMLIFrameElement>(".document-pane iframe"),
      (frame, index) => {
        frame.dataset.searchRetained = "frame-" + index;
        return {
          title: frame.title,
          src: frame.getAttribute("src"),
          stamp: frame.dataset.searchRetained,
        };
      },
    ),
  );
}

async function unchangedFrames(before: Awaited<ReturnType<typeof stampFrames>>) {
  const result = await browser.execute((previous) => {
    const current = Array.from(
      document.querySelectorAll<HTMLIFrameElement>(".document-pane iframe"),
    );
    const unchanged =
      current.length === previous.length &&
      previous.every((entry) => {
        const frame = current.find((candidate) => candidate.title === entry.title);
        return (
          frame?.getAttribute("src") === entry.src && frame.dataset.searchRetained === entry.stamp
        );
      });
    return {
      unchanged,
      current: current.map((frame) => ({
        title: frame.title,
        src: frame.getAttribute("src"),
        stamp: frame.dataset.searchRetained,
      })),
    };
  }, before);
  if (!result.unchanged)
    console.error(
      "NATIVE_FRAME_RETENTION_FAILURE " + JSON.stringify({ before, current: result.current }),
    );
  return result.unchanged;
}

(ordinaryFixture ? describe : describe.skip)("Native document search", () => {
  let ownedDirectory: string | undefined;
  const mutationDirectories: { path: string; files: string[] }[] = [];

  before(async () => {
    const snapshot = await native<Snapshot>("get_knowledge_tree");
    assert.ok(snapshot.rootPath, "Ordinary default fixture must be bootstrapped");
    assert.ok(
      toNamespacedPath(realpathSync.native(snapshot.rootPath)) ===
        toNamespacedPath(realpathSync.native(fixture)),
      "Search mutations must target the dedicated default fixture",
    );
    assert.ok(lstatSync(fixture).isDirectory() && !lstatSync(fixture).isSymbolicLink());
    await openSearch();
    await $(querySelector).waitForDisplayed();
    await ready();
  });

  after(async () => {
    await browser.switchToParentFrame();
    for (const { path, files } of [...mutationDirectories].reverse()) {
      const directory = lstatSync(path, { throwIfNoEntry: false });
      if (!directory?.isDirectory() || directory.isSymbolicLink()) continue;
      for (const name of files) {
        const file = join(path, name);
        const entry = lstatSync(file, { throwIfNoEntry: false });
        if (entry?.isFile() || entry?.isSymbolicLink()) unlinkSync(file);
      }
      rmdirSync(path);
    }
    if (!ownedDirectory) return;
    const directory = lstatSync(ownedDirectory, { throwIfNoEntry: false });
    if (!directory?.isDirectory() || directory.isSymbolicLink()) return;
    for (const name of ["Created.html", "Renamed.html"]) {
      const file = join(ownedDirectory, name);
      const entry = lstatSync(file, { throwIfNoEntry: false });
      if (entry?.isFile() || entry?.isSymbolicLink()) unlinkSync(file);
    }
    rmdirSync(ownedDirectory); // Unknown contents are left intact; no recursive deletion.
  });

  it("uses real Native literal Japanese/path search and escapes result snippets", async () => {
    for (const query of ["東京都", "ＲＵＳＴ", "NEAR(foo)", 'a"b', "%_", qualityPath]) {
      const page = await nativeSearch(query);
      assert.ok(
        page.hits.some((hit) => hit.relativePath === qualityPath),
        "Literal fixture query must match",
      );
    }
    for (const query of [
      "非索引StyleSentinel",
      "非索引InputSentinel",
      "非索引TextareaSentinel",
      "非索引TemplateSentinel",
      "非索引CommentSentinel",
      "非索引ScriptSentinel",
    ]) {
      assert.equal(
        (await nativeSearch(query)).hits.length,
        0,
        "Inactive/source-only content must not be indexed",
      );
    }
    await enterQuery("検索品質");
    await result(qualityPath).waitForExist();
    assert.equal(await result(qualityPath).$(".search-result-title").getText(), "日本語検索品質");
    assert.equal(await result(qualityPath).$(".search-result-path").getText(), qualityPath);
    assert.ok(
      (await result(qualityPath).$(".search-result-snippet").getText()).includes(
        '<img src="invalid"',
      ),
    );
    assert.ok(
      await browser.execute(
        () =>
          !document.querySelector(".search-result-snippet img") &&
          !(window as unknown as { searchSnippetExecuted?: boolean }).searchSnippetExecuted,
      ),
      "Snippet markup must remain text in the trusted shell",
    );
    await chooseResult(qualityPath);
    assert.equal(await $(".document-pane.active iframe").getAttribute("sandbox"), "allow-scripts");
  });

  it("reuses retained tabs and preserves them across empty/error/cancel/rebuild", async () => {
    const beforeOther = await stampFrames();
    await enterQuery("Examples/Interactive.html");
    await chooseResult("Examples/Interactive.html");
    const retained = await stampFrames();
    await enterQuery("検索品質");
    await chooseResult(qualityPath);
    assert.ok(
      await unchangedFrames(retained),
      "Clicking a search hit must reuse its existing iframe and tab",
    );
    assert.ok(beforeOther.some((frame) => frame.title === qualityPath));

    await $(querySelector).setValue("   ");
    assert.equal(await $(".search-form button[type=submit]").isExisting(), false);
    await browser.waitUntil(async () => !(await $(".search-results").isExisting()));
    await enterQuery("検索一致なしNativeSentinel");
    await $(".search-empty").waitForExist();
    assert.match(await $(".search-empty").getText(), /一致する文書がありません/);

    await $(querySelector).setValue("a b c d e f g h i");
    await $(".search-error[role=alert]").waitForExist();
    assert.match(await $(".search-error[role=alert]").getText(), /8個以内/);
    const workspaceId = await workspace();
    assert.equal(
      (
        await nativeCall("search_documents", {
          workspaceId,
          query: "a b c d e f g h i",
          limit: 20,
          offset: 0,
        })
      ).ok,
      false,
    );
    assert.equal(
      (
        await nativeCall("search_documents", {
          workspaceId: "stale-native-search-workspace",
          query: "検索品質",
          limit: 20,
          offset: 0,
        })
      ).ok,
      false,
    );
    await $(".search-input-row button[type=button]").click();
    assert.equal(await $(querySelector).getValue(), "");
    await browser.waitUntil(async () => !(await $(".search-error").isExisting()));

    await $(querySelector).setValue("検索品質");
    await browser.keys("Escape");
    assert.equal(await $(querySelector).getValue(), "");
    await browser.waitUntil(async () => !(await $(".search-results").isExisting()));
    assert.ok(
      await unchangedFrames(retained),
      "Search validation and cancellation must preserve tabs",
    );

    const status = await ready();
    const snapshot = await native<Snapshot>("get_knowledge_tree");
    await $(".search-index-details summary").click();
    await $(".search-rebuild").waitForEnabled();
    await $(".search-rebuild").click();
    await ready(status.requestRevision);
    await browser.waitUntil(async () => $(".search-rebuild").isEnabled());
    const after = await native<Snapshot>("get_knowledge_tree");
    assert.equal(after.workspaceId, snapshot.workspaceId);
    assert.equal(
      after.viewId,
      snapshot.viewId,
      "Rebuilding the search index must not replace renderer ownership",
    );
    assert.ok(
      await unchangedFrames(retained),
      "Rebuilding the derived index must preserve live iframes",
    );
    await enterQuery("検索品質");
    await result(qualityPath).waitForExist();
  });

  it("updates real search results after external create, save, rename and deletion", async () => {
    ownedDirectory = mkdtempSync(join(fixture, "search-native-"));
    const directoryName = basename(ownedDirectory);
    const createdPath = directoryName + "/Created.html";
    const renamedPath = directoryName + "/Renamed.html";
    const identifier = randomUUID().replaceAll("-", "");
    const firstQuery = "検索更新前" + identifier;
    const updatedQuery = "検索更新後" + identifier;
    const document = (query: string) =>
      '<meta charset="utf-8"><title>外部保存の検索検証</title><h1>' + query + "</h1>";
    const created = join(ownedDirectory, "Created.html");
    writeFileSync(created, document(firstQuery), { flag: "wx" });
    const initialPage = await waitPage(firstQuery, createdPath);
    assert.match(initialPage.hits[0].documentId, /^[a-f0-9]{64}$/);
    await enterQuery(firstQuery);
    await result(createdPath).waitForExist({ timeout: 30000 });

    writeFileSync(created, document(updatedQuery));
    await waitPage(updatedQuery, createdPath);
    await waitPage(firstQuery, null);
    await $(".search-empty").waitForExist({ timeout: 30000 });
    await enterQuery(updatedQuery);
    await result(createdPath).waitForExist();

    renameSync(created, join(ownedDirectory, "Renamed.html"));
    const moved = await waitPage(updatedQuery, renamedPath);
    assert.notEqual(
      moved.hits[0].documentId,
      initialPage.hits[0].documentId,
      "Renaming must replace the path-derived document identity",
    );
    await result(renamedPath).waitForExist({ timeout: 30000 });
    assert.equal(await result(createdPath).isExisting(), false);
    await chooseResult(renamedPath);
    unlinkSync(join(ownedDirectory, "Renamed.html"));
    await waitPage(updatedQuery, null);
    await $(".search-empty").waitForExist({ timeout: 30000 });
    assert.equal(await result(renamedPath).isExisting(), false);
    await browser.waitUntil(
      async () => !(await $('iframe[title="' + renamedPath + '"]').isExisting()),
    );
    assert.match(await $(".document-pane.active .document-empty").getText(), /削除|移動/);
  });

  it("refocuses the current Native search without clearing its query or repeating the search", async () => {
    await enterQuery("検索品質");
    await result(qualityPath).waitForExist();
    const frames = await stampFrames();
    await browser.execute(() => {
      const tracked = window as unknown as {
        __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> };
        searchInvokeCount?: number;
        restoreSearchInvoke?: () => void;
      };
      const original = tracked.__TAURI_INTERNALS__.invoke;
      tracked.searchInvokeCount = 0;
      tracked.__TAURI_INTERNALS__.invoke = (command, args) => {
        if (command === "search_documents") tracked.searchInvokeCount!++;
        return original(command, args);
      };
      tracked.restoreSearchInvoke = () => {
        tracked.__TAURI_INTERNALS__.invoke = original;
      };
    });
    try {
      for (let index = 0; index < 3; index++) {
        await $('button[aria-controls="knowledge-search"]').click();
        await browser.keys([process.platform === "darwin" ? "Meta" : "Control", "Shift", "f"]);
        await browser.waitUntil(async () =>
          browser.execute(() => document.activeElement?.id === "document-search-query"),
        );
      }
      assert.equal(await $(querySelector).getValue(), "検索品質");
      assert.ok(await result(qualityPath).isDisplayed());
      assert.ok(await unchangedFrames(frames));
      assert.equal(
        await browser.execute(
          () => (window as unknown as { searchInvokeCount: number }).searchInvokeCount,
        ),
        0,
      );
    } finally {
      await browser.execute(() =>
        (window as unknown as { restoreSearchInvoke: () => void }).restoreSearchInvoke(),
      );
    }
  });

  it("keeps external HTML search results current after Native reorder and move mutations", async function () {
    if (process.env.MY_KNOWLEDGE_TEST_BINARY || !process.env.MY_KNOWLEDGE_E2E_ACTION_CAPTURE)
      this.skip();
    const identifier = randomUUID().replaceAll("-", "");
    const rootName = "search-native-mutations-" + identifier;
    await mutate({ kind: "createFolder", parent: "", name: rootName });
    mutationDirectories.push({ path: join(fixture, rootName), files: [] });
    const source = rootName + "/Source";
    const target = rootName + "/Target";
    const firstName = "検索内作成" + identifier;
    const secondName = "検索内追加" + identifier;
    const firstFile = firstName + ".html";
    const secondFile = secondName + ".html";
    await mutate({ kind: "createFolder", parent: rootName, name: "Source" });
    mutationDirectories.push({ path: join(fixture, source), files: [firstFile, secondFile] });
    await mutate({ kind: "createFolder", parent: rootName, name: "Target" });
    mutationDirectories.push({ path: join(fixture, target), files: [firstFile] });
    const firstPath = source + "/" + firstFile;
    const secondPath = source + "/" + secondFile;
    writeFileSync(join(fixture, firstPath), "<title>" + firstName + "</title>", { flag: "wx" });
    const originalPage = await waitPage(firstName, firstPath);
    await enterQuery(firstName);
    await chooseResult(firstPath);
    writeFileSync(join(fixture, secondPath), "<title>" + secondName + "</title>", { flag: "wx" });
    await waitPage(secondName, secondPath);
    await ready();
    // Native index completion can precede the shell's structure notification.
    // Observe the new tree entry and completion of its resulting document load.
    await $('button[aria-label="ファイル"]').click();
    for (const folder of [rootName, source]) {
      const row = $('div[data-path="' + folder + '"]');
      await row.waitForExist();
      if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
    }
    await $('div[data-path="' + secondPath + '"]').waitForExist();
    await browser.waitUntil(
      async () => (await $(".document-pane.active .viewer").getAttribute("aria-busy")) === "false",
    );
    await openSearch();
    assert.equal(
      await $(querySelector).getValue(),
      firstName,
      "Tree synchronization must preserve the search query",
    );
    const frames = await stampFrames();
    const reordered = await mutate({
      kind: "reorder",
      source: secondPath,
      anchor: firstPath,
      after: false,
    });
    const children = findNode(reordered.snapshot.nodes, source)?.children.map(
      (node) => node.relativePath,
    );
    assert.deepEqual(
      children,
      [secondPath, firstPath],
      "Native reorder must change tree sibling order",
    );
    const afterOrder = await waitPage(firstName, firstPath);
    assert.equal(afterOrder.hits[0].documentId, originalPage.hits[0].documentId);
    assert.ok(await unchangedFrames(frames), "Reorder must preserve running document tabs");

    const tabCount = await browser.execute(() => document.querySelectorAll('[role="tab"]').length);
    const movedPath = target + "/" + firstFile;
    const moved = await mutate({ kind: "move", source: firstPath, parent: target });
    assert.ok(moved.moves.some((move) => move.from === firstPath && move.to === movedPath));
    const movedPage = await waitPage(firstName, movedPath);
    assert.notEqual(movedPage.hits[0].documentId, originalPage.hits[0].documentId);
    await result(movedPath).waitForExist({ timeout: 30000 });
    assert.equal(
      await result(firstPath).isExisting(),
      false,
      "Search must not retain the old mutation path",
    );
    await chooseResult(movedPath);
    assert.equal(
      await browser.execute(() => document.querySelectorAll('[role="tab"]').length),
      tabCount,
      "Opening a moved search hit must reuse the remapped tab",
    );
    assert.equal(
      (await waitPage(secondName, secondPath)).hits.length,
      1,
      "Sibling search entries must survive the move",
    );
    const oldUrl = await $(".document-pane.active iframe").getAttribute("src");
    const originalBytes = readFileSync(join(fixture, movedPath));
    const renamedName = "検索内改名" + identifier;
    const renamedFile = renamedName + ".html";
    const renamedPath = target + "/" + renamedFile;
    mutationDirectories
      .find((entry) => entry.path === join(fixture, target))!
      .files.push(renamedFile);
    const renamed = await mutate({ kind: "renameHtml", source: movedPath, name: renamedName });
    assert.ok(renamed.moves.some((move) => move.from === movedPath && move.to === renamedPath));
    await waitPage(renamedName, renamedPath);
    await waitPage(firstName, renamedPath);
    await enterQuery(renamedName);
    await result(renamedPath).waitForExist({ timeout: 30000 });
    assert.equal(await result(movedPath).isExisting(), false);
    await chooseResult(renamedPath);
    assert.equal(
      await browser.execute(() => document.querySelectorAll('[role="tab"]').length),
      tabCount,
    );
    assert.equal(
      (await fetch(oldUrl!)).status,
      404,
      "Native basename rename must revoke the previous document grant",
    );
    assert.deepEqual(
      readFileSync(join(fixture, renamedPath)),
      originalBytes,
      "Rename must preserve document content",
    );
  });
});
