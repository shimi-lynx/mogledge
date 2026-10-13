import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { collectNotices } from "./notices.mjs";
import {
  assertBinaryPrivacy,
  assertCandidateLayout,
  assertSourceArchivePaths,
  pathRemappings,
  pathRemappingManifest,
  remappedBuildEnvironment,
} from "./privacy.mjs";

export const platforms = {
  "windows-x64": {
    os: "win32",
    arch: "x64",
    target: "x86_64-pc-windows-msvc",
    signature: "unsigned",
  },
  "macos-arm64": {
    os: "darwin",
    arch: "arm64",
    target: "aarch64-apple-darwin",
    signature: "adhoc",
  },
  "macos-x64": { os: "darwin", arch: "x64", target: "x86_64-apple-darwin", signature: "adhoc" },
};

export function requireAdhoc(description) {
  if (
    !/^Signature=adhoc\r?$/m.test(description) ||
    /^Authority=/m.test(description) ||
    !/^TeamIdentifier=not set\r?$/m.test(description)
  ) {
    throw new Error("Expected an ad-hoc signature without an authenticated team");
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0)
    throw new Error(`Failed: ${command} (${result.status})\n${result.stderr ?? ""}`);
  return result;
}

export async function identity(repo) {
  const json = async (file) => JSON.parse(await readFile(path.join(repo, file), "utf8"));
  const pkg = await json("package.json");
  const lock = await json("package-lock.json");
  const config = await json("src-tauri/tauri.conf.json");
  if (
    !/^\d+\.\d+\.\d+$/.test(pkg.version) ||
    config.productName !== "Mogledge" ||
    config.mainBinaryName !== "my-knowledge" ||
    config.identifier !== "com.shimilynx.myknowledge"
  )
    throw new Error("Unexpected product identity");
  if (
    [lock.version, lock.packages[""].version, config.version].some(
      (version) => version !== pkg.version,
    )
  )
    throw new Error("Product version mismatch");
  for (const file of ["src-tauri/Cargo.toml", "src-tauri/Cargo.lock"]) {
    const text = await readFile(path.join(repo, file), "utf8");
    const entry = text.match(/name = "my-knowledge"\r?\nversion = "([^"]+)"/);
    if (entry?.[1] !== pkg.version) throw new Error("Cargo product version mismatch");
  }
  if (
    config.bundle.macOS.signingIdentity !== "-" ||
    config.bundle.windows.certificateThumbprint ||
    config.bundle.windows.signCommand ||
    config.bundle.createUpdaterArtifacts
  )
    throw new Error("Unexpected signing/updater configuration");
  return { productName: config.productName, version: pkg.version, identifier: config.identifier };
}

async function main(platform, appOnly = false) {
  const selected = platforms[platform];
  if (!selected || process.platform !== selected.os || process.arch !== selected.arch)
    throw new Error("Use the matching native runner");
  const repo = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
  process.chdir(repo);
  const product = await identity(repo);
  const sourceSha = run("git", ["rev-parse", "HEAD"]).stdout.trim();
  if (
    !/^[a-f0-9]{40}$/.test(sourceSha) ||
    run("git", ["status", "--porcelain", "--untracked-files=no"]).stdout.trim()
  )
    throw new Error("Build requires a clean committed revision");
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== sourceSha)
    throw new Error("Checkout/source SHA mismatch");
  if (
    (!appOnly && process.version !== "v24.11.0") ||
    !run("rustc", ["--version"]).stdout.startsWith("rustc 1.99.0 ")
  )
    throw new Error("Unexpected Node/Rust toolchain");
  if (Object.hasOwn(process.env, "TAURI_CONFIG"))
    throw new Error("Distribution builds require unset TAURI_CONFIG");
  const targetDirectory = path.resolve(repo, process.env.CARGO_TARGET_DIR || "src-tauri/target");
  const cargoHome = path.resolve(repo, process.env.CARGO_HOME || path.join(os.homedir(), ".cargo"));
  const remappings = pathRemappings(
    {
      home: os.homedir(),
      temporary: os.tmpdir(),
      cargo: cargoHome,
      sysroot: run("rustc", ["--print", "sysroot"]).stdout.trim(),
      repository: repo,
      target: targetDirectory,
    },
    selected.os,
  );
  const buildEnvironment = {
    ...remappedBuildEnvironment(process.env, remappings, selected.os),
    // Tauri enters src-tauri before invoking Cargo; make relative cache input
    // unambiguous and keep the verified output directory equal to Cargo's.
    CARGO_TARGET_DIR: targetDirectory,
    CARGO_HOME: cargoHome,
  };
  const verifyWindows = (exe, output) =>
    run("pwsh", [
      "-NoProfile",
      "-File",
      "scripts/distribution/windows.ps1",
      "-Action",
      "verify",
      "-Source",
      exe,
      "-Expected",
      product.version,
      "-Output",
      output,
    ]);
  if (appOnly) {
    if (selected.os !== "win32")
      throw new Error("App-only privacy build currently supports Windows");
    if (process.env.CARGO_BUILD_TARGET)
      throw new Error("App-only privacy builds require the native default Cargo target");
    const output = path.join(repo, ".tools/distribution-app-only");
    await mkdir(path.dirname(output), { recursive: true });
    await mkdir(output);
    // The native default target preserves the owner's existing cache layout.
    // No app launch, installer, notices upload or distribution approval occurs.
    run(
      process.execPath,
      [
        "node_modules/@tauri-apps/cli/tauri.js",
        "build",
        "--no-bundle",
        "--",
        "--locked",
        "--jobs",
        "1",
      ],
      { stdio: "inherit", env: buildEnvironment },
    );
    const executable = path.join(targetDirectory, "release/my-knowledge.exe");
    const bytes = await readFile(executable);
    assertBinaryPrivacy(bytes, remappings);
    verifyWindows(executable, path.join(output, "windows-verification.json"));
    await writeFile(
      path.join(output, "manifest.json"),
      `${JSON.stringify({ ...product, sourceSha, platform, target: selected.target, architecture: selected.arch, signature: selected.signature, executableSha256: createHash("sha256").update(bytes).digest("hex"), pathRemapping: pathRemappingManifest(remappings), purpose: "Private app-only verification; distribution review remains separate" }, null, 2)}\n`,
    );
    console.log("Verified private app-only build; no installer or distribution archive produced");
    return;
  }
  const work = path.join(repo, ".tools/distribution");
  // Never erase a previous candidate or package into a directory with stale files.
  await mkdir(path.dirname(work), { recursive: true });
  await mkdir(work);
  const name = `${product.productName}_${product.version}_${platform}_${selected.signature}_${sourceSha.slice(0, 12)}`;
  const staging = path.join(work, name);
  await mkdir(staging);
  const cargo = JSON.parse(
    run("cargo", [
      "metadata",
      "--locked",
      "--format-version",
      "1",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--filter-platform",
      selected.target,
      "--features",
      "custom-protocol",
    ]).stdout,
  );
  await collectNotices(repo, path.join(staging, "third-party"), cargo);
  await cp(path.join(repo, "LICENSE"), path.join(staging, "LICENSE"));
  await cp(
    path.join(repo, "docs/binary-distribution.md"),
    path.join(staging, "BINARY-DISTRIBUTION.md"),
  );
  assertSourceArchivePaths(run("git", ["ls-files", "-z"]).stdout.split("\0").filter(Boolean));
  run("git", [
    "archive",
    "--format=zip",
    `--output=${path.join(staging, "source.zip")}`,
    sourceSha,
  ]);
  const args = ["build", "--target", selected.target];
  args.push(...(selected.os === "win32" ? ["--no-bundle"] : ["--bundles", "app"]));
  args.push("--", "--locked", "--jobs", "1");
  run(process.execPath, ["node_modules/@tauri-apps/cli/tauri.js", ...args], {
    stdio: "inherit",
    env: buildEnvironment,
  });
  const release = path.join(targetDirectory, selected.target, "release");
  const verifyMac = (app) => {
    run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
    requireAdhoc(run("codesign", ["-dv", "--verbose=4", app]).stderr);
    const plist = path.join(app, "Contents/Info.plist");
    const get = (key) =>
      run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist]).stdout.trim();
    if (
      get("CFBundleIdentifier") !== product.identifier ||
      get("CFBundleShortVersionString") !== product.version ||
      get("CFBundleName") !== product.productName ||
      get("CFBundleExecutable") !== "my-knowledge"
    )
      throw new Error("Unexpected Mac bundle identity/version");
    const executable = path.join(app, "Contents/MacOS/my-knowledge");
    if (
      run("lipo", ["-archs", executable]).stdout.trim() !==
      (selected.arch === "arm64" ? "arm64" : "x86_64")
    )
      throw new Error("Unexpected Mach-O architecture");
    return executable;
  };
  let executable;
  if (selected.os === "win32") {
    executable = path.join(staging, "my-knowledge.exe");
    await cp(path.join(release, "my-knowledge.exe"), executable);
    verifyWindows(executable, path.join(work, "windows-verification.json"));
  } else {
    const app = path.join(staging, "Mogledge.app");
    run("ditto", [path.join(release, "bundle/macos/Mogledge.app"), app]);
    executable = verifyMac(app);
  }
  const sha256 = async (file) =>
    createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
  assertBinaryPrivacy(await readFile(executable), remappings);
  const manifest = {
    ...product,
    sourceSha,
    platform,
    architecture: selected.arch,
    target: selected.target,
    signature: selected.signature,
    notarized: false,
    updater: false,
    node: process.version,
    rust: run("rustc", ["--version"]).stdout.trim(),
    executableSha256: await sha256(executable),
    sourceZipSha256: await sha256(path.join(staging, "source.zip")),
    nativeDownloadQa: "not performed",
    thirdPartyReview: "manual review required in addition to inventory checks",
    pathRemapping: pathRemappingManifest(remappings),
  };
  await writeFile(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await assertCandidateLayout(staging, platform);
  const output = path.join(work, "output");
  await mkdir(output);
  const archive = path.join(output, `${name}.zip`);
  if (selected.os === "win32") {
    run("pwsh", [
      "-NoProfile",
      "-File",
      "scripts/distribution/windows.ps1",
      "-Action",
      "archive",
      "-Source",
      staging,
      "-Expected",
      product.version,
      "-Output",
      archive,
    ]);
    const restored = path.join(work, "extracted", name, "my-knowledge.exe");
    verifyWindows(restored, path.join(work, "windows-restored-verification.json"));
    if ((await sha256(restored)) !== manifest.executableSha256)
      throw new Error("Archive changed executable bytes");
    await assertCandidateLayout(path.dirname(restored), platform);
  } else {
    run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", staging, archive]);
    const extracted = path.join(work, "extracted");
    run("ditto", ["-x", "-k", archive, extracted]);
    const restored = verifyMac(path.join(extracted, name, "Mogledge.app"));
    if ((await sha256(restored)) !== manifest.executableSha256)
      throw new Error("Archive changed executable bytes");
    await assertCandidateLayout(path.join(extracted, name), platform);
  }
  await writeFile(
    path.join(output, "SHA256SUMS.txt"),
    `${await sha256(archive)}  ${path.basename(archive)}\n`,
  );
  await cp(path.join(staging, "manifest.json"), path.join(output, "manifest.json"));
  if ((await readdir(output)).length !== 3) throw new Error("Unexpected upload contents");
  console.log(`Verified candidate: ${path.basename(archive)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = process.argv[3];
  if (process.argv.length > 4 || (option && option !== "--app-only")) {
    console.error("Usage: node scripts/distribution/build.mjs <platform> [--app-only]");
    process.exitCode = 1;
  } else
    main(process.argv[2], option === "--app-only").catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
