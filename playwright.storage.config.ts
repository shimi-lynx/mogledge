import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/storage",
  testMatch: "browser.spec.ts",
  timeout: 30000,
  workers: 1,
  reporter: "list",
  use: {
    browserName: "chromium",
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
  },
});
