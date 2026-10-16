import { browser } from "@wdio/globals";
import { resolve } from "node:path";
import {
  cpSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  readFileSync,
  lstatSync,
  rmSync,
} from "node:fs";

const cloudRoot = process.env.MOGLEDGE_CLOUD_FIXTURE_ROOT;
if (cloudRoot) {
  if (process.platform !== "win32" || process.env.MOGLEDGE_BENCH_ROOT)
    throw new Error("Cloud fixture tests require Windows and cannot be combined with benchmarks");
  if (!lstatSync(cloudRoot).isDirectory() || lstatSync(cloudRoot).isSymbolicLink())
    throw new Error("Cloud fixture must be an ordinary dedicated directory");
  const marker = resolve(cloudRoot, ".mogledge-cloud-fixture");
  if (!lstatSync(marker).isFile() || lstatSync(marker).isSymbolicLink())
    throw new Error("Cloud fixture marker must be a regular file");
  if (readFileSync(marker, "utf8") !== "MOGLEDGE_DISPOSABLE_CLOUD_FIXTURE_V1\n")
    throw new Error(
      "Cloud fixture must have the disposable-fixture marker; see docs/onedrive-qa.md",
    );
}
const fixtureRoot = cloudRoot || process.env.MOGLEDGE_BENCH_ROOT || resolve(".tools/e2e-knowledge");
// Only the dedicated fixture run receives mutation cleanup or OS capture.
const mutationFixture =
  !cloudRoot && !process.env.MOGLEDGE_BENCH_ROOT && !process.env.MOGLEDGE_TEST_BINARY;
if (!cloudRoot) {
  mkdirSync(fixtureRoot, { recursive: true });
  if (mutationFixture)
    for (const name of ["Live.html", "Live.tmp", "Renamed.html"]) {
      const path = resolve(fixtureRoot, name);
      if (existsSync(path)) unlinkSync(path);
    }
  if (!process.env.MOGLEDGE_BENCH_ROOT)
    cpSync(resolve("tests/fixtures/knowledge"), fixtureRoot, { recursive: true });
}
if (mutationFixture && !process.env.WDIO_WORKER_ID)
  for (const name of ["MutationSource", "MutationTarget", "A"])
    rmSync(resolve(fixtureRoot, name), { recursive: true, force: true });
process.env.MOGLEDGE_E2E_ROOT = fixtureRoot;
// Capture only fixture-enabled runs. Production/custom binaries
// never receive an OS-action capture variable, and their side-effect test skips.
if (mutationFixture) {
  const capture = resolve(".tools/e2e-file-actions.jsonl");
  if (!process.env.WDIO_WORKER_ID && existsSync(capture)) unlinkSync(capture);
  process.env.MOGLEDGE_E2E_ACTION_CAPTURE = capture;
} else delete process.env.MOGLEDGE_E2E_ACTION_CAPTURE;

const appBinaryPath =
  process.env.MOGLEDGE_TEST_BINARY ||
  process.env.MOGLEDGE_E2E_BINARY ||
  resolve("src-tauri/target/debug/mogledge" + (process.platform === "win32" ? ".exe" : ""));
export const config = {
  runner: "local",
  specs: [
    resolve(
      cloudRoot
        ? "tests/e2e/windows-cloud.spec.ts"
        : process.env.MOGLEDGE_BENCH_ROOT
          ? "tests/e2e/performance.spec.ts"
          : process.platform === "darwin"
            ? "tests/e2e/mac-viewer.spec.ts"
            : "tests/e2e/viewer.spec.ts",
    ),
    ...(cloudRoot || process.env.MOGLEDGE_BENCH_ROOT ? [] : [resolve("tests/e2e/search.spec.ts")]),
    // These Control-key regressions use the ordinary Windows fixture, not Mac/cloud/bench roots.
    ...(process.platform === "win32" && !cloudRoot && !process.env.MOGLEDGE_BENCH_ROOT
      ? [
          resolve("tests/e2e/ui-search-integration.spec.ts"),
          resolve("tests/e2e/sidebar-reload.spec.ts"),
          resolve("tests/e2e/document-links.spec.ts"),
        ]
      : []),
  ],
  maxInstances: 1,
  logLevel: "warn",
  capabilities: [{ browserName: "tauri", "tauri:options": { application: appBinaryPath } }],
  services: [
    [
      "tauri",
      { appBinaryPath, driverProvider: process.platform === "darwin" ? "embedded" : "external" },
    ],
  ],
  async before() {
    const capture = process.env.MOGLEDGE_E2E_ACTION_CAPTURE;
    if (capture && !existsSync(capture))
      throw new Error("Rebuild with --features e2e: OS-action capture must be ready before tests");
    const handles = await browser.getWindowHandles();
    await browser.switchToWindow(handles[0]);
    await browser.waitUntil(
      async () =>
        Boolean(await browser.execute(() => document.querySelector("meta[data-mogledge-csp]"))),
      { timeoutMsg: "Native UI must install its document-origin CSP before displaying documents" },
    );
  },
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { timeout: 60000 },
  waitforTimeout: 15000,
};
