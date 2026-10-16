import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertBinaryPrivacy, pathRemappings, remappedBuildEnvironment } from "./privacy.mjs";

export function cargoBuildArguments(environment = {}) {
  const ci = environment.GITHUB_ACTIONS === "true";
  return ["--locked", "--jobs", ci ? "2" : "1", ...(ci ? ["--timings"] : [])];
}

export function ciBuildEnvironment(environment, repository, home = os.homedir()) {
  if (environment.GITHUB_ACTIONS !== "true" || !path.isAbsolute(environment.RUNNER_TEMP ?? ""))
    throw new Error("Expected a hosted Actions temporary directory");
  if (environment.RUSTFLAGS || environment.CARGO_ENCODED_RUSTFLAGS)
    throw new Error("Distribution builds require unset external Rust flags");
  const temporary = path.join(environment.RUNNER_TEMP, "mogledge-rust-tmp");
  return {
    ...environment,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    CARGO_HOME: path.resolve(environment.CARGO_HOME || path.join(home, ".cargo")),
    CARGO_TARGET_DIR: path.join(repository, "src-tauri/target"),
  };
}

export function rustCacheKey({ platform, rust, image, features, remappings, inputs }) {
  if (!/^(windows-x64|macos-arm64|macos-x64)$/.test(platform) || !rust.startsWith("rustc 1.99.0 "))
    throw new Error("Unexpected Rust cache platform/toolchain");
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ rust, image, features, profile: "release", remappings, inputs }))
    .digest("hex");
  return `mogledge-rust-v1-${platform}-release-${fingerprint}`;
}

export function rustCachePaths(cargoHome, targetDirectory, target, nativeTarget) {
  const paths = ["registry/index", "registry/cache", "registry/src", "git/db", "git/checkouts"].map(
    (relative) => path.join(cargoHome, relative),
  );
  // Host build scripts/proc macros and explicit-target dependencies are distinct.
  // Never cache the whole target, bundles, NSIS, .tools or Cargo credentials.
  for (const release of new Set([
    path.join(targetDirectory, "release"),
    ...(nativeTarget ? [] : [path.join(targetDirectory, target, "release")]),
  ]))
    for (const directory of [".fingerprint", "build", "deps"])
      paths.push(path.join(release, directory));
  return paths;
}

export function privateTimingReport(text, remappings) {
  for (const { from, to } of [...remappings].reverse()) {
    // Cargo embeds JSON in HTML; handle both literal and JSON-escaped prefixes.
    text = text.replaceAll(JSON.stringify(from).slice(1, -1), to).replaceAll(from, to);
  }
  assertBinaryPrivacy(
    Buffer.from(text.replaceAll("\\\\", "\\").replaceAll("\\/", "/")),
    remappings,
  );
  return text;
}

export async function writeCiTimings(directory, targetDirectory, remappings, measurements) {
  await mkdir(directory);
  const report = await readFile(
    path.join(targetDirectory, "cargo-timings/cargo-timing.html"),
    "utf8",
  );
  await writeFile(
    path.join(directory, "cargo-timing.html"),
    privateTimingReport(report, remappings),
  );
  await writeFile(path.join(directory, "build.json"), `${JSON.stringify(measurements, null, 2)}\n`);
}

async function prepare(platform, updaterApp) {
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  const { platforms, requireApprovedSource } = await import("./build.mjs");
  const selected = platforms[platform];
  if (!selected || selected.os !== process.platform || selected.arch !== process.arch)
    throw new Error("Use the matching native runner");
  const git = (...args) => execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
  requireApprovedSource(
    git("rev-parse", "HEAD"),
    process.env.EXPECTED_SOURCE_SHA,
    process.env.GITHUB_SHA,
  );
  if (git("status", "--porcelain", "--untracked-files=no"))
    throw new Error("Expected clean source");
  const environment = ciBuildEnvironment(process.env, repository);
  const rust = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).trim();
  const remappings = pathRemappings({
    home: os.homedir(),
    temporary: environment.TMPDIR,
    cargo: environment.CARGO_HOME,
    repository,
    target: environment.CARGO_TARGET_DIR,
    sysroot: execFileSync("rustc", ["--print", "sysroot"], { encoding: "utf8" }).trim(),
  });
  // Validate flags before restoring compiled code. The builder regenerates them;
  // exporting encoded flags here would defeat its external-override rejection.
  remappedBuildEnvironment(environment, remappings);
  const files = git(
    "ls-files",
    "-z",
    "rust-toolchain.toml",
    "package-lock.json",
    ".cargo",
    "src-tauri/.cargo",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
    "src-tauri/build.rs",
    "src-tauri/tauri.conf.json",
    "src-tauri/tauri.updater.distribution.json",
    "src-tauri/vendor/wry",
    "scripts/distribution/build.mjs",
    "scripts/distribution/privacy.mjs",
    "scripts/distribution/ci.mjs",
    ".github/workflows/binary-distribution.yml",
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  const inputs = [];
  for (const file of files)
    inputs.push([
      file,
      createHash("sha256")
        .update(await readFile(path.join(repository, file)))
        .digest("hex"),
    ]);
  const key = rustCacheKey({
    platform,
    rust,
    image: [process.env.ImageOS ?? "", process.env.ImageVersion ?? ""],
    features: updaterApp ? ["custom-protocol", "distribution-updater"] : ["custom-protocol"],
    remappings,
    inputs,
  });
  const paths = rustCachePaths(
    environment.CARGO_HOME,
    environment.CARGO_TARGET_DIR,
    selected.target,
    updaterApp && selected.os === "win32",
  );
  await mkdir(environment.TMPDIR, { recursive: true });
  const names = ["TMPDIR", "TMP", "TEMP", "CARGO_HOME", "CARGO_TARGET_DIR"];
  await appendFile(
    process.env.GITHUB_ENV,
    names.map((name) => `${name}=${environment[name]}\n`).join("") +
      `MOGLEDGE_RUST_CACHE_KEY=${key}\n`,
  );
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `key=${key}\npaths<<MOGLEDGE_CACHE_PATHS\n${paths.join("\n")}\nMOGLEDGE_CACHE_PATHS\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 4 || (process.argv[3] && process.argv[3] !== "--updater-app"))
    throw new Error("Usage: node scripts/distribution/ci.mjs <platform> [--updater-app]");
  prepare(process.argv[2], process.argv[3] === "--updater-app").catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
