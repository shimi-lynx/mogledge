// One-run diagnostics of approved existing artifacts; never builds an application.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { requireHostedRunner } from "./native-probe.mjs";

const platform = process.argv[2];
requireHostedRunner(process.env, platform);
const source = "9808a5eaa2cb90ba5f757ac59a1c1d662161430d";
const pins = {
  "windows-x64": [
    12047537683,
    27789182,
    "8b56a854443123c505da1c1c8a9144bf200d73f5a3031ea746cbc08f8e534df6",
  ],
  "macos-arm64": [
    12045787238,
    52144061,
    "39aabcfd7e6294b6400f466756b695abb27678e03316128fbc802364a2c2c371",
  ],
};
const [id, size, digest] = pins[platform] ?? [];
if (!id || process.env.PROBE_EXISTING_SOURCE_SHA !== source)
  throw new Error("Unapproved diagnostic artifact");
const api = (route) =>
  JSON.parse(
    execFileSync("gh", ["api", `repos/shimi-lynx/mogledge/${route}`], { encoding: "utf8" }),
  );
const run = api("actions/runs/38904737219");
const artifact = api(`actions/artifacts/${id}`);
if (
  run.head_sha !== source ||
  run.head_branch !== "main" ||
  run.event !== "workflow_dispatch" ||
  run.path !== ".github/workflows/binary-distribution.yml" ||
  run.repository.id !== 1416386985 ||
  artifact.name !== `Mogledge-${platform}-${source}` ||
  artifact.expired ||
  artifact.size_in_bytes !== size ||
  artifact.digest !== `sha256:${digest}` ||
  artifact.workflow_run.id !== 38904737219 ||
  artifact.workflow_run.head_sha !== source
)
  throw new Error("Existing artifact provenance changed");
const raw = execFileSync(
  "gh",
  ["api", `repos/shimi-lynx/mogledge/actions/artifacts/${id}/zip`, "--allow-escape-sequences"],
  { maxBuffer: 128 * 1024 * 1024 },
);
if (raw.length !== size || createHash("sha256").update(raw).digest("hex") !== digest)
  throw new Error("Existing artifact bytes changed");
const archive = path.join(process.env.RUNNER_TEMP, `approved-candidate-${platform}.zip`);
await writeFile(archive, raw, { flag: "wx" });
const prefix = `Mogledge_0.10.0_${platform}_${platform === "windows-x64" ? "unsigned" : "adhoc"}_updater_${source.slice(0, 12)}`;
const expected = [
  "manifest.json",
  "SHA256SUMS.txt",
  `${prefix}.zip`,
  prefix + (platform === "windows-x64" ? "-setup.exe" : ".app.tar.gz"),
].sort();
const entries = execFileSync("tar", ["-tf", archive], { encoding: "utf8" })
  .trim()
  .split(/\r?\n/)
  .sort();
if (JSON.stringify(entries) !== JSON.stringify(expected))
  throw new Error("Existing artifact layout changed");
const output = path.resolve(".tools/distribution/output");
await mkdir(output, { recursive: true });
execFileSync("tar", ["-xf", archive, "-C", output]);
console.log(`Reused approved ${platform} candidate ${id}; no application build`);
