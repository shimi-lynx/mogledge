import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type UpdateSnapshot = {
  revision: number;
  phase:
    | "disabled"
    | "idle"
    | "checking"
    | "available"
    | "downloading"
    | "ready"
    | "installing"
    | "upToDate"
    | "cancelled"
    | "error";
  currentVersion: string;
  disabledReason: "selfBuild" | "unconfigured" | "unsupported" | "appOnly" | null;
  release: { version: string; notes: string } | null;
  downloadedBytes: number;
  totalBytes: number | null;
  error: string | null;
};
export type AppUpdaterApi = {
  status: () => Promise<UpdateSnapshot>;
  check: () => Promise<UpdateSnapshot>;
  download: () => Promise<UpdateSnapshot>;
  cancel: () => Promise<UpdateSnapshot>;
  restart: () => Promise<UpdateSnapshot>;
  openHelp: (destination: "releases" | "manual") => Promise<void>;
  subscribe: (receive: (snapshot: UpdateSnapshot) => void) => Promise<() => void>;
};
export const appUpdaterApi: AppUpdaterApi = {
  status: () => invoke("get_app_update_status"),
  check: () => invoke("check_app_update"),
  download: () => invoke("download_app_update"),
  cancel: () => invoke("cancel_app_update"),
  restart: () => invoke("restart_app_update"),
  openHelp: (destination) => invoke("open_app_update_help", { destination }),
  subscribe: (receive) =>
    listen<UpdateSnapshot>("app-update-status", (event) => receive(event.payload)),
};

const diagnostics: Readonly<Record<string, string>> = {
  UpdateDisabled: "このビルドではアプリ内更新を利用できません",
  UpdateBusy: "更新処理が進行中です",
  UpdateCheckFailed: "更新を確認できません。ネットワークと配布元を確認し、再試行してください。",
  UpdateDownloadFailed:
    "ダウンロードに失敗しました。アプリは変更されていません。更新を再確認してください。",
  UpdateSignatureInvalid:
    "更新の署名を検証できません。安全のため適用しません。配布元に確認してください。",
  UpdateTooLarge: "更新が256MiBの上限を超えています。手動更新の案内を確認してください。",
  UpdateSaveFailed:
    "アプリの設定を保存できないため更新を中止しました。設定を確認し、更新を再確認してください。",
  UpdateInstallFailed:
    "更新を適用できません。現在のアプリと配布元の手動復旧手順を確認してください。",
  UpdateInstallLocationUnavailable:
    "アプリと同じボリュームに更新用の一時領域を確保できません。現在のアプリと手動更新の案内を確認してください。",
  UpdatePreviousAppNotRestored:
    "更新に失敗し、退避した旧アプリを元の場所へ戻せませんでした。現在のアプリと保管された旧アプリを確認し、手動復旧の案内に従ってください。",
};
export function updateDiagnostic(error: unknown): string {
  // Native failures may include filesystem paths, URLs or signature details.
  return typeof error === "string" && Object.hasOwn(diagnostics, error)
    ? diagnostics[error]
    : "更新の状態を確認できません。Nativeアプリで設定を開き直してください。";
}
