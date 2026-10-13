import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AppState } from "../../lib/types";
import type { KnowledgeController } from "../../lib/controller";
import "../quick-open/quick-open.css";
import "./workspace-lists.css";
import { translateUiMessage, useLanguage, useT } from "../../lib/i18n";
import {
  workspaceSetShortcutHint,
  workspaceSetShortcutSlots,
} from "../../lib/workspaceSetShortcuts";

export function WorkspaceLists({
  state,
  controller,
  onClose,
}: {
  state: AppState;
  controller: KnowledgeController;
  onClose: () => void;
}) {
  const t = useT();
  const language = useLanguage();
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef(0);
  const mounted = useRef(true);
  useLayoutEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.cancelWorkspaceSelection();
    };
  }, [controller]);
  useEffect(() => {
    void controller.refreshWorkspaceSets();
  }, [controller]);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const sets = state.workspaceSets;
  return (
    <dialog
      ref={dialog}
      className="quick-open workspace-lists"
      aria-label={t("作業セット")}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="workspace-lists-header">
        <span>{t("作業セット")}</span>
        <button autoFocus aria-label={t("閉じる")} onClick={onClose}>
          ×
        </button>
      </div>
      <div className="workspace-lists-content">
        <section aria-label={t("作業セット")}>
          <h2>{t("作業セット")}</h2>
          <p className="workspace-set-policy">
            {t(
              "同じ列のタブと現在の倍率を保持します。セット順に並べ、ほかのタブは後ろに残します。未選択の文書は読み込みません。読込中は完了後に呼び出してください。",
            )}
          </p>
          <p className="workspace-set-policy">
            {t(
              "番号はこのフォルダーのセットに割り当てます。入力・IME・ダイアログとHTML自身のキー操作を優先します。0は10番目です。",
            )}
          </p>
          <form
            className="workspace-set-form"
            onSubmit={(event) => {
              event.preventDefault();
              void controller.saveWorkspaceSet(name).then((saved) => {
                if (saved && mounted.current) setName("");
              });
            }}
          >
            <input
              aria-label={t("新しい作業セット名")}
              value={name}
              placeholder={t("セット名")}
              onChange={(event) => setName(event.target.value)}
            />
            <button
              disabled={
                state.actionBusy ||
                sets?.readOnly ||
                !state.tabs.some((tab) => tab.kind !== "help") ||
                state.tabs.some((tab) => tab.kind !== "help" && (tab.loading || tab.closing)) ||
                !name.trim() ||
                (sets?.sets.length ?? 0) >= 10
              }
            >
              {t("現在の配置を保存")}
            </button>
          </form>
          {sets?.sets.length ? (
            <ul>
              {sets.sets.map((set) => (
                <li key={set.id}>
                  {editing?.id === set.id ? (
                    <form
                      className="workspace-set-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void controller.editWorkspaceSet(set.id, editing.name).then((saved) => {
                          if (saved && mounted.current) setEditing(null);
                        });
                      }}
                    >
                      <input
                        aria-label={t("変更後のセット名")}
                        value={editing.name}
                        onChange={(event) => setEditing({ id: set.id, name: event.target.value })}
                      />
                      <button disabled={state.actionBusy || !editing.name.trim()}>
                        {t("変更")}
                      </button>
                      <button type="button" onClick={() => setEditing(null)}>
                        {t("取消")}
                      </button>
                    </form>
                  ) : (
                    <>
                      <button
                        className="workspace-document"
                        disabled={
                          state.actionBusy ||
                          state.tabs.some(
                            (tab) => tab.kind !== "help" && (tab.loading || tab.closing),
                          )
                        }
                        onClick={() => {
                          const generation = ++request.current;
                          void controller.restoreWorkspaceSet(set.id).then((restored) => {
                            if (restored && mounted.current && generation === request.current)
                              onClose();
                          });
                        }}
                      >
                        <span>{set.name}</span>
                        <small>
                          {set.items.length === 1
                            ? t("1文書")
                            : t("{count}文書", { count: set.items.length })}{" "}
                          · {t(set.items.some((item) => item.column === 1) ? "2列" : "1列")}
                        </small>
                      </button>
                      <select
                        className="workspace-set-shortcut"
                        aria-label={t("{name}のショートカット", { name: set.name })}
                        disabled={state.loading || state.actionBusy || sets.readOnly}
                        value={String(sets.setShortcuts.indexOf(set.id) + 1 || "")}
                        onChange={(event) => {
                          const slot =
                            workspaceSetShortcutSlots.find(
                              (slot) => String(slot) === event.target.value,
                            ) ?? null;
                          void controller.assignWorkspaceSetShortcut(set.id, slot);
                        }}
                      >
                        <option value="">{t("未割当")}</option>
                        {workspaceSetShortcutSlots.map((slot) => (
                          <option
                            key={slot}
                            value={slot}
                            disabled={
                              !!sets.setShortcuts[slot - 1] &&
                              sets.setShortcuts[slot - 1] !== set.id
                            }
                          >
                            {workspaceSetShortcutHint(slot)}
                          </option>
                        ))}
                      </select>
                      <button
                        disabled={state.actionBusy || sets.readOnly}
                        aria-label={t("{name}の名前を変更", { name: set.name })}
                        onClick={() => setEditing({ id: set.id, name: set.name })}
                      >
                        {t("名前")}
                      </button>
                      <button
                        disabled={state.actionBusy || sets.readOnly}
                        aria-label={t("{name}を削除", { name: set.name })}
                        onClick={() => void controller.editWorkspaceSet(set.id, null)}
                      >
                        ×
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="workspace-set-policy">
              {sets
                ? t("まだありません。最大10組・各30文書。入力値はセットに含まれません。")
                : t("読み込み中")}
            </p>
          )}
        </section>
      </div>
      {(sets?.error || state.error) && (
        <p role="alert">{translateUiMessage(sets?.error ?? state.error ?? "", language)}</p>
      )}
    </dialog>
  );
}
