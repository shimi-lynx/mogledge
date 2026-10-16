import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import {
  backendFilters,
  requireApprovedSource,
  requireDiscoveredTests,
  requireHostedTarget,
} from "./verify-changes.mjs";

test("focused Rust execution refuses local targets, incremental caches and external flags", () => {
  const temporary = path.resolve("synthetic-runner");
  const allowed = {
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    RUNNER_TEMP: temporary,
    CARGO_TARGET_DIR: path.join(temporary, "mogledge-focused-target"),
    CARGO_INCREMENTAL: "0",
  };
  requireHostedTarget(allowed);
  for (const rejected of [
    { GITHUB_ACTIONS: "false" },
    { RUNNER_ENVIRONMENT: "self-hosted" },
    { RUNNER_ENVIRONMENT: undefined },
    { RUNNER_TEMP: "relative" },
    { CARGO_TARGET_DIR: path.join(temporary, "other") },
    { CARGO_INCREMENTAL: "1" },
    { RUSTFLAGS: "unapproved" },
    { CARGO_ENCODED_RUSTFLAGS: "unapproved" },
  ])
    assert.throws(() => requireHostedTarget({ ...allowed, ...rejected }));
});

test("source approval rejects missing, moved, dirty or mismatched dispatches", () => {
  const sha = "a".repeat(40);
  requireApprovedSource(sha, sha, sha);
  for (const args of [
    [sha, undefined, sha],
    [sha, "b".repeat(40), sha],
    [sha, sha, "b".repeat(40)],
    [sha, sha, sha, " M file"],
    [sha, "A".repeat(40), sha],
  ])
    assert.throws(() => requireApprovedSource(...args));
});

test("fixed filters cannot silently succeed without discovered Rust tests", () => {
  assert.equal(
    requireDiscoveredTests("module::selected: test\nmodule::other: test", "module::selected"),
    1,
  );
  assert.throws(() => requireDiscoveredTests("module::other: test", "module::selected"));
  assert.throws(() => requireDiscoveredTests("module::selected: benchmark", "module::selected"));
  assert.ok(backendFilters.includes("tree_mutations::tests::"));
  assert.ok(backendFilters.includes("resident_startup::tests::"));
  assert.ok(backendFilters.some((filter) => filter.includes("canonical_and_legacy_endpoints")));
  assert.ok(backendFilters.every((filter) => /^[a-z_:]+$/.test(filter)));
});

test("focused workflow gates source before installation and never invokes the application build", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/desktop.yml", import.meta.url),
    "utf8",
  );
  const focused = workflow.slice(workflow.indexOf("  focused:"), workflow.indexOf("  macos:"));
  assert.ok(
    focused.indexOf("verify-changes.mjs source") < focused.indexOf("rustup toolchain install"),
  );
  assert.ok(focused.includes('CARGO_INCREMENTAL: "0"'));
  assert.match(focused, /github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(focused, /npm ci|tauri -- build|test:e2e|secrets\./);
  assert.ok(
    focused.includes("windows-2022") &&
      focused.includes("macos-15-intel") &&
      focused.includes("macos-15"),
  );
});
