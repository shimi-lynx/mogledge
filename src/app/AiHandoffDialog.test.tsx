import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import AiHandoffDialog from "./AiHandoffDialog";
import { aiDraft, type AiHandoffApi, type AiHandoffPreview } from "../lib/aiHandoff";
import { setLanguage } from "../lib/i18n";
const context = { workspaceId: "workspace", viewId: "view", relativePath: "日本語 &/a.html" };
const preview: AiHandoffPreview = {
  selectedPath: "/fixture/日本語 &/a.html",
  workingDirectory: "/fixture/日本語 &",
  revision: 1,
  kind: "file",
};
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(() => {
  cleanup();
  setLanguage("ja");
});
function setup(api?: AiHandoffApi) {
  const perform = vi.fn().mockResolvedValue(undefined);
  const prepare = vi.fn().mockResolvedValue(preview);
  const onClose = vi.fn();
  render(<AiHandoffDialog context={context} api={api ?? { prepare, perform }} onClose={onClose} />);
  return { perform, prepare, onClose };
}
test("keeps validated paths hidden and copies the empty request before explicit handoff", async () => {
  const { perform } = setup();
  await waitFor(() =>
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "依頼文をコピー" }).disabled).toBe(
      false,
    ),
  );
  expect(screen.queryByText(preview.selectedPath)).toBeNull();
  expect(screen.queryByText(preview.workingDirectory)).toBeNull();
  expect(screen.queryByText("渡す本文")).toBeNull();
  expect(screen.getAllByRole("textbox")).toHaveLength(1);
  expect(
    document.getElementById(screen.getByRole("textbox").getAttribute("aria-describedby")!)
      ?.textContent,
  ).toBe("選択パスは依頼文に自動で含まれます。空欄ならパスだけを渡します。");
  expect(perform).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "依頼文をコピー" }));
  await screen.findByText(/依頼文をコピーしました/);
  expect(perform).toHaveBeenLastCalledWith({
    context,
    preview,
    destination: "codexApp",
    instruction: "",
    copy: true,
  });
  fireEvent.change(screen.getByRole("textbox", { name: "依頼文（任意）" }), {
    target: { value: "日本語 & ? #\n変更してください" },
  });
  fireEvent.click(screen.getByRole("button", { name: "AIに渡す" }));
  await screen.findByText(/OSに開く操作を依頼しました/);
  expect(perform).toHaveBeenCalledWith({
    context,
    preview,
    destination: "codexApp",
    instruction: "日本語 & ? #\n変更してください",
    copy: false,
  });
});
test("Codex CLI exposes a copy flow, and Claude oversize remains complete and copyable", async () => {
  const { perform } = setup();
  await waitFor(() =>
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "依頼文をコピー" }).disabled).toBe(
      false,
    ),
  );
  fireEvent.change(screen.getByRole("combobox", { name: "連携先" }), {
    target: { value: "codexCli" },
  });
  expect(screen.queryByRole("button", { name: "AIに渡す" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "依頼文をコピー" }));
  await screen.findByText(/依頼文をコピーしました/);
  expect(perform.mock.calls[0][0].copy).toBe(true);
  fireEvent.change(screen.getByRole("combobox", { name: "連携先" }), {
    target: { value: "claudeCli" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "依頼文（任意）" }), {
    target: { value: "語".repeat(5000) },
  });
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "AIに渡す" }).disabled).toBe(true);
  expect(
    screen.getByRole<HTMLTextAreaElement>("textbox", { name: "依頼文（任意）" }).value,
  ).toContain("語".repeat(5000));
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "依頼文をコピー" }).disabled).toBe(
    false,
  );
});
test("dispatch failure exposes no URL and can retry without claiming success", async () => {
  const perform = vi.fn().mockRejectedValue("codex://new?prompt=secret");
  setup({ prepare: async () => preview, perform });
  await waitFor(() =>
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "依頼文をコピー" }).disabled).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "AIに渡す" }));
  await screen.findByRole("alert");
  expect(screen.queryByText(/secret/)).toBeNull();
  expect(screen.queryByText(/OSに開く操作を依頼しました/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "依頼文をコピー" }));
  await waitFor(() => expect(perform).toHaveBeenCalledTimes(2));
  expect(screen.queryByText(/依頼文をコピーしました/)).toBeNull();
  expect(screen.getByRole("alert").textContent).not.toContain("secret");
  perform.mockResolvedValue(undefined);
  fireEvent.click(screen.getByRole("button", { name: "依頼文をコピー" }));
  await screen.findByText(/依頼文をコピーしました/);
  expect(perform).toHaveBeenCalledTimes(3);
});
test("preparation failure disables dispatch and explicit close is inert", async () => {
  const perform = vi.fn();
  const { onClose } = setup({
    prepare: async () => {
      throw new Error("offline");
    },
    perform,
  });
  await screen.findByRole("alert");
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "AIに渡す" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(perform).not.toHaveBeenCalled();
});
test("a pending request locks double-clicks and cancellation; IME Enter is inert", async () => {
  let resolve: () => void = () => {};
  const perform = vi.fn().mockImplementation(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  const { onClose } = setup({ prepare: async () => preview, perform });
  await waitFor(() =>
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "依頼文をコピー" }).disabled).toBe(
      false,
    ),
  );
  const input = screen.getByRole("textbox", { name: "依頼文（任意）" });
  fireEvent.compositionStart(input);
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  fireEvent.click(screen.getByRole("button", { name: "AIに渡す" }));
  expect(perform).not.toHaveBeenCalled();
  fireEvent.compositionEnd(input);
  const open = screen.getByRole("button", { name: "AIに渡す" });
  fireEvent.click(open);
  fireEvent.click(open);
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(perform).toHaveBeenCalledOnce();
  expect(onClose).not.toHaveBeenCalled();
  resolve();
  await screen.findByText(/OSに開く操作を依頼しました/);
});

test("English handoff preserves Japanese input, destination and payload across live language changes", async () => {
  setLanguage("en");
  const { perform } = setup();
  expect(screen.getByRole("status").textContent).toBe("Checking the selected path");
  await waitFor(() =>
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Copy request" }).disabled).toBe(
      false,
    ),
  );
  expect(screen.getByRole("dialog", { name: "Send to AI" })).toBeTruthy();
  const input = screen.getByRole("textbox", { name: "Request (optional)" });
  fireEvent.change(input, { target: { value: "日本語依頼 & ? #\n維持してください" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Destination" }), {
    target: { value: "codexCli" },
  });
  expect(screen.queryByRole("button", { name: "Send to AI" })).toBeNull();
  expect(screen.getByText(/Copy only\. Start codex manually/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Copy request" }));
  await screen.findByText(/Request copied/);
  expect(perform).toHaveBeenLastCalledWith({
    context,
    preview,
    destination: "codexCli",
    instruction: "日本語依頼 & ? #\n維持してください",
    copy: true,
  });
  act(() => {
    setLanguage("ja");
  });
  expect(screen.getByRole("textbox", { name: "依頼文（任意）" })).toBe(input);
  expect((input as HTMLTextAreaElement).value).toBe("日本語依頼 & ? #\n維持してください");
  expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "連携先" }).value).toBe(
    "codexCli",
  );
  expect(screen.getByRole("status").textContent).toContain("依頼文をコピーしました");
  act(() => {
    setLanguage("en");
  });
  perform.mockRejectedValue("codex://new?prompt=fixture-secret");
  fireEvent.change(screen.getByRole("combobox", { name: "Destination" }), {
    target: { value: "claudeApp" },
  });
  expect(screen.getByText(/Claude also confirms the working folder/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Send to AI" }));
  expect((await screen.findByRole("alert")).textContent).toContain("The handoff failed");
  expect(screen.queryByText(/fixture-secret/)).toBeNull();
  expect(screen.queryByRole("status")).toBeNull();
  fireEvent.change(screen.getByRole("combobox", { name: "Destination" }), {
    target: { value: "claudeCli" },
  });
  fireEvent.change(input, { target: { value: "語".repeat(5000) } });
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send to AI" }).disabled).toBe(true);
  expect(screen.getByRole("alert").textContent).toContain("character limit has been exceeded");
  expect((input as HTMLTextAreaElement).value).toBe("語".repeat(5000));
});

test("native folder kind uses an empty or exact instruction draft and explains path-bearing copies", async () => {
  const folderPreview: AiHandoffPreview = {
    selectedPath: "/fixture/日本語フォルダー",
    workingDirectory: "/fixture/日本語フォルダー",
    revision: 1,
    kind: "folder",
  };
  const perform = vi.fn().mockResolvedValue(undefined);
  setup({ prepare: async () => folderPreview, perform });
  await waitFor(() =>
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "AIに渡す" }).disabled).toBe(
      false,
    ),
  );
  const hint = document.getElementById("ai-handoff-instruction-hint")!;
  expect(hint.textContent).toContain("本文なしで開きます");
  expect(hint.textContent).toContain("コピーにはフォルダーパスも含めます");
  fireEvent.click(screen.getByRole("button", { name: "AIに渡す" }));
  await screen.findByText(/OSに開く操作を依頼しました/);
  expect(perform).toHaveBeenLastCalledWith({
    context,
    preview: folderPreview,
    instruction: "",
    destination: "codexApp",
    copy: false,
  });
  const input = screen.getByRole("textbox", { name: "依頼文（任意）" });
  const instruction = " /fixture/日本語フォルダー\nこのパスと空白を残してください & ? # % ";
  fireEvent.change(input, { target: { value: instruction } });
  expect(aiDraft(folderPreview, instruction)).toBe(instruction);
  expect(aiDraft(folderPreview, " \n")).toBe(" \n");
  expect(aiDraft(preview, instruction)).toBe(preview.selectedPath + "\n\n" + instruction);
  expect(aiDraft(preview, " \n")).toBe(preview.selectedPath + "\n\n \n");
  fireEvent.change(screen.getByRole("combobox", { name: "連携先" }), {
    target: { value: "claudeCli" },
  });
  fireEvent.change(input, { target: { value: "a".repeat(5000) } });
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "AIに渡す" }).disabled).toBe(false);
  fireEvent.change(input, { target: { value: "a".repeat(5001) } });
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "AIに渡す" }).disabled).toBe(true);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "依頼文をコピー" }).disabled).toBe(
    false,
  );
  fireEvent.change(screen.getByRole("combobox", { name: "連携先" }), {
    target: { value: "codexCli" },
  });
  expect(hint.textContent).toContain("作業ディレクトリーは相手側で選んでください");
  fireEvent.change(input, { target: { value: instruction } });
  fireEvent.click(screen.getByRole("button", { name: "依頼文をコピー" }));
  await screen.findByText(/依頼文をコピーしました/);
  expect(perform).toHaveBeenLastCalledWith({
    context,
    preview: folderPreview,
    instruction,
    destination: "codexCli",
    copy: true,
  });
  act(() => {
    setLanguage("en");
  });
  expect(hint.textContent).toContain("Copies include the folder path");
  expect(
    screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Request (optional)" }).value,
  ).toBe(instruction);
  fireEvent.change(screen.getByRole("combobox", { name: "Destination" }), {
    target: { value: "claudeApp" },
  });
  expect(hint.textContent).toContain("leave it blank to open an empty draft");
});

test("optional root guide counts toward the draft while preserving the raw request and unchanged OFF empty prompt", async () => {
  const guide = "Before creating HTML read `../.mogledge/html-authoring/GUIDE.md`.";
  const guided = { ...preview, kind: "folder" as const, guideInstruction: guide };
  const api: AiHandoffApi = { prepare: vi.fn(async () => guided), perform: vi.fn(async () => {}) };
  setup(api);
  await screen.findByText(/この作業フォルダーの設定に従い/);
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "依頼文（任意）" });
  const raw = " 日本語 / $& / {path}\n\t ";
  fireEvent.change(input, { target: { value: raw } });
  fireEvent.click(screen.getByRole("button", { name: "AIに渡す" }));
  await waitFor(() =>
    expect(api.perform).toHaveBeenCalledWith({
      context,
      preview: guided,
      instruction: raw,
      destination: "codexApp",
      copy: false,
    }),
  );
  expect(input.value).toBe(raw);
  expect(aiDraft(guided, raw)).toBe(raw + "\n\n" + guide);
  expect(aiDraft({ ...guided, guideInstruction: undefined }, "")).toBe("");
  await act(() => setLanguage("en"));
  expect(input.value).toBe(raw);
  expect(screen.getByText(/This folder is set to add an instruction/)).toBeTruthy();
});

test("Codex CLI copy failure reports clipboard failure rather than link registration", async () => {
  const perform = vi.fn().mockRejectedValue("パスをコピーできません");
  setup({ prepare: async () => preview, perform });
  await waitFor(() =>
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "依頼文をコピー" }).disabled).toBe(
      false,
    ),
  );
  fireEvent.change(screen.getByRole("combobox", { name: "連携先" }), {
    target: { value: "codexCli" },
  });
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");
  const instruction = "  日本語 & ? # 😀\n/fixture/user-entered.html  ";
  fireEvent.change(input, { target: { value: instruction } });
  fireEvent.click(screen.getByRole("button", { name: "依頼文をコピー" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("クリップボードにコピーできませんでした");
  expect(alert.textContent).not.toContain("リンク登録");
  expect(screen.queryByRole("status")).toBeNull();
  expect(input.value).toBe(instruction);
  expect(perform).toHaveBeenCalledExactlyOnceWith({
    context,
    preview,
    instruction,
    destination: "codexCli",
    copy: true,
  });
  expect(screen.queryByRole("button", { name: "AIに渡す" })).toBeNull();
});

test("unknown Codex CLI copy outcome keeps input, waits for explicit retry and translates safely", async () => {
  setLanguage("en");
  const perform = vi.fn().mockRejectedValue(new Error("/fixture/private: IPC reply lost"));
  setup({ prepare: async () => preview, perform });
  const copy = await screen.findByRole<HTMLButtonElement>("button", { name: "Copy request" });
  await waitFor(() => expect(copy.disabled).toBe(false));
  fireEvent.change(screen.getByRole("combobox", { name: "Destination" }), {
    target: { value: "codexCli" },
  });
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");
  fireEvent.change(input, { target: { value: "日本語 😀\n/fixture/user-entered.html" } });
  fireEvent.click(copy);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Copy completion could not be verified");
  expect(alert.textContent).not.toContain("private");
  expect(alert.textContent).not.toContain("link registration");
  expect(screen.queryByRole("status")).toBeNull();
  expect(perform).toHaveBeenCalledOnce();
  expect(input.value).toBe("日本語 😀\n/fixture/user-entered.html");
  act(() => {
    setLanguage("ja");
  });
  expect(alert.textContent).toContain("コピーの完了を確認できませんでした");
  expect(perform).toHaveBeenCalledOnce();
  perform.mockResolvedValue(undefined);
  fireEvent.click(screen.getByRole("button", { name: "依頼文をコピー" }));
  await screen.findByText(/依頼文をコピーしました/);
  expect(perform).toHaveBeenCalledTimes(2);
});
