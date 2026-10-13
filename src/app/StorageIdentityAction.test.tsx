import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { setLanguage } from "../lib/i18n";
import { StorageIdentityAction } from "./StorageIdentityAction";
import { StartupRecoveryNotice } from "./StartupRecoveryNotice";

const ipc = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc.invoke }));
beforeEach(() => {
  ipc.invoke.mockReset();
  act(() => {
    setLanguage("en");
  });
});
afterEach(cleanup);

test("Windows and Linux expose no Mac transition action or IPC", () => {
  for (const platform of ["windows", "other"]) {
    const view = render(<StorageIdentityAction platform={platform} />);
    expect(screen.queryByRole("button")).toBeNull();
    view.unmount();
  }
  expect(ipc.invoke).not.toHaveBeenCalled();
});

test("Mac entry is inert until clicked and a cancelled handoff can be retried", async () => {
  ipc.invoke.mockResolvedValue(false);
  render(<StorageIdentityAction platform="macos" />);
  expect(ipc.invoke).not.toHaveBeenCalled();
  expect(screen.getByText(/independent backup/)).toBeTruthy();
  const button = screen.getByRole("button", { name: "Open saved-data confirmation tool" });
  fireEvent.click(button);
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  expect(ipc.invoke).toHaveBeenCalledWith("open_storage_identity_transition", { language: "en" });
  fireEvent.click(button);
  await waitFor(() => expect(ipc.invoke).toHaveBeenCalledTimes(2));
});

test("in-flight handoff rejects repeat clicks and keeps launch failures visible", async () => {
  let reject!: (error: string) => void;
  ipc.invoke.mockReturnValue(
    new Promise((_, fail) => {
      reject = fail;
    }),
  );
  render(<StorageIdentityAction platform="macos" />);
  const button = screen.getByRole("button");
  fireEvent.click(button);
  fireEvent.click(button);
  expect(ipc.invoke).toHaveBeenCalledOnce();
  expect(button.hasAttribute("disabled")).toBe(true);
  await act(async () => reject("StorageUnavailable"));
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(button.hasAttribute("disabled")).toBe(false);
});

test("identity-held startup offers explicit confirmation instead of ineffective reselection", () => {
  render(
    <StartupRecoveryNotice
      recovery={{ reason: "storageIdentityConfirmationRequired", canRetry: false }}
      loading={false}
      onRetry={vi.fn()}
      onChoose={vi.fn()}
      platform="macos"
    />,
  );
  expect(screen.getByRole("button", { name: "Open saved-data confirmation tool" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Select another folder" })).toBeNull();
  expect(ipc.invoke).not.toHaveBeenCalled();
});
