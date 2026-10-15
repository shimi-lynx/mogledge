import { useEffect, useRef, useState } from "react";
import { translateUiMessage, useLanguage, useT } from "../lib/i18n";
import type { Bridge, ManagedFolders } from "../lib/types";
import type { KnowledgeController } from "../lib/controller";
import "./managed-folders.css";

export function ManagedFoldersPanel({
  api,
  controller,
  disabled = false,
  onSelected,
}: {
  api: Bridge;
  controller?: Pick<KnowledgeController, "selectManagedFolder" | "unregisterManagedFolder">;
  disabled?: boolean;
  onSelected: () => void;
}) {
  const t = useT();
  const language = useLanguage();
  const [folders, setFolders] = useState<ManagedFolders | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [removeId, setRemoveId] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(false);
  const run = async (operation: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const load = async () => {
    if (!api.getManagedFolders) throw new Error("専用フォルダーを読み込めません");
    const next = await api.getManagedFolders();
    if (mounted.current) {
      setFolders(next);
      setRemoveId(null);
    }
  };
  useEffect(() => {
    mounted.current = true;
    void run(load);
    return () => {
      mounted.current = false;
    };
    // The mounted panel owns one read; errors only retry after an explicit action.
  }, [api]);
  const frozen = busy || disabled;
  return (
    <section
      id="settings-registered-folder-panel"
      aria-labelledby="settings-folder-heading"
      className="managed-folders"
      aria-busy={busy}
    >
      <h2 id="settings-folder-heading">{t("Mogledge 専用フォルダー")}</h2>
      <p>
        {t(
          "HTML と作成用ガイドをまとめる専用フォルダーです。登録済みのフォルダーを選んで開きます。",
        )}
      </p>
      <p>
        {t(
          "新規作成または既存フォルダーの登録時に、ガイド・テンプレート・Codex / Claude Skills と管理マーカーを配置します。既存ファイルと競合する場合は上書きしません。",
        )}
      </p>
      <p>
        {t(
          "切り替える前に、各 HTML の保存操作で入力を保存してください。開いている HTML の未保存入力と実行状態は保持されません。",
        )}
      </p>
      {folders && (
        <>
          {folders.folders.length === 0 && <p>{t("専用フォルダーはまだありません")}</p>}
          <ul className="managed-folder-list">
            {folders.folders.map((folder) => (
              <li key={folder.id}>
                <div>
                  <strong>{folder.name}</strong>
                  {folder.id === folders.selectedId && (
                    <span className="managed-folder-badge">{t("選択中")}</span>
                  )}
                </div>
                <p className="managed-folder-path">{folder.path}</p>
                {folder.status !== "ready" && (
                  <p>
                    {t(
                      folder.status === "missing"
                        ? "見つかりません。移動した場合は「既存フォルダーを登録」から場所を選び直してください。"
                        : "準備が完了していません",
                    )}
                  </p>
                )}
                {folder.kitUpdate !== "current" && (
                  <p>
                    {t(
                      folder.kitUpdate === "available"
                        ? "作成用ガイドの更新があります"
                        : "作成用ガイドの更新には競合の確認が必要です",
                    )}
                  </p>
                )}
                {folder.error && <p role="alert">{translateUiMessage(folder.error, language)}</p>}
                <div className="managed-folder-actions">
                  <button
                    type="button"
                    disabled={frozen || !controller || folder.status !== "ready"}
                    onClick={() =>
                      void run(async () => {
                        await controller!.selectManagedFolder(folder.id, folders.revision);
                        if (mounted.current) onSelected();
                      })
                    }
                  >
                    {t("このフォルダーを開く")}
                  </button>
                  <button type="button" disabled={frozen} onClick={() => setRemoveId(folder.id)}>
                    {t("登録解除")}
                  </button>
                </div>
                {removeId === folder.id && (
                  <div className="managed-folder-remove">
                    <p>
                      {t("登録だけを解除します。フォルダー、HTML、保存データはすべて残ります。")}
                    </p>
                    <button
                      type="button"
                      disabled={frozen || !controller}
                      onClick={() =>
                        void run(async () => {
                          const next = await controller!.unregisterManagedFolder(
                            folder.id,
                            folders.revision,
                          );
                          if (mounted.current) {
                            setFolders(next);
                            setRemoveId(null);
                          }
                        })
                      }
                    >
                      {t("この登録を解除")}
                    </button>
                    <button type="button" disabled={frozen} onClick={() => setRemoveId(null)}>
                      {t("キャンセル")}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!name.trim() || !api.createManagedFolder) return;
              void run(async () => {
                const next = await api.createManagedFolder!(name.trim(), folders.revision);
                if (next && mounted.current) {
                  setFolders(next);
                  setName("");
                }
              });
            }}
          >
            <label>
              {t("新しいフォルダー名")}
              <input
                value={name}
                disabled={frozen}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <button type="submit" disabled={frozen || !name.trim() || !api.createManagedFolder}>
              {t("保存先を選んで新規作成")}
            </button>
          </form>
          <button
            type="button"
            disabled={frozen || !api.registerManagedFolder}
            onClick={() =>
              void run(async () => {
                const next = await api.registerManagedFolder!(folders.revision);
                if (next && mounted.current) setFolders(next);
              })
            }
          >
            {t("既存フォルダーを登録")}
          </button>
        </>
      )}
      {error && <p role="alert">{translateUiMessage(error, language)}</p>}
      <button type="button" disabled={frozen} onClick={() => void run(load)}>
        {t("一覧を再読み込み")}
      </button>
    </section>
  );
}
