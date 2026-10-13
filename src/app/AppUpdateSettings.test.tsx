import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { setLanguage } from "../lib/i18n";
import { updateDiagnostic, type AppUpdaterApi, type UpdateSnapshot } from "../lib/appUpdater";
import { AppUpdateSettings } from "./AppUpdateSettings";

const initial: UpdateSnapshot = {
  revision: 0,
  phase: "idle",
  currentVersion: "0.7.5",
  disabledReason: null,
  release: null,
  downloadedBytes: 0,
  totalBytes: null,
  error: null,
};
const release = { version: "0.8.0", notes: "Fixes\n<script>window.leak=true</script>" };
function fixture(status: UpdateSnapshot = initial) {
  let receive: (value: UpdateSnapshot) => void = () => {};
  const stop = vi.fn();
  const api: AppUpdaterApi = {
    status: vi.fn(async () => status),
    check: vi.fn<AppUpdaterApi["check"]>(async () => ({
      ...initial,
      revision: 1,
      phase: "available",
      release,
    })),
    download: vi.fn<AppUpdaterApi["download"]>(async () => ({
      ...initial,
      revision: 2,
      phase: "ready",
      release,
    })),
    cancel: vi.fn<AppUpdaterApi["cancel"]>(async () => ({
      ...initial,
      revision: 3,
      phase: "cancelled",
    })),
    restart: vi.fn<AppUpdaterApi["restart"]>(async () => ({
      ...initial,
      revision: 4,
      phase: "installing",
      release,
    })),
    subscribe: vi.fn(async (callback) => {
      receive = callback;
      return stop;
    }),
  };
  return { api, stop, emit: (value: UpdateSnapshot) => act(() => receive(value)) };
}
beforeEach(() => setLanguage("en"));
afterEach(() => {
  cleanup();
  setLanguage("ja");
});

test("opening Settings reads state without checking a feed; default/self builds stay disabled", async () => {
  for (const reason of ["selfBuild", "unconfigured", "appOnly", "unsupported"] as const) {
    const f = fixture({ ...initial, phase: "disabled", disabledReason: reason });
    const view = render(<AppUpdateSettings api={f.api} />);
    await screen.findByText("Current version: 0.7.5");
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Check for updates" }).disabled,
    ).toBe(true);
    expect(f.api.check).not.toHaveBeenCalled();
    expect(f.api.download).not.toHaveBeenCalled();
    expect(f.api.restart).not.toHaveBeenCalled();
    view.unmount();
    expect(f.stop).toHaveBeenCalledOnce();
  }
});

test("manual check shows plain text notes; download waits for explicit save confirmation and restart", async () => {
  const f = fixture();
  render(<AppUpdateSettings api={f.api} />);
  await screen.findByText("Current version: 0.7.5");
  fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  await screen.findByText("Update version: 0.8.0");
  expect(screen.getByText(/<script>/).querySelector("script")).toBeNull();
  expect(f.api.download).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Download update" }));
  const restart = await screen.findByRole<HTMLButtonElement>("button", {
    name: "Restart and apply update",
  });
  expect(restart.disabled).toBe(true);
  expect(f.api.restart).not.toHaveBeenCalled();
  expect(screen.getByText(/cannot automatically detect or save/)).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox"));
  await waitFor(() => expect(restart.disabled).toBe(false));
  fireEvent.click(restart);
  fireEvent.click(restart);
  await screen.findByText("Applying the update and restarting");
  expect(f.api.restart).toHaveBeenCalledExactlyOnceWith(true);
});

test("no update and network errors allow another manual check", async () => {
  const f = fixture();
  f.api.check = vi
    .fn()
    .mockResolvedValueOnce({ ...initial, revision: 1, phase: "upToDate" })
    .mockResolvedValueOnce({ ...initial, revision: 2, phase: "error", error: "UpdateCheckFailed" });
  render(<AppUpdateSettings api={f.api} />);
  await screen.findByText("Current version: 0.7.5");
  fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  await screen.findByText("No update is available");
  fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  expect((await screen.findByRole("alert")).textContent).toContain("network and distributor");
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Check for updates" }).disabled,
    ).toBe(false),
  );
});

test("signature rejection never offers restart and does not expose native failure details", async () => {
  const f = fixture({ ...initial, phase: "available", release });
  f.api.download = vi.fn<AppUpdaterApi["download"]>(async () => ({
    ...initial,
    revision: 1,
    phase: "error",
    error: "UpdateSignatureInvalid",
  }));
  render(<AppUpdateSettings api={f.api} />);
  fireEvent.click(await screen.findByRole("button", { name: "Download update" }));
  expect((await screen.findByRole("alert")).textContent).toContain("will not be applied");
  expect(screen.queryByRole("button", { name: "Restart and apply update" })).toBeNull();
  for (const error of ["constructor", "https://private.invalid/token", { path: "private" }]) {
    expect(updateDiagnostic(error)).toBe(
      "更新の状態を確認できません。Nativeアプリで設定を開き直してください。",
    );
  }
});

test("progress handles missing length and stale replies cannot undo cancel or a newer operation", async () => {
  const f = fixture();
  let finish: (value: UpdateSnapshot) => void = () => {};
  f.api.check = vi.fn<AppUpdaterApi["check"]>(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<AppUpdateSettings api={f.api} />);
  await screen.findByText("Current version: 0.7.5");
  const check = screen.getByRole("button", { name: "Check for updates" });
  fireEvent.click(check);
  fireEvent.click(check);
  expect(f.api.check).toHaveBeenCalledOnce();
  f.emit({ ...initial, revision: 1, phase: "checking" });
  fireEvent.click(screen.getByRole("button", { name: "Cancel update" }));
  await screen.findByText("Update cancelled. The app has not been changed.");
  await act(async () => finish({ ...initial, revision: 2, phase: "available", release }));
  expect(screen.queryByText("Update version: 0.8.0")).toBeNull();
  f.emit({ ...initial, revision: 4, phase: "downloading", downloadedBytes: 1048576 });
  expect(screen.getByRole("progressbar").hasAttribute("value")).toBe(false);
  expect(screen.getByText("1.0 MiB downloaded (total size unknown)")).toBeTruthy();
  f.emit({
    ...initial,
    revision: 5,
    phase: "downloading",
    downloadedBytes: 1048576,
    totalBytes: 2097152,
  });
  expect(screen.getByRole<HTMLProgressElement>("progressbar").value).toBe(1048576);
  expect(screen.getByText("1.0 / 2.0 MiB")).toBeTruthy();
});

test("ready state survives page reopening but save confirmation is always fresh; Japanese stays localized", async () => {
  setLanguage("ja");
  const f = fixture({ ...initial, phase: "ready", release });
  const view = render(<AppUpdateSettings api={f.api} />);
  const restart = await screen.findByRole<HTMLButtonElement>("button", {
    name: "再起動して更新を適用",
  });
  expect(restart.disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox"));
  view.unmount();
  render(<AppUpdateSettings api={f.api} />);
  expect(
    (await screen.findByRole<HTMLButtonElement>("button", { name: "再起動して更新を適用" }))
      .disabled,
  ).toBe(true);
  expect(f.api.restart).not.toHaveBeenCalled();
  expect(f.api.cancel).not.toHaveBeenCalled();
});

test("cancel is unavailable from the moment restart is requested, before its native reply arrives", async () => {
  const f = fixture({ ...initial, phase: "ready", release });
  let finish: (value: UpdateSnapshot) => void = () => {};
  f.api.restart = vi.fn<AppUpdaterApi["restart"]>(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<AppUpdateSettings api={f.api} />);
  const restart = await screen.findByRole<HTMLButtonElement>("button", {
    name: "Restart and apply update",
  });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(restart);
  const cancel = screen.getByRole<HTMLButtonElement>("button", { name: "Cancel update" });
  expect(cancel.disabled).toBe(true);
  fireEvent.click(cancel);
  expect(f.api.cancel).not.toHaveBeenCalled();
  await act(async () => finish({ ...initial, revision: 1, phase: "installing", release }));
});
