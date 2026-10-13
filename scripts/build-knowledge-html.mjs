import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const [sourcePath, outputPath] = process.argv.slice(2);
if (!sourcePath || !outputPath || process.argv.length !== 4) {
  console.error("Usage: node scripts/build-knowledge-html.mjs <source.json> <output.html>");
  process.exitCode = 1;
} else {
  const assets = new URL("../.agents/skills/my-knowledge-html/assets/", import.meta.url);
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
  const escapeText = (text) =>
    text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const inlineScript = (text) => text.replace(/<\/script/gi, "<\\/script");
  const values = {
    TITLE: escapeText(source.title),
    STYLE: (source.style || "").replace(/<\/style/gi, "<\\/style"),
    BODY: source.body,
    ADAPTER: inlineScript(adapter),
    EXPORT: inlineScript(exportAdapter),
    SCRIPT: inlineScript(source.script),
  };
  await writeFile(
    resolve(outputPath),
    template.replace(
      /(?:<!--MY_KNOWLEDGE_(TITLE|BODY)-->|\/\*MY_KNOWLEDGE_(STYLE|ADAPTER|EXPORT|SCRIPT)\*\/)/g,
      (_, htmlName, scriptName) => values[htmlName || scriptName],
    ),
    "utf8",
  );
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
