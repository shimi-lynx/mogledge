import { useEffect, useRef, useState } from "react";
import { useT } from "../lib/i18n";
import {
  appUpdaterApi,
  updateDiagnostic,
  type AppUpdaterApi,
  type UpdateSnapshot,
} from "../lib/appUpdater";

export function AppUpdateSettings({ api = appUpdaterApi }: { api?: AppUpdaterApi }) {
  const t = useT();
  const [snapshot, setSnapshot] = useState<UpdateSnapshot | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState<string | null>(null);
  const mounted = useRef(false);
  const operation = useRef(0);
  const inFlight = useRef<string | null>(null);
  const revision = useRef(-1);
  const accept = (value: UpdateSnapshot) => {
    if (!mounted.current || value.revision < revision.current) return;
    revision.current = value.revision;
    setSnapshot(value);
  };
  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    // Subscribe before reading status so a completed action cannot be lost.
    void api
      .subscribe((value) => {
        if (!disposed) accept(value);
      })
      .then(async (stop) => {
        if (disposed) {
          stop();
          return;
        }
        unsubscribe = stop;
        const value = await api.status();
        if (!disposed) accept(value);
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(cause);
      });
    return () => {
      disposed = true;
      mounted.current = false;
      unsubscribe?.();
    };
  }, [api]);
  const run = async (action: "check" | "download" | "cancel" | "restart") => {
    if (inFlight.current === "restart") return;
    if (inFlight.current && action !== "cancel") return;
    if (action === "cancel" && inFlight.current === "cancel") return;
    const id = ++operation.current;
    inFlight.current = action;
    setPending(action);
    setError(null);
    try {
      accept(await api[action]());
    } catch (cause) {
      if (mounted.current && id === operation.current) setError(cause);
    } finally {
      if (id === operation.current) {
        inFlight.current = null;
        if (mounted.current) setPending(null);
      }
    }
  };

  const phase = snapshot?.phase;
  const busy =
    pending !== null || phase === "checking" || phase === "downloading" || phase === "installing";
  const disabled = !snapshot || phase === "disabled";
  const canCancel =
    !!snapshot && ["checking", "available", "downloading", "ready"].includes(snapshot.phase);
  const total = snapshot?.totalBytes;
  const downloaded = snapshot?.downloadedBytes ?? 0;
  const phaseText =
    phase === "checking"
      ? "更新を確認中"
      : phase === "downloading"
        ? "ダウンロードと署名検証中"
        : phase === "ready"
          ? "署名検証が完了しました。更新して再起動できます。"
          : phase === "installing"
            ? "更新を適用して再起動中"
            : phase === "upToDate"
              ? "利用できる更新はありません"
              : phase === "cancelled"
                ? "更新を取り消しました。アプリは変更されていません。"
                : null;
  const disabledText =
    snapshot?.disabledReason === "unconfigured"
      ? "配布URLまたは更新用公開鍵が未設定のため、アプリ内更新は無効です。配布元の案内を確認してください。"
      : snapshot?.disabledReason === "unsupported"
        ? "アプリ内更新はWindowsとmacOSの対応配布版で利用できます"
        : snapshot?.disabledReason === "appOnly"
          ? "この単体アプリは更新対象ではありません。配布元の手動更新手順を利用してください。"
          : "このビルドではアプリ内更新を利用できません。独自ビルドは自動で配布版へ置換しません。ソースまたは配布元の手動更新手順を利用してください。";
  const diagnostic = error ?? snapshot?.error;
  return (
    <section
      id="settings-app-update-panel"
      className="app-update-settings"
      aria-labelledby="settings-app-update-heading"
    >
      <h2 id="settings-app-update-heading">{t("アプリの更新")}</h2>
      <p>{t("設定画面から手動で確認します。起動時や常駐中に自動確認しません。")}</p>
      {snapshot && <p>{t("現在のバージョン: {version}", { version: snapshot.currentVersion })}</p>}
      {!snapshot && !error && <p role="status">{t("更新の設定を読み込み中")}</p>}
      {phase === "disabled" && <p>{t(disabledText)}</p>}
      {phaseText && <p role="status">{t(phaseText)}</p>}
      {diagnostic && <p role="alert">{t(updateDiagnostic(diagnostic))}</p>}
      {snapshot?.release && (
        <div className="app-update-release">
          <h3>{t("更新バージョン: {version}", { version: snapshot.release.version })}</h3>
          <h4>{t("更新内容")}</h4>
          <p className="app-update-notes">
            {snapshot.release.notes || t("更新内容は配布元から提供されていません")}
          </p>
        </div>
      )}
      {phase === "downloading" && (
        <div>
          <progress
            aria-label={t("ダウンロード進捗")}
            value={total ? Math.min(downloaded, total) : undefined}
            max={total || undefined}
          />
          <p>
            {total
              ? t("{downloaded} / {total} MiB", {
                  downloaded: (downloaded / 1048576).toFixed(1),
                  total: (total / 1048576).toFixed(1),
                })
              : t("{downloaded} MiB ダウンロード済み（総容量は不明）", {
                  downloaded: (downloaded / 1048576).toFixed(1),
                })}
          </p>
        </div>
      )}
      {phase === "ready" && (
        <p id="settings-app-update-warning">
          {t("未保存の入力は失われます。必要な内容を保存してから更新してください。")}
        </p>
      )}
      <div className="resident-actions">
        <button
          type="button"
          disabled={disabled || busy || phase === "ready"}
          onClick={() => void run("check")}
        >
          {t("更新を確認")}
        </button>
        {phase === "available" && (
          <button type="button" disabled={busy} onClick={() => void run("download")}>
            {t("ダウンロードして更新")}
          </button>
        )}
        {phase === "ready" && (
          <button
            type="button"
            disabled={busy}
            aria-describedby="settings-app-update-warning"
            onClick={() => void run("restart")}
          >
            {t("更新して再起動")}
          </button>
        )}
        {canCancel && (
          <button
            type="button"
            disabled={pending === "cancel" || pending === "restart"}
            onClick={() => void run("cancel")}
          >
            {t("更新を取り消す")}
          </button>
        )}
      </div>
      {!disabled && (
        <p>
          {t(
            "ダウンロード後も再起動を選ぶまでアプリは変更しません。設定を閉じても処理は続き、開き直すと状態を確認できます。取消は適用開始前に行ってください。",
          )}
        </p>
      )}
    </section>
  );
}
