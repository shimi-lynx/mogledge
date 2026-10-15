import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { JSDOM } from "jsdom";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validateDocumentId(value) {
  if (
    typeof value !== "string" ||
    !uuidPattern.test(value) ||
    value === "00000000-0000-0000-0000-000000000000"
  )
    throw new Error("documentId must be a canonical non-nil UUID");
  return value.toLowerCase();
}
function readDocumentId(html) {
  const dom = new JSDOM(html);
  try {
    const metadata = [...dom.window.document.querySelectorAll("meta")].filter(
      (element) => element.getAttribute("name")?.toLowerCase() === "mogledge-document-id",
    );
    if (metadata.length !== 1)
      throw new Error(
        "HTML requires exactly one mogledge-document-id meta element; preserve the original and resolve its identity explicitly",
      );
    return validateDocumentId(metadata[0].getAttribute("content"));
  } finally {
    dom.window.close();
  }
}

const [sourcePath, outputPath] = process.argv.slice(2);
if (!sourcePath || !outputPath || process.argv.length !== 4) {
  console.error("Usage: node scripts/build-knowledge-html.mjs <source.json> <output.html>");
  process.exitCode = 1;
} else {
  const assets = new URL("../.agents/skills/mogledge-html/assets/", import.meta.url);
  const [sourceText, template, adapter, exportAdapter] = await Promise.all([
    readFile(resolve(sourcePath), "utf8"),
    readFile(fileURLToPath(new URL("template.html", assets)), "utf8"),
    readFile(fileURLToPath(new URL("storage.js", assets)), "utf8"),
    readFile(fileURLToPath(new URL("export.js", assets)), "utf8"),
  ]);
  const source = JSON.parse(sourceText);
  for (const field of ["title", "body", "script"])
    if (typeof source[field] !== "string") throw new Error("Source requires string " + field);
  if (source.style !== undefined && typeof source.style !== "string")
    throw new Error("Source style must be a string");
  let existingDocumentId;
  try {
    existingDocumentId = readDocumentId(await readFile(resolve(outputPath), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const documentId =
    source.documentId === undefined
      ? existingDocumentId || randomUUID()
      : validateDocumentId(source.documentId);
  if (existingDocumentId && existingDocumentId !== documentId)
    throw new Error(
      "documentId differs from existing output; preserve its UUID or choose a new output for an independent document",
    );
  const escapeText = (text) =>
    text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const inlineScript = (text) => text.replace(/<\/script/gi, "<\\/script");
  const values = {
    DOCUMENT_ID: documentId,
    TITLE: escapeText(source.title),
    STYLE: (source.style || "").replace(/<\/style/gi, "<\\/style"),
    BODY: source.body,
    ADAPTER: inlineScript(adapter),
    EXPORT: inlineScript(exportAdapter),
    SCRIPT: inlineScript(source.script),
  };
  const html = template.replace(
    /(?:<!--MY_KNOWLEDGE_(TITLE|BODY|DOCUMENT_ID)-->|\/\*MY_KNOWLEDGE_(STYLE|ADAPTER|EXPORT|SCRIPT)\*\/)/g,
    (_, htmlName, scriptName) => values[htmlName || scriptName],
  );
  // Validate the complete author-supplied body too, before touching an existing output.
  if (readDocumentId(html) !== documentId) throw new Error("Generated HTML documentId changed");
  await writeFile(resolve(outputPath), html, "utf8");
  // Use the repo's existing formatter; the generated HTML has no runtime dependency on it.
  const formatted = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../node_modules/vite-plus/bin/vp", import.meta.url)),
      "fmt",
      resolve(outputPath),
    ],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" },
  );
  if (formatted.error || formatted.status !== 0)
    throw new Error(formatted.error?.message || formatted.stderr || "HTML formatting failed");
}
