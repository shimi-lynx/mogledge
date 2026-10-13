import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import type { KnowledgeController } from "../lib/controller";
import type { TransferView } from "../lib/stateTransfer";
import { setLanguage } from "../lib/i18n";
import StateTransferDialog from "./StateTransferDialog";

afterEach(() => {
  cleanup();
  setLanguage("ja");
  vi.restoreAllMocks();
});

test("switches confirmation language without resetting consent, reopening the dialog or changing target identifiers", async () => {
  const showModal = vi.fn(function (this: HTMLDialogElement) {
    this.open = true;
  });
  HTMLDialogElement.prototype.showModal = showModal;
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
  };
  const confirm = vi.fn();
  // The dialog uses only these controller methods; no Native operation is run.
  const controller = {
    confirmStateTransfer: confirm,
    cancelStateTransfer: vi.fn(),
    verifyStateTransferCurrentValues: vi.fn(),
  } as unknown as KnowledgeController;
  const view: TransferView = {
    path: "日本語/$&/文書.html",
    kind: "import",
    phase: "preview",
    busy: false,
    fileName: "日本語$&.json",
    backupName: "新しいバックアップ.json",
    preview: {
      planId: "plan",
      context: { workspaceId: "workspace", viewId: "view" },
      operation: "import",
      documentIdentity: "identity",
      logicalBytes: 1_234,
      incomingApps: [{ appId: "日本語のappId", schemaVersion: 1 }],
      previousApps: [{ appId: "以前のappId", schemaVersion: 1 }],
      source: { relativePath: "日本語/$&/{count}.html", revision: 3 },
      replacesExisting: true,
      backupRequired: true,
      stopReloadRequired: true,
      affectedViews: [],
      browserGrants: 1,
      openingRequests: 0,
      unflushedInput: "unknown",
    },
  };
  render(<StateTransferDialog view={view} controller={controller} />);
  const dialog = screen.getByRole("dialog");
  const checkboxes = screen.getAllByRole<HTMLInputElement>("checkbox");
  checkboxes.forEach((checkbox) => fireEvent.click(checkbox));
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "確認した内容で取り込む" }).disabled,
  ).toBe(false);
  await act(() => setLanguage("en"));
  expect(screen.getByRole("dialog", { name: "Import saved input" })).toBe(dialog);
  expect(showModal).toHaveBeenCalledOnce();
  expect(screen.getAllByRole("checkbox")).toEqual(checkboxes);
  expect(checkboxes.every((checkbox) => checkbox.checked)).toBe(true);
  expect(screen.getByText(view.path)).toBeTruthy();
  expect(screen.getByText("Selected file: 日本語$&.json")).toBeTruthy();
  expect(screen.getByText("日本語のappId (schema 1)")).toBeTruthy();
  expect(screen.getByText(/Source relative path:/).textContent).toContain("日本語/$&/{count}.html");
  fireEvent.click(screen.getByRole("button", { name: "Import as reviewed" }));
  expect(confirm).toHaveBeenCalledExactlyOnceWith(true, true);
  expect(view.preview?.documentIdentity).toBe("identity");
});
