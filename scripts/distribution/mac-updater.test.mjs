import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  macUpdaterBuildPlan,
  requireDistributionConfig,
  verifyBundledMaterials,
  windowsUpdaterBuildPlan,
  requireNsisPayload,
} from "./build.mjs";
import { collectNotices, materialReviewHash } from "./notices.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mogledge-mac-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("explicit distribution overlay preserves default disabled identity and validates only the supplied public key/feed", async () => {
  const config = JSON.parse(
    await readFile(
      new URL("../../src-tauri/tauri.updater.distribution.json", import.meta.url),
      "utf8",
    ),
  );
  requireDistributionConfig(config);
  const baseline = JSON.parse(
    await readFile(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
  );
  assert.equal(baseline.plugins?.updater, undefined);
  assert.notEqual(baseline.bundle.createUpdaterArtifacts, true);
  assert.equal(baseline.identifier, "com.shimilynx.myknowledge");
  for (const mutate of [
    (value) => {
      value.identifier = "com.example.changed";
    },
    (value) => {
      value.plugins.unrelated = {};
    },
    (value) => {
      value.bundle.createUpdaterArtifacts = false;
    },
    (value) => {
      value.plugins.updater.requireSignedVersion = false;
    },
    (value) => {
      value.plugins.updater.dangerousAcceptInvalidCerts = true;
    },
    (value) => {
      value.plugins.updater.endpoints = ["http://127.0.0.1/latest.json"];
    },
    (value) => {
      value.plugins.updater.pubkey = "ZmFrZQ==";
    },
  ]) {
    const changed = structuredClone(config);
    mutate(changed);
    assert.throws(() => requireDistributionConfig(changed));
  }
});

test("Mac plan compiles enrollment once and bundles that binary without requesting updater signing or removing OS signing", () => {
  const resources = { "../LICENSE": "LICENSE" };
  for (const target of ["x86_64-apple-darwin", "aarch64-apple-darwin"]) {
    const plan = macUpdaterBuildPlan(target, resources);
    assert.equal(plan.build[0], "build");
    assert.ok(plan.build.includes("--no-bundle"));
    assert.deepEqual(plan.build.slice(-4), ["--", "--locked", "--jobs", "1"]);
    assert.equal(plan.bundle[0], "bundle");
    assert.ok(plan.bundle.includes("app"));
    assert.ok(plan.build.includes(target) && plan.bundle.includes(target));
    for (const args of [plan.build, plan.bundle]) {
      assert.ok(args.includes("distribution-updater"));
      assert.ok(args.includes("src-tauri/tauri.updater.distribution.json"));
      assert.equal(args.includes("--no-sign"), false);
      assert.equal(
        args.some((value) => value.includes("PRIVATE_KEY")),
        false,
      );
    }
    assert.deepEqual(JSON.parse(plan.bundle.at(-1)), { bundle: { createUpdaterArtifacts: false } });
  }
  assert.throws(() => macUpdaterBuildPlan("x86_64-pc-windows-msvc", resources), /Mac target/);
});

test("Windows enrollment uses the native cache and packages only NSIS without requesting a signing key", () => {
  const resources = { "../LICENSE": "LICENSE" };
  const plan = windowsUpdaterBuildPlan(resources);
  assert.ok(plan.build.includes("--no-bundle"));
  assert.deepEqual(plan.build.slice(-4), ["--", "--locked", "--jobs", "1"]);
  assert.equal(plan.bundle[plan.bundle.indexOf("--bundles") + 1], "nsis");
  for (const args of [plan.build, plan.bundle]) {
    assert.ok(args.includes("distribution-updater"));
    assert.ok(args.includes("src-tauri/tauri.updater.distribution.json"));
    assert.equal(args.includes("--target"), false);
    assert.equal(args.includes("--no-sign"), false);
    assert.ok(args.includes(JSON.stringify({ bundle: { resources } })));
  }
  assert.deepEqual(JSON.parse(plan.bundle.at(-1)), { bundle: { createUpdaterArtifacts: false } });
});

test("NSIS permits only the unique Tauri UNK-to-NSS marker patch, preserving every other byte", () => {
  const marker = "__TAURI_BUNDLE_TYPE_VAR_";
  const source = Buffer.from(`prefix-${marker}UNK-suffix`);
  const payload = Buffer.from(`prefix-${marker}NSS-suffix`);
  requireNsisPayload(source, payload);
  for (const changed of [
    source,
    Buffer.from(`changed-${marker}NSS-suffix`),
    Buffer.from(`prefix-${marker}NSS-SUFFIX`),
    Buffer.from(`prefix-${marker}NSS-suffix-extra`),
  ])
    assert.throws(() => requireNsisPayload(source, changed));
  assert.throws(
    () =>
      requireNsisPayload(
        Buffer.from(`${marker}UNK-${marker}UNK`),
        Buffer.from(`${marker}NSS-${marker}UNK`),
      ),
    /marker/,
  );
  assert.throws(
    () => requireNsisPayload(Buffer.from("prefix-UNK-suffix"), Buffer.from("prefix-NSS-suffix")),
    /marker/,
  );
});

test("Windows NSIS inspection must preserve embedded source and every legal file", async (t) => {
  const root = await fixture(t);
  const staging = path.join(root, "staging");
  const extracted = path.join(root, "extracted");
  await mkdir(path.join(staging, "third-party/package"), { recursive: true });
  for (const file of [
    "LICENSE",
    "source.zip",
    "BINARY-DISTRIBUTION.md",
    "third-party/package/NOTICE",
  ])
    await writeFile(path.join(staging, file), `retained ${file}`);
  await cp(staging, extracted, { recursive: true });
  await verifyBundledMaterials(staging, extracted, "win32");
  await writeFile(path.join(extracted, "third-party/package/NOTICE"), "changed notice");
  await assert.rejects(
    verifyBundledMaterials(staging, extracted, "win32"),
    /material bytes differ/,
  );
  await cp(
    path.join(staging, "third-party/package/NOTICE"),
    path.join(extracted, "third-party/package/NOTICE"),
  );
  await rm(path.join(extracted, "source.zip"));
  await assert.rejects(verifyBundledMaterials(staging, extracted, "win32"));
});

test("bundled and extracted apps must preserve every notice/source file rather than only its index", async (t) => {
  const root = await fixture(t);
  const staging = path.join(root, "staging");
  const app = path.join(root, "Mogledge.app");
  const resources = path.join(app, "Contents/Resources");
  await mkdir(path.join(staging, "third-party/package/source"), { recursive: true });
  for (const file of [
    "LICENSE",
    "source.zip",
    "BINARY-DISTRIBUTION.md",
    "third-party/index.json",
    "third-party/package/NOTICE",
    "third-party/package/source/lib.rs",
  ])
    await writeFile(path.join(staging, file), `retained ${file}`);
  await cp(staging, resources, { recursive: true });
  await verifyBundledMaterials(staging, app);
  const notice = path.join(resources, "third-party/package/NOTICE");
  await writeFile(notice, "removed copyright text");
  await assert.rejects(verifyBundledMaterials(staging, app), /material bytes differ/);
  await cp(path.join(staging, "third-party/package/NOTICE"), notice);
  await rm(path.join(resources, "third-party/package/source/lib.rs"));
  await assert.rejects(verifyBundledMaterials(staging, app), /file count differs/);
});

test("pinned OSAKit declared-term evidence retains its reference label and SDK note; missing or changed evidence still stops", async (t) => {
  const root = await fixture(t);
  const materials = new URL("materials/", import.meta.url);
  const entries = JSON.parse(await readFile(new URL("index.json", materials), "utf8"));
  const review = structuredClone(entries["objc2-osa-kit@0.3.2"]);
  const materialRoot = path.join(root, "scripts/distribution/materials");
  const pkgRoot = path.join(root, "package");
  await mkdir(pkgRoot, { recursive: true });
  await mkdir(path.join(root, "src-tauri"));
  for (const file of review.files) {
    const target = path.join(materialRoot, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(new URL(file.path, materials), target);
  }
  await writeFile(path.join(root, "package-lock.json"), JSON.stringify({ packages: {} }));
  await writeFile(
    path.join(root, "src-tauri/Cargo.lock"),
    `[[package]]\nname = "${review.name}"\nversion = "${review.version}"\nchecksum = "${review.crateChecksum}"\n`,
  );
  await writeFile(
    path.join(pkgRoot, ".cargo_vcs_info.json"),
    JSON.stringify({ git: { sha1: review.sourceRevision }, path_in_vcs: review.sourcePath }),
  );
  const pkg = {
    id: "pkg",
    name: review.name,
    version: review.version,
    license: review.declaredLicense,
    source: "registry+https://github.com/rust-lang/crates.io-index",
    manifest_path: path.join(pkgRoot, "Cargo.toml"),
  };
  const metadata = {
    packages: [{ id: "app" }, pkg],
    resolve: {
      root: "app",
      nodes: [
        { id: "app", deps: [{ pkg: "pkg", dep_kinds: [{ kind: null }] }] },
        { id: "pkg", deps: [] },
      ],
    },
  };
  const save = () =>
    writeFile(
      path.join(materialRoot, "index.json"),
      JSON.stringify({ "objc2-osa-kit@0.3.2": review }),
    );
  await save();
  const inventory = await collectNotices(root, path.join(root, "accepted"), metadata);
  assert.deepEqual(inventory[0].selectedLicenses, ["Apache-2.0"]);
  assert.equal(inventory[0].supplementalFiles[1].referenceOnly, true);
  assert.equal(inventory[0].reviewNote, entries["objc2-osa-kit@0.3.2"].reviewRequired);
  assert.deepEqual(inventory[0].termCompletenessEvidence, review.termCompletenessEvidence);
  const evidence = review.termCompletenessEvidence;
  delete review.termCompletenessEvidence;
  review.adoptedReviewSha256 = materialReviewHash(review);
  await save();
  await assert.rejects(
    collectNotices(root, path.join(root, "old-classification"), metadata),
    /Missing complete license sections/,
  );
  review.termCompletenessEvidence = evidence;
  review.adoptedReviewSha256 = materialReviewHash(review);
  review.termCompletenessEvidence[0].declaredLicense = "GPL-3.0-only";
  review.adoptedReviewSha256 = materialReviewHash(review);
  await save();
  await assert.rejects(
    collectNotices(root, path.join(root, "wrong-declaration"), metadata),
    /declared alternative/,
  );
  review.termCompletenessEvidence[0].declaredLicense = "Apache-2.0";
  review.adoptedReviewSha256 = materialReviewHash(review);
  await save();
  await writeFile(path.join(materialRoot, review.files[1].path), "incomplete terms");
  await assert.rejects(
    collectNotices(root, path.join(root, "altered-text"), metadata),
    /checksum mismatch/,
  );
});
