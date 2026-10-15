import { beforeEach, expect, test, vi } from "vite-plus/test";
import { invoke } from "@tauri-apps/api/core";
import { appUpdaterApi, updateDiagnostic } from "./appUpdater";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

test("update and restart invokes the Native command without a save-confirmation argument", async () => {
  vi.mocked(invoke).mockResolvedValue({ phase: "installing" });
  await appUpdaterApi.restart();
  expect(invoke).toHaveBeenCalledExactlyOnceWith("restart_app_update");
});

test("help invokes only the fixed destination command without an arbitrary URL", async () => {
  for (const destination of ["releases", "manual"] as const) {
    vi.mocked(invoke).mockClear();
    await appUpdaterApi.openHelp(destination);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("open_app_update_help", { destination });
  }
});

test("install diagnostics explain only recognized failure types without native details", () => {
  expect(updateDiagnostic("UpdateInstallLocationUnavailable")).toContain("同じボリューム");
  expect(updateDiagnostic("UpdatePreviousAppNotRestored")).toContain(
    "旧アプリを元の場所へ戻せません",
  );
  expect(updateDiagnostic("UpdateInstallFailed")).toBe(
    "更新を適用できません。現在のアプリと配布元の手動復旧手順を確認してください。",
  );
  for (const detail of [
    "PreviousAppNotRestored(/Users/private/old.app)",
    "TempDirNotOnSameMountPoint: /private/secret",
    "UpdatePreviousAppNotRestored: /private/old.app",
    { path: "/private/old.app" },
    "constructor",
  ]) {
    expect(updateDiagnostic(detail)).toBe(
      "更新の状態を確認できません。Nativeアプリで設定を開き直してください。",
    );
  }
});
