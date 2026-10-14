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

export type SettingsDialogHandle = { focus: () => void };

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
  platform?: WindowChrome["platform"];
}) {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  const category = useRef<HTMLButtonElement>(null);
  const [page, setPage] = useState<"language" | "resident" | "html" | "savedData" | "update">(
    "language",
  );
  const [session] = useState(() => managementSession ?? new ManagementSession());
  const backdropPointer = useRef(false);
  const fallback = useRef(fallbackFocus);
  fallback.current = fallbackFocus;
  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
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
