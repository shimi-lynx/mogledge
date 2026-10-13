import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { TreeMutation, TreeNode } from "../../lib/types";
import { htmlNameParts } from "./model";
import { FolderPicker } from "./FolderPicker";
import { translateUiMessage, useT } from "../../lib/i18n";
import { rootCreationLabels } from "./rootCreationLabels";

export type MutationIntent =
  | { kind: "createHtml" | "createFolder"; parent: string }
  | { kind: "renameHtml"; source: string; name: string }
  | { kind: "move"; source: string; parent: string; anchor?: string; after?: boolean };
export function MutationDialog({
  intent,
  nodes,
  rootPath,
  busy,
  onSubmit,
  onClose,
}: {
  intent: MutationIntent;
  nodes: TreeNode[];
  rootPath?: string | null;
  busy: boolean;
  onSubmit: (mutation: TreeMutation) => Promise<string | null>;
  onClose: () => void;
}) {
  const t = useT();
  const rootLabel = rootCreationLabels(rootPath, t).root;
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(intent.kind === "renameHtml" ? intent.name : "");
  const [parent, setParent] = useState(intent.kind === "renameHtml" ? "" : intent.parent);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submission = useRef(false);
  const composing = useRef(false);
  const locked = busy || submitting;
  const moving = intent.kind === "move";
  const renaming = intent.kind === "renameHtml";
  const pickDestination = moving || intent.kind === "createFolder";
  useLayoutEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  useEffect(() => {
    if (!locked)
      dialog.current?.querySelector<HTMLElement>("[data-mutation-initial-focus]")?.focus();
  }, [locked]);
  const folders = useMemo(() => {
    if (!pickDestination) return [];
    const folders: { path: string; label: string }[] = [{ path: "", label: rootLabel }];
    const walk = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        if (node.kind === "folder") {
          if (
            intent.kind === "move" &&
            (node.relativePath === intent.source ||
              node.relativePath.startsWith(intent.source + "/"))
          )
            continue;
          folders.push({ path: node.relativePath, label: node.relativePath });
          walk(node.children);
        }
      }
    };
    walk(nodes);
    return folders;
  }, [nodes, intent, pickDestination, rootLabel]);
  const validParent = !pickDestination || folders.some((folder) => folder.path === parent);
  const title = moving
    ? "別フォルダーへ移動"
    : renaming
      ? "HTMLの名前を変更"
      : intent.kind === "createHtml"
        ? "HTMLを作成"
        : "フォルダーを作成";
  return (
    <dialog
      ref={dialog}
      className="mutation-dialog"
      aria-labelledby="mutation-title"
      onCompositionStartCapture={() => {
        composing.current = true;
      }}
      onCompositionEndCapture={() => {
        composing.current = false;
      }}
      onCancel={(event) => {
        event.preventDefault();
        if (!locked && !submission.current && !composing.current) onClose();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        // WKWebView can clear isComposing before the IME confirmation Enter.
        if (
          event.key === "Enter" &&
          (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composing.current)
        )
          event.preventDefault();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (locked || submission.current || composing.current || !validParent) return;
          submission.current = true;
          setSubmitting(true);
          void (async () => {
            setError(null);
            const mutation: TreeMutation =
              intent.kind === "move"
                ? {
                    ...intent,
                    parent,
                    anchor: parent === intent.parent ? intent.anchor : undefined,
                  }
                : intent.kind === "renameHtml"
                  ? { kind: intent.kind, source: intent.source, name }
                  : {
                      ...intent,
                      parent: intent.kind === "createFolder" ? parent : intent.parent,
                      name,
                    };
            try {
              const error = await onSubmit(mutation);
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
        <h2 id="mutation-title">{t(title)}</h2>
        {pickDestination && (
          <FolderPicker
            label={t(moving ? "移動先" : "作成先")}
            folders={folders}
            value={parent}
            locked={locked}
            autoFocus={moving}
            onChange={(path) => {
              setParent(path);
              setError(null);
            }}
          />
        )}
        {moving ? (
          <>
            <p className="mutation-source">{intent.source}</p>
            <p className="mutation-warning">
              {t("相対参照が変わる場合があります。HTML・CSS・JSのリンクは書き換えません。")}
            </p>
          </>
        ) : (
          <>
            {intent.kind !== "createFolder" && (
              <p title={renaming ? undefined : intent.parent || rootLabel}>
                {renaming
                  ? intent.source
                  : t("作成先: {path}", { path: intent.parent || rootLabel })}
              </p>
            )}
            <label>
              {t("名前")}
              <input
                autoFocus
                data-mutation-initial-focus
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setError(null);
                }}
                onFocus={(event) => {
                  if (renaming) event.target.select();
                }}
                onCompositionStart={() => {
                  composing.current = true;
                }}
                onCompositionEnd={() => {
                  composing.current = false;
                }}
                required
                maxLength={200}
                readOnly={locked}
              />
            </label>
            {intent.kind === "createHtml" && (
              <p>
                {t(
                  ".html拡張子がない名前には自動で補います。内容の編集は外部AI・エディタで行います。",
                )}
              </p>
            )}
            {renaming && (
              <p className="mutation-warning">
                {t(
                  "拡張子 {extension} は保持します。表示中の文書は再読み込みし、入力・実行状態はリセットします。HTML・CSS・JSのリンクは書き換えません。",
                  { extension: htmlNameParts(intent.source).extension },
                )}
              </p>
            )}
          </>
        )}
        {!validParent && (
          <p role="alert">
            {t("選択したフォルダーが見つかりません。作成先／移動先を選び直してください。")}
          </p>
        )}
        {error && <p role="alert">{translateUiMessage(error)}</p>}
        <div className="mutation-dialog-buttons">
          <button type="button" onClick={onClose} disabled={locked}>
            {t("キャンセル")}
          </button>
          <button type="submit" disabled={locked || !validParent || (!moving && !name.trim())}>
            {t(locked ? "操作中" : moving ? "移動する" : renaming ? "変更する" : "作成する")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
