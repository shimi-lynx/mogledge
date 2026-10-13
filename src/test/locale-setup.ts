import { beforeEach } from "vite-plus/test";
import { setLanguage } from "../lib/i18n";

// Existing behavior regressions use an explicit Japanese fixture. First-launch
// defaults are tested separately without relying on this fixture preference.
beforeEach(() => setLanguage("ja"));
