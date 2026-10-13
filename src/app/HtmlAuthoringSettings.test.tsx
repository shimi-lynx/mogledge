import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { HtmlAuthoringSettings } from "./HtmlAuthoringSettings";
import { SettingsDialog } from "./SettingsDialog";
import { setLanguage } from "../lib/i18n";
import type {
  HtmlAuthoringApi,
  HtmlAuthoringContext,
  HtmlAuthoringPreview,
  HtmlAuthoringStatus,
} from "../lib/htmlAuthoring";
const context: HtmlAuthoringContext = { workspaceId: "日本語root", viewId: "view", revision: 1 };
const status: HtmlAuthoringStatus = {
  rootIdentity: "f".repeat(64),
  enabled: false,
  preferenceHash: null,
  readOnly: false,
  guideAvailable: false,
  error: null,
};
const preview: HtmlAuthoringPreview = {
  planId: "plan",
  kitVersion: 1,
  readOnly: false,
  error: null,
  files: [
    { path: ".my-knowledge/html-authoring/GUIDE.md", action: "create" },
    { path: ".agents/skills/my-knowledge-html-authoring/SKILL.md", action: "conflict" },
  ],
};
function api(): HtmlAuthoringApi {
  return {
    status: vi.fn(async () => status),
    preview: vi.fn(async () => preview),
    install: vi.fn(async () => ({
      written: [preview.files[0].path],
      skipped: [preview.files[1].path],
      error: null,
    })),
    cancel: vi.fn(async () => {}),
    setEnabled: vi.fn(async (_context, _hash, enabled) => ({
      ...status,
      guideAvailable: true,
      enabled,
      preferenceHash: "saved",
    })),
  };
}
beforeEach(() => {
  setLanguage("ja");
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setLanguage("ja");
});
test("current-root setup requires preview and confirmation, skips conflict and keeps preferences off until explicitly enabled", async () => {
  const bridge = api();
  vi.mocked(bridge.status)
    .mockResolvedValueOnce(status)
    .mockResolvedValue({ ...status, guideAvailable: true });
  render(<HtmlAuthoringSettings context={context} api={bridge} />);
  await waitFor(() =>
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "配置内容を確認" }).disabled).toBe(
      false,
    ),
  );
  expect(screen.getByRole<HTMLInputElement>("checkbox").disabled).toBe(true);
  expect(screen.getByRole<HTMLInputElement>("checkbox").checked).toBe(false);
  expect(bridge.install).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "配置内容を確認" }));
  await screen.findByRole("region", { name: "配置内容" });
  expect(screen.getByText(preview.files[0].path)).toBeTruthy();
  expect(screen.getByText("既存の内容を保持")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
  expect(bridge.cancel).toHaveBeenCalledExactlyOnceWith(context, "plan");
  expect(bridge.install).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "配置内容を確認" }));
  await screen.findByRole("region", { name: "配置内容" });
  fireEvent.click(screen.getByRole("button", { name: "確認した内容を配置" }));
  fireEvent.click(screen.getByRole("button", { name: "確認した内容を配置" }));
  await screen.findByText("1件を配置し、1件を保持しました");
  expect(bridge.install).toHaveBeenCalledExactlyOnceWith(context, "plan");
  const checkbox = screen.getByRole<HTMLInputElement>("checkbox");
  await waitFor(() => expect(checkbox.disabled).toBe(false));
  fireEvent.click(checkbox);
  await waitFor(() => expect(checkbox.checked).toBe(true));
  expect(bridge.setEnabled).toHaveBeenLastCalledWith(context, null, true);
  fireEvent.click(checkbox);
  await waitFor(() => expect(checkbox.checked).toBe(false));
  expect(bridge.setEnabled).toHaveBeenLastCalledWith(context, "saved", false);
  await act(() => setLanguage("en"));
  expect(screen.getByText("Installed 1 files and kept 1 files")).toBeTruthy();
});
test("a late preview is canceled after root changes or unmount and never becomes installable", async () => {
  const bridge = api();
  let respond!: (value: HtmlAuthoringPreview) => void;
  bridge.preview = vi.fn(
    () =>
      new Promise<HtmlAuthoringPreview>((resolve) => {
        respond = resolve;
      }),
  );
  const view = render(<HtmlAuthoringSettings context={context} api={bridge} />);
  await waitFor(() =>
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "配置内容を確認" }).disabled).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "配置内容を確認" }));
  const next = { ...context, workspaceId: "other", viewId: "other-view" };
  view.rerender(<HtmlAuthoringSettings context={next} api={bridge} />);
  await act(async () => respond(preview));
  expect(bridge.cancel).toHaveBeenCalledWith(context, "plan");
  expect(screen.queryByRole("region", { name: "配置内容" })).toBeNull();
  await waitFor(() =>
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "配置内容を確認" }).disabled).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "配置内容を確認" }));
  view.unmount();
  await act(async () => respond({ ...preview, planId: "later" }));
  expect(bridge.cancel).toHaveBeenCalledWith(next, "later");
  expect(bridge.install).not.toHaveBeenCalled();
});
test("readonly ownership cannot install, profile failures retain the preference and English projection preserves paths", async () => {
  const bridge = api();
  bridge.status = vi.fn(async () => ({
    ...status,
    enabled: true,
    guideAvailable: false,
    error: "制作キットの所有記録を読み取れません。元の内容を保持します",
  }));
  bridge.preview = vi.fn(async () => ({
    ...preview,
    readOnly: true,
    error: "制作キットの所有記録を読み取れません。元の内容を保持します",
  }));
  bridge.setEnabled = vi.fn(async () => {
    throw new Error("保存できません");
  });
  render(<HtmlAuthoringSettings context={context} api={bridge} />);
  await waitFor(() => expect(screen.getByRole<HTMLInputElement>("checkbox").disabled).toBe(false));
  fireEvent.click(screen.getByRole("checkbox"));
  await screen.findByText(/保存できません/);
  expect(screen.getByRole<HTMLInputElement>("checkbox").checked).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "配置内容を確認" }));
  await screen.findByRole("region", { name: "配置内容" });
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "確認した内容を配置" }).disabled,
  ).toBe(true);
  await act(() => setLanguage("en"));
  expect(screen.getByText(preview.files[0].path)).toBeTruthy();
  expect(screen.getByText(/Could not read the authoring kit ownership record/)).toBeTruthy();
  expect(bridge.install).not.toHaveBeenCalled();
});
test("settings adds an optional two-column authoring page and no root leaves an empty state without Native reads", async () => {
  const bridge = api();
  const view = render(
    <SettingsDialog returnFocus={null} onClose={vi.fn()} rootContext={null} kitApi={bridge} />,
  );
  expect(screen.getByRole("combobox")).toBeTruthy();
  expect(bridge.status).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "AIによるHTML制作" }));
  expect(screen.getByText("作業フォルダーを選択してください")).toBeTruthy();
  expect(bridge.status).not.toHaveBeenCalled();
  view.rerender(
    <SettingsDialog returnFocus={null} onClose={vi.fn()} rootContext={context} kitApi={bridge} />,
  );
  await waitFor(() => expect(bridge.status).toHaveBeenCalledWith(context));
  fireEvent.click(screen.getByRole("button", { name: "配置内容を確認" }));
  await screen.findByRole("region", { name: "配置内容" });
  fireEvent.click(screen.getByRole("button", { name: "表示言語を選択" }));
  expect(screen.getByRole("combobox")).toBeTruthy();
  expect(bridge.cancel).toHaveBeenCalledWith(context, "plan");
});
