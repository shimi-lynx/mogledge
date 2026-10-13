import { useT } from "../../lib/i18n";
import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { Column, DocumentTab, DocumentZoomChange } from "../../lib/types";
import { MenuItemLabel, menuModifier } from "../../app/MenuItemLabel";

export function TabContextMenu({
  tab,
  x,
  y,
  canReopen,
  currentColumn,
  onOpen,
  onMove,
  onReload,
  onZoom,
  onCloseTab,
  canCloseRight,
  onCloseRight,
  onReopen,
  onDismiss,
  history,
  onHistory,
}: {
  history?: { back: boolean; forward: boolean };
  onHistory?: (direction: "back" | "forward") => void;
  tab: DocumentTab;
  x: number;
  y: number;
  canReopen: boolean;
  currentColumn: Column;
  onOpen: (column: Column) => void;
  onMove: (column: Column) => void;
  onReload: () => void;
  onZoom: (change: DocumentZoomChange) => void;
  onCloseTab: () => void;
  canCloseRight: boolean;
  onCloseRight: () => void;
  onReopen: () => void;
  onDismiss: (restoreFocus: boolean) => void;
}) {
  const t = useT();
  const menu = useRef<HTMLDivElement>(null);
  const modifier = menuModifier();
  useLayoutEffect(() => {
    const element = menu.current!;
    const rect = element.getBoundingClientRect();
    element.style.left = Math.max(8, Math.min(x, innerWidth - rect.width - 8)) + "px";
    element.style.top = Math.max(8, Math.min(y, innerHeight - rect.height - 8)) + "px";
    (element.querySelector<HTMLButtonElement>("button:not(:disabled)") ?? element).focus();
  }, [x, y, t]);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) onDismiss(false);
    };
    const resize = () => onDismiss(true);
    const blur = () => {
      queueMicrotask(() => {
        if (document.activeElement?.tagName === "IFRAME") onDismiss(false);
      });
    };
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("resize", resize);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("resize", resize);
      window.removeEventListener("blur", blur);
    };
  }, [onDismiss]);
  const run = (action: () => void) => {
    onDismiss(true);
    action();
  };
  return createPortal(
    <div
      ref={menu}
      role="menu"
      aria-label={t("{path}のタブ操作", { path: tab.path })}
      className="tab-context-menu"
      tabIndex={-1}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape" || event.key === "Tab") {
          event.preventDefault();
          onDismiss(true);
          return;
        }
        const buttons = Array.from(
          menu.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
        );
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          event.key === "ArrowDown"
            ? (index + 1) % buttons.length
            : event.key === "ArrowUp"
              ? (index + buttons.length - 1) % buttons.length
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? buttons.length - 1
                  : null;
        if (next !== null) {
          event.preventDefault();
          buttons[next]?.focus();
        }
      }}
    >
      <div className="tab-context-name" title={tab.path}>
        {tab.path.split("/").pop()}
      </div>
      {onHistory &&
        (["back", "forward"] as const).map((direction) => (
          <button
            key={direction}
            role="menuitem"
            disabled={!history?.[direction]}
            onClick={() => run(() => onHistory(direction))}
          >
            <MenuItemLabel
              label={t(direction === "back" ? "文書履歴を戻る" : "文書履歴を進む")}
              shortcut={
                /Mac/i.test(navigator.platform)
                  ? "⌘+" + (direction === "back" ? "[" : "]")
                  : "Alt+" + (direction === "back" ? "←" : "→")
              }
            />
          </button>
        ))}
      {([0, 1] as const).map((column) => (
        <button
          key={column}
          role="menuitem"
          disabled={tab.closing || tab.missing}
          onClick={() => run(() => onOpen(column))}
        >
          <MenuItemLabel label={t(column === 0 ? "左の列で開く" : "右の列で開く")} />
        </button>
      ))}
      {([0, 1] as const).map((column) => (
        <button
          key={"move-" + column}
          role="menuitem"
          disabled={tab.closing || currentColumn === column}
          title={t("このタブの入力・実行状態を保って移動します")}
          onClick={() => run(() => onMove(column))}
        >
          <MenuItemLabel
            label={t(column === 0 ? "左の列へ移動" : "右の列へ移動")}
            shortcut={modifier + "+Shift+" + (column === 0 ? "←" : "→")}
          />
        </button>
      ))}
      <div className="tab-context-name">
        {t("文書表示: {zoom}%", { zoom: Math.round((tab.zoom ?? 100) * 10) / 10 })}
      </div>
      {(["in", "out", "reset"] as const).map((change) => (
        <button
          key={change}
          role="menuitem"
          disabled={
            tab.closing ||
            tab.missing ||
            !tab.url ||
            (change === "in"
              ? (tab.zoom ?? 100) >= 200
              : change === "out"
                ? (tab.zoom ?? 100) <= 50
                : (tab.zoom ?? 100) === 100)
          }
          onClick={() => run(() => onZoom(change))}
        >
          <MenuItemLabel
            label={t(
              change === "in" ? "文書を拡大" : change === "out" ? "文書を縮小" : "100%に戻す",
            )}
            shortcut={modifier + "+" + (change === "in" ? "+" : change === "out" ? "−" : "0")}
          />
        </button>
      ))}
      <button
        role="menuitem"
        disabled={tab.closing || tab.loading}
        title={t("入力・Canvas・実行状態をリセットして読み込み直します")}
        onClick={() => run(onReload)}
      >
        <MenuItemLabel label={t("状態をリセットして再読み込み")} />
      </button>
      <button
        role="menuitem"
        disabled={tab.closing}
        title={t("このタブを閉じます。Ctrl/Cmd+Wはアクティブ列の現在のタブを閉じます")}
        onClick={() => run(onCloseTab)}
      >
        <MenuItemLabel label={t("タブを閉じる")} shortcut={modifier + "+W"} />
      </button>
      <button
        role="menuitem"
        disabled={tab.closing || !canCloseRight}
        title={t(
          canCloseRight
            ? "同じ列で、このタブより右側だけを閉じます"
            : "同じ列の右側に閉じるタブがありません",
        )}
        onClick={() => run(onCloseRight)}
      >
        <MenuItemLabel label={t("右側のタブを全て閉じる")} />
      </button>
      <button role="menuitem" disabled={!canReopen} onClick={() => run(onReopen)}>
        <MenuItemLabel label={t("閉じたタブを開き直す")} shortcut={modifier + "+Shift+T"} />
      </button>
    </div>,
    document.body,
  );
}
