import { cleanup, createEvent, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { clampSidebarWidth, sidebarMaximum, SidebarSeparator } from "./SidebarSeparator";

afterEach(cleanup);
it("reserves document width and clamps the sidebar at both bounds", () => {
  expect(sidebarMaximum(700)).toBe(379);
  expect(clampSidebarWidth(500, 700)).toBe(379);
  expect(clampSidebarWidth(10, 1200)).toBe(230);
  expect(clampSidebarWidth(500, 1200)).toBe(450);
});
it("exposes keyboard resizing and ignores composing input", () => {
  const onWidth = vi.fn();
  const view = render(
    <SidebarSeparator width={292} viewport={700} onWidth={onWidth} onResizing={vi.fn()} />,
  );
  const separator = view.getByRole("separator", { name: "左メニューの幅" });
  expect(separator.getAttribute("aria-valuemax")).toBe("379");
  fireEvent.keyDown(separator, { key: "ArrowRight" });
  expect(onWidth).toHaveBeenLastCalledWith(302);
  fireEvent.keyDown(separator, { key: "ArrowRight", shiftKey: true });
  expect(onWidth).toHaveBeenLastCalledWith(342);
  fireEvent.keyDown(separator, { key: "End" });
  expect(onWidth).toHaveBeenLastCalledWith(379);
  fireEvent.keyDown(separator, { key: "Home", isComposing: true });
  expect(onWidth).toHaveBeenCalledTimes(3);
});
it("leaves modified navigation keys available to workspace shortcuts", () => {
  const onWidth = vi.fn();
  const onKeyDown = vi.fn();
  const view = render(
    <div onKeyDown={onKeyDown}>
      <SidebarSeparator width={292} viewport={700} onWidth={onWidth} onResizing={vi.fn()} />
    </div>,
  );
  const separator = view.getByRole("separator");
  for (const modifier of ["ctrlKey", "metaKey", "altKey"]) {
    for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) {
      const event = createEvent.keyDown(separator, { key, shiftKey: true, [modifier]: true });
      fireEvent(separator, event);
      expect(event.defaultPrevented).toBe(false);
    }
  }
  expect(onWidth).not.toHaveBeenCalled();
  expect(onKeyDown).toHaveBeenCalledTimes(12);
});
