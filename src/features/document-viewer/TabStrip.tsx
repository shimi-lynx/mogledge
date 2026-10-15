import { useT } from "../../lib/i18n";
import { prepareNavigation } from "../../lib/navigationHistory";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AppState, Column, DocumentTab } from "../../lib/types";
import type { KnowledgeController } from "../../lib/controller";
import { TabContextMenu } from "./TabContextMenu";
import { htmlNameParts } from "../knowledge-tree/model";
import { shortcutScope } from "../../app/windowChrome";
import "./tab-workspace.css";

export function TabStrip({
  state,
  controller,
  onEmpty,
  onTabDrag,
  activeDragId,
}: {
  state: AppState;
  controller: KnowledgeController;
  onEmpty: () => void;
  onTabDrag?: (id: string | null) => void;
  activeDragId?: string | null;
}) {
  const t = useT();
  const container = useRef<HTMLDivElement>(null);
  const dragged = useRef<string | null>(null);
  const restore = useRef<{ id: string; origin: Element | null; reorder: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [drop, setDrop] = useState<{ column: Column; id?: string; after: boolean } | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  useEffect(() => {
    if (activeDragId === null) {
      dragged.current = null;
      setDragging(false);
      setDrop(null);
    }
  }, [activeDragId]);
  const order = state.tabs.map((tab) => tab.id).join(",");
  const membership = (tab: DocumentTab): Column => {
    const visible = state.columns.indexOf(tab.id);
    return state.split ? (visible >= 0 ? (visible as Column) : (tab.column ?? 0)) : 0;
  };
  const button = (id: string) =>
    container.current?.querySelector<HTMLButtonElement>(`[id="document-tab-${id}"]`);
  useLayoutEffect(() => {
    for (const id of state.columns) {
      if (id) button(id)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    }
    const pending = restore.current;
    if (!pending || (!pending.reorder && state.tabs.some((tab) => tab.id === pending.id))) return;
    restore.current = null;
    if (document.activeElement !== pending.origin && document.activeElement !== document.body)
      return;
    const target = pending.reorder
      ? button(pending.id)
      : (button(state.columns[state.activeColumn] ?? "") ??
        container.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]'));
    if (target) target.focus();
    else onEmpty();
  }, [order, state.columns, state.activeColumn, onEmpty]);

  const rememberFocus = (id: string, reorder = false) => {
    const item = button(id)?.closest(".tab-item");
    if (item?.contains(document.activeElement))
      restore.current = { id, origin: document.activeElement, reorder };
  };
  const close = (id: string) => {
    rememberFocus(id);
    void controller.closeTab(id);
  };
  const reorder = (id: string, anchor: string, after: boolean) => {
    rememberFocus(id, true);
    controller.reorderTab(id, anchor, after);
  };
  const moveToColumn = (id: string, column: Column, anchor?: string, after = false) => {
    rememberFocus(id, true);
    controller.moveTab(id, column, anchor, after);
  };
  const finishDrag = () => {
    onTabDrag?.(null);
    dragged.current = null;
    setDragging(false);
    setDrop(null);
  };
  const dropAtEnd = (column: Column) => {
    const source = state.tabs.find((tab) => tab.id === dragged.current && !tab.closing);
    if (source) {
      if (membership(source) === column) {
        const last = state.tabs.filter((tab) => membership(tab) === column && !tab.closing).at(-1);
        if (last && last.id !== source.id) reorder(source.id, last.id, true);
      } else moveToColumn(source.id, column);
    }
    finishDrag();
  };
  const dismissMenu = useCallback(
    (restoreFocus: boolean) => {
      if (restoreFocus && menu) {
        container.current
          ?.querySelector<HTMLButtonElement>(`[id="document-tab-${menu.id}"]`)
          ?.focus();
      }
      setMenu(null);
    },
    [menu],
  );
  const menuTab = state.tabs.find((tab) => tab.id === menu?.id && tab.kind !== "help");
  useEffect(() => {
    if (menu && !menuTab) setMenu(null);
  }, [menu, menuTab]);

  return (
    <div
      className="tab-strip"
      ref={container}
      data-split={state.split}
      data-dragging={dragging}
      data-tauri-drag-region={dragging ? undefined : true}
      hidden={!state.tabs.length}
    >
      {([0, 1] as const)
        .filter((column) => column === 0 || state.split)
        .map((column) => {
          const tabs = state.tabs.filter((tab) => membership(tab) === column);
          const enabled = tabs.filter((tab) => !tab.closing);
          const focusable = enabled.find((tab) => tab.id === state.columns[column]) ?? enabled[0];
          return (
            <div
              key={column}
              className={"tab-group " + (state.activeColumn === column ? "active" : "")}
              data-column={column}
              // Scrollbar presses target the scroller itself; Tauri must not turn them into window drags.
              data-tauri-drag-region="false"
              role="tablist"
              aria-label={t(
                state.split ? (column === 0 ? "左列の文書" : "右列の文書") : "開いている文書",
              )}
              onDragOver={(event) => {
                if (!dragged.current) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDrop({ column, after: true });
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                  setDrop(null);
              }}
              onDrop={(event) => {
                if (!dragged.current) return;
                event.preventDefault();
                event.stopPropagation();
                dropAtEnd(column);
              }}
            >
              {tabs.map((tab) => {
                const filename =
                  tab.kind === "help" ? t("機能と使い方") : (tab.path.split("/").pop() ?? tab.path);
                const label = htmlNameParts(filename).basename || filename;
                const selected = state.columns[column] === tab.id;
                const enabledIndex = enabled.findIndex((item) => item.id === tab.id);
                const move = (next: number) => {
                  const target = enabled[(next + enabled.length) % enabled.length];
                  if (!target) return;
                  controller.activate(target.id, column);
                  button(target.id)?.focus();
                };
                return (
                  <div
                    key={tab.id}
                    role="presentation"
                    className={
                      "tab-item " +
                      (selected ? "selected " : "") +
                      (drop?.id === tab.id ? (drop.after ? "drop-after" : "drop-before") : "")
                    }
                    draggable={!tab.closing}
                    onMouseDown={(event) => {
                      if (event.button === 1 || event.button === 2) event.preventDefault();
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      if (tab.kind === "help") return;
                      setMenu({ id: tab.id, x: event.clientX, y: event.clientY });
                    }}
                    onAuxClick={(event) => {
                      if (event.button === 1) {
                        event.preventDefault();
                        close(tab.id);
                      }
                    }}
                    onDragStart={(event) => {
                      dragged.current = tab.id;
                      onTabDrag?.(tab.id);
                      setDragging(true);
                      setMenu(null);
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", tab.id);
                    }}
                    onDragOver={(event) => {
                      const source = state.tabs.find((item) => item.id === dragged.current);
                      if (!source || source.id === tab.id || tab.closing) return;
                      event.preventDefault();
                      event.stopPropagation();
                      event.dataTransfer.dropEffect = "move";
                      const rect = event.currentTarget.getBoundingClientRect();
                      const after = event.clientX > rect.left + rect.width / 2;
                      setDrop((previous) =>
                        previous?.id === tab.id && previous.after === after
                          ? previous
                          : { column, id: tab.id, after },
                      );
                    }}
                    onDrop={(event) => {
                      const source = state.tabs.find((item) => item.id === dragged.current);
                      if (source && !source.closing && !tab.closing && source.id !== tab.id) {
                        event.preventDefault();
                        event.stopPropagation();
                        const rect = event.currentTarget.getBoundingClientRect();
                        const after = event.clientX > rect.left + rect.width / 2;
                        if (membership(source) === column) reorder(source.id, tab.id, after);
                        else moveToColumn(source.id, column, tab.id, after);
                      }
                      finishDrag();
                    }}
                    onDragEnd={finishDrag}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) return;
                      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                        event.preventDefault();
                        event.stopPropagation();
                        if (tab.kind === "help") return;
                        const rect = event.currentTarget.getBoundingClientRect();
                        setMenu({ id: tab.id, x: rect.left, y: rect.bottom });
                        return;
                      }
                      const zoomModifier = /Mac/i.test(navigator.platform)
                        ? event.metaKey && !event.ctrlKey
                        : event.ctrlKey && !event.metaKey;
                      const zoomChange =
                        event.key === "+" || event.key === "=" || event.code === "NumpadAdd"
                          ? "in"
                          : event.key === "-" || event.code === "NumpadSubtract"
                            ? "out"
                            : event.key === "0" && !event.shiftKey
                              ? "reset"
                              : null;
                      const focused = document.activeElement;
                      if (
                        zoomModifier &&
                        zoomChange &&
                        !event.altKey &&
                        !event.defaultPrevented &&
                        !event.nativeEvent.cancelBubble &&
                        event.target === focused &&
                        focused?.getAttribute("role") === "tab" &&
                        shortcutScope() === "app" &&
                        !tab.closing &&
                        !tab.missing &&
                        tab.url
                      ) {
                        // Tab focus survives menu dismissal; use that tab's own view, not the active column.
                        controller.zoomTab(tab.id, zoomChange);
                        event.preventDefault();
                        event.stopPropagation();
                        return;
                      }
                      const command = event.ctrlKey || event.metaKey;
                      if (
                        command &&
                        event.shiftKey &&
                        (event.key === "ArrowLeft" || event.key === "ArrowRight")
                      ) {
                        moveToColumn(tab.id, event.key === "ArrowLeft" ? 0 : 1);
                        event.preventDefault();
                        event.stopPropagation();
                        return;
                      }
                      const next =
                        command && event.key === "Tab"
                          ? enabledIndex + (event.shiftKey ? -1 : 1)
                          : event.key === "ArrowRight"
                            ? enabledIndex + 1
                            : event.key === "ArrowLeft"
                              ? enabledIndex - 1
                              : event.key === "Home"
                                ? 0
                                : event.key === "End"
                                  ? enabled.length - 1
                                  : null;
                      if (next !== null) {
                        event.preventDefault();
                        event.stopPropagation();
                        move(next);
                      }
                    }}
                  >
                    <button
                      id={"document-tab-" + tab.id}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      aria-controls={"panel-" + tab.id}
                      aria-label={
                        filename +
                        (tab.zoom !== undefined && tab.zoom !== 100
                          ? ` ${Math.round(tab.zoom * 10) / 10}%`
                          : "") +
                        (tab.dirty && !tab.deferred ? " " + t("更新あり") : "")
                      }
                      aria-description={tab.kind === "help" ? t("機能と使い方") : tab.path}
                      tabIndex={tab.id === focusable?.id ? 0 : -1}
                      disabled={tab.closing}
                      title={
                        (tab.kind === "help" ? t("機能と使い方") : tab.path) +
                        (tab.deferred
                          ? t("（選択時に読み込み）")
                          : tab.dirty
                            ? t("（更新あり）")
                            : "")
                      }
                      onClick={() => controller.activate(tab.id, column)}
                      onFocus={() => controller.setActiveColumn(column)}
                    >
                      <span className="tab-title">{label}</span>
                      {tab.zoom !== undefined && tab.zoom !== 100 && (
                        <span className="tab-zoom">{Math.round(tab.zoom * 10) / 10}%</span>
                      )}
                      {tab.dirty && !tab.deferred && (
                        <span className="tab-update" aria-label={t("更新あり")}>
                          ●
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      className="tab-action tab-close"
                      tabIndex={selected ? 0 : -1}
                      aria-label={t("{path}を閉じる", {
                        path: tab.kind === "help" ? t("機能と使い方") : tab.path,
                      })}
                      title={t("閉じる（中クリック／Ctrl/Cmd+W）")}
                      disabled={tab.closing}
                      onClick={() => close(tab.id)}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
              <div
                className={
                  "tab-group-drop-target " +
                  (drop?.column === column && !drop.id ? "drop-active" : "")
                }
                aria-label={t(column === 0 ? "左の列へ移動" : "右の列へ移動")}
                data-tauri-drag-region={dragging ? undefined : true}
              >
                {!tabs.length && t("文書をここへ移動")}
              </div>
            </div>
          );
        })}
      {!state.split && dragging && (
        <div
          className={"tab-split-drop-target " + (drop?.column === 1 ? "drop-active" : "")}
          data-column={1}
          aria-label={t("右の列へ移動")}
          onDragOver={(event) => {
            if (!dragged.current) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDrop({ column: 1, after: true });
          }}
          onDragLeave={() => setDrop(null)}
          onDrop={(event) => {
            if (!dragged.current) return;
            event.preventDefault();
            dropAtEnd(1);
          }}
        >
          {t("右の列へ移動")}
        </div>
      )}
      {menu && menuTab && (
        <TabContextMenu
          tab={menuTab}
          x={menu.x}
          y={menu.y}
          canReopen={state.closed.length > 0}
          history={{
            back: !!(
              state.navigationHistory &&
              prepareNavigation(state.navigationHistory[membership(menuTab)], "back").request
            ),
            forward: !!(
              state.navigationHistory &&
              prepareNavigation(state.navigationHistory[membership(menuTab)], "forward").request
            ),
          }}
          onHistory={(direction) => void controller.navigateHistory(direction, membership(menuTab))}
          currentColumn={membership(menuTab)}
          onOpen={(column) => void controller.openInColumn(menuTab.path, column)}
          onMove={(column) => moveToColumn(menuTab.id, column)}
          onReload={() => void controller.reload(menuTab.id, "user-reload")}
          onZoom={(change) => controller.zoomTab(menuTab.id, change)}
          onCloseTab={() => close(menuTab.id)}
          canCloseRight={state.tabs
            .slice(state.tabs.findIndex((tab) => tab.id === menuTab.id) + 1)
            .some((tab) => !tab.closing && membership(tab) === membership(menuTab))}
          onCloseRight={() => void controller.closeTabsToRight(menuTab.id)}
          onReopen={() => void controller.reopen()}
          onDismiss={dismissMenu}
        />
      )}
    </div>
  );
}
