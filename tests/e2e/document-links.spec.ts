import { browser, $ } from "@wdio/globals";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";

type MainNative = {
  __TAURI_INTERNALS__: {
    invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
};
const sourcePath = "01-Welcome.html";
const externalUrl = "https://example.com/?q=%E6%97%A5%E6%9C%AC&x=%22%5C#section";
const captures = () =>
  readFileSync(process.env.MY_KNOWLEDGE_E2E_ACTION_CAPTURE!, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { action: string; target: string });

async function source() {
  await $('[aria-label="ファイル"]').click();
  await $(`[data-path="${sourcePath}"]`).click();
  await browser.waitUntil(
    async () => (await $(".document-pane.active iframe").getAttribute("title")) === sourcePath,
  );
  return $(".document-pane.active iframe");
}

describe("document link routing in isolated Native QA", () => {
  before(function () {
    // e2e alone does not isolate app data. Require a separate QA binary with
    // a verified manifest; ordinary/default and production binaries skip.
    const binary = process.env.MY_KNOWLEDGE_E2E_BINARY;
    if (!binary || !process.env.MY_KNOWLEDGE_E2E_ACTION_CAPTURE) this.skip();
    const manifest = JSON.parse(
      readFileSync(resolve(dirname(binary!), "manifest.json"), "utf8"),
    ) as { identifier: string; features: string[]; sha256: string };
    assert.ok(
      manifest.identifier.startsWith("com.shimilynx.aiwiki.") &&
        manifest.identifier !== "com.shimilynx.aiwiki",
    );
    assert.ok(manifest.features.includes("e2e"));
    assert.equal(createHash("sha256").update(readFileSync(binary!)).digest("hex"), manifest.sha256);
  });

  it("keeps same-page anchors and routes another HTML through the source column", async () => {
    const frame = await source();
    const original = await frame.getAttribute("src");
    await browser.switchFrame(frame);
    await browser.execute(() => {
      const input = document.createElement("input");
      input.id = "link-state";
      input.value = "retained source";
      const section = document.createElement("h2");
      section.id = "link-section";
      section.textContent = "Section";
      section.style.marginTop = "1800px";
      const same = document.createElement("a");
      same.id = "same-page-link";
      same.href = "01-Welcome.html#link-section";
      same.textContent = "Same page";
      const other = document.createElement("a");
      other.id = "other-document-link";
      other.href = "Examples/Interactive.html#title";
      other.textContent = "Other HTML";
      document.body.prepend(input, same, other);
      document.body.append(section);
    });
    await $("#same-page-link").click();
    await browser.waitUntil(
      async () => (await browser.execute(() => location.hash)) === "#link-section",
    );
    assert.equal(await $("#link-state").getValue(), "retained source");
    // Native view URLs encode filename punctuation. This same-page relative
    // link goes through the parent resolver and consumes its burst interval.
    await browser.pause(350);
    await $("#other-document-link").click();
    await browser.switchFrame(null);
    await browser.waitUntil(
      async () =>
        (await $(".document-pane.active iframe").getAttribute("title")) ===
        "Examples/Interactive.html",
    );
    await browser.switchFrame($(".document-pane.active iframe"));
    await browser.waitUntil(async () => (await browser.execute(() => location.hash)) === "#title");
    await browser.switchFrame(null);
    const returned = await source();
    assert.equal(await returned.getAttribute("src"), original);
    await browser.switchFrame(returned);
    assert.equal(await $("#link-state").getValue(), "retained source");
    await browser.switchFrame(null);
  });

  it("honors later synchronous document cancellation for anchor, HTML and external clicks", async () => {
    const frame = await source();
    const original = await frame.getAttribute("src");
    const baseline = captures().length;
    await browser.switchFrame(frame);
    await browser.execute(() => {
      location.hash = "";
      (window as unknown as { qaLinkCancels: boolean[] }).qaLinkCancels = [];
      for (const [id, href] of [
        ["qa-cancel-anchor", "#qa-cancelled"],
        ["qa-cancel-html", "Examples/Interactive.html#title"],
        ["qa-cancel-external", "https://example.com/cancelled"],
      ]) {
        const link = document.createElement("a");
        link.id = id;
        link.href = href;
        link.textContent = id;
        document.body.prepend(link);
      }
      window.addEventListener("click", (event) => {
        const link = event.target as HTMLAnchorElement;
        if (!link.id.startsWith("qa-cancel-")) return;
        (window as unknown as { qaLinkCancels: boolean[] }).qaLinkCancels.push(event.isTrusted);
        if (link.id === "qa-cancel-html") event.returnValue = false;
        else event.preventDefault();
      });
    });
    for (const id of ["qa-cancel-anchor", "qa-cancel-html", "qa-cancel-external"]) {
      await $(`#${id}`).click();
      await browser.pause(350);
      assert.equal(await browser.execute(() => location.hash), "");
    }
    assert.deepEqual(
      await browser.execute(
        () => (window as unknown as { qaLinkCancels: boolean[] }).qaLinkCancels,
      ),
      [true, true, true],
    );
    await browser.switchFrame(null);
    assert.equal(await frame.getAttribute("src"), original);
    assert.equal(await $(".external-link-dialog").isExisting(), false);
    assert.equal(captures().length, baseline);
  });

  it("requires a trusted parent confirmation after forged messages and synthetic clicks", async () => {
    const frame = await source();
    const baseline = captures().length;
    await browser.switchFrame(frame);
    await browser.execute((href) => {
      const input = document.getElementById("link-state") as HTMLInputElement | null;
      if (!input) {
        const created = document.createElement("input");
        created.id = "link-state";
        created.value = "retained source";
        document.body.prepend(created);
      }
      const link = document.createElement("a");
      link.id = "external-document-link";
      link.href = href;
      link.textContent = "External";
      document.body.prepend(link);
      link.click();
    }, externalUrl);
    assert.equal(await $("#link-state").getValue(), "retained source");
    const isolation = await browser.execute(() => {
      let parentDenied = false;
      try {
        parent.document.querySelector("dialog button")?.dispatchEvent(new MouseEvent("click"));
      } catch {
        parentDenied = true;
      }
      return {
        parentDenied,
        nativeAbsent: !(window as unknown as Partial<MainNative>).__TAURI_INTERNALS__,
      };
    });
    assert.deepEqual(isolation, { parentDenied: true, nativeAbsent: true });
    await $("#link-state").click();
    await browser.execute(
      (href) =>
        parent.postMessage(
          { type: "my-knowledge-link-v1", token: location.pathname.split("/")[2], href },
          "*",
        ),
      externalUrl,
    );
    await browser.switchFrame(null);
    const dialog = $(".external-link-dialog");
    await dialog.waitForDisplayed();
    assert.equal(await dialog.$("code").getText(), externalUrl);
    assert.equal(captures().length, baseline);
    await browser.execute(() => {
      const buttons = document.querySelectorAll<HTMLButtonElement>(".external-link-dialog button");
      buttons[1].click();
      window.postMessage({ type: "my-knowledge-link-confirm-v1" }, "*");
    });
    assert.equal(captures().length, baseline);
    await dialog.$("button:nth-of-type(2)").click();
    await browser.waitUntil(async () => !(await dialog.isExisting()));
    assert.deepEqual(captures().slice(baseline), [{ action: "openBrowser", target: externalUrl }]);
  });

  it("rejects stale source grants and forbidden targets at the Native boundary", async () => {
    const frame = await source();
    const sourceUrl = await frame.getAttribute("src");
    assert.ok(sourceUrl);
    const baseline = captures().length;
    const failures = await browser.executeAsync((sourceUrl, done) => {
      const api = (window as unknown as MainNative).__TAURI_INTERNALS__;
      void (async () => {
        const snapshot = (await api.invoke("get_knowledge_tree")) as {
          workspaceId: string;
          viewId: string;
        };
        const args = { workspaceId: snapshot.workspaceId, viewId: snapshot.viewId, sourceUrl };
        const rejected: boolean[] = [];
        for (const href of [
          "file:///outside.html",
          "mailto:test@example.com",
          sourceUrl.replace("01-Welcome.html", "%2e%2e/outside.html"),
        ]) {
          try {
            await api.invoke("open_external_document_link", { ...args, href });
            rejected.push(false);
          } catch {
            rejected.push(true);
          }
        }
        try {
          await api.invoke("open_external_document_link", {
            ...args,
            viewId: "stale-view",
            href: "https://example.com/",
          });
          rejected.push(false);
        } catch {
          rejected.push(true);
        }
        done(rejected);
      })().catch((error) => done([String(error)]));
    }, sourceUrl);
    assert.deepEqual(failures, [true, true, true, true]);
    assert.equal(captures().length, baseline);
  });
});
