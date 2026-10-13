import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DocumentSelection, Snapshot } from "../../lib/types";
import { matchQuickOpen, quickOpenCandidates, QUICK_OPEN_QUERY_LIMIT } from "./model";
import "./quick-open.css";
import { useT } from "../../lib/i18n";

export function QuickOpen({
  snapshot,
  onSelect,
  onClose,
}: {
  snapshot: Snapshot;
  onSelect: (selection: DocumentSelection) => void;
  onClose: () => void;
}) {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState({ query, revision: snapshot.revision, index: 0 });
  const candidates = useMemo(() => quickOpenCandidates(snapshot.nodes), [snapshot.nodes]);
  const result = useMemo(() => matchQuickOpen(candidates, query), [candidates, query]);
  const index =
    selection.query === query && selection.revision === snapshot.revision
      ? Math.min(selection.index, Math.max(0, result.items.length - 1))
      : 0;
  const choose = (index: number) => {
    const item = result.items[index];
    if (!item || !snapshot.workspaceId || composing.current) return;
    onSelect({
      relativePath: item.relativePath,
      workspaceId: snapshot.workspaceId,
      viewId: snapshot.viewId,
      revision: snapshot.revision,
    });
  };
  useLayoutEffect(() => {
    dialog.current?.showModal();
    input.current?.focus();
  }, []);
  useLayoutEffect(() => {
    dialog.current
      ?.querySelector(`#quick-open-option-${index}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [index, query, snapshot.revision]);
  return (
    <dialog
      ref={dialog}
      className="quick-open"
      aria-label={t("クイックオープン")}
      onCancel={(event) => {
        event.preventDefault();
        if (!composing.current) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229 || composing.current) {
          // Native dialog Escape must not dismiss the UI during IME conversion.
          if (event.key === "Escape") event.preventDefault();
          return;
        }
        if (event.defaultPrevented) return;
        if (event.key === "Tab") {
          const close = dialog.current?.querySelector("button");
          if (event.shiftKey && event.target === input.current) {
            event.preventDefault();
            close?.focus();
          } else if (!event.shiftKey && event.target === close) {
            event.preventDefault();
            input.current?.focus();
          }
          return;
        }
        const primary = /Mac/i.test(navigator.platform)
          ? event.metaKey && !event.ctrlKey
          : event.ctrlKey && !event.metaKey;
        if (
          event.key === "Escape" ||
          (primary && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "p")
        ) {
          event.preventDefault();
          if (!event.repeat) onClose();
        } else if (
          event.target === input.current &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey
        ) {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const length = result.items.length;
            if (length)
              setSelection({
                query,
                revision: snapshot.revision,
                index: (index + (event.key === "ArrowDown" ? 1 : length - 1)) % length,
              });
          } else if (event.key === "Enter") {
            event.preventDefault();
            if (!event.repeat) choose(index);
          }
        }
      }}
    >
      <div className="quick-open-input-row">
        <input
          ref={input}
          aria-label={t("ファイル名・相対パス")}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls="quick-open-results"
          aria-activedescendant={result.items.length ? `quick-open-option-${index}` : undefined}
          placeholder={t("ファイル名・相対パス")}
          maxLength={QUICK_OPEN_QUERY_LIMIT}
          value={query}
          onChange={(event) => setQuery(event.target.value.slice(0, QUICK_OPEN_QUERY_LIMIT))}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
        />
        <button aria-label={t("閉じる")} title="Escape" onClick={onClose}>
          ×
        </button>
      </div>
      <ul id="quick-open-results" role="listbox" aria-label={t("HTML候補")}>
        {result.items.map((item, at) => (
          <li
            key={item.relativePath}
            id={`quick-open-option-${at}`}
            role="option"
            aria-selected={at === index}
            title={item.relativePath}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => choose(at)}
          >
            <span>{item.name.replace(/\.html?$/i, "")}</span>
            <small>{item.relativePath}</small>
          </li>
        ))}
      </ul>
      <p role="status">
        {result.hasMore
          ? t("先頭20件 · 名前を入力して絞り込み")
          : result.items.length
            ? t("↑↓ 選択 · Enter 開く · Esc 閉じる")
            : t("一致するHTMLがありません")}
      </p>
    </dialog>
  );
}
