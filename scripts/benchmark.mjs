import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
const root = resolve(".tools/benchmark-knowledge");
mkdirSync(root, { recursive: true });
for (let folder = 0; folder < 100; folder++) {
  const dir = resolve(root, "Folder" + String(folder).padStart(3, "0"));
  mkdirSync(dir, { recursive: true });
  for (let file = 0; file < 100; file++) {
    writeFileSync(
      resolve(dir, "Document" + String(file).padStart(3, "0") + ".html"),
      "<!doctype html><title>Benchmark</title><h1>Local document</h1>",
    );
  }
}
writeFileSync(
  resolve(root, "Benchmark.html"),
  "<!doctype html><meta charset=utf-8><title>100KB document</title><h1 id=ready>Ready</h1><!--" +
    "x".repeat(100000) +
    "-->",
);
const result = spawnSync(
  "npm",
  ["run", process.argv.includes("--production") ? "test:production" : "test:e2e"],
  {
    shell: process.platform === "win32",
    stdio: "inherit",
    env: { ...process.env, MY_KNOWLEDGE_BENCH_ROOT: root },
  },
);
process.exitCode = result.status ?? 1;
