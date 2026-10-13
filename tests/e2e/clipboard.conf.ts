import { config as base } from "./wdio.conf.ts";
import { resolve } from "node:path";
if (
  process.platform !== "win32" ||
  process.env.MY_KNOWLEDGE_E2E_CLIPBOARD !== "1" ||
  process.env.MY_KNOWLEDGE_TEST_BINARY ||
  process.env.MY_KNOWLEDGE_BENCH_ROOT ||
  process.env.MY_KNOWLEDGE_CLOUD_FIXTURE_ROOT ||
  !process.env.MY_KNOWLEDGE_E2E_BINARY
)
  throw new Error("Explicit isolated Windows clipboard QA required");
delete process.env.MY_KNOWLEDGE_E2E_ACTION_CAPTURE;
export const config = { ...base, specs: [resolve("tests/e2e/clipboard.spec.ts")] };
