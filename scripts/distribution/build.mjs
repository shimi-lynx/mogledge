import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { collectNotices } from "./notices.mjs";
import { cargoBuildArguments, writeCiTimings } from "./ci.mjs";
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

// Dispatch refs can move: bind both checkout and the event to the approved commit.
export function requireApprovedSource(sourceSha, expectedSourceSha, workflowSha) {
  if (
    !/^[a-f0-9]{40}$/.test(expectedSourceSha ?? "") ||
    sourceSha !== expectedSourceSha ||
    workflowSha !== expectedSourceSha
  )
    throw new Error("Approved source SHA must match checkout and workflow event");
}

export function requireDistributionConfig(config) {
  if (
    JSON.stringify(Object.keys(config).sort()) !==
      JSON.stringify(["$schema", "bundle", "plugins"]) ||
    JSON.stringify(config.bundle) !== JSON.stringify({ createUpdaterArtifacts: true })
  )
    throw new Error("Unexpected distribution overlay scope");
  if (
    !config.plugins ||
    JSON.stringify(Object.keys(config.plugins)) !== JSON.stringify(["updater"])
  )
    throw new Error("Unexpected distribution plugin scope");
  const updater = config.plugins.updater;
  if (
    !updater ||
    JSON.stringify(Object.keys(updater).sort()) !==
      JSON.stringify(["endpoints", "pubkey", "requireSignedVersion", "windows"]) ||
    updater.requireSignedVersion !== true ||
    JSON.stringify(updater.windows) !== JSON.stringify({ installMode: "passive" }) ||
    JSON.stringify(updater.endpoints) !==
      JSON.stringify([
        "https://github.com/shimi-lynx/mogledge/releases/latest/download/latest.json",
      ])
  )
    throw new Error("Unexpected distribution updater policy");
  const document = Buffer.from(updater.pubkey, "base64");
  if (document.toString("base64") !== updater.pubkey) throw new Error("Invalid update public key");
  const lines = document.toString("utf8").trimEnd().split("\n");
  const key = Buffer.from(lines[1] ?? "", "base64");
  if (
    lines.length !== 2 ||
    key.toString("base64") !== lines[1] ||
    key.length !== 42 ||
    key.subarray(0, 2).toString("ascii") !== "Ed" ||
    key.readBigUInt64LE(2) !== 0x834723b673fe6c1en ||
    lines[0] !== "untrusted comment: minisign public key: 834723B673FE6C1E" ||
    createHash("sha256").update(key.subarray(10)).digest("hex") !==
      "65b10a703ca58b486328274e88c5999fee34e16c15356d64aa3b19e54dd49a55"
  )
    throw new Error("Unexpected update public key identity");
}

export async function verifyBundledMaterials(staging, app, platform = "darwin") {
  const digest = async (file) =>
    createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
  const resources = platform === "win32" ? app : path.join(app, "Contents/Resources");
  for (const file of ["LICENSE", "source.zip", "BINARY-DISTRIBUTION.md"])
    if ((await digest(path.join(staging, file))) !== (await digest(path.join(resources, file))))
      throw new Error("Updater app omitted or changed bundled material");
  async function compare(source, target) {
    const original = await readdir(source, { withFileTypes: true });
    const copied = await readdir(target, { withFileTypes: true });
    if (original.length !== copied.length)
      throw new Error("Updater app material file count differs");
    for (const entry of original) {
      const found = copied.find((file) => file.name === entry.name);
      if (!found || entry.isSymbolicLink() || found.isSymbolicLink())
        throw new Error("Updater app material entry differs");
      if (entry.isDirectory() && found.isDirectory())
        await compare(path.join(source, entry.name), path.join(target, entry.name));
      else if (
        !entry.isFile() ||
        !found.isFile() ||
        (await digest(path.join(source, entry.name))) !==
          (await digest(path.join(target, entry.name)))
      )
        throw new Error("Updater app material bytes differ");
    }
  }
  await compare(path.join(staging, "third-party"), path.join(resources, "third-party"));
}

export function macUpdaterBuildPlan(target, resources, cargoArguments = cargoBuildArguments()) {
  if (!["x86_64-apple-darwin", "aarch64-apple-darwin"].includes(target))
    throw new Error("Updater app preparation requires a Mac target");
  const common = [
    "--target",
    target,
    "--features",
    "distribution-updater",
    "--config",
    "src-tauri/tauri.updater.distribution.json",
    "--config",
    JSON.stringify({ bundle: { resources } }),
  ];
  return {
    build: ["build", ...common, "--no-bundle", "--", ...cargoArguments],
    // Package the existing enrolled binary, keeping OS ad-hoc signing. Disabling
    // updater artifact generation only here prevents the CLI requesting a key.
    bundle: [
      "bundle",
      ...common,
      "--bundles",
      "app",
      "--config",
      JSON.stringify({ bundle: { createUpdaterArtifacts: false } }),
    ],
  };
}

export function windowsUpdaterBuildPlan(resources, cargoArguments = cargoBuildArguments()) {
  // The native x64 host is checked by the caller. Retain the existing cache's
  // default-target layout and compile enrollment before disabling CLI signing.
  const common = [
    "--features",
    "distribution-updater",
    "--config",
    "src-tauri/tauri.updater.distribution.json",
    "--config",
    JSON.stringify({ bundle: { resources } }),
  ];
  return {
    build: ["build", ...common, "--no-bundle", "--", ...cargoArguments],
    bundle: [
      "bundle",
      ...common,
      "--bundles",
      "nsis",
      "--config",
      JSON.stringify({ bundle: { createUpdaterArtifacts: false } }),
    ],
  };
}

export function requireNsisPayload(source, payload) {
  // Tauri restores the cached EXE after patching only this unique bundle marker
  // in the NSIS payload. Reject all other byte changes before recording its hash.
  const original = Buffer.from("__TAURI_BUNDLE_TYPE_VAR_UNK");
  const bundled = Buffer.from("__TAURI_BUNDLE_TYPE_VAR_NSS");
  const offset = source.indexOf(original);
  if (
    offset < 0 ||
    source.indexOf(original, offset + 1) >= 0 ||
    payload.length !== source.length ||
    payload.indexOf(bundled) !== offset ||
    payload.indexOf(bundled, offset + 1) >= 0
  )
    throw new Error("Unexpected NSIS bundle marker");
  const expected = Buffer.from(source);
  bundled.copy(expected, offset);
  if (!payload.equals(expected)) throw new Error("NSIS changed bytes outside the bundle marker");
}

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
    pkg.name !== "mogledge" ||
    lock.name !== "mogledge" ||
    lock.packages[""].name !== "mogledge" ||
    config.productName !== "Mogledge" ||
    config.mainBinaryName !== "mogledge" ||
    config.identifier !== "com.shimilynx.mogledge"
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
    const entry = text.match(/name = "mogledge"\r?\nversion = "([^"]+)"/);
    if (entry?.[1] !== pkg.version) throw new Error("Cargo product version mismatch");
    if (
      file.endsWith(".toml") &&
      (!/^default-run = "mogledge"$/m.test(text) || !/\[lib\]\r?\nname = "mogledge_lib"/.test(text))
    )
      throw new Error("Unexpected Cargo executable/library identity");
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

async function main(platform, appOnly = false, updaterApp = false) {
  const started = performance.now();
  const selected = platforms[platform];
  if (!selected || process.platform !== selected.os || process.arch !== selected.arch)
    throw new Error("Use the matching native runner");
  const repo = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
  process.chdir(repo);
  const product = await identity(repo);
  if (updaterApp) {
    if (
      [
        "TAURI_SIGNING_PRIVATE_KEY",
        "TAURI_SIGNING_PRIVATE_KEY_PATH",
        "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
        "APPLE_CERTIFICATE",
        "APPLE_CERTIFICATE_PASSWORD",
        "APPLE_ID",
        "APPLE_PASSWORD",
        "APPLE_API_KEY",
        "APPLE_API_ISSUER",
      ].some((name) => Object.hasOwn(process.env, name))
    )
      throw new Error("Updater app preparation must not receive signing credentials");
    requireDistributionConfig(
      JSON.parse(
        await readFile(path.join(repo, "src-tauri/tauri.updater.distribution.json"), "utf8"),
      ),
    );
  }
  const sourceSha = run("git", ["rev-parse", "HEAD"]).stdout.trim();
  if (
    !/^[a-f0-9]{40}$/.test(sourceSha) ||
    run("git", ["status", "--porcelain", "--untracked-files=no"]).stdout.trim()
  )
    throw new Error("Build requires a clean committed revision");
  if (process.env.GITHUB_SHA)
    requireApprovedSource(sourceSha, process.env.EXPECTED_SOURCE_SHA, process.env.GITHUB_SHA);
  if (
    (!appOnly && process.version !== "v24.11.0") ||
    !run("rustc", ["--version"]).stdout.startsWith("rustc 1.99.0 ")
  )
    throw new Error("Unexpected Node/Rust toolchain");
  if (Object.hasOwn(process.env, "TAURI_CONFIG"))
    throw new Error("Distribution builds require unset TAURI_CONFIG");
  if (
    updaterApp &&
    selected.os === "win32" &&
    (process.env.CARGO_BUILD_TARGET ||
      !/^host: x86_64-pc-windows-msvc\r?$/m.test(run("rustc", ["-vV"]).stdout))
  )
    throw new Error("Windows updater builds require the native x64 MSVC target");
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
  const cargoArguments = cargoBuildArguments(process.env);
  const phases = [];
  const runBuild = (phase, args) => {
    const phaseStarted = performance.now();
    run(process.execPath, args, { stdio: "inherit", env: buildEnvironment });
    phases.push({ phase, seconds: Math.round((performance.now() - phaseStarted) / 10) / 100 });
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
    runBuild("compile", [
      "node_modules/@tauri-apps/cli/tauri.js",
      "build",
      "--no-bundle",
      "--",
      ...cargoArguments,
    ]);
    const executable = path.join(targetDirectory, "release/mogledge.exe");
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
  const name = `${product.productName}_${product.version}_${platform}_${selected.signature}${updaterApp ? "_updater" : ""}_${sourceSha.slice(0, 12)}`;
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
      updaterApp ? "custom-protocol,distribution-updater" : "custom-protocol",
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
  const cli = "node_modules/@tauri-apps/cli/tauri.js";
  if (updaterApp) {
    const resources = {
      [`../.tools/distribution/${name}/third-party`]: "third-party",
      "../LICENSE": "LICENSE",
      [`../.tools/distribution/${name}/source.zip`]: "source.zip",
      "../docs/binary-distribution.md": "BINARY-DISTRIBUTION.md",
    };
    const plan =
      selected.os === "win32"
        ? windowsUpdaterBuildPlan(resources, cargoArguments)
        : macUpdaterBuildPlan(selected.target, resources, cargoArguments);
    runBuild("compile", [cli, ...plan.build]);
    runBuild("bundle", [cli, ...plan.bundle]);
  } else {
    const args = ["build", "--target", selected.target];
    args.push(...(selected.os === "win32" ? ["--no-bundle"] : ["--bundles", "app"]));
    args.push("--", ...cargoArguments);
    runBuild("compile-and-bundle", [cli, ...args]);
  }
  const release = path.join(
    targetDirectory,
    updaterApp && selected.os === "win32" ? "" : selected.target,
    "release",
  );
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
      get("CFBundleExecutable") !== "mogledge"
    )
      throw new Error("Unexpected Mac bundle identity/version");
    const executable = path.join(app, "Contents/MacOS/mogledge");
    if (
      run("lipo", ["-archs", executable]).stdout.trim() !==
      (selected.arch === "arm64" ? "arm64" : "x86_64")
    )
      throw new Error("Unexpected Mach-O architecture");
    return executable;
  };
  let executable;
  if (selected.os === "win32") {
    executable = path.join(staging, "mogledge.exe");
    await cp(path.join(release, "mogledge.exe"), executable);
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
    updater: updaterApp,
    ...(updaterApp
      ? {
          updaterSignature: "pending separately approved signing; not installable as an update yet",
          updateFeed: "awaiting public HTTPS assets; no live service is claimed",
          enrollmentNativeQa: "not performed",
          distributionConfigSha256: await sha256(
            path.join(repo, "src-tauri/tauri.updater.distribution.json"),
          ),
        }
      : {}),
    node: process.version,
    rust: run("rustc", ["--version"]).stdout.trim(),
    executableSha256: await sha256(executable),
    sourceZipSha256: await sha256(path.join(staging, "source.zip")),
    nativeDownloadQa: "not performed",
    thirdPartyReview: "adopted material requires artifact inclusion and new dependency checks",
    pathRemapping: pathRemappingManifest(remappings),
  };
  await writeFile(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await assertCandidateLayout(staging, platform);
  const output = path.join(work, "output");
  await mkdir(output);
  if (updaterApp && selected.os === "win32") {
    const installer = path.join(
      release,
      "bundle/nsis",
      `${product.productName}_${product.version}_x64-setup.exe`,
    );
    run("pwsh", [
      "-NoProfile",
      "-File",
      "scripts/distribution/windows.ps1",
      "-Action",
      "verify-installer",
      "-Source",
      installer,
      "-Expected",
      product.version,
      "-Output",
      path.join(work, "installer-verification.json"),
    ]);
    assertBinaryPrivacy(await readFile(installer), remappings);
    const extracted = path.join(work, "installer-extracted");
    run("pwsh", [
      "-NoProfile",
      "-File",
      "scripts/distribution/windows.ps1",
      "-Action",
      "unpack-installer",
      "-Source",
      installer,
      "-Expected",
      product.version,
      "-Output",
      extracted,
    ]);
    const restored = path.join(extracted, "mogledge.exe");
    verifyWindows(restored, path.join(work, "installer-payload-verification.json"));
    requireNsisPayload(await readFile(executable), await readFile(restored));
    await cp(restored, executable);
    assertBinaryPrivacy(await readFile(executable), remappings);
    manifest.executableSha256 = await sha256(executable);
    await verifyBundledMaterials(staging, extracted, "win32");
    const updateArchive = path.join(output, `${name}-setup.exe`);
    await cp(installer, updateArchive);
    manifest.updateArchive = path.basename(updateArchive);
    manifest.updateArchiveSha256 = await sha256(updateArchive);
    await writeFile(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  } else if (updaterApp) {
    await verifyBundledMaterials(staging, path.join(staging, "Mogledge.app"));
    const updateArchive = path.join(output, `${name}.app.tar.gz`);
    run("tar", ["-czf", updateArchive, "-C", staging, "Mogledge.app"]);
    const extracted = path.join(work, "updater-extracted");
    await mkdir(extracted);
    run("tar", ["-xzf", updateArchive, "-C", extracted]);
    const restored = verifyMac(path.join(extracted, "Mogledge.app"));
    if ((await sha256(restored)) !== manifest.executableSha256)
      throw new Error("Updater archive changed executable bytes");
    await verifyBundledMaterials(staging, path.join(extracted, "Mogledge.app"));
    manifest.updateArchive = path.basename(updateArchive);
    manifest.updateArchiveSha256 = await sha256(updateArchive);
    await writeFile(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }
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
    const restored = path.join(work, "extracted", name, "mogledge.exe");
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
  const checksums = [`${await sha256(archive)}  ${path.basename(archive)}`];
  if (updaterApp) checksums.push(`${manifest.updateArchiveSha256}  ${manifest.updateArchive}`);
  await writeFile(path.join(output, "SHA256SUMS.txt"), `${checksums.join("\n")}\n`);
  await writeFile(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  if ((await readdir(output)).length !== (updaterApp ? 4 : 3))
    throw new Error("Unexpected upload contents");
  if (process.env.GITHUB_ACTIONS === "true")
    await writeCiTimings(path.join(work, "performance"), targetDirectory, remappings, {
      sourceSha,
      platform,
      target: selected.target,
      profile: "release",
      features: updaterApp ? ["custom-protocol", "distribution-updater"] : ["custom-protocol"],
      cargoJobs: 2,
      cache: process.env.MOGLEDGE_RUST_CACHE_HIT === "hit" ? "hit" : "miss",
      cacheKey: process.env.MOGLEDGE_RUST_CACHE_KEY,
      rust: manifest.rust,
      node: process.version,
      phases,
      builderSeconds: Math.round((performance.now() - started) / 10) / 100,
    });
  console.log(`Verified candidate: ${path.basename(archive)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = process.argv[3];
  if (process.argv.length > 4 || (option && !["--app-only", "--updater-app"].includes(option))) {
    console.error(
      "Usage: node scripts/distribution/build.mjs <platform> [--app-only|--updater-app]",
    );
    process.exitCode = 1;
  } else
    main(process.argv[2], option === "--app-only", option === "--updater-app").catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
