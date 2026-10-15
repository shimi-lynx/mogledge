import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";

const fixtureId = "b3bc5d6c-a021-40aa-9006-c5546af018ae";
const source = { title: "Generator fixture", body: "<p>Fixture</p>", script: "" };
async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), "mogledge-generator-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function generate(input, output) {
  return spawnSync(process.execPath, ["scripts/build-knowledge-html.mjs", input, output], {
    encoding: "utf8",
  });
}
function documentId(html) {
  const dom = new JSDOM(html);
  try {
    const elements = dom.window.document.querySelectorAll('meta[name="mogledge-document-id"]');
    assert.equal(elements.length, 1);
    return elements[0].getAttribute("content");
  } finally {
    dom.window.close();
  }
}

test("new independent outputs receive fresh v4 UUIDs; regeneration preserves identity", async (t) => {
  const directory = await workspace(t);
  const input = join(directory, "source.json");
  const output = join(directory, "output.html");
  const second = join(directory, "second.html");
  await writeFile(input, JSON.stringify(source));
  for (const path of [output, second]) {
    const result = generate(input, path);
    assert.equal(result.status, 0, result.stderr);
  }
  const firstId = documentId(await readFile(output, "utf8"));
  assert.match(firstId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(documentId(await readFile(second, "utf8")), firstId);
  await writeFile(input, JSON.stringify({ ...source, title: "Updated document" }));
  const result = generate(input, output);
  assert.equal(result.status, 0, result.stderr);
  const updated = await readFile(output, "utf8");
  assert.equal(documentId(updated), firstId);
  assert.match(updated, /<title>Updated document<\/title>/);
  for (const name of ["generated", "converted"]) {
    const sample = JSON.parse(
      await readFile(`.agents/skills/mogledge-html/assets/${name}-sample.json`, "utf8"),
    );
    assert.equal(sample.documentId, undefined, "Samples must not reuse one fixed document UUID");
  }
});

test("explicit source UUID is retained across new output paths and normalized without version restrictions", async (t) => {
  const directory = await workspace(t);
  const input = join(directory, "source.json");
  const output = join(directory, "output.html");
  const id = "ABCDEFAB-1234-0000-0000-123456ABCDEF";
  await writeFile(input, JSON.stringify({ ...source, documentId: id }));
  const result = generate(input, output);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(documentId(await readFile(output, "utf8")), id.toLowerCase());
});

test("invalid or conflicting existing metadata is refused without modifying the original", async (t) => {
  const directory = await workspace(t);
  const input = join(directory, "source.json");
  const output = join(directory, "output.html");
  await writeFile(input, JSON.stringify({ ...source, documentId: fixtureId }));
  const tag = `<meta name="mogledge-document-id" content="${fixtureId}">`;
  for (const html of [
    "<!doctype html><title>Legacy HTML without metadata</title>",
    '<meta name="mogledge-document-id" content="broken">',
    '<meta name="mogledge-document-id" content="00000000-0000-0000-0000-000000000000">',
    tag + tag,
    '<meta name="mogledge-document-id" content="12345678-1234-1234-1234-123456789abc">',
  ]) {
    await writeFile(output, html);
    const result = generate(input, output);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /documentId|mogledge-document-id/);
    assert.equal(await readFile(output, "utf8"), html);
  }
});

test("invalid source IDs and extra author-supplied metadata cannot overwrite an existing document", async (t) => {
  const directory = await workspace(t);
  const input = join(directory, "source.json");
  const output = join(directory, "output.html");
  const original = `<meta name="mogledge-document-id" content="${fixtureId}">`;
  await writeFile(output, original);
  for (const invalid of [
    { ...source, documentId: null },
    { ...source, documentId: "00000000-0000-0000-0000-000000000000" },
    { ...source, documentId: "{" + fixtureId + "}" },
    { ...source, documentId: " " + fixtureId },
    { ...source, body: `<meta NAME="mogledge-document-id" content="${fixtureId}">` },
  ]) {
    await writeFile(input, JSON.stringify(invalid));
    const result = generate(input, output);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /documentId|mogledge-document-id/);
    assert.equal(await readFile(output, "utf8"), original);
  }
});
