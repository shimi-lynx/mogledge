import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";

const withoutDocumentId = (html) =>
  html.replace(/(<meta name="mogledge-document-id" content=")[^"]+("\s*\/>)/, "$1UUID$2");

const assets = ".agents/skills/mogledge-html/assets/";
async function openSample(name, beforeParse = () => {}) {
  const html = await readFile("tests/fixtures/knowledge/Storage/" + name + ".html", "utf8");
  const dom = new JSDOM(html, {
    url: "https://example.test/" + name + ".html",
    runScripts: "dangerously",
    beforeParse(window) {
      window.TextEncoder = TextEncoder;
      beforeParse(window);
    },
  });
  await waitFor(
    () => dom.window.document.querySelector("#status").textContent !== "保存状態を読込中…",
  );
  return dom;
}
async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Sample did not reach expected state");
}
function edit(window, amount, mode, enabled) {
  window.document.querySelector("#amount").value = String(amount);
  window.document.querySelector("#mode").value = mode;
  window.document.querySelector("#enabled").checked = enabled;
  window.document.querySelector("#amount").dispatchEvent(new window.Event("input"));
}

test("standalone generated/converted fixtures exactly match canonical source and template", async () => {
  const directory = await mkdtemp(join(tmpdir(), "knowledge-html-"));
  try {
    for (const name of ["generated", "converted"]) {
      const output = join(directory, name + ".html");
      const result = spawnSync(
        process.execPath,
        ["scripts/build-knowledge-html.mjs", assets + name + "-sample.json", output],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        withoutDocumentId(await readFile(output, "utf8")),
        withoutDocumentId(
          await readFile(
            "tests/fixtures/knowledge/Storage/" +
              (name === "generated" ? "Generated" : "Converted") +
              ".html",
            "utf8",
          ),
        ),
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("both samples save controls and restore before calculation on a new browser page", async () => {
  for (const name of ["Generated", "Converted"]) {
    const first = await openSample(name);
    try {
      edit(first.window, 7, "square", false);
      first.window.document.querySelector("#save").click();
      await waitFor(
        () => first.window.document.querySelector("#status").textContent === "保存済み",
      );
      assert.equal(first.window.document.querySelector("#result").value, "無効");
      const records = Object.entries(first.window.localStorage);
      const second = await openSample(name, (window) => {
        for (const [key, value] of records) window.localStorage.setItem(key, value);
      });
      try {
        assert.equal(second.window.document.querySelector("#amount").value, "7");
        assert.equal(second.window.document.querySelector("#mode").value, "square");
        assert.equal(second.window.document.querySelector("#enabled").checked, false);
        assert.equal(second.window.document.querySelector("#result").value, "無効");
        assert.equal(second.window.document.querySelector("#status").textContent, "復元済み");
      } finally {
        second.window.close();
      }
    } finally {
      first.window.close();
    }
  }
});

test("converted sample explicitly migrates legacy browser fields while retaining the source record", async () => {
  const dom = await openSample("Converted", (window) =>
    window.localStorage.setItem(
      "legacy-calculator-state",
      JSON.stringify({ number: 9, operation: "square", active: true }),
    ),
  );
  try {
    assert.equal(dom.window.document.querySelector("#amount").value, "2");
    dom.window.document.querySelector("#import-legacy").click();
    await waitFor(() => dom.window.document.querySelector("#status").textContent === "保存済み");
    assert.equal(dom.window.document.querySelector("#result").value, "81");
    assert.ok(dom.window.localStorage.getItem("legacy-calculator-state"));
  } finally {
    dom.window.close();
  }
});

test("Native samples calculate after failed restore, disable saving/migration and never touch localStorage", async () => {
  for (const name of ["Generated", "Converted"]) {
    for (const descriptor of ["__MOGLEDGE_STORAGE_V1__", "__MY_KNOWLEDGE_STORAGE_V1__"]) {
      let accesses = 0;
      const dom = await openSample(name, (window) => {
        window[descriptor] = Object.freeze({ version: 1, available: false });
        Object.defineProperty(window, "localStorage", {
          get() {
            accesses++;
            throw new Error("Unexpected fallback");
          },
        });
      });
      try {
        edit(dom.window, 8, "double", true);
        assert.equal(dom.window.document.querySelector("#result").value, "16");
        assert.equal(dom.window.document.querySelector("#save").disabled, true);
        assert.match(
          dom.window.document.querySelector("#status").textContent,
          /storage_unavailable/,
        );
        assert.equal(accesses, 0);
        if (name === "Converted")
          assert.equal(dom.window.document.querySelector("#import-legacy").disabled, true);
      } finally {
        dom.window.close();
      }
    }
  }
});

test("schema mismatch never overwrites persisted state through initialization or an input event", async () => {
  for (const descriptor of ["__MOGLEDGE_STORAGE_V1__", "__MY_KNOWLEDGE_STORAGE_V1__"]) {
    let writes = 0;
    const dom = await openSample("Generated", (window) => {
      window[descriptor] = Object.freeze({
        version: 1,
        available: true,
        endpoint: "http://127.0.0.1:1234/token/storage",
      });
      window.fetch = async (_, options) => {
        if (JSON.parse(options.body).op === "write") writes++;
        return {
          ok: true,
          json: async () => ({
            version: 1,
            value: { schemaVersion: 2, data: { amount: 77 } },
            revision: 1,
          }),
        };
      };
    });
    try {
      edit(dom.window, 8, "double", true);
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(writes, 0);
      assert.match(dom.window.document.querySelector("#status").textContent, /schema_mismatch/);
      assert.equal(dom.window.document.querySelector("#save").disabled, true);
    } finally {
      dom.window.close();
    }
  }
});

test("conversion preserves legacy calculation and control behavior", async () => {
  const legacyHtml = await readFile(assets + "legacy-localstorage.html", "utf8");
  const legacy = new JSDOM(legacyHtml, {
    url: "https://example.test/Legacy.html",
    runScripts: "dangerously",
  });
  const converted = await openSample("Converted");
  try {
    for (const [amount, mode, enabled] of [
      [2, "double", true],
      [7.5, "square", true],
      [0, "double", false],
    ]) {
      edit(legacy.window, amount, mode, enabled);
      edit(converted.window, amount, mode, enabled);
      assert.equal(
        converted.window.document.querySelector("#result").value,
        legacy.window.document.querySelector("#result").value,
      );
    }
  } finally {
    legacy.window.close();
    converted.window.close();
  }
});
