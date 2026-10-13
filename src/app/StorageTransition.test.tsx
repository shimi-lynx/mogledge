import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { setLanguage } from "../lib/i18n";
import StorageTransition from "./StorageTransition";

const ipc = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc.invoke }));
const entry = {
  documentIdentity: "legacy-document",
  rootIdentity: "legacy-root",
  relativePathHint: "<img src=x onerror=alert(1)>.html",
  revision: 4,
  bytes: 90,
};
const rootPreview = {
  operation: "acknowledge_root",
  rootIdentity: "physical-root",
  databaseSchemaVersion: 2,
  olderAppsWillReject: true,
  legacyPreferencesRetained: true,
};
const plan = (preview: Record<string, unknown> = rootPreview) => ({
  planId: "operation",
  confirmation: "confirm:operation",
  preview,
  backupDirectory: "backup-operation",
  backupManifestHash: "manifest-hash",
  backupScope: "saved-state-and-device-settings",
  expiresInMs: 300000,
});
type Request = { command: string; [key: string]: unknown };
let respond: (request: Request) => unknown;
beforeEach(() => {
  setLanguage("en");
  ipc.invoke.mockReset();
  respond = ({ command }) => {
    if (command === "inspect")
      return {
        schemaVersion: 2,
        rootIdentity: "physical-root",
        rootConfirmed: false,
        payloadsIncluded: false,
        entries: [entry],
      };
    if (command === "prepare_document")
      return plan({
        operation: "confirm_empty",
        rootIdentity: "physical-root",
        documentIdentity: "target-identity",
        targetRelativePath: "target.html",
        sourceOwnership: "owner_confirmation_required_path_is_only_a_hint",
      });
    if (command.startsWith("prepare_")) return plan();
    if (command === "confirm")
      return {
        status: "committed",
        operationId: "operation",
        schemaVersion: 3,
        settingsPublished: true,
      };
    return {};
  };
  ipc.invoke.mockImplementation(async (_name: string, args: { request: Request }) =>
    respond(args.request),
  );
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  setLanguage("ja");
});
const button = (name: string) => screen.getByRole<HTMLButtonElement>("button", { name });
async function open(rootConfirmed = false) {
  const previous = respond;
  respond = (request) =>
    request.command === "inspect"
      ? { ...(previous(request) as object), rootConfirmed }
      : previous(request);
  render(<StorageTransition />);
  fireEvent.change(screen.getByLabelText("Knowledge folder"), {
    target: { value: "synthetic-root" },
  });
  fireEvent.change(screen.getByLabelText("Backup parent folder"), {
    target: { value: "synthetic-backups" },
  });
  fireEvent.click(button("Open inspection session"));
  await screen.findByRole("button", { name: "Inspect again" });
  await screen.findByText(entry.relativePathHint);
}
const backupConsent = () =>
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "I agree to prepare a preview, including creating a backup",
    }),
  );
const confirmConsent = () =>
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: /^I reviewed the target, ownership, older-app rejection, backup scope and expiry/,
    }),
  );
async function prepareRoot() {
  backupConsent();
  fireEvent.click(button("Prepare root confirmation preview"));
  await screen.findByText("manifest-hash");
}
const commands = () =>
  ipc.invoke.mock.calls
    .filter(([name]) => name === "storage_transition_request")
    .map(([, args]) => args.request.command);

test("mount does not invoke IPC and directory picker cancellation retains the entered path", async () => {
  render(<StorageTransition />);
  expect(ipc.invoke).not.toHaveBeenCalled();
  expect(button("Open inspection session").disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Knowledge folder"), { target: { value: "keep-root" } });
  ipc.invoke.mockResolvedValueOnce(null);
  fireEvent.click(button("Choose (root)"));
  await waitFor(() => expect(button("Choose (root)").disabled).toBe(false));
  expect((screen.getByLabelText("Knowledge folder") as HTMLInputElement).value).toBe("keep-root");
  expect(ipc.invoke).toHaveBeenCalledWith("storage_transition_pick_directory", { kind: "root" });
});

test("inspection is metadata-only with no default source; root confirmation and both explicit consents gate mutation", async () => {
  await open();
  expect(commands()).toEqual(["open_session", "inspect"]);
  expect(ipc.invoke).toHaveBeenCalledWith("storage_transition_request", {
    request: {
      command: "open_session",
      rootPath: "synthetic-root",
      backupParent: "synthetic-backups",
    },
  });
  expect(document.body.querySelector("img")).toBeNull();
  expect(screen.getAllByRole<HTMLInputElement>("radio").every((radio) => !radio.checked)).toBe(
    true,
  );
  expect(button("Prepare document confirmation preview").disabled).toBe(true);
  expect(button("Prepare root confirmation preview").disabled).toBe(true);
  await prepareRoot();
  expect(button("Run reviewed operation").disabled).toBe(true);
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Operation preview");
  confirmConsent();
  fireEvent.click(button("Run reviewed operation"));
  fireEvent.click(button("Run reviewed operation"));
  await screen.findByText("The reviewed operation committed");
  expect(commands().filter((command) => command === "confirm")).toHaveLength(1);
  expect(ipc.invoke).toHaveBeenCalledWith("storage_transition_request", {
    request: { command: "confirm", plan_id: "operation", confirmation: "confirm:operation" },
  });
  expect(
    (screen.getByRole("radio", { name: "Explicitly confirm empty data" }) as HTMLInputElement)
      .disabled,
  ).toBe(false);
});

test("explicit empty and selected-source previews send distinct requests and never send saved values", async () => {
  await open(true);
  backupConsent();
  fireEvent.change(screen.getByLabelText("Target HTML relative path"), {
    target: { value: "target.html" },
  });
  expect(button("Prepare document confirmation preview").disabled).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: "Explicitly confirm empty data" }));
  fireEvent.click(button("Prepare document confirmation preview"));
  await screen.findByText("manifest-hash");
  expect(ipc.invoke).toHaveBeenCalledWith("storage_transition_request", {
    request: { command: "prepare_document", relative_path: "target.html" },
  });
  const previous = respond;
  respond = (request) =>
    request.command === "prepare_document"
      ? plan({
          operation: "copy_selected_legacy",
          rootIdentity: "physical-root",
          documentIdentity: "target-identity",
          targetRelativePath: "target.html",
          sourceOwnership: "owner_confirmation_required_path_is_only_a_hint",
          sourceIdentity: entry.documentIdentity,
          sourceRevision: entry.revision,
          sourcePayloadHash: "payload-hash",
        })
      : previous(request);
  fireEvent.click(screen.getByRole("radio", { name: entry.relativePathHint }));
  fireEvent.click(button("Prepare document confirmation preview"));
  await waitFor(() =>
    expect(ipc.invoke).toHaveBeenCalledWith("storage_transition_request", {
      request: {
        command: "prepare_document",
        relative_path: "target.html",
        source_identity: entry.documentIdentity,
      },
    }),
  );
  expect(commands()).not.toContain("confirm");
});

test("inspection paginates metadata while retaining explicit selection", async () => {
  const previous = respond;
  respond = (request) =>
    request.command === "inspect"
      ? {
          ...(previous(request) as object),
          entries: Array.from({ length: 26 }, (_, i) => ({
            ...entry,
            documentIdentity: `id-${i}`,
            relativePathHint: i === 0 ? entry.relativePathHint : `file-${i}.html`,
          })),
        }
      : previous(request);
  await open(true);
  expect(screen.getAllByRole("radio")).toHaveLength(26);
  expect(screen.queryByText("file-25.html")).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: entry.relativePathHint }));
  fireEvent.click(button("Next page"));
  expect(screen.getAllByRole("radio")).toHaveLength(2);
  expect(screen.getByText("file-25.html")).toBeTruthy();
  fireEvent.click(button("Previous page"));
  expect(
    (screen.getByRole("radio", { name: entry.relativePathHint }) as HTMLInputElement).checked,
  ).toBe(true);
});

test("lost confirmation response freezes mutation and permits only explicit status checks until committed", async () => {
  const previous = respond;
  respond = (request) => {
    if (request.command === "confirm") throw new Error("lost");
    if (request.command === "operation_status") return { status: "unknown" };
    return previous(request);
  };
  await open();
  await prepareRoot();
  confirmConsent();
  fireEvent.click(button("Run reviewed operation"));
  await screen.findByRole("button", { name: "Check operation result" });
  expect(button("Prepare root confirmation preview").disabled).toBe(true);
  expect(button("Inspect again").disabled).toBe(true);
  expect(button("Cancel preview").disabled).toBe(true);
  expect(button("Run reviewed operation").disabled).toBe(true);
  fireEvent.click(button("Check operation result"));
  await waitFor(() => expect(button("Check operation result").disabled).toBe(false));
  expect(commands().filter((command) => command === "confirm")).toHaveLength(1);
  respond = (request) =>
    request.command === "operation_status"
      ? { status: "committed", settingsMatchRoot: false }
      : previous(request);
  fireEvent.click(button("Check operation result"));
  await screen.findByText("The reviewed operation committed");
  expect(screen.getByText("settingsMatchRoot: false")).toBeTruthy();
});

test("explicit backend retry error retains the previous preview but invalidates its consent", async () => {
  const previous = respond;
  respond = (request) =>
    request.command === "confirm"
      ? { error: "source_changed", existingDataRetained: true, retryRequiresNewPreview: true }
      : previous(request);
  await open();
  await prepareRoot();
  confirmConsent();
  fireEvent.click(button("Run reviewed operation"));
  await screen.findByText("This preview expired or is invalid. Prepare a new preview.");
  expect(screen.getByText("manifest-hash")).toBeTruthy();
  expect(button("Run reviewed operation").disabled).toBe(true);
  expect(screen.queryByRole("button", { name: "Check operation result" })).toBeNull();
  expect(button("Prepare root confirmation preview").disabled).toBe(false);
});

test("invalid or unknown preview shapes cannot enable confirmation or expose payload values", async () => {
  const previous = respond;
  respond = (request) =>
    request.command === "prepare_root"
      ? { ...plan(), preview: { operation: "unexpected", payload: "secret-value" } }
      : previous(request);
  await open();
  backupConsent();
  fireEvent.click(button("Prepare root confirmation preview"));
  await screen.findByRole("alert");
  expect(screen.queryByText("secret-value")).toBeNull();
  expect(screen.queryByRole("button", { name: "Run reviewed operation" })).toBeNull();
  expect(commands()).not.toContain("confirm");
});

test("preferences and rollback display bounded file metadata and require separate confirmation", async () => {
  const previous = respond;
  respond = (request) => {
    if (request.command === "prepare_preferences")
      return plan({
        operation: "restore_preferences",
        sourceRootIdentity: "old-root",
        targetRootIdentity: "physical-root",
        pathOwnership: "owner_confirmation_required",
        mappedDocumentReferences: 2,
        unresolvedDocumentReferences: 3,
        unresolvedFolderReferences: 1,
        sourceRetained: true,
        existingTargetReplacement: false,
        outputVersion: 4,
        files: [
          {
            relativePath: "preferences.json",
            sha256: "file-hash",
            bytes: 23,
            value: "secret-value",
          },
        ],
      });
    if (request.command === "prepare_rollback")
      return plan({
        operation: "rollback",
        currentFormatWillBeReplaced: true,
        keepCurrentBackup: true,
        olderAppsMayResume: true,
        sourceRetained: true,
        inactivePreferenceCopiesRetained: true,
        changedOriginalPreferencesAllowed: false,
        targetSchemaVersion: 2,
      });
    if (request.command === "confirm")
      return {
        status: "rolled_back",
        operationId: "operation",
        schemaVersion: 2,
        settingsPublished: true,
        restartRequired: true,
      };
    return previous(request);
  };
  await open(true);
  backupConsent();
  fireEvent.change(screen.getByLabelText("Source root identity for preferences"), {
    target: { value: "old-root" },
  });
  fireEvent.click(button("Prepare preferences transition preview"));
  await screen.findByText("preferences.json / SHA-256: file-hash / bytes: 23");
  expect(screen.queryByText("secret-value")).toBeNull();
  for (const [field, value] of [
    ["mappedDocumentReferences", "2"],
    ["unresolvedDocumentReferences", "3"],
    ["unresolvedFolderReferences", "1"],
    ["outputVersion", "4"],
    ["sourceRetained", "true"],
  ]) {
    expect(screen.getByText(field).parentElement?.querySelector("dd")?.textContent).toBe(value);
  }
  expect(
    screen.getByRole("checkbox", {
      name: /Existing targets will not be overwritten; unconfirmed document and folder references retain their legacy references/,
    }),
  ).toBeTruthy();
  expect(button("Run reviewed operation").disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Rollback backup directory name"), {
    target: { value: "known-backup" },
  });
  fireEvent.click(button("Prepare rollback preview"));
  await screen.findByText("currentFormatWillBeReplaced");
  for (const [field, value] of [
    ["inactivePreferenceCopiesRetained", "true"],
    ["changedOriginalPreferencesAllowed", "false"],
    ["targetSchemaVersion", "2"],
  ]) {
    expect(screen.getByText(field).parentElement?.querySelector("dd")?.textContent).toBe(value);
  }
  expect(
    screen.getByRole("checkbox", {
      name: /Transitioned preference copies remain inactive; rollback is rejected if original preferences have changed/,
    }),
  ).toBeTruthy();
  expect(ipc.invoke).toHaveBeenCalledWith("storage_transition_request", {
    request: { command: "prepare_rollback", backup_directory: "known-backup" },
  });
  confirmConsent();
  fireEvent.click(button("Run reviewed operation"));
  await screen.findByText("Rollback completed. Quit the tool and restart the app.");
  expect(
    screen.getByRole("radio", { name: "Explicitly confirm empty data" }).closest("fieldset")
      ?.disabled,
  ).toBe(true);
});

test("expired preview cannot confirm even after consent", async () => {
  await open();
  await prepareRoot();
  confirmConsent();
  vi.useFakeTimers();
  act(() => {
    vi.setSystemTime(Date.now() + 300001);
  });
  fireEvent.click(button("Run reviewed operation"));
  expect(commands()).not.toContain("confirm");
});

test("incomplete successful confirmation remains unknown and never permits a second confirm", async () => {
  const previous = respond;
  respond = (request) =>
    request.command === "confirm" ? { status: "committed" } : previous(request);
  await open();
  await prepareRoot();
  confirmConsent();
  fireEvent.click(button("Run reviewed operation"));
  await screen.findByRole("button", { name: "Check operation result" });
  expect(button("Run reviewed operation").disabled).toBe(true);
  expect(commands().filter((command) => command === "confirm")).toHaveLength(1);
});

test("a rollback receipt reported as committed resolves lost responses and requires restart", async () => {
  const previous = respond;
  respond = (request) => {
    if (request.command === "prepare_rollback")
      return plan({
        operation: "rollback",
        currentFormatWillBeReplaced: true,
        keepCurrentBackup: true,
        olderAppsMayResume: true,
        sourceRetained: true,
        inactivePreferenceCopiesRetained: true,
        changedOriginalPreferencesAllowed: false,
        targetSchemaVersion: 2,
      });
    if (request.command === "confirm") throw new Error("lost");
    if (request.command === "operation_status")
      return { status: "committed", settingsMatchRoot: false };
    return previous(request);
  };
  await open(true);
  backupConsent();
  fireEvent.change(screen.getByLabelText("Rollback backup directory name"), {
    target: { value: "known-backup" },
  });
  fireEvent.click(button("Prepare rollback preview"));
  await screen.findByText("currentFormatWillBeReplaced");
  confirmConsent();
  fireEvent.click(button("Run reviewed operation"));
  await screen.findByRole("button", { name: "Check operation result" });
  fireEvent.click(button("Check operation result"));
  await screen.findByText("Rollback completed. Quit the tool and restart the app.");
  expect(button("Prepare root confirmation preview").disabled).toBe(true);
  expect(commands().filter((command) => command === "confirm")).toHaveLength(1);
});

test("cancel is explicit and clears consent; feature-disabled session keeps user selections", async () => {
  await open();
  await prepareRoot();
  confirmConsent();
  expect(commands()).not.toContain("cancel");
  fireEvent.click(button("Cancel preview"));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Run reviewed operation" })).toBeNull(),
  );
  expect(commands()).toContain("cancel");
  fireEvent.click(button("Prepare root confirmation preview"));
  await screen.findByText("manifest-hash");
  expect(button("Run reviewed operation").disabled).toBe(true);
  cleanup();
  respond = () => ({ error: "native_identity_disabled" });
  render(<StorageTransition />);
  fireEvent.change(screen.getByLabelText("Knowledge folder"), {
    target: { value: "retained-root" },
  });
  fireEvent.change(screen.getByLabelText("Backup parent folder"), {
    target: { value: "retained-backup" },
  });
  fireEvent.click(button("Open inspection session"));
  expect((await screen.findByRole("alert")).textContent).toContain("native_identity_disabled");
  expect((screen.getByLabelText("Knowledge folder") as HTMLInputElement).value).toBe(
    "retained-root",
  );
  expect(screen.queryByRole("button", { name: "Inspect again" })).toBeNull();
});

test("root commit with unpublished settings keeps document and preferences actions gated", async () => {
  const previous = respond;
  respond = (request) =>
    request.command === "confirm"
      ? {
          status: "committed",
          operationId: "operation",
          schemaVersion: 3,
          settingsPublished: false,
        }
      : previous(request);
  await open();
  await prepareRoot();
  confirmConsent();
  fireEvent.click(button("Run reviewed operation"));
  await screen.findByText("The reviewed operation committed");
  expect(
    screen.getByRole("radio", { name: "Explicitly confirm empty data" }).closest("fieldset")
      ?.disabled,
  ).toBe(true);
  expect(
    screen.getByLabelText("Source root identity for preferences").closest("fieldset")?.disabled,
  ).toBe(true);
});

test("missing preference reference counts and permissive rollback restrictions reject the preview", async () => {
  const previous = respond;
  respond = (request) => {
    if (request.command === "prepare_preferences")
      return plan({
        operation: "restore_preferences",
        sourceRootIdentity: "old-root",
        targetRootIdentity: "physical-root",
        pathOwnership: "owner_confirmation_required",
        mappedDocumentReferences: 2,
        unresolvedDocumentReferences: 1,
        sourceRetained: true,
        existingTargetReplacement: false,
        outputVersion: 4,
        files: [],
      });
    if (request.command === "prepare_rollback")
      return plan({
        operation: "rollback",
        currentFormatWillBeReplaced: true,
        keepCurrentBackup: true,
        olderAppsMayResume: true,
        sourceRetained: true,
        inactivePreferenceCopiesRetained: true,
        changedOriginalPreferencesAllowed: true,
        targetSchemaVersion: 2,
      });
    return previous(request);
  };
  await open(true);
  backupConsent();
  fireEvent.change(screen.getByLabelText("Source root identity for preferences"), {
    target: { value: "old-root" },
  });
  fireEvent.click(button("Prepare preferences transition preview"));
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "Run reviewed operation" })).toBeNull();
  fireEvent.change(screen.getByLabelText("Rollback backup directory name"), {
    target: { value: "known-backup" },
  });
  fireEvent.click(button("Prepare rollback preview"));
  await waitFor(() => expect(button("Prepare rollback preview").disabled).toBe(false));
  expect(screen.queryByRole("button", { name: "Run reviewed operation" })).toBeNull();
  expect(commands()).not.toContain("confirm");
});

for (const pendingCommand of ["prepare_root", "confirm"]) {
  test(`requests cancellation once during deferred ${pendingCommand} without deciding its outcome`, async () => {
    await open();
    if (pendingCommand === "confirm") {
      await prepareRoot();
      confirmConsent();
    } else backupConsent();
    let finishOperation!: (value: unknown) => void;
    let finishCancellation!: (value: unknown) => void;
    const operation = new Promise<unknown>((resolve) => {
      finishOperation = resolve;
    });
    const cancellation = new Promise<unknown>((resolve) => {
      finishCancellation = resolve;
    });
    const previous = respond;
    respond = (request) =>
      request.command === pendingCommand
        ? operation
        : request.command === "cancel"
          ? cancellation
          : previous(request);
    fireEvent.click(
      button(
        pendingCommand === "confirm"
          ? "Run reviewed operation"
          : "Prepare root confirmation preview",
      ),
    );
    const stop = await screen.findByRole<HTMLButtonElement>("button", {
      name: "Request cancellation",
    });
    expect(stop.disabled).toBe(false);
    fireEvent.click(stop);
    fireEvent.click(stop);
    expect(commands().filter((command) => command === "cancel")).toHaveLength(1);
    await act(async () => {
      finishCancellation({ cancelRequested: true });
    });
    expect(
      screen.getByText(
        "Cancellation was requested. Waiting for the operation's definitive response.",
      ),
    ).toBeTruthy();
    expect(button("Request cancellation").disabled).toBe(true);
    expect(button("Prepare root confirmation preview").disabled).toBe(true);
    expect(screen.queryByText("The reviewed operation committed")).toBeNull();
    if (pendingCommand === "confirm") {
      expect(button("Run reviewed operation").disabled).toBe(true);
      await act(async () => {
        finishOperation({ unexpected: true });
      });
      expect(button("Check operation result").disabled).toBe(false);
      expect(button("Run reviewed operation").disabled).toBe(true);
      expect(commands().filter((command) => command === "confirm")).toHaveLength(1);
    } else {
      await act(async () => {
        finishOperation(plan());
      });
      expect(screen.getByText("manifest-hash")).toBeTruthy();
      expect(button("Run reviewed operation").disabled).toBe(true);
    }
    expect(screen.queryByRole("button", { name: "Request cancellation" })).toBeNull();
  });
}
