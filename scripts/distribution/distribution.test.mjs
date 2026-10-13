import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { identity, requireAdhoc, requireApprovedSource } from "./build.mjs";
import {
  assertBinaryPrivacy,
  assertCandidateLayout,
  assertSourceArchivePaths,
  pathRemappings,
  pathRemappingManifest,
  remappedBuildEnvironment,
} from "./privacy.mjs";
import {
  cargoPackages,
  cargoPackageScopes,
  collectNotices,
  materialReviewHash,
  containedFile,
  requireLicenseText,
  validateLicense,
} from "./notices.mjs";

const mitText = await readFile(
  new URL("materials/webview2-com@0.39.1/LICENSE", import.meta.url),
  "utf8",
);

test("manual candidates require the approved full commit in both checkout and dispatch", () => {
  const approved = "a".repeat(40);
  requireApprovedSource(approved, approved, approved);
  for (const [checkout, expected, event] of [
    [approved, undefined, approved],
    [approved, "a".repeat(12), approved],
    [approved, "main", approved],
    [approved, "A".repeat(40), approved],
    ["b".repeat(40), approved, approved],
    [approved, approved, "b".repeat(40)],
    [approved, "$(touch unexpected)", approved],
  ])
    assert.throws(() => requireApprovedSource(checkout, expected, event), /Approved source SHA/);
});

test("authenticated/unsigned signatures cannot pass the ad-hoc gate", () => {
  requireAdhoc("Identifier=com.example\nSignature=adhoc\nTeamIdentifier=not set\n");
  for (const text of [
    "Signature=adhoc\nTeamIdentifier=ABC\n",
    "Signature=adhoc\nAuthority=Developer ID\nTeamIdentifier=not set\n",
    "code object is not signed",
  ]) {
    assert.throws(() => requireAdhoc(text));
  }
});

test("unsupported or unspecified license obligations fail closed", () => {
  validateLicense("(MIT OR Apache-2.0) AND Unicode-3.0");
  for (const expression of [
    null,
    "",
    "GPL-3.0-only",
    "MIT WITH unknown",
    "LicenseRef-private",
    "MIT OR",
    "MIT Apache-2.0",
    "(MIT",
  ])
    assert.throws(() => validateLicense(expression));
});

test("SPDX-only and incomplete texts do not establish a complete license", () => {
  assert.throws(() => requireLicenseText("MIT", ["SPDX-License-Identifier: MIT"]));
  assert.throws(() => requireLicenseText("MIT", ["Permission is hereby granted".repeat(40)]));
  assert.throws(() => requireLicenseText("MIT AND Apache-2.0", [mitText]));
  requireLicenseText("MIT", [mitText]);
});

test("Cargo inventory retains transitive normal/build packages, excludes dev-only graph", () => {
  const deps = (pkg, kind) => ({ pkg, dep_kinds: [{ kind }] });
  const graph = {
    resolve: {
      root: "app",
      nodes: [
        { id: "app", deps: [deps("normal", null), deps("builder", "build"), deps("dev", "dev")] },
        { id: "normal", deps: [deps("shared", null)] },
        { id: "builder", deps: [] },
        { id: "shared", deps: [deps("normal", null)] },
        { id: "dev", deps: [] },
      ],
    },
    packages: ["app", "normal", "builder", "shared", "dev"].map((id) => ({ id })),
  };
  assert.deepEqual(
    cargoPackages(graph).map(({ id }) => id),
    ["normal", "builder", "shared"],
  );
  assert.throws(() => cargoPackages({ resolve: null }));
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mogledge-distribution-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("license paths reject traversal and absolute paths", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "package"));
  await writeFile(path.join(root, "LICENSE"), "outside");
  await assert.rejects(containedFile(path.join(root, "package"), "../LICENSE"));
  await assert.rejects(containedFile(path.join(root, "package"), path.join(root, "LICENSE")));
});

test(
  "license symlinks cannot escape package",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await fixture(t);
    await mkdir(path.join(root, "package"));
    await writeFile(path.join(root, "LICENSE"), "outside");
    await symlink("../LICENSE", path.join(root, "package/LICENSE"));
    await assert.rejects(containedFile(path.join(root, "package"), "LICENSE"));
  },
);

test("missing legal text blocks packaging; MPL source and notices are retained", async (t) => {
  const repo = await fixture(t);
  const dependency = path.join(repo, "node_modules/example");
  await mkdir(dependency, { recursive: true });
  await writeFile(
    path.join(repo, "package-lock.json"),
    JSON.stringify({ packages: { "": {}, "node_modules/example": { version: "1.0.0" } } }),
  );
  await writeFile(
    path.join(dependency, "package.json"),
    JSON.stringify({ name: "example", version: "1.0.0", license: "MPL-2.0" }),
  );
  const metadata = {
    resolve: { root: "app", nodes: [{ id: "app", deps: [] }] },
    packages: [{ id: "app" }],
  };
  const out = path.join(repo, "notices");
  await assert.rejects(collectNotices(repo, out, metadata), /Missing full license/);
  await writeFile(
    path.join(dependency, "LICENSE"),
    "Mozilla Public License Version 2.0 Exhibit A Exhibit B".repeat(30),
  );
  await writeFile(path.join(dependency, "NOTICE"), "Copyright fixture");
  await writeFile(path.join(dependency, "source.js"), "source fixture");
  const inventory = await collectNotices(repo, out, metadata);
  assert.equal(inventory[0].sourceIncluded, true);
  assert.equal(
    await readFile(path.join(out, "npm/example@1.0.0/NOTICE"), "utf8"),
    "Copyright fixture",
  );
  assert.equal(
    await readFile(path.join(out, "npm/example@1.0.0/source/source.js"), "utf8"),
    "source fixture",
  );
  assert.equal(JSON.stringify(inventory).includes(repo), false);
});

test(
  "legal symlinks are not silently dropped from an otherwise licensed package",
  { skip: process.platform === "win32" },
  async (t) => {
    const repo = await fixture(t);
    const dependency = path.join(repo, "node_modules/example");
    await mkdir(dependency, { recursive: true });
    await writeFile(
      path.join(repo, "package-lock.json"),
      JSON.stringify({ packages: { "": {}, "node_modules/example": { version: "1.0.0" } } }),
    );
    await writeFile(
      path.join(dependency, "package.json"),
      JSON.stringify({ name: "example", version: "1.0.0", license: "MIT" }),
    );
    await writeFile(path.join(dependency, "LICENSE"), mitText);
    await writeFile(path.join(repo, "external-notice"), "outside");
    await symlink("../../external-notice", path.join(dependency, "NOTICE"));
    const metadata = {
      resolve: { root: "app", nodes: [{ id: "app", deps: [] }] },
      packages: [{ id: "app" }],
    };
    await assert.rejects(
      collectNotices(repo, path.join(repo, "notices"), metadata),
      /Legal text symlink/,
    );
  },
);

test("a complete UNLICENSE is retained as the package's legal text", async (t) => {
  const repo = await fixture(t);
  const dependency = path.join(repo, "node_modules/example");
  await mkdir(dependency, { recursive: true });
  await writeFile(
    path.join(repo, "package-lock.json"),
    JSON.stringify({ packages: { "": {}, "node_modules/example": { version: "1.0.0" } } }),
  );
  await writeFile(
    path.join(dependency, "package.json"),
    JSON.stringify({ name: "example", version: "1.0.0", license: "Unlicense" }),
  );
  // Preserve the actual UNLICENSE text from aho-corasick 1.1.5 as the regression fixture.
  const unlicense = await readFile(new URL("fixtures/UNLICENSE", import.meta.url), "utf8");
  await writeFile(path.join(dependency, "UNLICENSE"), unlicense);
  const metadata = {
    resolve: { root: "app", nodes: [{ id: "app", deps: [] }] },
    packages: [{ id: "app" }],
  };
  const destination = path.join(repo, "notices");
  const inventory = await collectNotices(repo, destination, metadata);
  assert.deepEqual(inventory[0].legalFiles, ["UNLICENSE"]);
  assert.equal(
    await readFile(path.join(destination, "npm/example@1.0.0/UNLICENSE"), "utf8"),
    unlicense,
  );
});

test("current product manifests agree; ad-hoc config is explicit", async () => {
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  assert.equal((await identity(repo)).productName, "Mogledge");
});

test("OR chooses a complete branch, AND preserves every obligation and precedence", () => {
  const mit = mitText;
  const bsd =
    "Redistribution and use in source and binary forms Neither the name THIS SOFTWARE IS PROVIDED".repeat(
      10,
    );
  assert.deepEqual(requireLicenseText("MIT OR Apache-2.0", [mit]), ["MIT"]);
  assert.deepEqual(requireLicenseText("Apache-2.0 OR MIT", [mit]), ["MIT"]);
  assert.deepEqual(requireLicenseText("MIT AND BSD-3-Clause OR Apache-2.0", [mit, bsd]), [
    "MIT",
    "BSD-3-Clause",
  ]);
  assert.throws(() => requireLicenseText("MIT AND BSD-3-Clause", [mit]));
  assert.throws(() => requireLicenseText("(MIT OR Apache-2.0) AND BSD-3-Clause", [mit]));
  assert.throws(() =>
    requireLicenseText("MIT", [
      "Permission is hereby granted".repeat(30),
      "THE SOFTWARE IS PROVIDED".repeat(30),
    ]),
  );
  for (const expression of [
    "MIT/Apache-2.0",
    "MIT OR GPL-3.0-only",
    "(MIT) WITH LLVM-exception",
    "MIT WITH LLVM-exception",
    "MIT OR ()",
    "MIT) OR (Apache-2.0",
    "MIT AND OR Apache-2.0",
  ])
    assert.throws(() => validateLicense(expression));
});

test("LLVM exception must accompany the complete Apache terms", async () => {
  const materials = JSON.parse(
    await readFile(new URL("materials/index.json", import.meta.url), "utf8"),
  );
  const entry = materials["winx@0.36.4"];
  assert.equal(entry.declaredLicense, "Apache-2.0 WITH LLVM-exception");
  const apache = "Apache License Version 2.0 END OF TERMS AND CONDITIONS".repeat(20);
  assert.throws(() => requireLicenseText(entry.declaredLicense, [apache]));
  const legal = entry.files.find((file) => file.archivePath?.endsWith("/LICENSE"));
  const actual = await readFile(new URL(`materials/${legal.path}`, import.meta.url), "utf8");
  assert.deepEqual(requireLicenseText(entry.declaredLicense, [actual]), [entry.declaredLicense]);
  validateLicense(entry.declaredLicense);
});

test(
  "contained in-package legal symlinks also fail closed",
  { skip: process.platform === "win32" },
  async (t) => {
    const repo = await fixture(t);
    await writeFile(path.join(repo, "actual.txt"), "license fixture");
    await symlink("actual.txt", path.join(repo, "LICENSE"));
    await assert.rejects(containedFile(repo, "LICENSE"), /symlink/);
  },
);

test("diagnosis records failures without producing a distributable index", async (t) => {
  const repo = await fixture(t);
  const dependency = path.join(repo, "node_modules/example");
  await mkdir(dependency, { recursive: true });
  await writeFile(
    path.join(repo, "package-lock.json"),
    JSON.stringify({ packages: { "node_modules/example": { version: "1.0.0" } } }),
  );
  await writeFile(
    path.join(dependency, "package.json"),
    JSON.stringify({ name: "example", version: "1.0.0", license: "MIT" }),
  );
  const metadata = {
    resolve: { root: "app", nodes: [{ id: "app", deps: [] }] },
    packages: [{ id: "app" }],
  };
  const out = path.join(repo, "diagnosis");
  const result = await collectNotices(repo, out, metadata, { diagnostic: true });
  assert.equal(result.failures.length, 1);
  assert.equal(result.inventory.length, 0);
  await assert.rejects(readFile(path.join(out, "index.json")), { code: "ENOENT" });
  await assert.rejects(collectNotices(repo, path.join(repo, "distribution"), metadata));
});

test("host proc-macro closures remain build scope; shared packages keep both roles", () => {
  const dep = (pkg, kind = null) => ({ pkg, dep_kinds: [{ kind }] });
  const metadata = {
    resolve: {
      root: "app",
      nodes: [
        { id: "app", deps: [dep("macro"), dep("shared")] },
        { id: "macro", deps: [dep("shared"), dep("builder", "build")] },
        { id: "shared", deps: [] },
        { id: "builder", deps: [] },
      ],
    },
    packages: ["app", "macro", "shared", "builder"].map((id) => ({
      id,
      targets: [{ kind: [id === "macro" ? "proc-macro" : "lib"] }],
    })),
  };
  assert.deepEqual(
    cargoPackageScopes(metadata).map(({ pkg, scopes }) => [pkg.id, scopes]),
    [
      ["macro", ["build"]],
      ["shared", ["build", "runtime"]],
      ["builder", ["build"]],
    ],
  );
});

test("pinned material checksums, source identity, SDK bytes and review blockers fail closed", async (t) => {
  const repo = await fixture(t);
  const upstream = fileURLToPath(new URL("../../", import.meta.url));
  const materialRoot = path.join(repo, "scripts/distribution/materials");
  const pkgRoot = path.join(repo, "package");
  await mkdir(materialRoot, { recursive: true });
  await mkdir(pkgRoot);
  await writeFile(path.join(repo, "package-lock.json"), JSON.stringify({ packages: {} }));
  const reviews = JSON.parse(
    await readFile(path.join(upstream, "scripts/distribution/materials/index.json"), "utf8"),
  );
  const review = structuredClone(reviews["webview2-com@0.39.1"]);
  review.files = [review.files[0]];
  const source = path.join(upstream, "scripts/distribution/materials", review.files[0].path);
  const target = path.join(materialRoot, review.files[0].path);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, await readFile(source));
  await mkdir(path.join(repo, "src-tauri"));
  const locked = `[[package]]\r\nname = "${review.name}"\r\nversion = "${review.version}"\r\nchecksum = "${review.crateChecksum}"\r\n`;
  await writeFile(path.join(repo, "src-tauri/Cargo.lock"), locked);
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
  const saveReview = () =>
    writeFile(
      path.join(materialRoot, "index.json"),
      JSON.stringify({ "webview2-com@0.39.1": review }),
    );
  await saveReview();
  assert.equal(
    (await collectNotices(repo, path.join(repo, "good"), metadata))[0].selectedLicenses[0],
    "MIT",
  );
  await writeFile(target, `${mitText}changed`);
  await assert.rejects(
    collectNotices(repo, path.join(repo, "bad-text"), metadata),
    /checksum mismatch/,
  );
  await writeFile(target, await readFile(source));
  await writeFile(
    path.join(repo, "src-tauri/Cargo.lock"),
    locked.replace(review.crateChecksum, "0".repeat(64)),
  );
  await assert.rejects(
    collectNotices(repo, path.join(repo, "bad-lock"), metadata),
    /lock checksum mismatch/,
  );
  await writeFile(path.join(repo, "src-tauri/Cargo.lock"), locked);
  pkg.source = "git+https://example.test/package";
  await assert.rejects(
    collectNotices(repo, path.join(repo, "bad-source"), metadata),
    /source\/declaration mismatch/,
  );
  pkg.source = "registry+https://github.com/rust-lang/crates.io-index";
  await writeFile(
    path.join(pkgRoot, ".cargo_vcs_info.json"),
    JSON.stringify({ git: { sha1: "0".repeat(40) } }),
  );
  await assert.rejects(
    collectNotices(repo, path.join(repo, "bad-revision"), metadata),
    /source revision mismatch/,
  );
  await writeFile(
    path.join(pkgRoot, ".cargo_vcs_info.json"),
    JSON.stringify({ git: { sha1: review.sourceRevision }, path_in_vcs: review.sourcePath }),
  );
  review.sdk = { matchedFiles: [{ path: "loader.lib", sha256: "0".repeat(64) }] };
  await writeFile(path.join(pkgRoot, "loader.lib"), "mismatched fixture");
  await saveReview();
  await assert.rejects(
    collectNotices(repo, path.join(repo, "bad-sdk"), metadata),
    /SDK material checksum mismatch/,
  );
  delete review.sdk;
  review.reviewRequired = "SDK attribution unresolved";
  await saveReview();
  await assert.rejects(
    collectNotices(repo, path.join(repo, "unreviewed"), metadata),
    /Distribution review required/,
  );
  const diagnosis = await collectNotices(repo, path.join(repo, "audit"), metadata, {
    diagnostic: true,
  });
  assert.equal(diagnosis.failures[0].reviewRequired, review.reviewRequired);
  assert.equal(diagnosis.inventory.length, 0);
  review.adoptedReviewSha256 = materialReviewHash(review);
  await saveReview();
  const adopted = await collectNotices(repo, path.join(repo, "adopted"), metadata);
  assert.equal(adopted[0].reviewNote, review.reviewRequired);
  assert.equal(adopted[0].reviewPolicy, "existing-material-adopted");
  const originalVersion = review.version;
  review.version = "9.9.9";
  assert.notEqual(review.adoptedReviewSha256, materialReviewHash(review));
  review.version = originalVersion;
  const originalNote = review.reviewRequired;
  review.reviewRequired = "A newly identified mandatory notice issue";
  await saveReview();
  await assert.rejects(
    collectNotices(repo, path.join(repo, "changed-note"), metadata),
    /Distribution review required/,
  );
  review.reviewRequired = originalNote;
  await writeFile(target, `${mitText}changed`);
  await saveReview();
  await assert.rejects(
    collectNotices(repo, path.join(repo, "adopted-bad-text"), metadata),
    /checksum mismatch/,
  );
  await writeFile(target, await readFile(source));
  review.files[0].referenceOnly = true;
  await saveReview();
  await assert.rejects(
    collectNotices(repo, path.join(repo, "reference-only"), metadata),
    /Missing full license/,
  );
});

test("encoded remappings retain whitespace, equals and both Windows separators", () => {
  const roots = {
    home: "C:\\Users\\example",
    temporary: "C:\\Users\\example\\Temp space",
    cargo: "C:\\Users\\example\\.cargo",
    sysroot: "C:\\Users\\example\\.rustup\\toolchain",
    repository: "C:\\Users\\example\\project=work",
    target: "C:\\Users\\example\\project=work\\target",
  };
  const mappings = pathRemappings(roots, "win32");
  const environment = remappedBuildEnvironment({ KEEP: "unchanged" }, mappings, "win32");
  const flags = environment.CARGO_ENCODED_RUSTFLAGS.split("\x1f");
  assert.equal(environment.KEEP, "unchanged");
  assert.ok(flags.includes("--remap-path-prefix=C:/Users/example/Temp space=/build/tmp"));
  assert.ok(flags.includes("--remap-path-prefix=C:\\Users\\example\\project=work=/mogledge"));
  assert.equal(flags.at(-1), "-Clink-arg=/PDBALTPATH:%_PDB%");
  assert.throws(() => remappedBuildEnvironment({ RUSTFLAGS: "-C target-cpu=native" }, mappings));
  assert.throws(() => remappedBuildEnvironment({ CARGO_ENCODED_RUSTFLAGS: "-g" }, mappings));
  assert.equal(JSON.stringify(pathRemappingManifest(mappings)).includes("example"), false);
  assert.equal(JSON.stringify(pathRemappingManifest(mappings)).includes("C:"), false);
  assert.throws(() => pathRemappings({ ...roots, repository: "relative" }, "win32"));
  for (const control of ["\0", "\n", "\r", "\x1f", "\x07"])
    assert.throws(() =>
      pathRemappings({ ...roots, repository: `C:\\project${control}root` }, "win32"),
    );
});

test("final binary privacy rejects local roots and unknown personal paths without echoing values", () => {
  const mappings = [{ name: "repository", from: "/private/build-root", to: "/mogledge" }];
  assert.throws(() =>
    assertBinaryPrivacy(Buffer.from("/private/資料/source.rs"), [
      { name: "repository", from: "/private/資料", to: "/mogledge" },
    ]),
  );
  assertBinaryPrivacy(Buffer.from("panic at /mogledge/src/main.rs:12"), mappings);
  for (const text of [
    "/private/build-root/src/main.rs",
    "C:\\Users\\example\\code.rs",
    "\0/Users/example/code.rs",
  ]) {
    for (const encoding of ["utf8", "utf16le"]) {
      const bytes = Buffer.from(text, encoding);
      for (const input of [bytes, Buffer.concat([Buffer.from([1]), bytes])])
        assert.throws(
          () => assertBinaryPrivacy(input, mappings),
          (error) => !error.message.includes(text),
        );
    }
  }
});

test("candidate root rejects launchers and nested debug/log/private output", async (t) => {
  const root = await fixture(t);
  for (const name of [
    "my-knowledge.exe",
    "manifest.json",
    "LICENSE",
    "BINARY-DISTRIBUTION.md",
    "source.zip",
  ])
    await writeFile(path.join(root, name), "fixture");
  await mkdir(path.join(root, "third-party"));
  await writeFile(path.join(root, "third-party", ".env.example"), "public configuration template");
  await assertCandidateLayout(root, "windows-x64");
  await writeFile(path.join(root, "Launch.cmd"), "fixture launcher");
  await assert.rejects(assertCandidateLayout(root, "windows-x64"), /unexpected files/);
  await rm(path.join(root, "Launch.cmd"));
  for (const name of ["private.pdb", "build.log", ".env", ".env.local"]) {
    await writeFile(path.join(root, "third-party", name), "fixture output");
    await assert.rejects(
      assertCandidateLayout(root, "windows-x64"),
      /debug symbols, logs or private config/,
    );
    await rm(path.join(root, "third-party", name));
  }
});

test("source archive preserves public build scripts and rejects tracked private output", () => {
  assertSourceArchivePaths([
    "LICENSE",
    "scripts/build.ps1",
    "scripts/distribution/build.mjs",
    ".env.example",
  ]);
  for (const entry of [
    ".git/config",
    ".tools/output.txt",
    ".codex/state.json",
    "AGENTS.local.md",
    "build/app.pdb",
    "debug/app.dSYM/symbols",
    "logs/build.log",
    ".env",
    ".env.local",
    ".ENV.LOCAL",
  ])
    assert.throws(() => assertSourceArchivePaths([entry]));
});

test("unsupported build options stop before invoking a product build", () => {
  const script = fileURLToPath(new URL("build.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "windows-x64", "--unsupported"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: node scripts\/distribution\/build.mjs/);
  assert.equal(result.stdout, "");
});

test(
  "Windows Rust probe removes source/PDB paths while retaining panic symbols and lines",
  { skip: process.platform !== "win32" || process.env.MOGLEDGE_PATH_REMAP_NATIVE_PROBE !== "1" },
  async (t) => {
    const root = await fixture(t);
    const source = path.join(root, "source space=probe");
    await mkdir(source);
    const dependency = path.join(source, "dependency.rs");
    const main = path.join(source, "main.rs");
    await writeFile(
      dependency,
      '#[inline(never)] pub fn location() -> &\'static str { file!() }\n#[inline(never)] pub fn fail() { panic!("native fixture panic"); }\n',
    );
    await writeFile(
      main,
      'fn main() { if std::env::args().len() > 1 { probe_dependency::fail(); } println!("{} {}", file!(), probe_dependency::location()); }\n',
    );
    const run = (command, args, options = {}) => {
      const result = spawnSync(command, args, { encoding: "utf8", cwd: root, ...options });
      assert.equal(result.error, undefined, "Native fixture tool unavailable");
      assert.equal(result.status, 0, "Native fixture compilation/execution failed");
      return result;
    };
    const sysroot = run("rustc", ["--print", "sysroot"]).stdout.trim();
    const mappings = pathRemappings({
      home: os.homedir(),
      temporary: os.tmpdir(),
      cargo: process.env.CARGO_HOME || path.join(os.homedir(), ".cargo"),
      sysroot,
      repository: source,
      target: path.join(root, "output"),
    });
    const flags = remappedBuildEnvironment({}, mappings).CARGO_ENCODED_RUSTFLAGS.split("\x1f");
    for (const [name, extra] of [
      ["control", []],
      ["mapped", flags],
    ]) {
      const output = path.join(root, name);
      await mkdir(output);
      const library = path.join(output, "libprobe_dependency.rlib");
      run("rustc", [
        dependency,
        "--crate-name",
        "probe_dependency",
        "--crate-type",
        "rlib",
        "--edition=2021",
        "-g",
        "-o",
        library,
        ...extra,
      ]);
      const exe = path.join(output, "probe.exe");
      run("rustc", [
        main,
        "--edition=2021",
        "-g",
        "--extern",
        `probe_dependency=${library}`,
        "-o",
        exe,
        ...extra,
      ]);
      const bytes = await readFile(exe);
      if (name === "control") assert.throws(() => assertBinaryPrivacy(bytes, mappings));
      else {
        assertBinaryPrivacy(bytes, mappings);
        const normal = run(exe, []).stdout;
        assert.match(normal, /\/mogledge[\\/]main.rs/);
        assert.match(normal, /\/mogledge[\\/]dependency.rs/);
        const panic = spawnSync(exe, ["panic"], {
          encoding: "utf8",
          env: { ...process.env, RUST_BACKTRACE: "1" },
        });
        assert.notEqual(panic.status, 0);
        assert.match(panic.stderr, /\/mogledge[\\/]dependency.rs:2/);
        assert.match(panic.stderr, /probe_dependency::fail/);
      }
    }
  },
);
