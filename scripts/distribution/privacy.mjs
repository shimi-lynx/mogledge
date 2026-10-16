import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

// rustc applies the last matching textual prefix. Keep broad roots first and
// include both separator spellings because Cargo emits both on Windows.
export function pathRemappings(roots, platform = process.platform) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const remappings = [];
  for (const [name, replacement] of [
    ["home", "/build/home"],
    ["temporary", "/build/tmp"],
    ["cargo", "/cargo"],
    ["sysroot", "/rust-toolchain"],
    ["repository", "/mogledge"],
    ["target", "/build/target"],
  ]) {
    const original = roots[name];
    if (
      typeof original !== "string" ||
      !paths.isAbsolute(original) ||
      Array.from(original).some((character) => character.charCodeAt(0) < 0x20)
    )
      throw new Error("Expected an absolute build root without control characters");
    const normalized = paths.normalize(original).replace(/[\\/]+$/, "");
    if (!normalized || normalized === paths.parse(original).root.replace(/[\\/]+$/, ""))
      throw new Error("Cannot remap a filesystem root");
    const variants =
      platform === "win32"
        ? [normalized.replaceAll("\\", "/"), normalized.replaceAll("/", "\\")]
        : [normalized];
    for (const from of new Set(variants)) remappings.push({ name, from, to: replacement });
  }
  return remappings;
}

export function remappedBuildEnvironment(environment, remappings, platform = process.platform) {
  // Do not silently replace flags that could change target code generation or
  // quote/split whitespace differently from Cargo's encoded argument format.
  if (environment.RUSTFLAGS || environment.CARGO_ENCODED_RUSTFLAGS)
    throw new Error("Distribution builds require unset external Rust flags");
  const flags = remappings.map(({ from, to }) => `--remap-path-prefix=${from}=${to}`);
  if (platform === "win32") flags.push("-Clink-arg=/PDBALTPATH:%_PDB%");
  return { ...environment, CARGO_ENCODED_RUSTFLAGS: flags.join("\x1f") };
}

export function assertBinaryPrivacy(bytes, remappings) {
  // This final-byte check also catches paths introduced by native compilers,
  // generated literals or linkers, which rustc's remapping does not control.
  const texts = [
    bytes.toString("utf8").toLowerCase(),
    bytes.toString("utf16le").toLowerCase(),
    bytes.subarray(1).toString("utf16le").toLowerCase(),
  ];
  const roots = remappings.map(({ from }) => from.toLowerCase());
  for (const text of texts) {
    if (roots.some((root) => text.includes(root)))
      throw new Error("Executable retains a local build directory; values are redacted");
    if (/[a-z]:[\\/]users[\\/]|(?:^|[\0\s"'])\/(?:users|home)\//.test(text))
      throw new Error("Executable retains a personal-directory prefix; values are redacted");
  }
}

export function pathRemappingManifest(remappings) {
  return {
    rustScope: "all",
    roots: [...new Map(remappings.map(({ name, to }) => [name, { name, to }])).values()],
    finalBinaryCheck: "known build roots and personal-directory prefixes absent",
    debugSymbols: "kept outside candidate; Windows executable records only PDB basename",
  };
}

export function assertSourceArchivePaths(entries) {
  for (const entry of entries) {
    if (
      /(^|\/)(?:\.git|\.tools|\.codex)(?:\/|$)/i.test(entry) ||
      /(^|\/)AGENTS\.local\.md$/i.test(entry) ||
      /\.(?:pdb|dSYM|log)(?:\/|$)/i.test(entry) ||
      /(^|\/)\.env(?:$|\.(?!example$))/i.test(entry)
    )
      throw new Error("Source archive contains private configuration or build output");
  }
}

export async function assertCandidateLayout(staging, platform) {
  const app = platform === "windows-x64" ? "mogledge.exe" : "Mogledge.app";
  const expected = new Set([
    app,
    "manifest.json",
    "LICENSE",
    "BINARY-DISTRIBUTION.md",
    "source.zip",
    "third-party",
  ]);
  const entries = await readdir(staging);
  if (entries.length !== expected.size || entries.some((entry) => !expected.has(entry)))
    throw new Error("Candidate root contains missing or unexpected files");
  for (const entry of entries) {
    const stat = await lstat(path.join(staging, entry));
    const directory = entry === "third-party" || entry === "Mogledge.app";
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()))
      throw new Error("Unexpected candidate root entry type");
  }
  async function inspect(directory) {
    for (const entry of await readdir(directory)) {
      const file = path.join(directory, entry);
      const stat = await lstat(file);
      if (stat.isSymbolicLink()) throw new Error("Candidate symlink requires review");
      // Reject rather than silently removing files from legal/source material.
      if (/\.(?:pdb|dSYM|log)$/i.test(entry) || /^\.env(?:$|\.(?!example$))/i.test(entry))
        throw new Error("Candidate contains debug symbols, logs or private config");
      if (stat.isDirectory()) await inspect(file);
      else if (!stat.isFile()) throw new Error("Candidate contains a special filesystem entry");
    }
  }
  await inspect(staging);
}
