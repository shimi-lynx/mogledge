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
    openHelp: vi.fn(async () => {}),
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
    expect(f.api.openHelp).not.toHaveBeenCalled();
    view.unmount();
    expect(f.stop).toHaveBeenCalledOnce();
  }
});

for (const language of ["ja", "en"] as const) {
  test(`install failures offer explicit help without update side effects (${language})`, async () => {
    setLanguage(language);
    const cases = [
      {
        code: "UpdateInstallLocationUnavailable",
        message: language === "ja" ? "同じボリューム" : "temporary storage on the app's volume",
      },
      {
        code: "UpdatePreviousAppNotRestored",
        message:
          language === "ja"
            ? "旧アプリを元の場所へ戻せません"
            : "previous app could not be restored",
      },
      {
        code: "UpdateInstallFailed",
        message: language === "ja" ? "更新を適用できません" : "Could not apply the update",
      },
      {
        code: "/private/unknown-install-failure",
        message:
          language === "ja" ? "更新の状態を確認できません" : "Could not read the update status",
      },
    ];
    for (const { code, message } of cases) {
      const f = fixture({ ...initial, phase: "error", error: code });
      f.api.openHelp = vi.fn().mockRejectedValue(new Error("/private/secret/path"));
      const view = render(<AppUpdateSettings api={f.api} />);
      expect((await screen.findByRole("alert")).textContent).toContain(message);
      expect(f.api.openHelp).not.toHaveBeenCalled();
      const helpNames =
        language === "ja"
          ? ["公式の配布ページを開く", "手動更新・復旧の案内を開く"]
          : ["Open official releases", "Open manual update and recovery guide"];
      for (const [index, name] of helpNames.entries()) {
        const help = screen.getByRole<HTMLButtonElement>("button", { name });
        await waitFor(() => expect(help.disabled).toBe(false));
        fireEvent.click(help);
        await waitFor(() =>
          expect(f.api.openHelp).toHaveBeenLastCalledWith(index === 0 ? "releases" : "manual"),
        );
        await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
        expect(screen.getAllByRole("alert")[0].textContent).toContain(message);
      }
      expect(view.container.textContent).not.toContain("/private/");
      expect(view.container.textContent).not.toMatch(/read.only|AppTranslocation|読み取り専用/);
      expect(
        screen.queryByRole("button", {
          name: language === "ja" ? "更新して再起動" : "Update and restart",
        }),
      ).toBeNull();
      expect(f.api.check).not.toHaveBeenCalled();
      expect(f.api.download).not.toHaveBeenCalled();
      expect(f.api.restart).not.toHaveBeenCalled();
      expect(f.api.cancel).not.toHaveBeenCalled();
      view.unmount();
    }
  });

  test(`disabled builds can open help without enabling updates (${language})`, async () => {
    setLanguage(language);
    const f = fixture({ ...initial, phase: "disabled", disabledReason: "selfBuild" });
    render(<AppUpdateSettings api={f.api} />);
    const help = await screen.findByRole("button", {
      name:
        language === "ja" ? "手動更新・復旧の案内を開く" : "Open manual update and recovery guide",
    });
    expect(f.api.openHelp).not.toHaveBeenCalled();
    fireEvent.click(help);
    await waitFor(() => expect(f.api.openHelp).toHaveBeenCalledExactlyOnceWith("manual"));
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: language === "ja" ? "更新を確認" : "Check for updates",
      }).disabled,
    ).toBe(true);
    expect(f.api.check).not.toHaveBeenCalled();
    expect(f.api.download).not.toHaveBeenCalled();
    expect(f.api.restart).not.toHaveBeenCalled();
  });
}

test("verified download enables update and restart with a warning and no confirmation checkbox", async () => {
  const f = fixture();
  render(<AppUpdateSettings api={f.api} />);
  await screen.findByText("Current version: 0.7.5");
  fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  await screen.findByText("Update version: 0.8.0");
  expect(screen.getByText(/<script>/).querySelector("script")).toBeNull();
  expect(f.api.download).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Download update" }));
  const restart = await screen.findByRole<HTMLButtonElement>("button", {
    name: "Update and restart",
  });
  expect(restart.disabled).toBe(false);
  expect(f.api.restart).not.toHaveBeenCalled();
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(
    screen.getByText("Unsaved inputs will be lost. Save what you need before updating."),
  ).toBeTruthy();
  expect(restart.getAttribute("aria-describedby")).toBe("settings-app-update-warning");
  fireEvent.click(restart);
  fireEvent.click(restart);
  await screen.findByText("Applying the update and restarting");
  expect(f.api.restart).toHaveBeenCalledExactlyOnceWith();
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
  expect(screen.queryByRole("button", { name: "Update and restart" })).toBeNull();
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

test("reopening a verified update keeps the Japanese action and warning without applying automatically", async () => {
  setLanguage("ja");
  const f = fixture({ ...initial, phase: "ready", release });
  const view = render(<AppUpdateSettings api={f.api} />);
  const restart = await screen.findByRole<HTMLButtonElement>("button", {
    name: "更新して再起動",
  });
  expect(restart.disabled).toBe(false);
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(
    screen.getByText("未保存の入力は失われます。必要な内容を保存してから更新してください。"),
  ).toBeTruthy();
  view.unmount();
  render(<AppUpdateSettings api={f.api} />);
  expect(
    (await screen.findByRole<HTMLButtonElement>("button", { name: "更新して再起動" })).disabled,
  ).toBe(false);
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
    name: "Update and restart",
  });
  fireEvent.click(restart);
  const cancel = screen.getByRole<HTMLButtonElement>("button", { name: "Cancel update" });
  expect(cancel.disabled).toBe(true);
  fireEvent.click(cancel);
  expect(f.api.cancel).not.toHaveBeenCalled();
  await act(async () => finish({ ...initial, revision: 1, phase: "installing", release }));
});

test("update and restart is absent until Native reports a verified ready update", async () => {
  for (const phase of [
    "idle",
    "checking",
    "available",
    "downloading",
    "upToDate",
    "cancelled",
    "error",
    "installing",
  ] as const) {
    const f = fixture({ ...initial, phase, release });
    const view = render(<AppUpdateSettings api={f.api} />);
    await screen.findByText("Current version: 0.7.5");
    expect(screen.queryByRole("button", { name: "Update and restart" })).toBeNull();
    expect(f.api.restart).not.toHaveBeenCalled();
    view.unmount();
  }
});

test("a ready event cannot enable restart while the download request is still pending", async () => {
  const f = fixture({ ...initial, phase: "available", release });
  let finish: (value: UpdateSnapshot) => void = () => {};
  f.api.download = vi.fn<AppUpdaterApi["download"]>(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<AppUpdateSettings api={f.api} />);
  fireEvent.click(await screen.findByRole("button", { name: "Download update" }));
  f.emit({ ...initial, revision: 1, phase: "ready", release });
  const restart = screen.getByRole<HTMLButtonElement>("button", { name: "Update and restart" });
  expect(restart.disabled).toBe(true);
  fireEvent.click(restart);
  expect(f.api.restart).not.toHaveBeenCalled();
  await act(async () => finish({ ...initial, revision: 1, phase: "ready", release }));
  expect(restart.disabled).toBe(false);
  fireEvent.click(restart);
  expect(f.api.restart).toHaveBeenCalledExactlyOnceWith();
});
