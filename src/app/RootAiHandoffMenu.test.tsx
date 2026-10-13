import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { RootAiHandoffMenu } from "./RootAiHandoffMenu";
import { setLanguage } from "../lib/i18n";

afterEach(() => {
  cleanup();
  setLanguage("ja");
});
test("root context menu keeps left click and returns the root button to the AI dialog", () => {
  const choose = vi.fn();
  const handoff = vi.fn();
  const { rerender } = render(
    <RootAiHandoffMenu disabled={false} contextKey="workspace:view" onAiHandoff={handoff}>
      <button onClick={choose}>選択中のルート</button>
    </RootAiHandoffMenu>,
  );
  const button = screen.getByRole("button", { name: "選択中のルート" });
  fireEvent.click(button);
  expect(choose).toHaveBeenCalledOnce();
  expect(handoff).not.toHaveBeenCalled();
  fireEvent.contextMenu(button, { clientX: 20, clientY: 30 });
  const action = screen.getByRole("menuitem", { name: "AIに渡す" });
  expect(document.activeElement).toBe(action);
  fireEvent.click(action);
  expect(handoff).toHaveBeenCalledWith(button);
  expect(choose).toHaveBeenCalledOnce();
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.keyDown(button, { key: "F10", shiftKey: true });
  fireEvent.keyDown(screen.getByRole("menuitem"), { key: "Escape" });
  expect(document.activeElement).toBe(button);
  fireEvent.keyDown(button, { key: "ContextMenu" });
  expect(screen.getByRole("menu")).toBeTruthy();
  rerender(
    <RootAiHandoffMenu disabled={false} contextKey="new:view" onAiHandoff={handoff}>
      <button onClick={choose}>選択中のルート</button>
    </RootAiHandoffMenu>,
  );
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.keyDown(button, { key: "F10", shiftKey: true, isComposing: true });
  expect(screen.queryByRole("menu")).toBeNull();
  rerender(
    <RootAiHandoffMenu disabled={true} contextKey="new:view" onAiHandoff={handoff}>
      <button onClick={choose}>選択中のルート</button>
    </RootAiHandoffMenu>,
  );
  fireEvent.contextMenu(button);
  fireEvent.keyDown(button, { key: "ContextMenu" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(handoff).toHaveBeenCalledOnce();
});

test("root action language changes without translating the selected folder name", () => {
  const handoff = vi.fn();
  render(
    <RootAiHandoffMenu disabled={false} contextKey="workspace:view" onAiHandoff={handoff}>
      <button>日本語ルート名</button>
    </RootAiHandoffMenu>,
  );
  const root = screen.getByRole("button", { name: "日本語ルート名" });
  fireEvent.contextMenu(root);
  act(() => {
    setLanguage("en");
  });
  expect(screen.getByRole("menu", { name: "Root folder actions" })).toBeTruthy();
  const action = screen.getByRole("menuitem", { name: "Send to AI" });
  expect(document.activeElement).toBe(action);
  expect(screen.getByRole("button", { name: "日本語ルート名" })).toBe(root);
  fireEvent.click(action);
  expect(handoff).toHaveBeenCalledWith(root);
});

test("root menu keeps AI first and navigates copy/open with focus restored and live language", () => {
  const onRootAction = vi.fn();
  const choose = vi.fn();
  render(
    <RootAiHandoffMenu
      disabled={false}
      contextKey="root:view"
      onAiHandoff={vi.fn()}
      onRootAction={onRootAction}
    >
      <button onClick={choose}>日本語 空白 root</button>
    </RootAiHandoffMenu>,
  );
  const root = screen.getByRole("button", { name: "日本語 空白 root" });
  fireEvent.keyDown(root, { key: "ContextMenu" });
  expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
    "AIに渡す",
    "フルパスをコピー",
    "フォルダーを開く",
  ]);
  const [ai, copy, open] = screen.getAllByRole("menuitem");
  fireEvent.keyDown(ai!, { key: "ArrowUp" });
  expect(document.activeElement).toBe(open);
  fireEvent.keyDown(open!, { key: "Home" });
  expect(document.activeElement).toBe(ai);
  fireEvent.keyDown(ai!, { key: "ArrowDown" });
  expect(document.activeElement).toBe(copy);
  act(() => {
    setLanguage("en");
  });
  expect(document.activeElement).toBe(copy);
  expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
    "Send to AI",
    "Copy full path",
    "Open folder",
  ]);
  fireEvent.keyDown(copy!, { key: "Enter", isComposing: true });
  expect(onRootAction).not.toHaveBeenCalled();
  fireEvent.click(copy!);
  expect(onRootAction).toHaveBeenLastCalledWith("copyPath");
  expect(document.activeElement).toBe(root);
  expect(choose).not.toHaveBeenCalled();
  fireEvent.contextMenu(root);
  fireEvent.keyDown(screen.getAllByRole("menuitem")[0]!, { key: "End" });
  fireEvent.click(screen.getByRole("menuitem", { name: "Open folder" }));
  expect(onRootAction).toHaveBeenLastCalledWith("openFolder");
  expect(document.activeElement).toBe(root);
  fireEvent.contextMenu(root);
  fireEvent.keyDown(screen.getAllByRole("menuitem")[0]!, { key: "Tab" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(root);
});
