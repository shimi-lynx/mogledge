import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CURRENT_ID = "com.shimilynx.mogledge";
const OLD_ID = "com.shimilynx.myknowledge";
const OLD_SOURCE = "b07f0bab242ae3f8b47f461d4046e4211b91ea81";
export const legacyAssets = {
  "windows-x64": {
    name: "Mogledge_0.9.1_windows-x64_unsigned_updater_b07f0bab242a-setup.exe",
    sha256: "64e5cce0274d16655ab6f1f263b84739b35fed4ca1e655b006ab78d93c8815ba",
  },
  "macos-arm64": {
    name: "Mogledge_0.9.1_macos-arm64_adhoc_updater_b07f0bab242a.app.tar.gz",
    sha256: "dcd751c04d0f08293556822389aca060effd039033cf623d0a62d3b9bbdc854b",
  },
  "macos-x64": {
    name: "Mogledge_0.9.1_macos-x64_adhoc_updater_b07f0bab242a.app.tar.gz",
    sha256: "520e781e47ea5c4194dbb7939c18f54425d6b22e14f51c2bea8186b82486f380",
  },
};

// This probe intentionally exercises formal IDs only on empty, disposable hosted
// runners. It must never become a local QA shortcut for an ordinary user profile.
export function requireHostedRunner(env, platform, system = process.platform, arch = process.arch) {
  const expected = {
    "windows-x64": ["Windows", "win32", "x64", "X64"],
    "macos-arm64": ["macOS", "darwin", "arm64", "ARM64"],
    "macos-x64": ["macOS", "darwin", "x64", "X64"],
  }[platform];
  if (
    !expected ||
    env.GITHUB_ACTIONS !== "true" ||
    env.CI !== "true" ||
    env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    env.RUNNER_OS !== expected[0] ||
    system !== expected[1] ||
    arch !== expected[2] ||
    env.RUNNER_ARCH !== expected[3] ||
    !env.RUNNER_TEMP ||
    !env.RUNNER_NAME ||
    !/^\d+$/.test(env.GITHUB_RUN_ID ?? "") ||
    !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? "") ||
    env.GITHUB_REPOSITORY !== "shimi-lynx/mogledge"
  )
    throw new Error("Disposable matching GitHub-hosted runner required");
}

export function requireCandidate(manifest, config, platform, source, env) {
  if (
    !/^[a-f0-9]{40}$/.test(source) ||
    source !== env.EXPECTED_SOURCE_SHA ||
    source !== env.GITHUB_SHA ||
    !/^0\.\d+\.\d+$/.test(env.EXPECTED_VERSION ?? "") ||
    env.EXPECTED_VERSION === "0.9.1" ||
    config.identifier !== CURRENT_ID ||
    config.productName !== "Mogledge" ||
    config.mainBinaryName !== "mogledge" ||
    config.version !== env.EXPECTED_VERSION ||
    manifest.identifier !== CURRENT_ID ||
    manifest.productName !== "Mogledge" ||
    manifest.version !== config.version ||
    manifest.sourceSha !== source ||
    manifest.platform !== platform ||
    manifest.updater !== true ||
    !/^[a-f0-9]{64}$/.test(manifest.executableSha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(manifest.updateArchiveSha256 ?? "") ||
    typeof manifest.updateArchive !== "string" ||
    manifest.updateArchive !== path.basename(manifest.updateArchive) ||
    manifest.updateArchive.includes("\\") ||
    manifest.updateArchive.includes("..") ||
    !/^[A-Za-z0-9_.-]+$/.test(manifest.updateArchive) ||
    !(platform === "windows-x64"
      ? manifest.updateArchive.endsWith("-setup.exe")
      : manifest.updateArchive.endsWith(".app.tar.gz"))
  )
    throw new Error("Candidate identity, source, version or updater archive mismatch");
}

export function requireContained(root, target) {
  const relative = path.relative(root, target);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error("Probe fixture must remain inside runner temporary directory");
}

export function requireMacArchiveEntries(listing) {
  const entries = listing.trim().split("\n");
  if (
    !entries.length ||
    entries.some(
      (entry) =>
        !entry ||
        entry.includes("\\") ||
        entry.includes("\0") ||
        entry.split("/").includes("..") ||
        (entry !== "Mogledge.app" && !entry.startsWith("Mogledge.app/")),
    )
  ) {
    throw new Error("Mac archive must contain only its owned application bundle");
  }
}

export function legacyLaunchAgent(executable) {
  if (!path.posix.isAbsolute(executable) || /[<>&\r\n]/.test(executable))
    throw new Error("Unsupported synthetic LaunchAgent path");
  // Exact auto-launch 0.6.0 no-argument template, matching the read-only guard.
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n  <dict>\n  <key>Label</key>\n  <string>My Knowledge</string>\n  <key>AssociatedBundleIdentifiers</key>\n  <array></array>\n  <key>ProgramArguments</key>\n  <array><string>${executable}</string></array>\n  <key>RunAtLoad</key>\n  <true/>\n  </dict>\n</plist>`;
}

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function exists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 500));
function command(file, args, timeout = 30_000) {
  return execFileSync(file, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  }).trim();
}
async function hash(file, expected) {
  if (digest(await readFile(file)) !== expected)
    throw new Error("Candidate or legacy asset hash mismatch");
}

async function downloadLegacy(platform, fixture) {
  const asset = legacyAssets[platform];
  const response = await fetch(
    `https://github.com/shimi-lynx/mogledge/releases/download/v0.9.1/${asset.name}`,
    {
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!response.ok) throw new Error("Pinned legacy asset download failed");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (digest(bytes) !== asset.sha256) throw new Error("Pinned legacy asset hash mismatch");
  const destination = path.join(fixture, asset.name);
  await writeFile(destination, bytes, { flag: "wx" });
  return destination;
}

async function treeSnapshot(roots) {
  const entries = [];
  async function visit(file, label) {
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error("Unexpected profile alias in disposable fixture");
    if (info.isDirectory()) {
      entries.push([label, "directory"]);
      for (const name of (await readdir(file)).sort())
        await visit(path.join(file, name), `${label}/${name}`);
    } else if (info.isFile()) entries.push([label, digest(await readFile(file))]);
    else throw new Error("Unexpected profile entry in disposable fixture");
  }
  for (const [index, root] of roots.entries()) await visit(root, String(index));
  return JSON.stringify(entries);
}

function verifyMacBundle(app, version, identifier, executableName, architecture) {
  const plist = path.join(app, "Contents/Info.plist");
  const field = (name) => command("/usr/libexec/PlistBuddy", ["-c", `Print :${name}`, plist]);
  if (
    field("CFBundleIdentifier") !== identifier ||
    field("CFBundleShortVersionString") !== version ||
    field("CFBundleExecutable") !== executableName
  )
    throw new Error("Mac bundle identity mismatch");
  command("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  const executable = path.join(app, "Contents/MacOS", executableName);
  if (command("/usr/bin/lipo", ["-archs", executable]) !== architecture)
    throw new Error("Mac native architecture mismatch");
  return executable;
}

async function requireBundleLinksContained(app) {
  async function visit(file) {
    const info = await lstat(file);
    if (info.isSymbolicLink()) requireContained(app, await realpath(file));
    else if (info.isDirectory())
      for (const name of await readdir(file)) await visit(path.join(file, name));
    else if (!info.isFile()) throw new Error("Unsupported Mac bundle entry");
  }
  await visit(app);
}

function macProcess(pid) {
  try {
    return {
      executable: command("/bin/ps", ["-ww", "-p", String(pid), "-o", "comm="]),
      started: command("/bin/ps", ["-p", String(pid), "-o", "lstart="]),
    };
  } catch {
    return null;
  }
}

function hasMacWindow(pid) {
  const script = `ObjC.import('CoreGraphics'); const windows=ObjC.deepUnwrap($.CGWindowListCopyWindowInfo(1,0));
    JSON.stringify(windows.some(w=>w.kCGWindowOwnerPID===${pid} && w.kCGWindowLayer===0 &&
      w.kCGWindowBounds.Width>=400 && w.kCGWindowBounds.Height>=250));`;
  return command("/usr/bin/osascript", ["-l", "JavaScript", "-e", script]) === "true";
}

async function macProbe(platform, manifest, output, fixture, legacy, checks, report) {
  const library = path.join(os.homedir(), "Library");
  const bases = ["Application Support", "WebKit", "Caches"];
  for (const directory of [
    library,
    path.join(library, "LaunchAgents"),
    ...bases.map((base) => path.join(library, base)),
  ]) {
    if ((await exists(directory)) && (await lstat(directory)).isSymbolicLink())
      throw new Error("Mac profile parent must not be an alias");
  }
  const ids = ["com.shimilynx.aiwiki", OLD_ID, CURRENT_ID];
  const profiles = bases.flatMap((base) => ids.map((id) => path.join(library, base, id)));
  const registrations = ["My Knowledge", "Mogledge"].map((name) =>
    path.join(library, "LaunchAgents", `${name}.plist`),
  );
  for (const file of [
    ...profiles,
    ...registrations,
    ...ids.map((id) => path.join(library, "Preferences", `${id}.plist`)),
    ...["Mogledge", "My Knowledge", "AIWiki"].flatMap((name) => [
      `/Applications/${name}.app`,
      path.join(os.homedir(), "Applications", `${name}.app`),
    ]),
  ])
    if (await exists(file))
      throw new Error("Preexisting formal Mac profile, app or registration; probe refused");
  const alreadyRunning = command("/usr/bin/osascript", [
    "-l",
    "JavaScript",
    "-e",
    `ObjC.import('AppKit'); JSON.stringify([${ids.map((id) => JSON.stringify(id)).join(",")}].some(id=>$.NSRunningApplication.runningApplicationsWithBundleIdentifier(id).count>0));`,
  ]);
  if (alreadyRunning !== "false")
    throw new Error("Preexisting formal Mac app process; probe refused");
  checks.push("empty-runner-preflight");
  const oldProfiles = bases.map((base) => path.join(library, base, OLD_ID));
  for (const profile of oldProfiles) {
    await mkdir(profile, { recursive: true });
    await writeFile(
      path.join(profile, "native-probe-sentinel.json"),
      '{"synthetic":true,"preserve":"0.9.1"}\n',
      { flag: "wx" },
    );
  }
  const oldSnapshot = await treeSnapshot(oldProfiles);
  const installed = path.join(fixture, "fixed-location");
  await mkdir(installed);
  requireMacArchiveEntries(command("/usr/bin/tar", ["-tzf", legacy]));
  command("/usr/bin/tar", ["-xzf", legacy, "-C", installed]);
  const app = path.join(installed, "Mogledge.app");
  const architecture = platform === "macos-arm64" ? "arm64" : "x86_64";
  await requireBundleLinksContained(app);
  const oldExecutable = verifyMacBundle(app, "0.9.1", OLD_ID, "my-knowledge", architecture);
  const oldAgent = path.join(library, "LaunchAgents", "My Knowledge.plist");
  const agentBytes = legacyLaunchAgent(oldExecutable);
  await mkdir(path.dirname(oldAgent), { recursive: true });
  // Do not load/register the fixture with launchctl or start the predecessor.
  await writeFile(oldAgent, agentBytes, { flag: "wx" });
  await rename(app, path.join(installed, "previous-Mogledge.app"));
  const unpacked = path.join(fixture, "candidate");
  await mkdir(unpacked);
  requireMacArchiveEntries(
    command("/usr/bin/tar", ["-tzf", path.join(output, manifest.updateArchive)]),
  );
  command("/usr/bin/tar", ["-xzf", path.join(output, manifest.updateArchive), "-C", unpacked]);
  await rename(path.join(unpacked, "Mogledge.app"), app);
  await requireBundleLinksContained(app);
  const executable = verifyMacBundle(app, manifest.version, CURRENT_ID, "mogledge", architecture);
  await hash(executable, manifest.executableSha256);
  checks.push("verified-old-bundle-replacement-at-same-owned-location");
  report.failedStage = "mac-profile-before-launch";
  for (const base of bases)
    if (await exists(path.join(library, base, CURRENT_ID)))
      throw new Error("Current profile existed before owned candidate launch");
  const child = spawn(executable, [], { stdio: "ignore" });
  let launchError = false;
  child.once("error", (error) => {
    launchError = true;
    if (/^[A-Z0-9_]+$/.test(error.code ?? "")) report.launchErrorCode = error.code;
  });
  // Capture identity before cleanup. PID alone must never authorize a signal.
  let identity;
  let probeFailure;
  let cleanupFailure;
  try {
    report.failedStage = "mac-process-identity";
    for (let attempt = 0; attempt < 20 && !identity && !launchError; attempt++) {
      identity = child.pid ? macProcess(child.pid) : null;
      if (!identity) await pause();
    }
    if (!identity || identity.executable !== executable)
      throw new Error("Owned Mac candidate process not observed");
    report.failedStage = "mac-window-and-profile";
    let ready = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      const current = macProcess(child.pid);
      if (!current || current.executable !== executable || current.started !== identity.started)
        break;
      if (
        (await exists(
          path.join(library, "Application Support", CURRENT_ID, "document-state/state.sqlite"),
        )) &&
        hasMacWindow(child.pid)
      ) {
        ready = true;
        break;
      }
      await pause();
    }
    if (!ready)
      throw new Error("Native Mac main window and initialized current profile were not observed");
    checks.push("ordinary-candidate-native-window-and-current-profile");
    report.failedStage = "mac-old-data-and-registration";
    if ((await treeSnapshot(oldProfiles)) !== oldSnapshot)
      throw new Error("Legacy synthetic profile changed");
    for (const base of bases)
      if (await exists(path.join(library, base, CURRENT_ID, "native-probe-sentinel.json")))
        throw new Error("Legacy sentinel copied into current profile");
    if (
      (await readFile(oldAgent, "utf8")) !== agentBytes ||
      (await exists(path.join(library, "LaunchAgents/Mogledge.plist")))
    )
      throw new Error("Synthetic legacy LaunchAgent changed or a current agent was created");
    checks.push("old-config-webkit-cache-sentinels-unchanged-no-copy");
    checks.push("exact-old-launchagent-fixture-unchanged-no-current-registration");
  } catch (error) {
    probeFailure = error;
    report.processExitCode = child.exitCode;
    if (String(error.message).startsWith("Command failed: /usr/bin/osascript"))
      report.failureKind = "window-observation-command";
  } finally {
    try {
      const current = child.pid ? macProcess(child.pid) : null;
      if (identity && current?.executable === executable && current.started === identity.started) {
        // Normal termination only; never target by process name or identifier.
        process.kill(child.pid, "SIGTERM");
        for (let attempt = 0; attempt < 20 && macProcess(child.pid); attempt++) await pause();
        if (macProcess(child.pid))
          cleanupFailure = new Error("Owned Mac candidate did not terminate normally");
      }
    } catch (error) {
      cleanupFailure = error;
    }
  }
  if (probeFailure && cleanupFailure)
    throw new AggregateError(
      [probeFailure, cleanupFailure],
      "Native Mac probe and owned cleanup failed",
    );
  if (probeFailure) throw probeFailure;
  if (cleanupFailure) throw cleanupFailure;
}

async function main(platform) {
  requireHostedRunner(process.env, platform);
  const repo = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
  const source = command("git", ["-C", repo, "rev-parse", "HEAD"]);
  const output = path.join(repo, ".tools/distribution/output");
  const manifest = JSON.parse(await readFile(path.join(output, "manifest.json"), "utf8"));
  const config = JSON.parse(await readFile(path.join(repo, "src-tauri/tauri.conf.json"), "utf8"));
  requireCandidate(manifest, config, platform, source, process.env);
  await hash(path.join(output, manifest.updateArchive), manifest.updateArchiveSha256);
  const temporary = await realpath(process.env.RUNNER_TEMP);
  if ((await lstat(temporary)).isSymbolicLink())
    throw new Error("Runner temporary root must not be an alias");
  const fixture = path.join(
    temporary,
    `mogledge-native-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-${platform}`,
  );
  requireContained(temporary, fixture);
  await mkdir(fixture);
  const reportDirectory = path.join(repo, ".tools/distribution/native-probe");
  await mkdir(reportDirectory, { recursive: true });
  const checks = [];
  const report = {
    schemaVersion: 1,
    platform,
    sourceSha: source,
    version: manifest.version,
    legacySourceSha: OLD_SOURCE,
    legacyAssetSha256: legacyAssets[platform].sha256,
    candidateArchiveSha256: manifest.updateArchiveSha256,
    status: "failed",
    checks,
    limits: [
      "No user-device installation or profile was accessed",
      "Updater UI/signature handoff and login-session behavior not exercised",
      "Mac legacy LaunchAgent safe-stop is covered separately; this probe does not exercise its UI",
      "Window and database observation is a startup smoke check, without settings or document interactions",
      "Physical input, native pickers and media not exercised",
    ],
  };
  try {
    report.failedStage = "legacy-download";
    const legacy = await downloadLegacy(platform, fixture);
    if (platform === "windows-x64") {
      report.failedStage = "windows-helper-preflight";
      try {
        command(
          "pwsh",
          [
            "-NoProfile",
            "-File",
            path.join(repo, "scripts/distribution/native-probe.ps1"),
            "-OutputDirectory",
            output,
            "-FixtureRoot",
            fixture,
            "-LegacyInstaller",
            legacy,
            "-ExpectedSource",
            source,
            "-ExpectedVersion",
            manifest.version,
          ],
          12 * 60_000,
        );
      } catch (error) {
        const reasons = [
          ["Disposable matching approved", "hosted-source-guard"],
          ["exclusive ordinary runner temporary fixture", "fixture-guard"],
          ["Only the current candidate output", "candidate-output-guard"],
          ["Candidate manifest/configuration mismatch", "candidate-manifest-guard"],
          ["Candidate or pinned legacy installer hash mismatch", "installer-hash-guard"],
        ];
        const reason = reasons.find(([message]) => String(error.stderr ?? "").includes(message));
        if (reason) report.failedStage = reason[1];
        const failed = (await exists(path.join(fixture, "windows-result.json")))
          ? JSON.parse(await readFile(path.join(fixture, "windows-result.json"), "utf8"))
          : {};
        if (/^[a-z-]+$/.test(failed.failedStage ?? "")) report.failedStage = failed.failedStage;
        if (
          Array.isArray(failed.checks) &&
          failed.checks.every((check) => /^[a-z0-9-]+$/.test(check))
        )
          checks.push(...failed.checks);
        throw new Error("Native Windows stage failed");
      }
      const windows = JSON.parse(await readFile(path.join(fixture, "windows-result.json"), "utf8"));
      if (windows.status !== "passed" || !Array.isArray(windows.checks))
        throw new Error("Native Windows report did not pass");
      checks.push(...windows.checks);
    } else await macProbe(platform, manifest, output, fixture, legacy, checks, report);
    delete report.failedStage;
    report.status = "passed";
  } catch {
    throw new Error(`Native ${platform} probe failed; uncompleted checks remain unverified`);
  } finally {
    await writeFile(
      path.join(reportDirectory, `${platform}.json`),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  console.log(
    `Native ${platform} bounded probe passed (${checks.length} checks); full device QA remains separate`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch((error) => {
    // Filesystem and child-process exceptions may contain private paths. Reports
    // contain only fixed check labels; never echo the underlying exception text.
    console.error(
      error.message === "Disposable matching GitHub-hosted runner required"
        ? error.message
        : "Native probe failed or prerequisites were unavailable; incomplete checks remain unverified",
    );
    process.exitCode = 1;
  });
}
