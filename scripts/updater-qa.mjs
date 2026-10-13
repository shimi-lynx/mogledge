import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const identity = {
  identifier: "com.shimilynx.mogledge.updaterqa",
  productName: "Mogledge Updater QA",
  mainBinaryName: "mogledge-updater-qa",
  installIdentity: "MogledgeUpdaterQA",
};
export const artifactName = "MogledgeUpdaterQA_0.8.0_x64-setup.exe";
export const endpoint = "http://127.0.0.1:47653/latest.json";
export const artifactUrl = `http://127.0.0.1:47653/${artifactName}`;
const repo = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const scenarios = new Set([
  "good",
  "no-update",
  "error",
  "tampered",
  "foreign-signature",
  "signed-version-mismatch",
  "external-artifact",
  "redirect-manifest",
  "redirect-artifact",
  "cancel",
]);

export function qaTemplate(source) {
  const original = '!define INSTALLIDENTITY "My Knowledge"';
  if (source.split(original).length !== 2) throw new Error("Expected production identity absent");
  return source.replace(original, `!define INSTALLIDENTITY "${identity.installIdentity}"`);
}

export async function prepare(directory, publicKeyPath) {
  const output = path.resolve(directory);
  await mkdir(output);
  const pubkey = (await readFile(publicKeyPath, "utf8")).trim();
  const box = Buffer.from(pubkey, "base64").toString("utf8").trim().split(/\r?\n/);
  const raw = Buffer.from(box[1] || "", "base64");
  if (
    box.length !== 2 ||
    !/^untrusted comment:.*public key/i.test(box[0]) ||
    raw.length !== 42 ||
    raw.subarray(0, 2).toString() !== "Ed"
  )
    throw new Error("Public-only key required");
  const template = qaTemplate(
    await readFile(path.join(repo, "src-tauri/windows/installer.nsi"), "utf8"),
  );
  await writeFile(path.join(output, "installer.qa.nsi"), template, { flag: "wx" });
  const config = {
    ...identity,
    bundle: {
      createUpdaterArtifacts: true,
      publisher: "Mogledge QA",
      windows: {
        webviewInstallMode: { type: "skip" },
        nsis: {
          installMode: "currentUser",
          template: path.join(output, "installer.qa.nsi"),
          displayLanguageSelector: false,
        },
      },
    },
    plugins: {
      updater: {
        pubkey,
        requireSignedVersion: true,
        dangerousInsecureTransportProtocol: true,
        endpoints: [endpoint],
        windows: { installMode: "passive", installerArgs: ["/NS"] },
      },
    },
  };
  delete config.installIdentity;
  await writeFile(path.join(output, "tauri.qa.json"), `${JSON.stringify(config, null, 2)}\n`, {
    flag: "wx",
  });
  // Signing is a later owner-input step; the compiled overlay still requires it.
  const unsignedBundle = structuredClone(config);
  unsignedBundle.bundle.createUpdaterArtifacts = false;
  await writeFile(
    path.join(output, "bundle-unsigned.qa.json"),
    `${JSON.stringify(unsignedBundle, null, 2)}\n`,
    { flag: "wx" },
  );
  await mkdir(path.join(output, "serve"));
  await writeFile(path.join(output, "control.json"), '{"scenario":"good"}\n', { flag: "wx" });
}

async function regular(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Regular fixture file required");
  return stat;
}

export function fixtureServer(directory, record = () => {}) {
  const root = path.resolve(directory);
  const serve = path.join(root, "serve");
  return createServer(async (request, response) => {
    try {
      const allowed =
        request.method === "GET" && ["/latest.json", `/${artifactName}`].includes(request.url);
      if (!allowed) {
        record({ route: "rejected", status: 404 });
        response.writeHead(404).end();
        return;
      }
      const { scenario } = JSON.parse(await readFile(path.join(root, "control.json"), "utf8"));
      if (!scenarios.has(scenario)) throw new Error("Unsupported scenario");
      record({ route: request.url === "/latest.json" ? "manifest" : "artifact", scenario });
      if (request.url === "/latest.json") {
        if (scenario === "no-update") {
          response.writeHead(204).end();
          return;
        }
        if (scenario === "error") {
          response.writeHead(503).end();
          return;
        }
        if (scenario === "redirect-manifest") {
          response.writeHead(302, { Location: `${endpoint}/not-allowed` }).end();
          return;
        }
        const file = path.join(serve, "latest.json");
        if ((await regular(file)).size > 65536) throw new Error("Fixture manifest limit exceeded");
        const manifest = JSON.parse(await readFile(file, "utf8"));
        if (
          manifest.version !== "0.8.0" ||
          manifest.platforms?.["windows-x86_64"]?.url !== artifactUrl ||
          typeof manifest.platforms["windows-x86_64"].signature !== "string"
        )
          throw new Error("Verified fixture manifest required");
        if (scenario === "signed-version-mismatch") manifest.version = "0.8.1";
        if (scenario === "external-artifact")
          manifest.platforms["windows-x86_64"].url = "https://updates.invalid/never-request.exe";
        if (scenario === "foreign-signature")
          manifest.platforms["windows-x86_64"].signature = (
            await readFile(path.join(root, "foreign-public-fixture.sig"), "utf8")
          ).trim();
        response.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        response.end(JSON.stringify(manifest));
        return;
      }
      if (scenario === "redirect-artifact") {
        response.writeHead(302, { Location: `${endpoint}/not-allowed` }).end();
        return;
      }
      const file = path.join(serve, artifactName);
      const stat = await regular(file);
      if (stat.size === 0 || stat.size > 256 * 1024 * 1024)
        throw new Error("Fixture artifact limit exceeded");
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": stat.size,
        "Cache-Control": "no-store",
      });
      const input = createReadStream(file, { highWaterMark: 65536 });
      response.on("close", () => input.destroy());
      let offset = 0;
      for await (const chunk of input) {
        if (response.destroyed) break;
        if (scenario === "tampered" && offset === 0) chunk[0] ^= 1;
        offset += chunk.length;
        response.write(chunk);
        if (scenario === "cancel") await new Promise((resolve) => setTimeout(resolve, 100));
      }
      response.end();
    } catch {
      if (!response.headersSent) response.writeHead(503);
      response.end();
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, directory, key] = process.argv.slice(2);
  if (action === "prepare" && directory && key) await prepare(directory, key);
  else if (action === "serve" && directory) {
    const server = fixtureServer(directory, (event) =>
      process.stdout.write(`${JSON.stringify(event)}\n`),
    );
    server.on("error", () => {
      process.stderr.write("QA_SERVER_START_FAILED\n");
      process.exitCode = 1;
    });
    server.listen(47653, "127.0.0.1", () => process.stdout.write("QA_LOOPBACK_SERVER_READY\n"));
  } else
    throw new Error(
      "Use prepare <new-fixture-directory> <public-key-file> or serve <fixture-directory>",
    );
}
