import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { RootAction } from "../lib/rootActions";
import { useT } from "../lib/i18n";
import "./root-ai-handoff.css";

export function RootAiHandoffMenu({
  children,
  disabled,
  contextKey,
  onAiHandoff,
  onRootAction,
  rootName,
}: {
  children: ReactElement;
  disabled: boolean;
  contextKey: string;
  onAiHandoff: (returnFocus: HTMLElement) => void;
  onRootAction?: (action: RootAction) => void;
  rootName?: string;
}) {
  const t = useT();
  const trigger = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ x: number; y: number; contextKey: string } | null>(
    null,
  );
  const close = (restoreFocus: boolean) => {
    setPosition(null);
    if (restoreFocus) trigger.current?.querySelector("button")?.focus();
  };
  useEffect(() => {
    close(false);
  }, [contextKey, disabled]);
  useLayoutEffect(() => {
    if (!position || !menu.current) return;
    const element = menu.current;
    const bounds = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(position.x, window.innerWidth - bounds.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(position.y, window.innerHeight - bounds.height - 8))}px`;
  }, [position, t]);
  useLayoutEffect(() => {
    if (position) menu.current?.querySelector("button")?.focus();
  }, [position]);
  useEffect(() => {
    if (!position) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) close(false);
    };
    const cancel = () => close(true);
    const blur = () => {
      queueMicrotask(() => {
        if (document.activeElement?.tagName === "IFRAME") close(false);
      });
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", cancel);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", cancel);
      window.removeEventListener("blur", blur);
    };
  }, [position]);
  return (
    <div
      ref={trigger}
      className="root-ai-handoff-trigger"
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!disabled) setPosition({ x: event.clientX, y: event.clientY, contextKey });
      }}
      onKeyDown={(event) => {
        if (
          position ||
          event.defaultPrevented ||
          event.nativeEvent.isComposing ||
          event.nativeEvent.keyCode === 229
        )
          return;
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
          event.preventDefault();
          event.stopPropagation();
          if (!disabled) {
            const bounds = trigger.current!.getBoundingClientRect();
            setPosition({ x: bounds.left, y: bounds.bottom, contextKey });
          }
        }
      }}
    >
      {children}
      {position && position.contextKey === contextKey && !disabled && (
        <div
          ref={menu}
          className="file-context-menu app-surface"
          role="menu"
          aria-label={t("ルートフォルダーの操作")}
          style={{ left: position.x, top: position.y }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
              if (event.key === "Enter") event.preventDefault();
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              close(true);
            } else if (event.key === "Tab") {
              event.preventDefault();
              close(true);
            } else if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
              const current = items.findIndex((item) => item === document.activeElement);
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? items.length - 1
                    : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
              items[next]?.focus();
            }
          }}
        >
          {rootName && (
            <div className="registered-folder-menu-label">
              {t("登録フォルダー：{name}", { name: rootName })}
            </div>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const button = trigger.current?.querySelector("button");
              close(false);
              if (button && !disabled && position.contextKey === contextKey) onAiHandoff(button);
            }}
          >
            {t("AIに渡す")}
          </button>
          {onRootAction &&
            (
              [
                ["copyPath", "フルパスをコピー"],
                ["openFolder", "フォルダーを開く"],
              ] as const
            ).map(([action, label]) => (
              <button
                type="button"
                role="menuitem"
                key={action}
                onClick={() => {
                  close(true);
                  if (!disabled && position.contextKey === contextKey) onRootAction(action);
                }}
              >
                {t(label)}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
