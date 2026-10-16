import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
export const backendFilters = Object.freeze([
  "identifier_migration::tests::current_profile_",
  "identifier_migration::tests::ordinary_current_profile_is_validated_before_ready_or_database_creation",
  "document_server::storage::tests::canonical_and_legacy_endpoints_require_the_same_exact_token_path",
  "state_transfer::format::tests::",
  "tree_mutations::tests::",
  "watcher::tests::",
  "index::mutation_tests::",
  "resident_startup::tests::",
]);

export function requireApprovedSource(actual, expected, event, dirty = "") {
  if (
    !/^[a-f0-9]{40}$/.test(expected ?? "") ||
    actual !== expected ||
    event !== expected ||
    dirty.trim()
  )
    throw new Error("Expected clean checkout, dispatch and approved source SHA to match");
}

export function requireDiscoveredTests(list, filter) {
  const matches = list
    .split(/\r?\n/)
    .filter((line) => line.endsWith(": test") && line.includes(filter));
  if (!matches.length) throw new Error(`No backend tests discovered for fixed filter: ${filter}`);
  return matches.length;
}

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: repository,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    if (capture) process.stderr.write(result.stderr ?? "");
    throw new Error(`${command} failed (${result.status})`, { cause: result.error });
  }
  return result.stdout ?? "";
}

export function requireHostedTarget(environment = process.env) {
  if (
    environment.GITHUB_ACTIONS !== "true" ||
    environment.RUNNER_ENVIRONMENT !== "github-hosted" ||
    !path.isAbsolute(environment.RUNNER_TEMP ?? "")
  )
    throw new Error("Focused Rust validation runs only on a hosted Actions runner");
  const expected = path.join(environment.RUNNER_TEMP, "mogledge-focused-target");
  if (
    path.resolve(environment.CARGO_TARGET_DIR ?? "") !== expected ||
    environment.CARGO_INCREMENTAL !== "0"
  )
    throw new Error(
      "Focused validation requires its isolated target and disabled incremental cache",
    );
  if (environment.RUSTFLAGS || environment.CARGO_ENCODED_RUSTFLAGS)
    throw new Error("External Rust flags are not accepted");
}

function verifyBackend() {
  requireHostedTarget();
  // macOS system temp may pass through /var -> /private/var. Fixtures must use
  // a physical runner directory rather than weakening production nofollow guards.
  const temporary = realpathSync(process.env.RUNNER_TEMP);
  for (const name of ["TMPDIR", "TMP", "TEMP"]) process.env[name] = temporary;
  const common = ["--locked", "--manifest-path", "tests/backend/Cargo.toml", "--jobs", "1"];
  run("cargo", ["fmt", "--manifest-path", "src-tauri/Cargo.toml", "--check"]);
  run("cargo", ["fmt", "--manifest-path", "tests/backend/Cargo.toml", "--check"]);
  // A renamed filter must not silently pass zero tests.
  const listing = run("cargo", ["test", ...common, "--lib", "--", "--list"], true);
  for (const filter of backendFilters) {
    const count = requireDiscoveredTests(listing, filter);
    console.log(`Running fixed backend filter ${filter} (${count} discovered tests)`);
    run("cargo", ["test", ...common, "--lib", filter, "--", "--test-threads=1"]);
  }
  const fixtureFilter =
    "tests::formal_ids_and_ambiguous_identifiers_are_rejected_before_filesystem";
  const fixtureListing = run(
    "cargo",
    ["test", ...common, "--bin", "profile-fixture", "--", "--list"],
    true,
  );
  requireDiscoveredTests(fixtureListing, fixtureFilter);
  run("cargo", ["test", ...common, "--bin", "profile-fixture", fixtureFilter, "--", "--exact"]);
  run("cargo", ["clippy", ...common, "--all-targets", "--", "-D", "warnings"]);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      "Focused backend filters, Rust formatting and harness Clippy passed. No Tauri application build, GUI, installer, installed update, login restart or production signature was tested.\n",
    );
}

function cacheKey() {
  requireHostedTarget();
  if (!process.env.GITHUB_OUTPUT || !process.env.ImageOS || !process.env.ImageVersion)
    throw new Error("Hosted image metadata and Actions output are required");
  const digest = createHash("sha256");
  digest.update(
    JSON.stringify({
      platform: process.platform,
      architecture: process.arch,
      image: process.env.ImageOS,
      imageVersion: process.env.ImageVersion,
      rust: run("rustc", ["-vV"], true),
      profile: "dev-no-incremental",
    }),
  );
  for (const name of [
    "tests/backend/Cargo.toml",
    "tests/backend/Cargo.lock",
    "rust-toolchain.toml",
    ".github/workflows/desktop.yml",
    "scripts/verify-changes.mjs",
  ])
    digest.update(name).update(readFileSync(path.join(repository, name)));
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `key=mogledge-focused-v1-${process.platform}-${process.arch}-${digest.digest("hex")}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode === "source") {
    const git = (...args) =>
      execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
    requireApprovedSource(
      git("rev-parse", "HEAD"),
      process.env.EXPECTED_SOURCE_SHA,
      process.env.GITHUB_SHA,
      git("status", "--porcelain", "--untracked-files=no"),
    );
  } else if (mode === "backend") verifyBackend();
  else if (mode === "cache") cacheKey();
  else throw new Error("Use the fixed source, cache or backend verification mode");
}
