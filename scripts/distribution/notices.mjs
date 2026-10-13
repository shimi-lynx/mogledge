import { cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

// This is a conservative inventory, not a determination that every obligation is met.
const licenseIds = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "Zlib",
  "Unicode-3.0",
  "Unicode-DFS-2016",
  "Unlicense",
  "CC0-1.0",
  "BSL-1.0",
  "MPL-2.0",
  "MIT-0",
]);

// Distinct opening/grant/disclaimer sections reject SPDX-only placeholders.
// This is a completeness guard; manual review still covers package-specific notices.
const textMarkers = {
  MIT: [
    /Permission is hereby granted/i,
    /The above copyright notice and this permission notice shall be included/i,
    /THE SOFTWARE IS PROVIDED/i,
    /IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE/i,
  ],
  "MIT-0": [/MIT No Attribution/i, /Permission is hereby granted/i, /THE SOFTWARE IS PROVIDED/i],
  "Apache-2.0": [/Apache License/i, /Version 2\.0/i, /END OF TERMS AND CONDITIONS/i],
  "BSD-2-Clause": [
    /Redistribution and use in source and binary forms/i,
    /THIS SOFTWARE IS PROVIDED/i,
  ],
  "BSD-3-Clause": [
    /Redistribution and use in source and binary forms/i,
    /Neither the name/i,
    /THIS SOFTWARE IS PROVIDED/i,
  ],
  ISC: [/Permission to use, copy, modify/i, /THE SOFTWARE IS PROVIDED/i],
  "0BSD": [/Permission to use, copy, modify/i, /THE SOFTWARE IS PROVIDED/i],
  Zlib: [/This software is provided/i, /origin of this software must not be misrepresented/i],
  "Unicode-3.0": [
    /UNICODE LICENSE V3/i,
    /Permission is hereby granted/i,
    /THE DATA FILES AND SOFTWARE ARE PROVIDED/i,
  ],
  "Unicode-DFS-2016": [
    /UNICODE, INC\. LICENSE AGREEMENT/i,
    /Permission is hereby granted/i,
    /THE DATA FILES AND SOFTWARE ARE PROVIDED/i,
  ],
  Unlicense: [
    /free and unencumbered software released into the public domain/i,
    /THE SOFTWARE IS PROVIDED/i,
  ],
  "CC0-1.0": [/Creative Commons/i, /Public License Fallback/i, /Limitations and Disclaimers/i],
  "BSL-1.0": [
    /Boost Software License/i,
    /Permission is hereby granted/i,
    /THE SOFTWARE IS PROVIDED/i,
  ],
  "MPL-2.0": [/Mozilla Public License Version 2\.0/i, /Exhibit A/i, /Exhibit B/i],
};

// SPDX precedence: WITH binds to one license, AND binds more tightly than OR.
// Legacy Cargo slash declarations are normalized only by pinned material reviews.
function parseLicense(expression) {
  if (typeof expression !== "string" || !expression.trim())
    throw new Error("Missing license expression");
  const tokens = expression
    .replace(/([()])/g, " $1 ")
    .trim()
    .split(/\s+/);
  let position = 0;
  const fail = () => {
    throw new Error(`License requires a separate distribution review: ${expression}`);
  };
  function operand() {
    if (tokens[position] === "(") {
      position += 1;
      const value = or();
      if (tokens[position++] !== ")") fail();
      return value;
    }
    const id = tokens[position++];
    if (!licenseIds.has(id)) fail();
    if (tokens[position] === "WITH") {
      position += 1;
      if (id !== "Apache-2.0" || tokens[position++] !== "LLVM-exception") fail();
      return { id: "Apache-2.0 WITH LLVM-exception" };
    }
    return { id };
  }
  function and() {
    let value = operand();
    while (tokens[position] === "AND") {
      position += 1;
      value = { operator: "AND", left: value, right: operand() };
    }
    return value;
  }
  function or() {
    let value = and();
    while (tokens[position] === "OR") {
      position += 1;
      value = { operator: "OR", left: value, right: and() };
    }
    return value;
  }
  const result = or();
  if (position !== tokens.length) fail();
  return result;
}

export function validateLicense(expression) {
  parseLicense(expression);
}

export function requireLicenseText(expression, texts) {
  const tree = parseLicense(expression);
  const contents = texts.map((text) => text.replace(/\s+/g, " "));
  function select(node) {
    if (node.id) {
      const markers =
        node.id === "Apache-2.0 WITH LLVM-exception"
          ? [
              ...textMarkers["Apache-2.0"],
              /LLVM Exceptions to the Apache 2.0 License/i,
              /without complying with the conditions of Sections 4\(a\), 4\(b\) and 4\(d\)/i,
              /only in their entirety and only with respect to the Combined Software/i,
            ]
          : textMarkers[node.id];
      // A single complete document must contain all sections. Do not assemble a
      // grant from fragments of unrelated licenses or SPDX metadata.
      if (
        !contents.some(
          (content) => content.length >= 500 && markers.every((marker) => marker.test(content)),
        )
      )
        throw new Error(`Missing complete license sections: ${node.id}`);
      return [node.id];
    }
    if (node.operator === "AND") return [...select(node.left), ...select(node.right)];
    try {
      return select(node.left);
    } catch (error) {
      if (!error.message.startsWith("Missing complete license sections:")) throw error;
      return select(node.right);
    }
  }
  return [...new Set(select(tree))];
}

export async function containedFile(root, relative) {
  if (path.isAbsolute(relative)) throw new Error("Absolute license path");
  if (relative.split(/[\\/]/).includes("..")) throw new Error("License path escapes package");
  let current = root;
  for (const component of relative.split(/[\\/]/)) {
    current = path.join(current, component);
    if ((await lstat(current)).isSymbolicLink())
      throw new Error("Legal text symlink requires review");
  }
  const base = await realpath(root);
  const file = await realpath(path.resolve(root, relative));
  const within = path.relative(base, file);
  if (!within || within.startsWith(`..${path.sep}`) || within === ".." || path.isAbsolute(within)) {
    throw new Error("License path escapes package");
  }
  return file;
}

export function cargoPackages(metadata) {
  return cargoPackageScopes(metadata).map(({ pkg }) => pkg);
}

export function cargoPackageScopes(metadata) {
  if (!metadata.resolve?.root) throw new Error("Cargo dependency graph missing");
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const scopes = new Map();
  function visit(id, scope) {
    const visited = scopes.get(id) ?? new Set();
    if (visited.has(scope)) return;
    visited.add(scope);
    scopes.set(id, visited);
    const node = nodes.get(id);
    if (!node || !packages.has(id)) throw new Error("Incomplete Cargo graph");
    for (const dependency of node.deps) {
      for (const { kind } of dependency.dep_kinds) {
        if (kind !== null && kind !== "build") continue;
        const procMacro = packages
          .get(dependency.pkg)
          ?.targets?.some((target) => target.kind.includes("proc-macro"));
        visit(
          dependency.pkg,
          scope === "build" || kind === "build" || procMacro ? "build" : "runtime",
        );
      }
    }
  }
  visit(metadata.resolve.root, "runtime");
  return metadata.packages
    .filter((pkg) => scopes.has(pkg.id) && pkg.id !== metadata.resolve.root)
    .map((pkg) => ({ pkg, scopes: [...scopes.get(pkg.id)].sort((a, b) => a.localeCompare(b)) }));
}

async function legalFiles(root, directory = "", depth = 0) {
  const result = [];
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (
      entry.isSymbolicLink() &&
      /^(licen[cs]e|unlicense|copying|notice|copyright|authors|legal)/i.test(entry.name)
    ) {
      throw new Error("Legal text symlink requires review");
    }
    if (
      entry.isFile() &&
      /^(licen[cs]e|unlicense|copying|notice|copyright|authors)([._-]|$)/i.test(entry.name)
    )
      result.push(relative);
    if (entry.isDirectory() && depth < 2 && /^(licen[cs]es?|legal|notices?)$/i.test(entry.name)) {
      result.push(...(await legalFiles(root, relative, depth + 1)));
    }
  }
  return result;
}

// Bind adoption to the complete pinned material record, including source/files,
// so updating a package cannot silently inherit an old packaging decision.
export function materialReviewHash(review) {
  const material = { ...review };
  delete material.adoptedReviewSha256;
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

export async function collectNotices(repo, destination, metadata, { diagnostic = false } = {}) {
  let materials = {};
  try {
    materials = JSON.parse(
      await readFile(path.join(repo, "scripts/distribution/materials/index.json"), "utf8"),
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const failures = [];
  const inventory = [];
  const used = new Set();
  async function collect(ecosystem, pkg, root, extraLicense, scopes) {
    const review = ecosystem === "cargo" ? materials[`${pkg.name}@${pkg.version}`] : undefined;
    let expression = pkg.license;
    if (review) {
      if (
        pkg.source !== "registry+https://github.com/rust-lang/crates.io-index" ||
        pkg.license !== review.declaredLicense
      )
        throw new Error("Reviewed package source/declaration mismatch");
      const lock = (await readFile(path.join(repo, "src-tauri/Cargo.lock"), "utf8")).replace(
        /\r\n/g,
        "\n",
      );
      const entry = lock
        .split("[[package]]")
        .find(
          (entry) =>
            entry.includes(`name = "${pkg.name}"\n`) &&
            entry.includes(`version = "${pkg.version}"\n`),
        );
      if (!entry?.includes(`checksum = "${review.crateChecksum}"`))
        throw new Error("Reviewed package lock checksum mismatch");
      if (review.sourceRevision) {
        const vcs = JSON.parse(
          await readFile(await containedFile(root, ".cargo_vcs_info.json"), "utf8"),
        );
        if (
          vcs.git?.sha1 !== review.sourceRevision ||
          (vcs.path_in_vcs ?? "") !== review.sourcePath
        )
          throw new Error("Reviewed package source revision mismatch");
      }
      expression = review.normalizedLicense ?? pkg.license;
    }
    validateLicense(expression);
    if (!/^[a-zA-Z0-9@/_.+-]+$/.test(pkg.name) || !/^[a-zA-Z0-9_.+-]+$/.test(pkg.version))
      throw new Error("Invalid package identity");
    const key = `${ecosystem}/${pkg.name.replaceAll("/", "__")}@${pkg.version}`;
    if (used.has(key)) throw new Error(`Duplicate package identity: ${key}`);
    used.add(key);
    const adoptedReview =
      review?.reviewRequired && review.adoptedReviewSha256 === materialReviewHash(review);
    const termEvidence = review?.termCompletenessEvidence ?? [];
    if (termEvidence.length && !adoptedReview)
      throw new Error("Term completeness evidence requires an adopted pinned record");
    const contains = (node, id) =>
      node.id === id || (node.operator && (contains(node.left, id) || contains(node.right, id)));
    for (const item of termEvidence) {
      if (
        !review.files.some((file) => file.path === item.path && file.referenceOnly === true) ||
        !contains(parseLicense(expression), item.declaredLicense)
      )
        throw new Error(
          "Term completeness evidence must match a declared alternative and retained reference",
        );
    }
    const files = await legalFiles(root);
    if (extraLicense && !files.includes(extraLicense)) files.push(extraLicense);
    const supplements = [];
    if (review) {
      for (const file of review.files) {
        const source = await containedFile(
          path.join(repo, "scripts/distribution/materials"),
          file.path,
        );
        const content = await readFile(source);
        if (createHash("sha256").update(content).digest("hex") !== file.sha256)
          throw new Error("Supplemental legal text checksum mismatch");
        supplements.push({ ...file, source });
      }
      for (const file of review.sdk?.matchedFiles ?? []) {
        const source = await containedFile(root, file.path);
        if (
          createHash("sha256")
            .update(await readFile(source))
            .digest("hex") !== file.sha256
        )
          throw new Error("Embedded SDK material checksum mismatch");
      }
    }
    // SPDX metadata alone does not retain copyright notices or full license text.
    if (
      ![
        ...files,
        ...supplements.filter((file) => !file.referenceOnly).map((file) => file.path),
      ].some((file) => /^(licen[cs]e|unlicense|copying)([._-]|$)/i.test(path.basename(file)))
    ) {
      throw new Error(`Missing full license text: ${key}`);
    }
    const output = path.join(destination, key);
    const texts = [];
    for (const file of files) {
      const source = await containedFile(root, file);
      const content = await readFile(source, "utf8");
      if (!content.trim()) throw new Error(`Empty legal text: ${key}`);
      if (!/\.spdx$/i.test(file)) texts.push(content);
      const target = path.join(output, file);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(source, target);
    }
    for (const file of supplements) {
      const target = path.join(output, "supplemental", file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(file.source, target);
      const term = termEvidence.find((item) => item.path === file.path);
      if (term) requireLicenseText(term.declaredLicense, [await readFile(file.source, "utf8")]);
      if ((!file.referenceOnly || term) && !/\.spdx$/i.test(file.path))
        texts.push(await readFile(file.source, "utf8"));
    }
    const selectedLicenses = requireLicenseText(expression, texts);
    // The owner adopted these existing texts/notices for packaging. Bind that
    // decision to the recorded note; changed or newly flagged material still stops.
    if (review?.reviewRequired && !adoptedReview)
      throw new Error(`Distribution review required: ${review.reviewRequired}`);
    const sourceIncluded =
      pkg.license.includes("MPL-2.0") || (ecosystem === "cargo" && !pkg.source);
    if (sourceIncluded) {
      // Includes patched wry and MPL sources; do not follow package symlinks.
      await cp(root, path.join(output, "source"), {
        recursive: true,
        dereference: false,
        filter: async (file) => {
          const stat = await lstat(file);
          if (stat.isSymbolicLink()) throw new Error(`Source symlink requires review: ${key}`);
          return path.basename(file) !== ".cargo-ok";
        },
      });
    }
    inventory.push({
      ecosystem,
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      selectedLicenses,
      scopes,
      ...(review
        ? { materialReview: `${pkg.name}@${pkg.version}`, supplementalFiles: review.files }
        : {}),
      ...(adoptedReview
        ? { reviewNote: review.reviewRequired, reviewPolicy: "existing-material-adopted" }
        : {}),
      ...(termEvidence.length ? { termCompletenessEvidence: termEvidence } : {}),
      legalFiles: files.map((file) => file.replaceAll(path.sep, "/")),
      sourceIncluded,
    });
  }
  async function attempt(ecosystem, pkg, root, extraLicense, scopes) {
    try {
      await collect(ecosystem, pkg, root, extraLicense, scopes);
    } catch (error) {
      if (!diagnostic) throw error;
      failures.push({
        ecosystem,
        name: pkg.name,
        version: pkg.version,
        license: pkg.license,
        scopes,
        ...(ecosystem === "cargo" && materials[`${pkg.name}@${pkg.version}`]?.reviewRequired
          ? { reviewRequired: materials[`${pkg.name}@${pkg.version}`].reviewRequired }
          : {}),
        error: error.message,
      });
    }
  }
  const lock = JSON.parse(await readFile(path.join(repo, "package-lock.json"), "utf8"));
  for (const [relative, locked] of Object.entries(lock.packages)) {
    if (!relative || locked.dev) continue;
    if (!relative.startsWith("node_modules/") || locked.link)
      throw new Error("Unsupported npm package location");
    const root = await containedFile(repo, relative);
    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    if (pkg.version !== locked.version) throw new Error("npm lock/version mismatch");
    await attempt("npm", pkg, root, undefined, ["runtime"]);
  }
  for (const { pkg, scopes } of cargoPackageScopes(metadata)) {
    await attempt("cargo", pkg, path.dirname(pkg.manifest_path), pkg.license_file, scopes);
  }
  inventory.sort((a, b) =>
    `${a.ecosystem}/${a.name}@${a.version}`.localeCompare(`${b.ecosystem}/${b.name}@${b.version}`),
  );
  await mkdir(destination, { recursive: true });
  if (diagnostic) {
    const report = { inventory, failures };
    await writeFile(
      path.join(destination, "diagnosis.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    return report;
  }
  await writeFile(path.join(destination, "index.json"), `${JSON.stringify(inventory, null, 2)}\n`);
  await writeFile(
    path.join(destination, "README.txt"),
    "Selected OR license branches are recorded in index.json; all collected license/copyright/NOTICE texts are retained beside each package. MPL-2.0 packages and local patched Cargo packages include corresponding source in source/ beside each package: recipients can obtain and modify that included source directly, with its original license/attribution notices preserved. MPL covered source remains governed by MPL-2.0. Scopes describe dependency-graph roles (including host proc-macros), not final linked binary contents. The accompanying source.zip contains the exact application revision and lockfiles. This conservative inventory includes normal and build Cargo dependencies. The owner adopted the retained material research; verify concrete required material inclusion and any newly bundled dependencies/components before redistribution. Recorded interpretation notes remain in index.json and are not legal certification.\n",
  );
  return inventory;
}
