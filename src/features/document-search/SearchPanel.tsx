import { useEffect, useId, useMemo, useRef, useState } from "react";
import { searchBridge } from "./bridge";
import { HighlightedText } from "./HighlightedText";
import type { FolderSearchScope, IndexStatus, SearchBridge, SearchMode, SearchPage } from "./types";
import { useT, useLanguage, translateUiMessage } from "../../lib/i18n";
import "./search.css";
import type { TreeNode } from "../../lib/types";
import { FolderPicker } from "../knowledge-tree/FolderPicker";
import { rememberSearchScope, useSearchPreferences } from "./preferences";

const PAGE_SIZE = 20;
// Must match the native literal-search range limit.
const MAX_PAGE_OFFSET = 10_000;
const MAX_QUERY_CHARACTERS = 256;
const MAX_QUERY_TERMS = 8;

export function nextSearchPageOffset(offset: number, hasMore: boolean): number | null {
  return hasMore && offset < MAX_PAGE_OFFSET ? Math.min(offset + PAGE_SIZE, MAX_PAGE_OFFSET) : null;
}

interface ResultSet extends SearchPage {
  context: string;
  query: string;
  mode: SearchMode;
  offset: number;
}

interface StatusState {
  context: string;
  value: IndexStatus;
}

interface ContextError {
  context: string;
  message: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function capQuery(value: string): string {
  return Array.from(value).slice(0, MAX_QUERY_CHARACTERS).join("");
}

function statusKey(status: IndexStatus | null): string {
  return status
    ? `${status.rootId}:${status.phase}:${status.generation}:${status.requestRevision}`
    : "";
}

export function SearchPanel({
  workspaceId,
  revision,
  onSelect,
  active = true,
  focusRequest = 0,
  viewId,
  scope,
  onResetScope,
  nodes,
  onChangeScope,
  scopeLocked = false,
  bridge = searchBridge,
}: {
  workspaceId: string | null;
  revision: number;
  onSelect: (relativePath: string) => void;
  active?: boolean;
  focusRequest?: number;
  viewId?: string;
  scope?: FolderSearchScope;
  onResetScope?: () => void;
  nodes?: TreeNode[];
  onChangeScope?: (path: string) => void;
  scopeLocked?: boolean;
  bridge?: SearchBridge;
}) {
  const t = useT();
  const language = useLanguage();
  const context = JSON.stringify([
    workspaceId,
    revision,
    viewId,
    scope?.viewId,
    scope?.relativePath,
  ]);
  const runSearch = (workspace: string, offset: number) =>
    scope
      ? bridge.search(workspace, query, PAGE_SIZE, offset, mode, scope)
      : bridge.search(workspace, query, PAGE_SIZE, offset, mode);
  const [query, setQuery] = useState("");
  const { preferences, update, saveFailed, readOnly } = useSearchPreferences();
  const mode = preferences.mode;
  const setMode = (mode: SearchMode) => update((current) => ({ ...current, mode }));
  const detailsId = useId();
  const rootContext = JSON.stringify([workspaceId, viewId]);
  const [restoredContext, setRestoredContext] = useState<string | null>(null);
  const [missingScope, setMissingScope] = useState(false);
  const canRestoreScope = !!nodes && !!onChangeScope && !!viewId;
  const scopeReady = !canRestoreScope || restoredContext === rootContext;
  const folders = useMemo(() => {
    if (!active || !preferences.detailsOpen) return [];
    const folders = [{ path: "", label: t("ルート全体") }];
    const walk = (nodes: TreeNode[]) => {
      for (const node of nodes)
        if (node.kind === "folder") {
          folders.push({ path: node.relativePath, label: node.relativePath });
          walk(node.children);
        }
    };
    walk(nodes ?? []);
    return folders;
  }, [active, preferences.detailsOpen, nodes, t]);
  const [composing, setComposing] = useState(false);
  const [statusState, setStatusState] = useState<StatusState | null>(null);
  const [results, setResults] = useState<ResultSet | null>(null);
  const [searchError, setSearchError] = useState<ContextError | null>(null);
  const [statusError, setStatusError] = useState<ContextError | null>(null);
  const [rebuildError, setRebuildError] = useState<ContextError | null>(null);
  const [loading, setLoading] = useState(false);
  const [rebuildingContext, setRebuildingContext] = useState<string | null>(null);
  const [searchNonce, setSearchNonce] = useState(0);
  const [statusNonce, setStatusNonce] = useState(0);
  const sequence = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const activation = useRef(0);
  const statusSequence = useRef(0);
  const immediate = useRef(false);
  const mounted = useRef(false);
  const latest = useRef({ context, query, mode, composing, active, fingerprint: "" });
  const status = statusState?.context === context ? statusState.value : null;
  const fingerprint = statusKey(status);
  latest.current = { context, query, mode, composing, active, fingerprint };
  const rebuilding = rebuildingContext === context;
  const trimmedQuery = query.trim();
  const terms = trimmedQuery ? trimmedQuery.split(/\s+/u).length : 0;
  const queryValid = !!trimmedQuery && terms <= MAX_QUERY_TERMS && scopeReady;
  const hasQuery = !!trimmedQuery;
  const searchable = !!status && status.phase !== "pending" && status.phase !== "failed";
  const currentResults =
    results?.context === context &&
    results.query === query &&
    results.mode === mode &&
    results.generation === status?.generation &&
    results.requestRevision === status?.requestRevision &&
    !composing
      ? results
      : null;
  const nextOffset = currentResults
    ? nextSearchPageOffset(currentResults.offset, currentResults.hasMore)
    : null;

  useEffect(() => {
    if (!active || !status || !canRestoreScope || scopeLocked || scopeReady) return;
    const saved = preferences.roots.find((root) => root.rootId === status.rootId)?.path;
    const contains = (nodes: TreeNode[]): boolean =>
      nodes.some(
        (node) =>
          node.kind === "folder" && (node.relativePath === saved || contains(node.children)),
      );
    setMissingScope(false);
    // Explicit tree-menu scope wins over startup restoration. A stored path is
    // only a UI filter; Native still verifies root/view/path before each query.
    if (!scope && saved) {
      if (contains(nodes ?? [])) onChangeScope?.(saved);
      else setMissingScope(true);
    }
    setRestoredContext(rootContext);
  }, [
    active,
    status,
    canRestoreScope,
    scopeLocked,
    scopeReady,
    rootContext,
    preferences.roots,
    nodes,
    scope,
    onChangeScope,
  ]);
  useEffect(() => {
    if (status && scopeReady && canRestoreScope && !scopeLocked)
      update((current) => rememberSearchScope(current, status.rootId, scope?.relativePath ?? ""));
  }, [status, scopeReady, canRestoreScope, scopeLocked, scope?.relativePath, update]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sequence.current += 1;
    };
  }, []);

  useEffect(() => {
    activation.current += 1;
    if (!active) {
      setStatusState(null);
      setComposing(false);
      return;
    }
    input.current?.focus();
  }, [active]);

  useEffect(() => {
    if (active) input.current?.focus();
  }, [active, focusRequest]);

  useEffect(() => {
    if (!active || !workspaceId) return;
    const request = ++statusSequence.current;
    let polling = true;
    let indexing = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (!polling || request !== statusSequence.current) return;
      try {
        const value = await bridge.getStatus(workspaceId);
        if (!polling || request !== statusSequence.current || latest.current.context !== context)
          return;
        if (value.workspaceId !== workspaceId) throw new Error("検索対象が変わりました");
        setStatusState({ context, value });
        setStatusError(null);
        indexing = value.phase === "pending" || value.phase === "building";
        if (indexing || hasQuery) {
          timer = setTimeout(() => void poll(), 1_000);
        }
      } catch (error) {
        if (!polling || request !== statusSequence.current || latest.current.context !== context)
          return;
        setStatusError({ context, message: message(error) });
        if (indexing || hasQuery) timer = setTimeout(() => void poll(), 1_000);
      }
    };
    void poll();
    return () => {
      polling = false;
      clearTimeout(timer);
    };
  }, [active, bridge, context, workspaceId, hasQuery, statusNonce]);

  useEffect(() => {
    const request = ++sequence.current;
    setLoading(false);
    if (!active) return;
    // Revalidate a retained page against the fresh index status when reopening.
    const offset = currentResults?.offset ?? 0;
    if (!status) return;
    setResults(null);
    setSearchError(null);
    if (!workspaceId || !queryValid || composing || !searchable || rebuilding || !status) {
      return;
    }
    const generation = status.generation;
    const requestRevision = status.requestRevision;
    const delay = immediate.current ? 0 : 250;
    immediate.current = false;
    const timer = setTimeout(() => {
      setLoading(true);
      void runSearch(workspaceId, offset).then(
        (page) => {
          if (
            !mounted.current ||
            request !== sequence.current ||
            latest.current.context !== context ||
            latest.current.query !== query ||
            latest.current.mode !== mode ||
            latest.current.composing ||
            latest.current.fingerprint !== fingerprint
          ) {
            return;
          }
          setLoading(false);
          if (page.generation !== generation || page.requestRevision !== requestRevision) {
            setStatusNonce((value) => value + 1);
            setSearchNonce((value) => value + 1);
            return;
          }
          setResults({ ...page, context, query, mode, offset });
        },
        (error: unknown) => {
          if (
            mounted.current &&
            request === sequence.current &&
            latest.current.context === context &&
            latest.current.query === query &&
            latest.current.mode === mode &&
            latest.current.fingerprint === fingerprint &&
            !latest.current.composing
          ) {
            setLoading(false);
            setSearchError({ context, message: message(error) });
          }
        },
      );
    }, delay);
    return () => {
      clearTimeout(timer);
      sequence.current += 1;
    };
  }, [
    active,
    bridge,
    context,
    workspaceId,
    query,
    mode,
    composing,
    queryValid,
    searchable,
    rebuilding,
    fingerprint,
    searchNonce,
  ]);

  const cancel = () => {
    sequence.current += 1;
    immediate.current = false;
    setQuery("");
    setResults(null);
    setSearchError(null);
    setRebuildError(null);
    setLoading(false);
  };

  const loadPage = (offset: number) => {
    if (
      !workspaceId ||
      !currentResults ||
      loading ||
      rebuilding ||
      offset < 0 ||
      offset > MAX_PAGE_OFFSET
    )
      return;
    const previous = currentResults;
    const request = ++sequence.current;
    setLoading(true);
    setSearchError(null);
    void runSearch(workspaceId, offset).then(
      (page) => {
        if (
          !mounted.current ||
          request !== sequence.current ||
          latest.current.context !== context ||
          latest.current.query !== query ||
          latest.current.mode !== mode ||
          latest.current.composing ||
          latest.current.fingerprint !== fingerprint
        ) {
          return;
        }
        setLoading(false);
        if (
          page.generation !== previous.generation ||
          page.requestRevision !== previous.requestRevision ||
          page.normalizedQuery !== previous.normalizedQuery
        ) {
          setResults(null);
          setStatusNonce((value) => value + 1);
          setSearchNonce((value) => value + 1);
          return;
        }
        // Keep only one page mounted, even when users browse many results.
        setResults({ ...page, context, query, mode, offset });
      },
      (error: unknown) => {
        if (
          mounted.current &&
          request === sequence.current &&
          latest.current.context === context &&
          latest.current.query === query &&
          latest.current.mode === mode &&
          latest.current.fingerprint === fingerprint &&
          !latest.current.composing
        ) {
          setLoading(false);
          setSearchError({ context, message: message(error) });
        }
      },
    );
  };

  const rebuild = () => {
    if (!workspaceId || rebuilding) return;
    const rebuildActivation = activation.current;
    sequence.current += 1;
    statusSequence.current += 1;
    setResults(null);
    setSearchError(null);
    setLoading(false);
    setRebuildingContext(context);
    setRebuildError(null);
    void bridge.rebuild(workspaceId).then(
      (value) => {
        if (!mounted.current || latest.current.context !== context) return;
        setRebuildingContext(null);
        if (
          latest.current.active &&
          activation.current === rebuildActivation &&
          value.workspaceId === workspaceId
        )
          setStatusState({ context, value });
        setStatusNonce((value) => value + 1);
        setSearchNonce((value) => value + 1);
      },
      (error: unknown) => {
        if (!mounted.current || latest.current.context !== context) return;
        setRebuildingContext(null);
        setRebuildError({ context, message: message(error) });
        setStatusNonce((value) => value + 1);
      },
    );
  };

  const shownError =
    (rebuildError?.context === context ? rebuildError.message : null) ??
    (searchError?.context === context ? searchError.message : null) ??
    (statusError?.context === context ? statusError.message : null);
  const waiting = status?.phase === "pending" || status?.phase === "building";
  return (
    <section
      id="knowledge-search"
      className="document-search"
      aria-label={t("文書検索")}
      hidden={!active}
    >
      <form
        className="search-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!workspaceId || !queryValid || composing || rebuilding) return;
          immediate.current = true;
          setSearchNonce((value) => value + 1);
        }}
      >
        <label htmlFor="document-search-query">{t("文書を検索")}</label>
        <div className="search-input-row">
          <div className="search-query-field">
            <input
              ref={input}
              id="document-search-query"
              type="search"
              value={query}
              disabled={!workspaceId}
              placeholder={t("入力して検索を開始…")}
              autoComplete="off"
              maxLength={MAX_QUERY_CHARACTERS * 2}
              onChange={(event) => {
                sequence.current += 1;
                setQuery(capQuery(event.currentTarget.value));
              }}
              onCompositionStart={() => {
                sequence.current += 1;
                setComposing(true);
                setResults(null);
              }}
              onCompositionEnd={(event) => {
                setQuery(capQuery(event.currentTarget.value));
                setComposing(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  if (composing || event.nativeEvent.isComposing) {
                    event.stopPropagation();
                    return;
                  }
                  if (!query && !loading) return;
                  event.preventDefault();
                  event.stopPropagation();
                  cancel();
                }
                if (event.key === "Enter" && (composing || event.nativeEvent.isComposing)) {
                  event.preventDefault();
                }
              }}
            />
            <button
              type="button"
              aria-label={t("取消")}
              title={t("検索を取り消す")}
              className="search-clear"
              onClick={() => {
                cancel();
                input.current?.focus();
              }}
              disabled={composing || (!query && !loading)}
            >
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="m5 5 10 10M15 5 5 15" />
              </svg>
            </button>
          </div>
          <button
            type="button"
            className="search-settings-toggle"
            aria-label={t("検索の詳細設定")}
            title={t("検索の詳細設定")}
            aria-expanded={preferences.detailsOpen}
            aria-controls={detailsId}
            onClick={() => update((current) => ({ ...current, detailsOpen: !current.detailsOpen }))}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M3 5h14M3 10h14M3 15h14M7 3v4M13 8v4M8 13v4" />
            </svg>
          </button>
        </div>
        <div id={detailsId} className="search-settings" hidden={!preferences.detailsOpen}>
          <fieldset disabled={!workspaceId || composing}>
            <legend>{t("検索条件")}</legend>
            <div className="search-mode-options">
              {(["and", "or"] as const).map((value) => (
                <label key={value}>
                  <input
                    type="radio"
                    name={detailsId + "-mode"}
                    value={value}
                    checked={mode === value}
                    onChange={() => {
                      sequence.current += 1;
                      setMode(value);
                    }}
                  />
                  {t(value === "and" ? "AND（すべての語）" : "OR（いずれかの語）")}
                </label>
              ))}
            </div>
          </fieldset>
          {active && preferences.detailsOpen && onChangeScope && (
            <FolderPicker
              key={rootContext}
              folders={folders}
              value={scope?.relativePath ?? ""}
              label={t("検索するフォルダー")}
              locked={!workspaceId || !scopeReady || scopeLocked || composing}
              onChange={(path) => {
                setMissingScope(false);
                onChangeScope(path);
              }}
            />
          )}
          <p>{t("選択したフォルダーと、その配下すべてを検索します。")}</p>
          <button
            type="button"
            onClick={() => {
              if (mode !== "and") sequence.current += 1;
              setMode("and");
              setMissingScope(false);
              onResetScope?.();
            }}
            disabled={composing || scopeLocked || (!!workspaceId && !scopeReady)}
          >
            {t("検索条件をリセット")}
          </button>
        </div>
        {(readOnly || saveFailed) && (
          <p className="search-error" role="alert">
            {t(
              readOnly
                ? "保存した検索設定を読み取れません。元の設定を保持し、今回の変更は保存しません。"
                : "検索設定を保存できません。今回の操作は使えますが、再起動後に戻る場合があります。",
            )}
          </p>
        )}
        {missingScope && (
          <p className="search-progress" role="status">
            {t("保存した検索範囲が見つからないため、ルート全体を検索します。")}
          </p>
        )}
        {mode === "or" && !preferences.detailsOpen && (
          <p className="search-active-mode">{t("OR（いずれかの語）")}</p>
        )}
        {scope && (
          <div className="search-scope" aria-label={t("検索範囲")}>
            <span title={scope.relativePath}>
              {t("範囲: {path}", { path: scope.relativePath })}
            </span>
            <button
              type="button"
              aria-label={t("検索範囲を解除")}
              title={t("全体を検索")}
              onClick={() => {
                onResetScope?.();
                input.current?.focus();
              }}
            >
              ×
            </button>
          </div>
        )}
      </form>
      <details className="search-index-details">
        <summary>{t("索引の状態・再構築")}</summary>
        {scope && <p>{t("索引の件数・再構築は選択したルート全体が対象です。")}</p>}
        <p>
          {t(
            "空白区切りで8語まで。AND はすべて、OR はいずれかの語に一致します。入力中の AND・OR・引用符は文字列として検索します。",
          )}
        </p>
        <div className="search-index-status" role="status" aria-live="polite">
          {!workspaceId ? (
            <span>{t("フォルダを選択すると検索できます")}</span>
          ) : rebuilding ? (
            <span>{t("索引を再構築しています")}</span>
          ) : !status ? (
            <span>{t("索引を確認しています")}</span>
          ) : (
            <>
              <span>
                {status.phase === "pending"
                  ? t("索引の更新待ち")
                  : status.phase === "building"
                    ? t("索引を作成しています")
                    : status.phase === "failed"
                      ? t("索引の作成に失敗しました")
                      : t("{count}件を検索できます", { count: status.indexed })}
              </span>
              {status.pending > 0 && (
                <span>{t("未索引 {count}件", { count: status.pending })}</span>
              )}
              {status.unavailable > 0 && (
                <span>{t("未取得・利用不可 {count}件", { count: status.unavailable })}</span>
              )}
              {status.failed > 0 && (
                <span>{t("読み取り失敗 {count}件", { count: status.failed })}</span>
              )}
              {status.truncated > 0 && (
                <span>{t("本文を省略した文書 {count}件", { count: status.truncated })}</span>
              )}
              {status.limited && (
                <span>{t("索引の上限に達しました。一部の文書は検索できません")}</span>
              )}
              {!status.complete && !waiting && <span>{t("一部の文書が未索引です")}</span>}
              {status.rebuilt && <span>{t("索引を再作成しました")}</span>}
              {status.error && <span>{translateUiMessage(status.error, language)}</span>}
            </>
          )}
        </div>
        {workspaceId && (
          <button
            type="button"
            className="search-rebuild"
            onClick={rebuild}
            disabled={rebuilding || waiting}
          >
            {t("索引を再構築")}
          </button>
        )}
      </details>
      {status && !status.complete && (
        <p className="search-progress" role="status">
          {status.phase === "failed"
            ? t("索引の作成に失敗しました。索引の状態を確認してください")
            : waiting
              ? t("索引を更新しています。検索結果は不完全です")
              : t("一部の文書は検索できません。索引の状態を確認してください")}
        </p>
      )}
      {terms > MAX_QUERY_TERMS && (
        <p className="search-error" role="alert">
          {t("検索語は8個以内にしてください")}
        </p>
      )}
      {shownError && (
        <p className="search-error" role="alert">
          {translateUiMessage(shownError, language)}
        </p>
      )}
      {loading && (
        <p className="search-progress" role="status">
          {t("検索しています")}
        </p>
      )}
      {currentResults && (
        <>
          {currentResults.hits.length ? (
            <ul className="search-results" aria-label={t("検索結果")}>
              {currentResults.hits.map((hit) => (
                <li key={hit.documentId}>
                  <button
                    type="button"
                    disabled={loading || rebuilding || status?.phase === "pending"}
                    onClick={() => onSelect(hit.relativePath)}
                    title={hit.relativePath}
                  >
                    <span className="search-result-title">
                      <HighlightedText
                        text={hit.title || hit.relativePath}
                        ranges={hit.title ? hit.titleMatches : []}
                      />
                    </span>
                    <span className="search-result-path">{hit.relativePath}</span>
                    <span className="search-result-snippet">
                      <HighlightedText text={hit.snippet} ranges={hit.snippetMatches} />
                    </span>
                    {hit.truncated && (
                      <span className="search-result-limit">{t("本文の一部を検索")}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="search-empty">
              {waiting
                ? t("現在の索引には一致する文書がありません")
                : t("一致する文書がありません")}
            </p>
          )}
          <div className="search-pagination">
            {currentResults.offset > 0 && (
              <button
                type="button"
                disabled={loading || rebuilding}
                onClick={() => loadPage(Math.max(0, currentResults.offset - PAGE_SIZE))}
              >
                {t("前の20件")}
              </button>
            )}
            {nextOffset !== null && (
              <button
                type="button"
                disabled={loading || rebuilding}
                onClick={() => loadPage(nextOffset)}
              >
                {t("次の20件")}
              </button>
            )}
          </div>
          {currentResults.hasMore && nextOffset === null && (
            <p className="search-progress" role="status">
              {t("検索範囲の上限に達しました。検索語を追加して結果を絞り込んでください")}
            </p>
          )}
        </>
      )}
    </section>
  );
}
