import { browser, $ } from "@wdio/globals";
import assert from "node:assert/strict";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, toNamespacedPath } from "node:path";
import type { Snapshot, TreeNode } from "../../src/lib/types";

const configuredRoot = process.env.MY_KNOWLEDGE_CLOUD_FIXTURE_ROOT;
const enabled = process.platform === "win32" && Boolean(configuredRoot);
const mutations = process.env.MY_KNOWLEDGE_CLOUD_MUTATIONS === "1";
const markerName = ".my-knowledge-cloud-fixture";
const markerContent = "MY_KNOWLEDGE_DISPOSABLE_CLOUD_FIXTURE_V1\n";

function fixtureRoot() {
  assert.ok(configuredRoot, "An explicitly supplied disposable cloud fixture is required");
  const root = resolve(configuredRoot);
  const rootMetadata = lstatSync(root);
  assert.ok(
    rootMetadata.isDirectory() && !rootMetadata.isSymbolicLink(),
    "Fixture must be a real directory",
  );
  const marker = join(root, markerName);
  const metadata = lstatSync(marker);
  assert.ok(
    metadata.isFile() && !metadata.isSymbolicLink(),
    "Fixture requires a regular opt-in marker",
  );
  assert.equal(
    readFileSync(marker, "utf8"),
    markerContent,
    "Disposable fixture marker must match exactly",
  );
  return root;
}

async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = (await browser.executeAsync(
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
  assert.ok(result.ok, "Native command must succeed");
  return result.value as T;
}

function paths(nodes: TreeNode[]): string[] {
  return nodes.flatMap((node) => [node.relativePath, ...paths(node.children)]);
}

async function refresh() {
  const previous = await invoke<Snapshot>("get_knowledge_tree");
  await $('button[aria-label="再走査"]').click();
  await browser.waitUntil(
    async () => (await invoke<Snapshot>("get_knowledge_tree")).revision > previous.revision,
  );
  await browser.waitUntil(async () => $('button[aria-label="再走査"]').isEnabled());
  const refreshed = await invoke<Snapshot>("get_knowledge_tree");
  assert.equal(
    refreshed.workspaceId,
    previous.workspaceId,
    "Same-root refresh must retain the workspace",
  );
  assert.equal(
    refreshed.viewId,
    previous.viewId,
    "Same-root refresh must retain renderer ownership",
  );
  return refreshed;
}

async function expand(path: string) {
  const node = $('div[data-path="' + path + '"]');
  await node.waitForExist();
  if ((await node.getAttribute("aria-expanded")) !== "true") await node.click();
}

async function select(path: string) {
  const reused = await browser.execute(
    (relativePath) => Boolean(document.querySelector('iframe[title="' + relativePath + '"]')),
    path,
  );
  await $('div[data-path="' + path + '"]').click();
  await browser.waitUntil(
    async () =>
      (await $(".document-pane.active iframe").isExisting()) &&
      (await $(".document-pane.active iframe").getAttribute("title")) === path,
  );
  if (reused) {
    const previous = await $(".document-pane.active iframe").getAttribute("src");
    await $('button[aria-label="文書を再読み込み"]').click();
    await browser.waitUntil(
      async () => (await $(".document-pane.active iframe").getAttribute("src")) !== previous,
    );
  }
}

// Never recursively remove the supplied root or a directory whose contents are unknown.
function cleanOwnedDirectory(directory: string, names: string[]) {
  const metadata = lstatSync(directory, { throwIfNoEntry: false });
  if (!metadata || !metadata.isDirectory() || metadata.isSymbolicLink()) return;
  for (const name of names) {
    const file = join(directory, name);
    const entry = lstatSync(file, { throwIfNoEntry: false });
    if (entry?.isFile() || entry?.isSymbolicLink()) unlinkSync(file);
  }
  rmdirSync(directory); // Unexpected contents are retained, never traversed or deleted.
}

(enabled ? describe : describe.skip)("Opt-in Windows cloud fixture", () => {
  let root: string;
  let scratch: string | undefined;
  let relative: string;
  const ownedNames = [
    "View.html",
    "style.css",
    "classic.js",
    "module.mjs",
    "data.json",
    "image.svg",
    "Live.html",
    "Live.tmp",
    "Renamed.html",
  ];

  before(() => {
    root = fixtureRoot();
  });
  afterEach(async () => {
    await browser.switchToParentFrame();
  });
  after(() => {
    if (scratch) cleanOwnedDirectory(scratch, ownedNames);
  });

  it("bootstraps a locally retained cloud root through the real Native boundary", async () => {
    const snapshot = await invoke<Snapshot>("get_knowledge_tree");
    assert.ok(
      snapshot.workspaceId && snapshot.rootPath,
      "Cloud root must be accepted at bootstrap",
    );
    assert.ok(
      toNamespacedPath(realpathSync.native(snapshot.rootPath)).toLowerCase() ===
        toNamespacedPath(realpathSync.native(root)).toLowerCase(),
      "Bootstrap must select the supplied fixture",
    );
    assert.equal(snapshot.watchError, null, "Retained fixture must scan and watch successfully");
    await $("[role=tree]").waitForExist();
  });

  it("renders locally resident HTML, CSS, classic JS, Modules, JSON and image assets", async () => {
    fixtureRoot();
    scratch = mkdtempSync(join(root, "my-knowledge-cloud-qa-"));
    relative = basename(scratch);
    const files: Record<string, string> = {
      "View.html":
        '<link rel="stylesheet" href="style.css"><h1 id="ready">resident</h1><img id="image" src="image.svg"><p id="json"></p><script src="classic.js"></script><script type="module" src="module.mjs"></script>',
      "style.css": "body { background-color: rgb(12, 34, 56); }",
      "classic.js": 'document.documentElement.dataset.classic = "ready";',
      "module.mjs":
        'const data = await fetch("data.json").then(response => response.json()); document.querySelector("#json").textContent = data.message;',
      "data.json": '{"message":"resident JSON"}',
      "image.svg":
        '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="green"/></svg>',
    };
    for (const [name, content] of Object.entries(files))
      writeFileSync(join(scratch, name), content, { flag: "wx" });
    await refresh();
    await expand(relative);
    await select(relative + "/View.html");
    await browser.switchToFrame($(".document-pane.active iframe"));
    await browser.waitUntil(async () => (await $("#json").getText()) === "resident JSON");
    assert.equal(await browser.execute(() => document.documentElement.dataset.classic), "ready");
    assert.equal(
      await browser.execute(() => getComputedStyle(document.body).backgroundColor),
      "rgb(12, 34, 56)",
    );
    await browser.waitUntil(async () =>
      browser.execute(() => {
        const image = document.querySelector<HTMLImageElement>("#image")!;
        return image.complete && image.naturalWidth > 0;
      }),
    );
    await browser.switchToParentFrame();
    assert.equal(await $(".document-pane.active iframe").getAttribute("sandbox"), "allow-scripts");
  });

  (mutations ? it : it.skip)(
    "reflects external save, atomic replace, rename and deletion of its own files",
    async () => {
      assert.ok(scratch, "Resident fixture must be created first");
      await select(relative + "/View.html");
      const assetPrevious = await $(".document-pane.active iframe").getAttribute("src");
      writeFileSync(join(scratch, "data.json"), '{"message":"updated JSON"}');
      await browser.waitUntil(
        async () => (await $(".document-pane.active iframe").getAttribute("src")) !== assetPrevious,
      );
      await browser.switchToFrame($(".document-pane.active iframe"));
      await browser.waitUntil(async () => (await $("#json").getText()) === "updated JSON");
      await browser.switchToParentFrame();
      const live = join(scratch, "Live.html");
      writeFileSync(live, '<h1 id="live">one</h1>', { flag: "wx" });
      await $('div[data-path="' + relative + '/Live.html"]').waitForExist();
      await select(relative + "/Live.html");
      const previous = await $(".document-pane.active iframe").getAttribute("src");
      writeFileSync(join(scratch, "Live.tmp"), '<h1 id="live">two</h1>', { flag: "wx" });
      renameSync(join(scratch, "Live.tmp"), live);
      await browser.waitUntil(
        async () => (await $(".document-pane.active iframe").getAttribute("src")) !== previous,
      );
      await browser.switchToFrame($(".document-pane.active iframe"));
      await browser.waitUntil(async () => (await $("#live").getText()) === "two");
      await browser.switchToParentFrame();
      renameSync(live, join(scratch, "Renamed.html"));
      await $('div[data-path="' + relative + '/Renamed.html"]').waitForExist();
      await browser.waitUntil(async () => !(await $(".document-pane.active iframe").isExisting()));
      await select(relative + "/Renamed.html");
      unlinkSync(join(scratch, "Renamed.html"));
      await browser.waitUntil(async () => !(await $(".document-pane.active iframe").isExisting()));
      assert.match(await $('.workspace-feedback [role="alert"]').getText(), /削除|移動/);
    },
  );

  (mutations ? it : it.skip)(
    "excludes a junction and rejects Native tab creation and HTTP asset reads outside the root",
    async () => {
      assert.ok(scratch, "Resident fixture must be created first");
      const outside = mkdtempSync(join(tmpdir(), "my-knowledge-cloud-outside-"));
      const junction = join(scratch, "Escape");
      let created = false;
      try {
        writeFileSync(join(outside, "Outside.html"), "<h1>outside sentinel</h1>", { flag: "wx" });
        const sentinel = "MY_KNOWLEDGE_OUTSIDE_CSS_SENTINEL";
        writeFileSync(join(outside, "outside.css"), "/* " + sentinel + " */", { flag: "wx" });
        symlinkSync(outside, junction, "junction");
        created = true;
        const snapshot = await refresh();
        assert.ok(
          snapshot.workspaceId && snapshot.viewId,
          "Current workspace and renderer ownership must exist",
        );
        assert.ok(
          !paths(snapshot.nodes).some((path) => path.startsWith(relative + "/Escape")),
          "Junction must not enter the tree",
        );
        const accepted = await browser.executeAsync(
          (parameters, done) => {
            void (
              window as unknown as {
                __TAURI_INTERNALS__: {
                  invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
                };
              }
            ).__TAURI_INTERNALS__
              .invoke("create_document_tab", parameters)
              .then(
                () => done(true),
                () => done(false),
              );
          },
          {
            workspaceId: snapshot.workspaceId,
            viewId: snapshot.viewId,
            relativePath: relative + "/Escape/Outside.html",
          },
        );
        assert.equal(accepted, false, "Junction document must fail Native tab creation");

        await expand(relative);
        await select(relative + "/View.html");
        const source = await $(".document-pane.active iframe").getAttribute("src");
        assert.ok(source, "A current document session must exist");
        const documentUrl = new URL(source);
        assert.ok(
          documentUrl.protocol === "http:" && documentUrl.hostname === "127.0.0.1",
          "Asset checks must target the local document server",
        );
        assert.ok(
          /^\/s\/[a-fA-F0-9]{64}\//.test(documentUrl.pathname),
          "Asset checks require the current authorized session",
        );
        const sessionPrefix = documentUrl.pathname.split("/").slice(0, 3).join("/") + "/";
        async function assetRequest(parts: string[]) {
          const assetUrl = new URL(documentUrl);
          assetUrl.pathname = sessionPrefix + parts.map(encodeURIComponent).join("/");
          assetUrl.search = "";
          assetUrl.hash = "";
          // Never include the authorized URL/token in assertion or transport errors.
          try {
            const response = await fetch(assetUrl, {
              redirect: "error",
              signal: AbortSignal.timeout(15000),
            });
            return { status: response.status, body: await response.text() };
          } catch {
            throw new Error("Local asset HTTP request failed");
          }
        }
        const local = await assetRequest([relative, "style.css"]);
        assert.equal(local.status, 200, "Regular in-root CSS must be served as the control");
        assert.ok(
          local.body.includes("rgb(12, 34, 56)"),
          "Control CSS must contain its local contents",
        );
        const escaped = await assetRequest([relative, "Escape", "outside.css"]);
        assert.equal(escaped.status, 404, "Junction CSS must fail actual HTTP asset reading");
        assert.ok(
          !escaped.body.includes(sentinel),
          "Root-external CSS contents must never be returned",
        );
      } finally {
        if (created && lstatSync(junction, { throwIfNoEntry: false })?.isSymbolicLink())
          rmdirSync(junction);
        cleanOwnedDirectory(outside, ["Outside.html", "outside.css"]);
      }
    },
  );
});
