import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, writeFile, mkdir, readFile, rm, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  artifactName,
  artifactUrl,
  endpoint,
  fixtureServer,
  identity,
  qaTemplate,
} from "./updater-qa.mjs";

test("QA installer identity and loopback URLs match the isolated native policy", async () => {
  const policy = await readFile(new URL("../src-tauri/src/updater_qa.rs", import.meta.url), "utf8");
  for (const value of [
    identity.identifier,
    identity.productName,
    identity.mainBinaryName,
    endpoint,
    artifactUrl,
  ])
    assert.ok(policy.includes(JSON.stringify(value)), value);
  const original = await readFile(
    new URL("../src-tauri/windows/installer.nsi", import.meta.url),
    "utf8",
  );
  const template = qaTemplate(original);
  assert.equal(template.includes('!define INSTALLIDENTITY "My Knowledge"'), false);
  assert.ok(template.includes('!define INSTALLIDENTITY "MogledgeUpdaterQA"'));
  assert.equal(
    template.replace(
      '!define INSTALLIDENTITY "MogledgeUpdaterQA"',
      '!define INSTALLIDENTITY "My Knowledge"',
    ),
    original,
  );
  const cargo = await readFile(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8");
  assert.doesNotMatch(
    cargo.match(/^default\s*=.*$/m)[0],
    /updater-loopback-qa|distribution-updater/,
  );
});

test("loopback fixture serves an allowlist and models rejection cases without modifying retained bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mogledge-updater-fixture-"));
  const events = [];
  const server = fixtureServer(root, (event) => events.push(event));
  try {
    await mkdir(path.join(root, "serve"));
    const bytes = Buffer.from("retained unsigned synthetic unit fixture");
    await writeFile(path.join(root, "serve", artifactName), bytes);
    await writeFile(
      path.join(root, "serve/latest.json"),
      JSON.stringify({
        version: "0.8.0",
        platforms: {
          "windows-x86_64": {
            url: artifactUrl,
            signature: "public-unit-fixture-not-a-valid-signature",
          },
        },
      }),
    );
    const mode = (scenario) =>
      writeFile(path.join(root, "control.json"), JSON.stringify({ scenario }));
    await mode("good");
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    assert.equal(server.address().address, "127.0.0.1");
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${base}/latest.json`)).status, 200);
    assert.deepEqual(
      Buffer.from(await (await fetch(`${base}/${artifactName}`)).arrayBuffer()),
      bytes,
    );
    for (const route of [
      "/",
      "/control.json",
      "/../control.json",
      "/latest.json?query=1",
      "/private.key",
    ])
      assert.equal((await fetch(base + route)).status, 404);
    assert.equal((await fetch(`${base}/latest.json`, { method: "POST" })).status, 404);
    await mode("no-update");
    assert.equal((await fetch(`${base}/latest.json`)).status, 204);
    await mode("error");
    assert.equal((await fetch(`${base}/latest.json`)).status, 503);
    await mode("tampered");
    assert.notDeepEqual(
      Buffer.from(await (await fetch(`${base}/${artifactName}`)).arrayBuffer()),
      bytes,
    );
    assert.deepEqual(await readFile(path.join(root, "serve", artifactName)), bytes);
    await mode("signed-version-mismatch");
    assert.equal((await (await fetch(`${base}/latest.json`)).json()).version, "0.8.1");
    await mode("external-artifact");
    assert.equal(
      (await (await fetch(`${base}/latest.json`)).json()).platforms["windows-x86_64"].url,
      "https://updates.invalid/never-request.exe",
    );
    await mode("redirect-manifest");
    assert.equal((await fetch(`${base}/latest.json`, { redirect: "manual" })).status, 302);
    assert.ok(events.some((event) => event.route === "rejected"));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mogledge-updater-fixture-"));
    assert.equal((await lstat(root)).isSymbolicLink(), false);
    await rm(root, { recursive: true, force: true });
  }
});
