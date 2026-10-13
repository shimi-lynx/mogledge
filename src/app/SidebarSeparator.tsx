import { useT } from "../lib/i18n";
import { useCallback, useEffect, useRef, useState } from "react";

export const MIN_SIDEBAR_WIDTH = 230;
const MAX_SIDEBAR_WIDTH = 450;
const MIN_DOCUMENT_WIDTH = 320;
export const SIDEBAR_SEPARATOR_WIDTH = 1;
export const SIDEBAR_OVERLAY_WIDTH = 640;

export function sidebarMaximum(viewport: number) {
  return Math.max(
    MIN_SIDEBAR_WIDTH,
    Math.min(MAX_SIDEBAR_WIDTH, viewport - MIN_DOCUMENT_WIDTH - SIDEBAR_SEPARATOR_WIDTH),
  );
}

export function clampSidebarWidth(width: number, viewport: number) {
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(sidebarMaximum(viewport), width));
}

export function useSidebarWidth() {
  const [viewport, setViewport] = useState(window.innerWidth);
  const [width, setWidth] = useState(292);
  const [resizing, setResizing] = useState(false);
  useEffect(() => {
    const resize = () => {
      setViewport(window.innerWidth);
      if (window.innerWidth > SIDEBAR_OVERLAY_WIDTH)
        setWidth((value) => clampSidebarWidth(value, window.innerWidth));
    };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  return { width, viewport, setWidth, resizing, setResizing };
}

export function SidebarSeparator({
  width,
  viewport,
  onWidth,
  onResizing,
}: {
  width: number;
  viewport: number;
  onWidth: (width: number) => void;
  onResizing: (resizing: boolean) => void;
}) {
  const t = useT();
  const drag = useRef<{ id: number; x: number; width: number } | null>(null);
  const separator = useRef<HTMLDivElement>(null);
  const stop = useCallback(
    (cancel = false) => {
      const previous = drag.current;
      if (!previous) return;
      drag.current = null;
      if (cancel) onWidth(clampSidebarWidth(previous.width, window.innerWidth));
      if (separator.current?.hasPointerCapture?.(previous.id))
        separator.current.releasePointerCapture(previous.id);
      onResizing(false);
    },
    [onWidth, onResizing],
  );
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !drag.current) return;
      event.preventDefault();
      event.stopPropagation();
      stop(true);
    };
    const blur = () => stop();
    window.addEventListener("keydown", cancel, true);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", cancel, true);
      window.removeEventListener("blur", blur);
      stop();
    };
  }, [stop]);
  return (
    <div
      ref={separator}
      className="sidebar-separator"
      role="separator"
      aria-label={t("左メニューの幅")}
      aria-orientation="vertical"
      aria-controls="knowledge-sidebar"
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={sidebarMaximum(viewport)}
      aria-valuenow={Math.round(width)}
      aria-valuetext={t("{width}ピクセル", { width: Math.round(width) })}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        drag.current = { id: event.pointerId, x: event.clientX, width };
        event.currentTarget.setPointerCapture?.(event.pointerId);
        onResizing(true);
      }}
      onPointerMove={(event) => {
        const source = drag.current;
        if (source?.id !== event.pointerId) return;
        onWidth(clampSidebarWidth(source.width + event.clientX - source.x, window.innerWidth));
      }}
      onPointerUp={() => stop()}
      onPointerCancel={() => stop(true)}
      onLostPointerCapture={() => stop()}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
        const step = event.shiftKey ? 50 : 10;
        const next =
          event.key === "ArrowLeft"
            ? width - step
            : event.key === "ArrowRight"
              ? width + step
              : event.key === "Home"
                ? MIN_SIDEBAR_WIDTH
                : event.key === "End"
                  ? sidebarMaximum(viewport)
                  : null;
        if (next === null) return;
        event.preventDefault();
        onWidth(clampSidebarWidth(next, viewport));
      }}
    />
  );
}
