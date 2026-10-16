import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  legacyAssets,
  exists,
  legacyLaunchAgent,
  requireCandidate,
  requireContained,
  requireHostedRunner,
  requireMacArchiveEntries,
} from "./native-probe.mjs";

const source = "a".repeat(40);
const environment = {
  GITHUB_ACTIONS: "true",
  CI: "true",
  RUNNER_ENVIRONMENT: "github-hosted",
  RUNNER_OS: "Windows",
  RUNNER_ARCH: "X64",
  RUNNER_TEMP: "/runner/temporary",
  RUNNER_NAME: "hosted-test",
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_REPOSITORY: "shimi-lynx/mogledge",
  EXPECTED_SOURCE_SHA: source,
  GITHUB_SHA: source,
  EXPECTED_VERSION: "0.10.0",
};
const config = {
  identifier: "com.shimilynx.mogledge",
  productName: "Mogledge",
  mainBinaryName: "mogledge",
  version: "0.10.0",
};
const candidate = {
  ...config,
  sourceSha: source,
  platform: "windows-x64",
  updater: true,
  executableSha256: "b".repeat(64),
  updateArchiveSha256: "c".repeat(64),
  updateArchive: "Mogledge_0.10.0_windows-x64_unsigned_updater_aaaaaaaaaaaa-setup.exe",
};

test("Native probes accept only the matching disposable hosted runner", () => {
  requireHostedRunner(environment, "windows-x64", "win32", "x64");
  requireHostedRunner(
    { ...environment, RUNNER_OS: "macOS", RUNNER_ARCH: "ARM64" },
    "macos-arm64",
    "darwin",
    "arm64",
  );
  requireHostedRunner({ ...environment, RUNNER_OS: "macOS" }, "macos-x64", "darwin", "x64");
  for (const [key, value] of Object.entries({
    GITHUB_ACTIONS: "false",
    CI: "false",
    RUNNER_ENVIRONMENT: "self-hosted",
    RUNNER_OS: "Linux",
    RUNNER_ARCH: "ARM64",
    RUNNER_TEMP: "",
    RUNNER_NAME: "",
    GITHUB_RUN_ID: "../other",
    GITHUB_RUN_ATTEMPT: "",
    GITHUB_REPOSITORY: "other/repository",
  })) {
    assert.throws(() =>
      requireHostedRunner({ ...environment, [key]: value }, "windows-x64", "win32", "x64"),
    );
  }
  assert.throws(() => requireHostedRunner(environment, "windows-x64", "darwin", "x64"));
  assert.throws(() => requireHostedRunner(environment, "other", "win32", "x64"));
});

test("Candidate execution binds version, identifier and exact approved source", () => {
  requireCandidate(candidate, config, "windows-x64", source, environment);
  for (const changed of [
    { identifier: "com.shimilynx.myknowledge" },
    { version: "0.9.1" },
    { productName: "Other" },
    { sourceSha: "d".repeat(40) },
    { platform: "macos-arm64" },
    { updater: false },
    { executableSha256: "invalid" },
    { updateArchiveSha256: "invalid" },
    { updateArchive: "../setup.exe" },
    { updateArchive: "folder\\setup.exe" },
    { updateArchive: "candidate;other-setup.exe" },
    { updateArchive: "candidate.zip" },
  ]) {
    assert.throws(() =>
      requireCandidate({ ...candidate, ...changed }, config, "windows-x64", source, environment),
    );
  }
  assert.throws(() =>
    requireCandidate(
      candidate,
      { ...config, mainBinaryName: "my-knowledge" },
      "windows-x64",
      source,
      environment,
    ),
  );
  assert.throws(() =>
    requireCandidate(candidate, config, "windows-x64", source, {
      ...environment,
      GITHUB_SHA: "d".repeat(40),
    }),
  );
  assert.throws(() =>
    requireCandidate(candidate, config, "windows-x64", source, {
      ...environment,
      EXPECTED_SOURCE_SHA: "d".repeat(40),
    }),
  );
  assert.throws(() =>
    requireCandidate(candidate, config, "windows-x64", source, {
      ...environment,
      EXPECTED_VERSION: "0.9.1",
    }),
  );
});

test("Fixtures cannot escape or equal the runner temporary root", () => {
  const root = path.resolve("runner-temporary");
  requireContained(root, path.join(root, "exclusive-fixture"));
  for (const target of [root, path.dirname(root), path.resolve("other-fixture"), `${root}-other`]) {
    assert.throws(() => requireContained(root, target));
  }
});

test("Mac archive extraction refuses paths outside the owned bundle", () => {
  requireMacArchiveEntries("Mogledge.app/\nMogledge.app/Contents/MacOS/mogledge\n");
  for (const listing of [
    "",
    "/Mogledge.app",
    "Mogledge.app/../outside",
    "other.app/Contents",
    "Mogledge.app\\outside",
    "Mogledge.app/\0invalid",
  ]) {
    assert.throws(() => requireMacArchiveEntries(listing));
  }
});

test("Legacy LaunchAgent fixture preserves the pinned no-argument plugin template", () => {
  const executable = "/Applications/Mogledge.app/Contents/MacOS/my-knowledge";
  const fixture = legacyLaunchAgent(executable);
  assert.equal(Buffer.byteLength(fixture), 453);
  assert.ok(fixture.includes(`<array><string>${executable}</string></array>`));
  assert.ok(fixture.includes("<key>AssociatedBundleIdentifiers</key>\n  <array></array>"));
  assert.ok(fixture.endsWith("  </dict>\n</plist>"));
  for (const file of [
    "relative/my-knowledge",
    "/Applications/A&B.app/Contents/MacOS/my-knowledge",
    "/Applications/a\nb.app/my-knowledge",
  ])
    assert.throws(() => legacyLaunchAgent(file));
});

test("Profile preflight treats dangling aliases as present", async (context) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "mogledge-probe-guard-"));
  try {
    const ordinary = path.join(fixture, "ordinary");
    await writeFile(ordinary, "synthetic");
    assert.equal(await exists(ordinary), true);
    assert.equal(await exists(path.join(fixture, "missing")), false);
    const alias = path.join(fixture, "alias");
    const target = path.join(fixture, "missing-target");
    await mkdir(target);
    try {
      await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error.code === "EPERM") {
        context.skip("OS does not permit temporary symlink fixtures");
        return;
      }
      throw error;
    }
    await rmdir(target);
    assert.equal(await exists(alias), true);
  } finally {
    requireContained(path.resolve(os.tmpdir()), path.resolve(fixture));
    await rm(fixture, { recursive: true, force: true });
  }
});

test("Legacy executable assets are pinned independently for all three OS architectures", () => {
  assert.deepEqual(Object.keys(legacyAssets).sort(), ["macos-arm64", "macos-x64", "windows-x64"]);
  for (const asset of Object.values(legacyAssets)) {
    assert.match(asset.name, /^Mogledge_0\.9\.1_.*_b07f0bab242a(?:-setup\.exe|\.app\.tar\.gz)$/);
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(new Set(Object.values(legacyAssets).map((asset) => asset.sha256)).size, 3);
});

test("CLI refuses a local environment before reading profiles or candidate output", () => {
  const script = fileURLToPath(new URL("./native-probe.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "windows-x64"], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_ACTIONS: "false" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Disposable matching GitHub-hosted runner required/);
});

test(
  "PowerShell helper parses without executing any Native operations",
  { skip: process.platform !== "win32" },
  () => {
    const script = fileURLToPath(new URL("./native-probe.ps1", import.meta.url));
    // The parser reads source text only. Never dot-source the helper in local tests.
    const result = execFileSync(
      "pwsh",
      [
        "-NoProfile",
        "-Command",
        `$probeTokens=$null; $probeErrors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'", "''")}',[ref]$probeTokens,[ref]$probeErrors); if($probeErrors.Count){exit 1}`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.trim(), "");
  },
);
