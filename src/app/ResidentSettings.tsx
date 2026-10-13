import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useT, translateUiMessage } from "../lib/i18n";
import {
  residentApi,
  residentDiagnostic,
  residentShortcutFromKey,
  residentShortcutLabel,
  sameResidentShortcut,
  type ResidentAction,
  type ResidentApi,
  type ResidentStatus,
  type ResidentShortcut,
  type ResidentCustomShortcut,
} from "../lib/resident";
import type { AppState } from "../lib/types";

export function ResidentSettings({
  state,
  api = residentApi,
}: {
  state?: AppState;
  api?: ResidentApi;
}) {
  const t = useT();
  const [status, setStatus] = useState<ResidentStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shortcutMode, setShortcutMode] = useState<ResidentShortcut["kind"]>("standard");
  const [customShortcut, setCustomShortcut] = useState<ResidentCustomShortcut | null>(null);
  const [recording, setRecording] = useState(false);
  const [captureError, setCaptureError] = useState(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    void api
      .status()
      .then((value) => {
        if (mounted.current) {
          setStatus(value);
          setShortcutMode(value.shortcut.kind);
          if (value.shortcut.kind === "custom") setCustomShortcut(value.shortcut);
        }
      })
      .catch(() => {
        if (mounted.current) setError("常駐設定を読み取れません");
      });
    return () => {
      mounted.current = false;
    };
  }, [api]);
  const update = async (action: ResidentAction) => {
    if (busy) return;
    setRecording(false);
    setBusy(true);
    setError(null);
    try {
      const value = await api.update(action);
      if (mounted.current) {
        setStatus(value);
        if (action.kind === "shortcut" && !value.error) {
          setShortcutMode(value.shortcut.kind);
          if (value.shortcut.kind === "custom") setCustomShortcut(value.shortcut);
        }
      }
    } catch (cause) {
      if (mounted.current)
        setError(residentDiagnostic(typeof cause === "string" ? cause : "ResidentUnavailable"));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const disabled = busy || !status || !status.supported || status.readOnly;
  const selected = status?.target.kind === "pinned" ? status.target.document.relativePath : "";
  const diagnostic = error ?? (status?.error ? residentDiagnostic(status.error) : null);
  const proposedShortcut: ResidentShortcut | null =
    shortcutMode === "standard" ? { kind: "standard" } : customShortcut;
  const customActive = status?.shortcut.kind === "custom";
  const captureShortcut = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording || disabled) return;
    // Confine capture to this focused control; the dialog and app shortcuts must not run.
    event.stopPropagation();
    if (event.key === "Escape" && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      setRecording(false);
      setCaptureError(false);
      return;
    }
    if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey) {
      setRecording(false);
      return;
    }
    event.preventDefault();
    if (
      ["Control", "Alt", "Shift", "Meta"].includes(event.key) ||
      event.repeat ||
      event.nativeEvent.isComposing
    )
      return;
    const shortcut = residentShortcutFromKey(event.nativeEvent);
    if (!shortcut) {
      setCaptureError(true);
      return;
    }
    setCustomShortcut(shortcut);
    setCaptureError(false);
    setRecording(false);
  };
  const monitorText =
    status?.monitorStatus === "active"
      ? customActive
        ? "同時押しの呼び出しキーを待機しています"
        : "順次キー操作を待機しています"
      : status?.monitorStatus === "permission-required"
        ? "順次キー操作にはmacOSの入力監視の許可が必要です"
        : status?.monitorStatus === "unavailable"
          ? "呼び出しキーを利用できません。通常起動またはトレイから表示できます"
          : "常駐は無効です";
  return (
    <div className="resident-settings">
      <h2>{t("常駐と呼び出し")}</h2>
      {!status && !error && <p role="status">{t("常駐設定を読み込み中")}</p>}
      {status && !status.supported && (
        <p>{t("常駐はWindowsとmacOSのNativeアプリで利用できます")}</p>
      )}
      {diagnostic && (
        <p className="resident-warning" role="alert">
          {translateUiMessage(diagnostic)}
        </p>
      )}
      <div className="resident-group">
        <label className="resident-toggle">
          <input
            type="checkbox"
            checked={status?.enabled ?? false}
            disabled={disabled}
            onChange={(event) => void update({ kind: "enabled", enabled: event.target.checked })}
          />
          {t("アプリを常駐させる")}
        </label>
        <p>
          {t(
            "有効時は閉じるボタンでトレイに隠れます。トレイの表示で戻り、終了でアプリを終了します。",
          )}
        </p>
        <p className="resident-note">
          {t(
            "常駐中も開いているHTMLの処理は残ります。画面を隠すだけでCPU使用やメモリがなくなる保証はありません。",
          )}
        </p>
        {status?.enabled && !status.trayAvailable && (
          <p className="resident-warning" role="alert">
            {t("トレイを準備できないため画面を隠しません。通常起動で設定を変更できます。")}
          </p>
        )}
      </div>
      <div className="resident-group">
        <h3>{t("キー操作で呼び出す")}</h3>
        <p className="resident-status" role="status">
          {t(monitorText)}
        </p>
        <p role="status">
          {status?.shortcut.kind === "custom"
            ? t("有効な呼び出しキー: {shortcut}", {
                shortcut: residentShortcutLabel(status.shortcut),
              })
            : t("有効な呼び出しキー: 標準の順次押し")}
        </p>
        <div role="radiogroup" aria-label={t("呼び出しキーの方式")}>
          <label className="resident-toggle">
            <input
              type="radio"
              name="resident-shortcut"
              checked={shortcutMode === "standard"}
              disabled={disabled}
              onChange={() => {
                setShortcutMode("standard");
                setRecording(false);
                setCaptureError(false);
              }}
            />
            {t("標準の順次押し")}
          </label>
          <label className="resident-toggle">
            <input
              type="radio"
              name="resident-shortcut"
              checked={shortcutMode === "custom"}
              disabled={disabled}
              onChange={() => {
                setShortcutMode("custom");
                setRecording(false);
                setCaptureError(false);
              }}
            />
            {t("カスタムの同時押し")}
          </label>
        </div>
        {shortcutMode === "standard" ? (
          <>
            <p>
              {t(
                "Windows: Shift → Ctrl → Shift、macOS: Shift → Cmd → Shift。全キーを離してから、各キーを押して離してください。",
              )}
            </p>
            <p>
              {t(
                "全体1.5秒以内、各押下400ms以内。順に離してください。途中の通常キーや長い同時押しは取り消します。キー入力の内容は記録しません。",
              )}
            </p>
          </>
        ) : (
          <>
            <p>
              {t(
                "記録ボタンにフォーカスしたまま、Ctrl・Alt・Cmd/Winのいずれかと通常キーを同時に押してください。Shiftも追加できます。",
              )}
            </p>
            <p>
              {customShortcut
                ? t("適用するキー: {shortcut}", { shortcut: residentShortcutLabel(customShortcut) })
                : t("呼び出しキーは未記録です")}
            </p>
            <div className="resident-actions">
              <button
                type="button"
                disabled={disabled}
                onKeyDown={captureShortcut}
                onBlur={() => setRecording(false)}
                onClick={(event) => {
                  // macOS WebKit does not focus buttons on a pointer click.
                  // Recording remains scoped to this control's keyboard events.
                  event.currentTarget.focus();
                  setRecording(!recording);
                  setCaptureError(false);
                }}
              >
                {t(recording ? "記録中… Escapeで中止" : "呼び出しキーを記録")}
              </button>
            </div>
            {captureError && (
              <p role="alert">
                {t("Ctrl・Alt・Cmd/Winのいずれかと通常キーを組み合わせてください")}
              </p>
            )}
            <p>
              {t(
                "記録しただけでは変更しません。登録に成功しても、他のアプリのすべてのショートカットとの競合がないことは保証できません。",
              )}
            </p>
          </>
        )}
        <div className="resident-actions">
          <button
            type="button"
            disabled={
              disabled ||
              recording ||
              !proposedShortcut ||
              (!!status && sameResidentShortcut(status.shortcut, proposedShortcut))
            }
            onClick={() => {
              if (proposedShortcut) void update({ kind: "shortcut", shortcut: proposedShortcut });
            }}
          >
            {t(shortcutMode === "standard" ? "標準の順次押しに戻す" : "呼び出しキーを適用")}
          </button>
        </div>
        <p>{t("常駐OFFでは呼び出しキーを解除します。選んだ設定は次回起動にも引き継ぎます。")}</p>
        {status?.enabled && status.monitorStatus === "permission-required" && (
          <>
            <p>
              {t(
                "「入力監視の設定を開く」から、このアプリを利用者自身で許可してください。開けない場合は、macOSのプライバシーとセキュリティ（旧版ではセキュリティとプライバシー）→ 入力監視を開いてください。アプリは自動許可しません。許可後はここに戻り、「許可後に再確認」を押してください。",
              )}
            </p>
            <div className="resident-actions">
              <button
                type="button"
                disabled={disabled}
                onClick={() => void update({ kind: "openPermissionSettings" })}
              >
                {t("入力監視の設定を開く")}
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() => void update({ kind: "checkPermission" })}
              >
                {t("許可後に再確認")}
              </button>
            </div>
          </>
        )}
        {status?.enabled && status.monitorStatus === "unavailable" && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => void update({ kind: "checkPermission" })}
          >
            {t("呼び出しキーを再確認")}
          </button>
        )}
      </div>
      <div className="resident-group">
        <h3>{t("呼び出したときの表示")}</h3>
        <p className="resident-target resident-status" title={selected || undefined}>
          {selected ? t("固定したHTML: {path}", { path: selected }) : t("呼び出し時の表示を保持")}
        </p>
        <p>
          {t(
            "呼び出したときに表示するHTMLを固定します。固定しない場合は、現在の表示をそのまま使います。",
          )}
        </p>
        <div className="resident-actions">
          <button
            type="button"
            disabled={disabled || !selected}
            onClick={() => void update({ kind: "current" })}
          >
            {t("固定を解除")}
          </button>
          <button
            type="button"
            disabled={
              disabled ||
              !state?.selectedPath ||
              !state.snapshot.workspaceId ||
              state.loading ||
              state.actionBusy
            }
            onClick={() => {
              const snapshot = state?.snapshot;
              if (snapshot?.workspaceId && state?.selectedPath)
                void update({
                  kind: "pin",
                  workspaceId: snapshot.workspaceId,
                  viewId: snapshot.viewId,
                  revision: snapshot.revision,
                  relativePath: state.selectedPath,
                });
            }}
          >
            {t("このHTMLを固定")}
          </button>
        </div>
        <p>
          {t(
            "指定できるのは現在のルート内のHTML1つです。移動・削除・ルート変更で確認できなければ現在の表示を保持します。開いているタブを再利用します。",
          )}
        </p>
      </div>
      <div className="resident-group">
        <h3>{t("ログイン時の起動")}</h3>
        <label className="resident-toggle">
          <input
            type="checkbox"
            checked={status?.startupRegistered ?? status?.startupEnabled ?? false}
            disabled={disabled}
            onChange={(event) => void update({ kind: "startup", enabled: event.target.checked })}
          />
          {t("OSへのログイン時にアプリを起動する")}
        </label>
        {status && status.startupRegistered === null && (
          <p role="status">{t("OSの自動起動登録状態は不明です")}</p>
        )}
        <p>
          {t(
            "自動起動は常駐とは別の設定で、初期値は無効です。起動時は画面を表示します。開発用アプリでは登録しません。",
          )}
        </p>
      </div>
    </div>
  );
}
