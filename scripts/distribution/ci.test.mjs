import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  cargoBuildArguments,
  ciBuildEnvironment,
  privateTimingReport,
  rustCacheKey,
  rustCachePaths,
  writeCiTimings,
} from "./ci.mjs";
import { macUpdaterBuildPlan, windowsUpdaterBuildPlan } from "./build.mjs";

test("only Actions builds use two Rust jobs and Cargo timings; local plans retain one", () => {
  assert.deepEqual(cargoBuildArguments(), ["--locked", "--jobs", "1"]);
  assert.deepEqual(cargoBuildArguments({ CI: "true" }), cargoBuildArguments());
  const args = cargoBuildArguments({ GITHUB_ACTIONS: "true" });
  assert.deepEqual(args, ["--locked", "--jobs", "2", "--timings"]);
  for (const target of ["x86_64-apple-darwin", "aarch64-apple-darwin"])
    assert.deepEqual(macUpdaterBuildPlan(target, {}, args).build.slice(-5), ["--", ...args]);
  assert.deepEqual(windowsUpdaterBuildPlan({}, args).build.slice(-5), ["--", ...args]);
  assert.deepEqual(windowsUpdaterBuildPlan({}).build.slice(-3), ["--locked", "--jobs", "1"]);
});

test("CI temp roots are stable despite dynamic OS temp paths and external flags stay rejected", () => {
  const repository = path.resolve("fixture-repository"),
    home = path.resolve("fixture-home");
  const runner = path.resolve("fixture-runner-temp");
  const base = { GITHUB_ACTIONS: "true", RUNNER_TEMP: runner };
  const first = ciBuildEnvironment({ ...base, TMPDIR: "/var/folders/first/T" }, repository, home);
  const second = ciBuildEnvironment({ ...base, TMPDIR: "/var/folders/other/T" }, repository, home);
  assert.equal(first.TMPDIR, second.TMPDIR);
  assert.equal(first.TMP, first.TMPDIR);
  assert.equal(first.TEMP, first.TMPDIR);
  assert.equal(first.CARGO_TARGET_DIR, path.join(repository, "src-tauri/target"));
  assert.equal(Object.hasOwn(first, "CARGO_ENCODED_RUSTFLAGS"), false);
  for (const name of ["RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS"])
    assert.throws(
      () => ciBuildEnvironment({ ...base, [name]: "-C target-cpu=native" }, repository, home),
      /external Rust flags/,
    );
  assert.throws(() => ciBuildEnvironment({ ...base, RUNNER_TEMP: "relative" }, repository, home));
  assert.throws(() => ciBuildEnvironment({}, repository, home));
});

test("cache keys separate every native platform, compiler, image, feature, manifest and private prefix", () => {
  const input = {
    platform: "windows-x64",
    rust: "rustc 1.99.0 (fixture)\nhost: x86_64-pc-windows-msvc",
    image: ["windows-2022", "fixture-1"],
    features: ["custom-protocol"],
    remappings: [{ from: "/private/fixture", to: "/mogledge" }],
    inputs: [
      ["Cargo.lock", "one"],
      ["Cargo.toml", "one"],
      ["vendor/wry/lib.rs", "one"],
    ],
  };
  const key = rustCacheKey(input);
  assert.match(key, /^mogledge-rust-v1-windows-x64-release-[a-f0-9]{64}$/);
  assert.equal(key.includes("private"), false);
  for (const changes of [
    { platform: "macos-arm64" },
    { platform: "macos-x64" },
    { rust: input.rust + "\ncommit-hash: changed" },
    { image: ["windows-2022", "fixture-2"] },
    { features: [...input.features, "distribution-updater"] },
    { remappings: [{ from: "/different/fixture", to: "/mogledge" }] },
    ...input.inputs.map((_, index) => ({
      inputs: input.inputs.map((entry, i) => (i === index ? [entry[0], "changed"] : entry)),
    })),
  ])
    assert.notEqual(rustCacheKey({ ...input, ...changes }), key);
  assert.throws(() => rustCacheKey({ ...input, rust: "rustc other" }));
  assert.throws(() => rustCacheKey({ ...input, platform: "linux-x64" }));
});

test("cache allowlist retains host/target dependencies but excludes candidate bundles and credentials", () => {
  const cargo = path.resolve("fixture-cargo"),
    target = path.resolve("fixture-target");
  for (const [triple, native] of [
    ["x86_64-pc-windows-msvc", true],
    ["x86_64-pc-windows-msvc", false],
    ["x86_64-apple-darwin", false],
    ["aarch64-apple-darwin", false],
  ]) {
    const paths = rustCachePaths(cargo, target, triple, native);
    assert.ok(paths.includes(path.join(target, "release/deps")));
    assert.equal(paths.includes(path.join(target, triple, "release/deps")), !native);
    assert.equal(paths.includes(cargo) || paths.includes(target), false);
    for (const cached of paths)
      assert.doesNotMatch(cached, /credentials|\.tools|bundle|nsis|incremental|\*/);
  }
});

test("timing HTML redacts literal/JSON build paths and rejects unknown personal paths", () => {
  const maps = [
    { from: "C:\\Users\\fixture", to: "/build/home" },
    { from: "C:\\Users\\fixture\\project", to: "/mogledge" },
    { from: "/private/fixture", to: "/mogledge" },
  ];
  const text = `<p>C:\\Users\\fixture\\project\\src\\lib.rs</p><script>${JSON.stringify({ path: "C:\\Users\\fixture\\project\\src\\lib.rs" })}</script>/private/fixture/src/main.rs`;
  const safe = privateTimingReport(text, maps);
  assert.equal(safe.includes("fixture"), false);
  assert.ok(safe.includes("/mogledge"));
  for (const privatePath of ["/Users/other/source", JSON.stringify("C:\\Users\\other\\source")])
    assert.throws(() => privateTimingReport(privatePath, maps), /personal-directory/);
});

test("separate timing output carries safe measurements without changing candidate contents", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mogledge-ci-timing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "target/cargo-timings"), { recursive: true });
  await writeFile(
    path.join(root, "target/cargo-timings/cargo-timing.html"),
    "<p>/private/fixture/main.rs</p>",
  );
  const metrics = { cargoJobs: 2, cache: "miss", phases: [{ phase: "compile", seconds: 10 }] };
  await writeCiTimings(
    path.join(root, "performance"),
    path.join(root, "target"),
    [{ from: "/private/fixture", to: "/mogledge" }],
    metrics,
  );
  assert.deepEqual(
    JSON.parse(await readFile(path.join(root, "performance/build.json"), "utf8")),
    metrics,
  );
  assert.equal(
    await readFile(path.join(root, "performance/cargo-timing.html"), "utf8"),
    "<p>/mogledge/main.rs</p>",
  );
});

test("cache cannot precede source approval or save a failed/non-main candidate", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/binary-distribution.yml", import.meta.url),
    "utf8",
  );
  assert.ok(
    workflow.indexOf("Verify approved source") < workflow.indexOf("Prepare approved Rust cache"),
  );
  assert.ok(
    workflow.indexOf("Prepare approved Rust cache") <
      workflow.indexOf("uses: actions/cache/restore@"),
  );
  assert.match(
    workflow,
    /if: success\(\) && github.ref == 'refs\/heads\/main' && steps.rust-cache.outputs.cache-hit != 'true'\s+uses: actions\/cache\/save@[a-f0-9]{40}/,
  );
  assert.doesNotMatch(workflow, /restore-keys:|pull_request:|secrets\./);
  assert.match(workflow, /path: \.tools\/distribution\/output\/\*/);
  assert.match(workflow, /path: \.tools\/distribution\/performance\/\*/);
});

test("a wrong approved source exits before exporting cache paths or build environment", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mogledge-ci-reject-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("ci.mjs", import.meta.url)),
      process.platform === "win32"
        ? "windows-x64"
        : process.arch === "arm64"
          ? "macos-arm64"
          : "macos-x64",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_ACTIONS: "true",
        EXPECTED_SOURCE_SHA: "a".repeat(40),
        GITHUB_SHA: "a".repeat(40),
        GITHUB_ENV: path.join(root, "env"),
        GITHUB_OUTPUT: path.join(root, "output"),
      },
    },
  );
  assert.notEqual(result.status, 0);
  await assert.rejects(readFile(path.join(root, "env")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(root, "output")), { code: "ENOENT" });
});
