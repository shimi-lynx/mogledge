import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // Legal documents must retain the exact upstream bytes used by the collector.
  fmt: {
    ignorePatterns: [
      "src-tauri/vendor/**",
      "scripts/distribution/materials/**/LICENSE.md",
      "scripts/distribution/materials/**/RUST-REUSE-reference.toml",
    ],
  },
  lint: {
    ignorePatterns: ["src-tauri/vendor/**"],
    options: { typeAware: true, typeCheck: true, denyWarnings: true },
    rules: { eqeqeq: "error", "no-var": "error", "prefer-const": "error" },
  },
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/.tools/**", "**/src-tauri/**"] },
  },
  envPrefix: ["VITE_"],
  build: { target: ["es2022", "safari15"], sourcemap: false },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test/locale-setup.ts"],
  },
});
