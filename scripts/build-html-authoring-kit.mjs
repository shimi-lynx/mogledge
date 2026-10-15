import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// This developer generator only touches the four bundled app resources. It
// never accepts a user workspace path or installs skills into an author's root.
const repo = new URL("../", import.meta.url);
const asset = new URL(".agents/skills/my-knowledge-html/assets/", repo);
const source = new URL(".agents/skills/my-knowledge-html/kit/", repo);
const output = new URL("src-tauri/html-authoring-kit/", repo);
if (process.argv.length !== 2) throw new Error("Usage: node scripts/build-html-authoring-kit.mjs");
await mkdir(output, { recursive: true });
const hash = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const [adapter, exportAdapter, template, api, exportApi, guide, skill] = await Promise.all([
  readFile(new URL("storage.js", asset), "utf8"),
  readFile(new URL("export.js", asset), "utf8"),
  readFile(new URL("template.html", asset), "utf8"),
  readFile(new URL("docs/document-storage.md", repo), "utf8"),
  readFile(new URL("docs/html-artifact-export.md", repo), "utf8"),
  readFile(new URL("guide.md", source), "utf8"),
  readFile(new URL("skill.md", source), "utf8"),
]);
const provenance = `<!-- Generated kitVersion=2 storageAPI=1 adapterSHA256=${hash(adapter)} canonicalTemplateSHA256=${hash(template)} apiSpecSHA256=${hash(api)} exportAPI=1 exportAdapterSHA256=${hash(exportAdapter)} exportApiSpecSHA256=${hash(exportApi)} -->`;
for (const [file, content] of [
  ["guide.md", guide],
  ["codex-skill.md", skill],
  ["claude-skill.md", skill],
]) {
  if (!content.includes("{{PROVENANCE}}"))
    throw new Error("Missing kit provenance marker: " + file);
  await writeFile(new URL(file, output), content.replace("{{PROVENANCE}}", provenance), "utf8");
}
// Reuse canonical HTML assembly and its formatter. Only developer generation
// needs Node/dependencies; all installed outputs are complete text or HTML.
const temporary = await mkdtemp(join(tmpdir(), "mogledge-kit-"));
try {
  const generated = join(temporary, "template.html");
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("scripts/build-knowledge-html.mjs", repo)),
      fileURLToPath(new URL("generated-sample.json", asset)),
      generated,
    ],
    { cwd: fileURLToPath(repo), encoding: "utf8" },
  );
  if (result.error || result.status !== 0)
    throw new Error(result.error?.message || result.stderr || "Kit template generation failed");
  // A shared kit template must not silently give all copied documents one UUID.
  // Authors replace this deliberately invalid marker before Native saving.
  const html = (await readFile(generated, "utf8")).replace(
    /(<meta name="mogledge-document-id" content=")[^"]+("\s*\/>)/,
    "$1REPLACE_WITH_NEW_UUID$2",
  );
  if (!html.includes('content="REPLACE_WITH_NEW_UUID"'))
    throw new Error("Kit document ID placeholder was not inserted");
  await writeFile(new URL("template.html", output), html, "utf8");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
