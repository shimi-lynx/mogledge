import { useLayoutEffect, useEffect, useRef } from "react";
import type { FileAction } from "../../lib/types";
import { useT } from "../../lib/i18n";
import { MenuItemLabel, menuModifier } from "../../app/MenuItemLabel";

const actions: { action: FileAction; label: string; hint?: string }[] = [
  { action: "copyPath", label: "フルパスをコピー" },
  { action: "openFolder", label: "元フォルダーを開く" },
  {
    action: "openBrowser",
    label: "既定ブラウザーで表示",
    hint: "アプリ終了・フォルダー変更・画面再起動後は表示できません。もう一度ここから開いてください",
  },
];
export function FileContextMenu({
  path,
  x,
  y,
  busy,
  onAction,
  onClose,
  kind = "html",
  onTreeAction,
  onOpenColumn,
  onRecoverState,
  onStateTransfer,
  onAiHandoff,
  favorite = false,
  onFavorite,
  onSearchFolder,
  reorderDisabled = [false, false],
  onTrash,
}: {
  path: string;
  x: number;
  y: number;
  busy: boolean;
  onAction?: (action: FileAction) => void;
  onClose: (restoreFocus: boolean) => void;
  kind?: "html" | "folder";
  onTreeAction?: (action: "createFolder" | "renameHtml" | "move" | "up" | "down") => void;
  onOpenColumn?: (path: string, column: 0 | 1) => void;
  onRecoverState?: (path: string) => void;
  onStateTransfer?: (path: string, kind: "import" | "export") => void;
  onAiHandoff?: (path: string) => void;
  favorite?: boolean;
  onFavorite?: (path: string, add: boolean) => void;
  onSearchFolder?: (path: string) => void;
  reorderDisabled?: [boolean, boolean];
  onTrash?: () => void;
}) {
  const t = useT();
  const menu = useRef<HTMLDivElement>(null);
  const modifier = menuModifier();
  useLayoutEffect(() => {
    const element = menu.current!;
    const rect = element.getBoundingClientRect();
    element.style.left = Math.max(8, Math.min(x, innerWidth - rect.width - 8)) + "px";
    element.style.top = Math.max(8, Math.min(y, innerHeight - rect.height - 8)) + "px";
  }, [x, y, t]);
  useLayoutEffect(() => {
    const element = menu.current!;
    (element.querySelector<HTMLButtonElement>("button:not(:disabled)") ?? element).focus();
  }, [x, y]);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose(false);
    };
    const resize = () => onClose(true);
    const blur = () => {
      // Opaque child iframe clicks do not bubble to the parent window.
      queueMicrotask(() => {
        if (document.activeElement?.tagName === "IFRAME") onClose(false);
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
  }, [onClose]);
  return (
    <div
      ref={menu}
      className="file-context-menu"
      role="menu"
      aria-label={t("{path}のファイル操作", { path })}
      tabIndex={-1}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        // Enter/Space activate the focused button, never the underlying tree row.
        event.stopPropagation();
        if (["Escape", "Tab"].includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          onClose(true);
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
        if (next === null) return;
        event.preventDefault();
        event.stopPropagation();
        buttons[next]?.focus();
      }}
    >
      <div className="context-file-name" title={path}>
        {path.split("/").pop()}
      </div>
      {onAiHandoff && (
        <button
          role="menuitem"
          disabled={busy}
          onClick={() => {
            onClose(true);
            onAiHandoff(path);
          }}
        >
          <MenuItemLabel label={t("AIに渡す")} />
        </button>
      )}
      {kind === "folder" && onSearchFolder && (
        <button
          role="menuitem"
          disabled={busy}
          onClick={() => {
            onClose(false);
            onSearchFolder(path);
          }}
        >
          <MenuItemLabel label={t("このフォルダー内を検索")} />
        </button>
      )}
      {onFavorite && (
        <button
          role="menuitem"
          disabled={busy}
          onClick={() => {
            onClose(true);
            onFavorite(path, !favorite);
          }}
        >
          <MenuItemLabel label={t(favorite ? "お気に入りから解除" : "お気に入りに追加")} />
        </button>
      )}
      {kind === "html" &&
        onOpenColumn &&
        ([0, 1] as const).map((column) => (
          <button
            key={column}
            role="menuitem"
            disabled={busy}
            onClick={() => {
              onClose(true);
              onOpenColumn(path, column);
            }}
          >
            <MenuItemLabel label={t(column === 0 ? "左の列で開く" : "右の列で開く")} />
          </button>
        ))}
      {(onAction
        ? actions.filter(({ action }) => kind === "html" || action !== "openBrowser")
        : []
      ).map(({ action, label, hint }) => (
        <button
          key={action}
          role="menuitem"
          disabled={busy}
          title={hint ? t(hint) : undefined}
          onClick={() => {
            onClose(true);
            onAction?.(action);
          }}
        >
          <MenuItemLabel
            label={t(kind === "folder" && action === "openFolder" ? "フォルダーを開く" : label)}
          />
        </button>
      ))}
      {kind === "html" &&
        onStateTransfer &&
        (["export", "import"] as const).map((kind) => (
          <button
            key={kind}
            role="menuitem"
            disabled={busy}
            onClick={() => {
              onClose(true);
              onStateTransfer(path, kind);
            }}
          >
            <MenuItemLabel
              label={t(kind === "import" ? "保存済み入力を取り込む" : "保存済み入力を書き出す")}
            />
          </button>
        ))}
      {kind === "html" && onRecoverState && (
        <button
          role="menuitem"
          disabled={busy}
          onClick={() => {
            onClose(true);
            onRecoverState(path);
          }}
        >
          <MenuItemLabel label={t("以前の入力状態を引き継ぐ")} />
        </button>
      )}
      {onTreeAction && kind === "html" && (
        <button
          role="menuitem"
          disabled={busy}
          title={t("ツリーで項目にフォーカスして名前を変更")}
          onClick={() => {
            onClose(true);
            onTreeAction("renameHtml");
          }}
        >
          <MenuItemLabel label={t("名前を変更")} shortcut={modifier === "⌘" ? "Enter" : "F2"} />
        </button>
      )}
      {onTreeAction &&
        (
          [
            ["createFolder", "フォルダーを作成", false],
            ["up", "上へ並べ替え", reorderDisabled[0]],
            ["down", "下へ並べ替え", reorderDisabled[1]],
            ["move", "別フォルダーへ移動", false],
          ] as const
        ).map(([action, label, disabled]) => (
          <button
            key={action}
            role="menuitem"
            disabled={busy || disabled}
            onClick={() => {
              onClose(true);
              onTreeAction(action);
            }}
          >
            <MenuItemLabel
              label={t(label)}
              shortcut={action === "createFolder" ? modifier + "+Shift+N" : undefined}
            />
          </button>
        ))}
      {onTrash && (
        <button
          role="menuitem"
          disabled={busy}
          onClick={() => {
            onClose(true);
            onTrash();
          }}
        >
          <MenuItemLabel
            label={t("ごみ箱に移動")}
            shortcut={modifier === "⌘" ? "⌘+Delete（⌫）" : "Delete / Backspace"}
          />
        </button>
      )}
    </div>
  );
}
