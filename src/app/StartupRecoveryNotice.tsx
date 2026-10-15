import type { StartupRecovery } from "../lib/types";
import { useT } from "../lib/i18n";
import { useLayoutEffect, useRef } from "react";
import { StorageIdentityAction } from "./StorageIdentityAction";

const messages: Record<StartupRecovery["reason"], string> = {
  storageIdentityConfirmationRequired:
    "保存データの識別方式を確認する必要があります。データは保持されています。アプリを終了し、保存データの移行手順を確認してください。",
  confirmationRequired: "保存フォルダーの確認が必要です。選び直してください。",
  pathUnavailable:
    "保存フォルダーにアクセスできません。名前・場所やドライブ接続を確認してください。",
  permissionDenied: "保存フォルダーを読み取る権限がありません。アクセス権を確認してください。",
  syncUnavailable:
    "保存フォルダーの同期サービスを利用できません。接続・同期状態を確認してください。",
  unsupportedRoot: "保存フォルダーは安全に開けません。通常のフォルダーを選び直してください。",
  identityChanged: "保存フォルダーが別のフォルダーに置き換わっています。選び直してください。",
  unavailable: "保存フォルダーを開けません。接続・アクセス状態を確認するか、選び直してください。",
};
export function StartupRecoveryNotice({
  recovery,
  loading,
  onRetry,
  onChoose,
  platform,
}: {
  recovery: StartupRecovery;
  loading: boolean;
  onRetry: () => void;
  onChoose: () => void;
  platform?: string;
}) {
  const t = useT();
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    if (loading) return;
    const button = returnFocus.current;
    returnFocus.current = null;
    // Disabling the action blurs it in Chromium. Restore keyboard focus only
    // while focus is otherwise idle; do not interrupt another control.
    if (button?.isConnected && document.activeElement === document.body) button.focus();
  }, [loading]);
  const invoke = (button: HTMLButtonElement, action: () => void) => {
    returnFocus.current = document.activeElement === button ? button : null;
    action();
  };
  return (
    <div className="workspace-feedback">
      <p role="status">{t(messages[recovery.reason])}</p>
      {recovery.canRetry && (
        <button disabled={loading} onClick={(event) => invoke(event.currentTarget, onRetry)}>
          {t("保存フォルダーを再試行")}
        </button>
      )}
      {recovery.reason === "storageIdentityConfirmationRequired" ? (
        <StorageIdentityAction platform={platform} />
      ) : (
        <button disabled={loading} onClick={(event) => invoke(event.currentTarget, onChoose)}>
          {t("Mogledge 専用フォルダーを管理")}
        </button>
      )}
    </div>
  );
}
