import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectNotices } from "./notices.mjs";

const [metadataFile, outputDirectory, ...extra] = process.argv.slice(2);
if (!metadataFile || !outputDirectory || extra.length)
  throw new Error(
    "Usage: node scripts/distribution/diagnose.mjs <metadata.json> <new-output-directory>",
  );
const repo = fileURLToPath(new URL("../../", import.meta.url));
const destination = path.resolve(outputDirectory);
// A diagnosis contains partial material and must never be reused as candidate staging.
await mkdir(destination);
const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
const { inventory, failures } = await collectNotices(repo, destination, metadata, {
  diagnostic: true,
});
for (const ecosystem of ["npm", "cargo"]) {
  const passed = inventory.filter((pkg) => pkg.ecosystem === ecosystem).length;
  const blocked = failures.filter((pkg) => pkg.ecosystem === ecosystem).length;
  console.log(`${ecosystem}: ${passed} passed, ${blocked} blocked`);
}
if (failures.length) process.exitCode = 1;
