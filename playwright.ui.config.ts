import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/ui",
  timeout: 30000,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:1420",
    browserName: "chromium",
    // Fix the locale of existing behavior fixtures independently of the app's
    // English first-launch default. Default-language tests clear this value.
    storageState: {
      cookies: [],
      origins: [
        {
          origin: "http://127.0.0.1:1420",
          localStorage: [{ name: "mogledge.ui-language", value: "ja" }],
        },
      ],
    },
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:1420",
    reuseExistingServer: false,
  },
});
