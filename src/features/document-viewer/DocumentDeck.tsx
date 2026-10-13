import { DocumentExports } from "./DocumentExports";
import { translateUiMessage, useT } from "../../lib/i18n";
import type { AppState, Column } from "../../lib/types";
import type { KnowledgeController } from "../../lib/controller";
import { DocumentViewer } from "./DocumentViewer";
import { lazy, Suspense, useRef, useState } from "react";
import { useDocumentShortcuts } from "./documentShortcuts";
import { DocumentLinks } from "./DocumentLinks";
import { useDocumentReady } from "./documentReady";

const AppHelp = lazy(() => import("../../app/AppHelp"));

export function DocumentDeck({
  state,
  controller,
  draggedTab,
  onDragDone,
  onQuickOpen,
  onAiHandoff,
  onToggleSidebar,
  onShowFiles,
  onOpenSettings,
}: {
  state: AppState;
  controller: KnowledgeController;
  draggedTab?: string | null;
  onDragDone?: () => void;
  onQuickOpen?: () => void;
  onAiHandoff?: (tabId: string) => void;
  onToggleSidebar?: () => void;
  onShowFiles?: () => void;
  onOpenSettings?: (returnFocus: HTMLElement) => void;
}) {
  const t = useT();
  // Tab-strip reordering must never reorder live iframe DOM nodes.
  const mountOrder = useRef<string[]>([]);
  const stage = useRef<HTMLDivElement>(null);
  useDocumentShortcuts(
    stage,
    state,
    controller,
    onQuickOpen,
    onAiHandoff,
    onToggleSidebar,
    onOpenSettings,
    onShowFiles,
  );
  useDocumentReady(stage, state, controller);
  const [dropColumn, setDropColumn] = useState<Column | null>(null);
  const tabsById = new Map(state.tabs.map((tab) => [tab.id, tab]));
  const previous = new Set(mountOrder.current);
  mountOrder.current = [
    ...mountOrder.current.filter((id) => tabsById.has(id)),
    ...state.tabs.filter((tab) => !previous.has(tab.id)).map((tab) => tab.id),
  ];
  return (
    <>
      <DocumentExports stage={stage} state={state} controller={controller} />
      <DocumentLinks stage={stage} state={state} controller={controller} />
      <div ref={stage} className={"document-stage " + (state.split ? "split" : "")}>
        {draggedTab && state.tabs.some((tab) => tab.id === draggedTab && !tab.closing) && (
          <div className="document-drop-columns">
            {([0, 1] as const).map((column) => (
              <div
                key={column}
                className={"document-tab-drop " + (dropColumn === column ? "active" : "")}
                data-drop-column={column}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setDropColumn(column);
                }}
                onDragLeave={() => setDropColumn(null)}
                onDrop={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setDropColumn(null);
                  controller.moveTab(draggedTab, column);
                  onDragDone?.();
                }}
              >
                {t(column === 0 ? "左の列へ移動" : "右の列へ移動")}
              </div>
            ))}
          </div>
        )}
        {/* Every tab keeps the same parent and React key. Changing columns only
            changes grid placement; moving an iframe DOM node would reset its heap. */}
        {mountOrder.current.map((id) => {
          const tab = tabsById.get(id)!;
          const column = state.columns.indexOf(tab.id);
          const visible = column === 0 || (state.split && column === 1);
          return (
            <section
              key={tab.id}
              id={"panel-" + tab.id}
              role="tabpanel"
              aria-labelledby={"document-tab-" + tab.id}
              className={
                "document-pane " + (visible && state.activeColumn === column ? "active" : "")
              }
              hidden={!visible}
              style={{ gridColumn: visible ? column + 1 : undefined, gridRow: 1 }}
              aria-label={tab.kind === "help" ? t("機能と使い方") : tab.path}
              onFocusCapture={() => {
                if (visible) controller.setActiveColumn(column as Column);
              }}
            >
              {tab.kind === "help" ? (
                <Suspense
                  fallback={
                    <div className="document-empty" role="status">
                      {t("ヘルプを読み込み中")}
                    </div>
                  }
                >
                  <AppHelp documentOrigin={state.snapshot.documentOrigin} />
                </Suspense>
              ) : tab.url ? (
                <DocumentViewer
                  url={tab.url}
                  loading={tab.loading}
                  title={tab.path}
                  navigation={tab.navigation}
                  zoom={tab.zoom}
                  zoomAnchor={tab.zoomAnchor}
                  zoomRequest={tab.zoomRequest}
                />
              ) : (
                <div className="document-empty" role={tab.error ? "status" : undefined}>
                  {tab.error
                    ? translateUiMessage(tab.error)
                    : t(
                        tab.loading
                          ? "読み込み中"
                          : tab.deferred
                            ? "選択すると読み込みます"
                            : "文書を再読み込みしてください",
                      )}
                  {!tab.loading && !tab.closing && (
                    <button onClick={() => void controller.reload(tab.id)}>
                      {t("再読み込み")}
                    </button>
                  )}
                </div>
              )}
            </section>
          );
        })}
        {([0, 1] as const)
          .filter((column) => (column === 0 || state.split) && !state.columns[column])
          .map((column) => (
            <section
              key={"empty-" + column}
              className="document-pane"
              style={{ gridColumn: column + 1, gridRow: 1 }}
            >
              <button
                className="empty-column-button"
                onClick={() => controller.setActiveColumn(column)}
                aria-pressed={state.activeColumn === column}
              >
                {t(
                  state.split
                    ? column === 0
                      ? "左列で文書を開く"
                      : "右列で文書を開く"
                    : "左のツリーから文書を選択",
                )}
              </button>
              <DocumentViewer url={null} loading={false} />
            </section>
          ))}
      </div>
    </>
  );
}
