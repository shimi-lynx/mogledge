import {
  lazy,
  Suspense,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from "react";
import { useT } from "../lib/i18n";
import { ManagementSession, type ManagementContext } from "../lib/stateManagement";
import type { StorageLimitsSession } from "../lib/storageLimits";
import { HtmlAuthoringSettings } from "./HtmlAuthoringSettings";
import type { HtmlAuthoringApi, HtmlAuthoringContext } from "../lib/htmlAuthoring";
import { LanguagePicker } from "./LanguagePicker";
import { ResidentSettings } from "./ResidentSettings";
import type { AppState } from "../lib/types";
import type { WindowChrome } from "./windowChrome";
import type { AppUpdaterApi } from "../lib/appUpdater";
import "./settings-dialog.css";
const SavedDataSettings = lazy(() =>
  import("./SavedDataSettings").then((module) => ({ default: module.SavedDataSettings })),
);
const AppUpdateSettings = lazy(() =>
  import("./AppUpdateSettings").then((module) => ({ default: module.AppUpdateSettings })),
);

type SettingsPage = "language" | "folder" | "resident" | "html" | "savedData" | "update";
export type SettingsDialogHandle = { focus: (page?: SettingsPage) => void };

export function SettingsDialog({
  onClose,
  returnFocus,
  fallbackFocus,
  ref,
  state,
  rootContext = null,
  kitApi,
  managementContext,
  managementSession,
  limitsSession,
  updateApi,
  onRegisterRoot,
  initialPage = "language",
  platform = /Mac/i.test(navigator.platform) ? "macos" : "other",
}: {
  onClose: () => void;
  returnFocus: HTMLElement | null;
  fallbackFocus?: HTMLElement | null;
  ref?: Ref<SettingsDialogHandle>;
  state?: AppState;
  rootContext?: HtmlAuthoringContext | null;
  kitApi?: HtmlAuthoringApi;
  managementContext?: ManagementContext;
  managementSession?: ManagementSession;
  limitsSession?: StorageLimitsSession;
  updateApi?: AppUpdaterApi;
  onRegisterRoot?: () => void;
  initialPage?: SettingsPage;
  platform?: WindowChrome["platform"];
}) {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  const category = useRef<HTMLButtonElement>(null);
  const [page, setPage] = useState<SettingsPage>(initialPage);
  const hasRegisteredFolder = !!state?.snapshot.rootPath || !!state?.snapshot.startupRecovery;
  const [session] = useState(() => managementSession ?? new ManagementSession());
  const backdropPointer = useRef(false);
  const fallback = useRef(fallbackFocus);
  fallback.current = fallbackFocus;
  useImperativeHandle(
    ref,
    () => ({
      focus: (requestedPage) => {
        if (requestedPage) setPage(requestedPage);
        if (!dialog.current?.contains(document.activeElement)) category.current?.focus();
      },
    }),
    [],
  );
  const hitsBackdrop = (target: EventTarget | null, x: number, y: number) => {
    const element = dialog.current;
    if (!element || target !== element) return false;
    const bounds = element.getBoundingClientRect();
    return x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom;
  };
  useLayoutEffect(() => {
    const element = dialog.current!;
    const previous = returnFocus ?? document.activeElement;
    element.showModal();
    category.current?.focus();
    return () => {
      element.close();
      const available = (target: unknown): target is HTMLElement =>
        target instanceof HTMLElement && target.isConnected && !target.closest("[hidden], [inert]");
      const target = available(previous)
        ? previous
        : available(fallback.current)
          ? fallback.current
          : null;
      target?.focus();
      if (target instanceof HTMLIFrameElement) target.contentWindow?.focus();
    };
  }, [returnFocus]);
  return (
    <dialog
      ref={dialog}
      className="settings-dialog app-surface"
      data-platform={platform}
      aria-labelledby="settings-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onPointerDown={(event) => {
        backdropPointer.current = hitsBackdrop(event.target, event.clientX, event.clientY);
      }}
      onClick={(event) => {
        if (backdropPointer.current && hitsBackdrop(event.target, event.clientX, event.clientY))
          onClose();
        backdropPointer.current = false;
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
          return;
        }
        if (event.key !== "Tab") return;
        const controls = [
          ...dialog.current!.querySelectorAll<HTMLElement>(
            "button:not(:disabled), select:not(:disabled), input:not(:disabled)",
          ),
        ];
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey ? document.activeElement === first : document.activeElement === last) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        }
      }}
    >
      <header className="settings-header">
        <h1 id="settings-title">{t("設定")}</h1>
        {platform !== "macos" && (
          <button
            type="button"
            className="settings-close-icon"
            aria-label={t("閉じる")}
            title={t("閉じる")}
            onClick={onClose}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
              <path d="m5 5 10 10M15 5 5 15" />
            </svg>
          </button>
        )}
      </header>
      <div className="settings-columns">
        <nav aria-label={t("設定項目")}>
          <button
            ref={category}
            type="button"
            aria-current={page === "language" ? "page" : undefined}
            aria-controls="settings-language-panel"
            onClick={() => setPage("language")}
          >
            {t("表示言語を選択")}
          </button>
          <button
            type="button"
            aria-current={page === "folder" ? "page" : undefined}
            aria-controls="settings-registered-folder-panel"
            onClick={() => setPage("folder")}
          >
            {t("登録フォルダー")}
          </button>
          <button
            type="button"
            aria-current={page === "resident" ? "page" : undefined}
            aria-controls="settings-resident-panel"
            onClick={() => setPage("resident")}
          >
            {t("常駐と呼び出し")}
          </button>
          <button
            type="button"
            aria-current={page === "html" ? "page" : undefined}
            aria-controls="settings-html-authoring-panel"
            onClick={() => setPage("html")}
          >
            {t("AIによるHTML制作")}
          </button>
          <button
            type="button"
            aria-current={page === "savedData" ? "page" : undefined}
            aria-controls="settings-saved-data-panel"
            onClick={() => setPage("savedData")}
          >
            {t("保存データ")}
          </button>
          <button
            type="button"
            aria-current={page === "update" ? "page" : undefined}
            aria-controls="settings-app-update-panel"
            onClick={() => setPage("update")}
          >
            {t("アプリの更新")}
          </button>
        </nav>
        {page === "language" ? (
          <section id="settings-language-panel" aria-labelledby="settings-language-heading">
            <h2 id="settings-language-heading">{t("表示言語を選択")}</h2>
            <LanguagePicker variant="settings" />
          </section>
        ) : page === "folder" ? (
          <section id="settings-registered-folder-panel" aria-labelledby="settings-folder-heading">
            <h2 id="settings-folder-heading">{t("登録フォルダー")}</h2>
            <p className="registered-folder-path">
              {state?.snapshot.rootPath ??
                t(
                  hasRegisteredFolder ? "登録フォルダーを復元できません" : "フォルダーは未登録です",
                )}
            </p>
            <p>
              {t(
                "登録フォルダーは保存データの基準です。通常の表示切替では、このフォルダー内だけを表示し、保存先は変えません。",
              )}
            </p>
            <p>
              {t(
                "登録先を変更しても既存の保存データは削除・移行・統合されません。新しい登録先との対応が未確認なら、保存データの利用を保留します。",
              )}
            </p>
            <p>
              {t(
                "登録先を変更すると現在の文書タブが切り替わり、開いているHTMLの未保存入力・実行状態は保持されません。変更前に各HTMLの保存操作で入力を保存してください。保存できない入力は別に控えてください。表示フォルダーだけの切替では、開いているタブは保持されます。",
              )}
            </p>
            <button
              type="button"
              disabled={!onRegisterRoot || state?.loading || state?.actionBusy}
              onClick={() => {
                onClose();
                onRegisterRoot?.();
              }}
            >
              {t(hasRegisteredFolder ? "登録フォルダーを変更" : "フォルダーを登録")}
            </button>
          </section>
        ) : page === "resident" ? (
          <section id="settings-resident-panel" aria-label={t("常駐と呼び出し")}>
            <ResidentSettings state={state} />
          </section>
        ) : page === "html" ? (
          <HtmlAuthoringSettings context={rootContext} api={kitApi} />
        ) : page === "update" ? (
          <Suspense fallback={<p role="status">{t("更新の設定を読み込み中")}</p>}>
            <AppUpdateSettings api={updateApi} />
          </Suspense>
        ) : (
          <section id="settings-saved-data-panel" aria-label={t("保存データ")}>
            <Suspense fallback={<p role="status">{t("保存データを確認中")}</p>}>
              <SavedDataSettings
                context={managementContext ?? { workspaceId: null, viewId: "" }}
                session={session}
                limitsSession={limitsSession}
              />
            </Suspense>
          </section>
        )}
      </div>
      {platform === "macos" && (
        <footer className="settings-footer">
          <button type="button" onClick={onClose}>
            {t("閉じる")}
          </button>
        </footer>
      )}
    </dialog>
  );
}
