import { useLayoutEffect, useRef, useState } from "react";
import type { TreeNode } from "../../lib/types";
import { translateUiMessage, useT } from "../../lib/i18n";

export function TrashDialog({
  node,
  busy,
  stale,
  onSubmit,
  onClose,
}: {
  node: TreeNode;
  busy: boolean;
  stale: boolean;
  onSubmit: () => Promise<string | null>;
  onClose: () => void;
}) {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  const submission = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = busy || submitting;
  useLayoutEffect(() => {
    dialog.current?.showModal();
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => dialog.current?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="mutation-dialog"
      aria-labelledby="trash-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!locked && !submission.current) onClose();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (locked || stale || submission.current) return;
          submission.current = true;
          setSubmitting(true);
          void (async () => {
            try {
              const error = await onSubmit();
              if (error) setError(error);
              else onClose();
            } catch (error) {
              setError(error instanceof Error ? error.message : String(error));
            } finally {
              submission.current = false;
              setSubmitting(false);
            }
          })();
        }}
      >
        <h2 id="trash-title">{t("ごみ箱に移動しますか？")}</h2>
        <p className="mutation-source">{node.relativePath}</p>
        <p>
          {t(
            node.kind === "folder"
              ? "このフォルダーと配下すべて（非表示のファイル・非HTML資料も含む）をOSのごみ箱へ移動します。"
              : "このファイル1件をOSのごみ箱へ移動します。",
          )}
        </p>
        <p className="mutation-warning">
          {t(
            "開いた文書は表示できなくなり、未保存の入力・実行状態が失われる可能性があります。保存APIで保存済みの入力データは保持します。",
          )}
        </p>
        <p>
          {t(
            "復元はOSのごみ箱で行ってください。ごみ箱へ移動できない場合は操作を中止します。複数項目の一括削除には対応していません。",
          )}
        </p>
        {stale && (
          <p role="alert">
            {t("ツリーが変更されました。キャンセルして対象を確認し直してください。")}
          </p>
        )}
        {error && <p role="alert">{translateUiMessage(error)}</p>}
        <div className="mutation-dialog-buttons">
          <button type="button" onClick={onClose} disabled={locked}>
            {t("キャンセル")}
          </button>
          <button type="submit" disabled={locked || stale}>
            {t(locked ? "操作中" : "ごみ箱に移動する")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
