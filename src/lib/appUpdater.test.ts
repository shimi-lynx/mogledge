import { expect, test, vi } from "vite-plus/test";
import { invoke } from "@tauri-apps/api/core";
import { appUpdaterApi } from "./appUpdater";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

test("update and restart invokes the Native command without a save-confirmation argument", async () => {
  vi.mocked(invoke).mockResolvedValue({ phase: "installing" });
  await appUpdaterApi.restart();
  expect(invoke).toHaveBeenCalledExactlyOnceWith("restart_app_update");
});
