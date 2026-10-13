import { useLayoutEffect, useRef, useState } from "react";
import type { KnowledgeController } from "../lib/controller";
import type { TransferView } from "../lib/stateTransfer";
import { useT, useLanguage, translateUiMessage } from "../lib/i18n";
import "./app-help.css";

export default function StateTransferDialog({
  view,
  controller,
}: {
  view: TransferView;
  controller: KnowledgeController;
}) {
  const t = useT();
  const language = useLanguage();
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [unknownAccepted, setUnknownAccepted] = useState(false);
  const [replace, setReplace] = useState(false);
  const [stopReload, setStopReload] = useState(false);
  const terminal = ["completed", "cancelled", "failed"].includes(view.phase);
  const preview = view.preview;
  useLayoutEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement;
    element.showModal();
    cancel.current?.focus();
    return () => {
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  const dismiss = () =>
    terminal ? controller.dismissStateTransfer() : void controller.cancelStateTransfer();
  return (
    <dialog
      ref={dialog}
      className="app-help state-transfer"
      aria-labelledby="state-transfer-title"
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key !== "Tab" || event.nativeEvent.isComposing) return;
        const buttons = [
          ...dialog.current!.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), [tabindex="0"]',
          ),
        ];
        const edge = event.shiftKey ? buttons[0] : buttons.at(-1);
        if (document.activeElement === edge) {
          event.preventDefault();
          (event.shiftKey ? buttons.at(-1) : buttons[0])?.focus();
        }
      }}
    >
      <header className="app-help-header">
        <h1 id="state-transfer-title">
          {view.kind === "import" ? t("保存済み入力を取り込む") : t("保存済み入力を書き出す")}
        </h1>
        <button ref={cancel} onClick={dismiss}>
          {terminal ? t("閉じる") : t("取消")}
        </button>
      </header>
      <div className="app-help-content" tabIndex={0} aria-label={t("入力転送の確認")}>
        <p>{view.path}</p>
        <p>
          {t(
            "信頼できるHTMLと保存ファイルだけを選んでください。対象は確定済みの保存状態です。入力欄・Canvas・JavaScriptの全状態や未確認writeを保全する機能ではありません。保存ack・未保存入力の有無は不明です。",
          )}
        </p>
        <p>
          {t(
            "書き出しとbackupは平文JSONです。個人情報を含むことがあるため保管先を確認してください。HTML原本は変更しません。",
          )}
        </p>
        {view.fileName && <p>{t("選択ファイル: {name}", { name: view.fileName })}</p>}
        {view.backupName && <p>{t("新しいbackup先: {name}", { name: view.backupName })}</p>}
        {view.message && <p role="status">{translateUiMessage(view.message, language)}</p>}
        {view.phase === "selecting" && (
          <p role="status">{t("Native画面で選択・対象確認中です。")}</p>
        )}
        {view.phase === "backup" && (
          <button disabled={view.busy} onClick={() => void controller.chooseStateTransferBackup()}>
            {t("新しいbackup先を選ぶ")}
          </button>
        )}
        {preview && (
          <section aria-label={t("転送する保存状態")}>
            <p>
              {t("{bytes} bytes・{count} appId", {
                bytes: preview.logicalBytes.toLocaleString(language),
                count: preview.incomingApps.length,
              })}
            </p>
            {preview.source && (
              <p>
                {t(
                  "書出元の相対パス: {path}・保存revision {revision}（来歴のみで、取り込み先の権限ではありません）",
                  { path: preview.source.relativePath, revision: preview.source.revision },
                )}
              </p>
            )}
            <ul>
              {preview.incomingApps.map((app) => (
                <li key={app.appId}>
                  {t("{appId}（schema {version}）", {
                    appId: app.appId,
                    version: app.schemaVersion,
                  })}
                </li>
              ))}
            </ul>
            <p>
              {t(
                "実表示view: 表示中{active}件／非表示{hidden}件、外部browser grant {grants}件、進行中open {opening}件。保存ackはすべて不明です。",
                {
                  active: preview.affectedViews.filter((view) => view.visibility === "active")
                    .length,
                  hidden: preview.affectedViews.filter((view) => view.visibility === "hidden")
                    .length,
                  grants: preview.browserGrants,
                  opening: preview.openingRequests,
                },
              )}
            </p>
            {preview.replacesExisting && (
              <label>
                <input
                  type="checkbox"
                  checked={replace}
                  disabled={view.phase !== "preview"}
                  onChange={(event) => setReplace(event.target.checked)}
                />
                {t(
                  "既存の全appIdの保存状態を置換し、新しい平文backupへ保全することを確認しました（{count} appId）。",
                  { count: preview.previousApps?.length ?? 0 },
                )}
              </label>
            )}
            {preview.stopReloadRequired && (
              <p>
                <label>
                  <input
                    type="checkbox"
                    checked={stopReload}
                    disabled={view.phase !== "preview"}
                    onChange={(event) => setStopReload(event.target.checked)}
                  />
                  {t(
                    "別の確認: 対象の表示中・非表示・外部browserの保存権限を停止し、同identityの実表示タブを再読み込みします。未保存入力・Canvas・JS実行状態を失う可能性を了承しました。未表示の作業セットは読み込みません。",
                  )}
                </label>
              </p>
            )}
            {view.kind === "import" && ["preview", "unknown"].includes(view.phase) && (
              <p>
                <button
                  disabled={view.busy || view.checking}
                  onClick={() => void controller.verifyStateTransferCurrentValues()}
                >
                  {t("選択ファイルと現在値を照合")}
                </button>
              </p>
            )}
            {view.phase === "preview" && (
              <button
                disabled={
                  view.busy ||
                  view.checking ||
                  (preview.replacesExisting && !replace) ||
                  (preview.stopReloadRequired && !stopReload)
                }
                onClick={() => void controller.confirmStateTransfer(replace, stopReload)}
              >
                {view.kind === "import" ? t("確認した内容で取り込む") : t("確認した内容で書き出す")}
              </button>
            )}
          </section>
        )}
        {view.phase === "processing" && (
          <p role="status">{t("処理中です。取消要求の後にもcommitが完了することがあります。")}</p>
        )}
        {view.phase === "unknown" && (
          <>
            <p>
              {t(
                "処理結果は不明です。自動再実行しません。照会で完了・取消・失敗を確認してください。アプリ終了後は再選択による現在値照合が必要で、過去の実行を証明するものではありません。",
              )}
            </p>
            <button disabled={view.busy} onClick={() => void controller.verifyStateTransfer()}>
              {t("処理結果を照会")}
            </button>
            <p>
              <label>
                <input
                  type="checkbox"
                  checked={unknownAccepted}
                  onChange={(event) => setUnknownAccepted(event.target.checked)}
                />
                {t(
                  "結果不明のまま閉じることを理解しました。取消要求を送り、表示タブは自動復旧しません。",
                )}
              </label>
            </p>
            <button
              disabled={view.busy || !unknownAccepted}
              onClick={() => controller.dismissUnknownStateTransfer()}
            >
              {t("結果不明のまま閉じる")}
            </button>
          </>
        )}
      </div>
    </dialog>
  );
}
