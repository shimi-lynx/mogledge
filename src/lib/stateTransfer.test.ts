import { expect, it, vi } from "vite-plus/test";
import {
  StateTransfer,
  transferErrorCode,
  type TransferPreview,
  type TransferReceipt,
  type TransferView,
  type TransferContext,
  type TransferFile,
  type TransferVerification,
} from "./stateTransfer";
import type { Bridge } from "./types";
import { translate, translateUiMessage } from "./i18n";
const context = { workspaceId: "root", viewId: "view" };
const preview: TransferPreview = {
  context,
  planId: "plan",
  operation: "import",
  documentIdentity: "identity",
  logicalBytes: 12,
  incomingApps: [{ appId: "calculator", schemaVersion: 1 }],
  previousApps: [],
  replacesExisting: true,
  backupRequired: true,
  stopReloadRequired: true,
  affectedViews: [],
  browserGrants: 0,
  openingRequests: 0,
  unflushedInput: "unknown",
};
const receipt: TransferReceipt = {
  operationId: "plan",
  operation: "import",
  context,
  documentIdentity: "identity",
  reloadTabIds: [],
  revokedBrowserGrants: 0,
};
function setup() {
  let currentContext: TransferContext | null = context;
  let view: TransferView | undefined;
  const reload = vi.fn(async () => {});
  const api = {
    chooseStateTransferFile: vi.fn(
      async (
        _context: TransferContext,
        kind: "import" | "export" | "backup",
      ): Promise<TransferFile | null> => ({
        fileId: kind,
        kind,
        name: kind + ".json",
      }),
    ),
    prepareStateTransfer: vi.fn(async () => structuredClone(preview)),
    confirmStateTransfer: vi.fn(async () => structuredClone(receipt)),
    cancelStateTransfer: vi.fn(async (): Promise<TransferVerification> => ({
      status: "cancelled",
    })),
    verifyStateTransfer: vi.fn(async (): Promise<TransferVerification> => ({
      status: "completed",
      receipt: structuredClone(receipt),
    })),
  };
  // This isolated orchestration fixture deliberately exposes no document APIs.
  const transfer = new StateTransfer(api as unknown as Bridge, {
    context: () => currentContext,
    capture: () => ({ activeTabIds: ["left", "right"], reload }),
    publish: (next) => (view = next),
  });
  return {
    api,
    transfer,
    reload,
    view: () => view,
    changeRoot: () => {
      currentContext = { workspaceId: "other", viewId: "next" };
      transfer.invalidate();
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
it("requires separate replacement and stop/reload confirmations and ignores repeated execute", async () => {
  const { api, transfer, reload, view } = setup();
  await transfer.begin("a.html", "import");
  expect(view()?.preview?.unflushedInput).toBe("unknown");
  expect(api.prepareStateTransfer).toHaveBeenCalledWith({
    context,
    relativePath: "a.html",
    fileId: "import",
    backupFileId: null,
    activeTabIds: ["left", "right"],
  });
  await transfer.confirm(false, true);
  await transfer.confirm(true, false);
  expect(api.confirmStateTransfer).not.toHaveBeenCalled();
  const gate = deferred<TransferReceipt>();
  api.confirmStateTransfer.mockReturnValue(gate.promise);
  const pending = transfer.confirm(true, true);
  await transfer.confirm(true, true);
  expect(api.confirmStateTransfer).toHaveBeenCalledOnce();
  gate.resolve(receipt);
  await pending;
  expect(reload).toHaveBeenCalledOnce();
  expect(view()?.phase).toBe("completed");
  await transfer.confirm(true, true);
  await transfer.verify();
  expect(reload).toHaveBeenCalledOnce();
});
it.each(["capacity_exceeded", "resource_unavailable"])(
  "typed %s transfer errors preserve input and prevent redispatch while diagnostics ignore private causes",
  async (code) => {
    const { api, transfer, reload, view } = setup();
    api.confirmStateTransfer.mockRejectedValue({
      code,
      message: "/private/state.db secret payload",
    });
    await transfer.begin("a.html", "import");
    await transfer.confirm(true, true);
    expect(view()?.phase).toBe("unknown");
    expect(view()?.preview).toEqual(preview);
    expect(view()?.message).toContain("既存の保存値と入力を保持します");
    expect(view()?.message).not.toContain("/private/");
    expect(view()?.message).not.toContain("secret");
    expect(translate(transferErrorCode({ code, message: "/private/state.db" }), "en")).toContain(
      "Existing saved values and input are retained.",
    );
    await transfer.confirm(true, true);
    expect(api.confirmStateTransfer).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
    api.verifyStateTransfer.mockResolvedValue({
      status: "failed",
      code,
      grantsRevoked: false,
      backupPublished: false,
      exportPublished: false,
    });
    await transfer.verify();
    expect(view()?.phase).toBe("failed");
    expect(view()?.message).toContain("既存の保存値と入力を保持します");
    expect(translateUiMessage(view()?.message ?? "", "en")).toContain(
      "Existing saved values and input are retained.",
    );
    expect(reload).not.toHaveBeenCalled();
  },
);
it("unknown transport and failed-verification codes never disclose paths or payloads while known codes retain their meaning", async () => {
  for (const error of [
    "/private/state.db secret payload",
    new Error("/private/state.db secret payload"),
    { code: "/private/state.db", message: "secret payload" },
    { code: 42 },
    "constructor",
  ]) {
    const safe = transferErrorCode(error);
    expect(safe).toBe("転送の詳細を確認できません。処理結果を照会してください");
    expect(translate(safe, "en")).toBe(
      "Transfer details could not be verified. Check the operation result.",
    );
  }
  expect(
    transferErrorCode({ code: "explicit_backup_required", message: "/private/state.db" }),
  ).toBe("explicit_backup_required");
  expect(transferErrorCode({ code: "quota_exceeded" })).toBe("quota_exceeded");
  const { api, transfer, view, reload } = setup();
  api.confirmStateTransfer.mockRejectedValue(new Error("/private/state.db secret payload"));
  await transfer.begin("a.html", "import");
  await transfer.confirm(true, true);
  expect(view()?.phase).toBe("unknown");
  expect(view()?.message).not.toContain("/private/");
  expect(view()?.message).not.toContain("secret");
  api.verifyStateTransfer.mockResolvedValue({
    status: "failed",
    code: "/private/state.db secret payload",
    grantsRevoked: false,
    backupPublished: false,
    exportPublished: false,
  });
  await transfer.verify();
  expect(view()?.phase).toBe("failed");
  expect(view()?.message).not.toContain("/private/");
  expect(view()?.message).not.toContain("secret");
  expect(api.confirmStateTransfer).toHaveBeenCalledOnce();
  expect(reload).not.toHaveBeenCalled();
});
it("cancel before execution does not confirm or reload any view", async () => {
  const { api, transfer, reload, view } = setup();
  await transfer.begin("a.html", "import");
  await transfer.cancel();
  expect(view()?.phase).toBe("cancelled");
  expect(api.confirmStateTransfer).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
  transfer.dismiss();
  expect(view()).toBeUndefined();
});
it("keeps a lost confirmation response unknown, then verifies and applies its receipt once", async () => {
  const { api, transfer, view, reload } = setup();
  api.confirmStateTransfer.mockRejectedValue(new Error("IPC lost"));
  await transfer.begin("a.html", "import");
  await transfer.confirm(true, true);
  expect(view()?.phase).toBe("unknown");
  await transfer.confirm(true, true);
  expect(api.confirmStateTransfer).toHaveBeenCalledOnce();
  expect(reload).not.toHaveBeenCalled();
  await transfer.verify();
  await transfer.verify();
  expect(reload).toHaveBeenCalledOnce();
  expect(view()?.phase).toBe("completed");
});
it("a cancellation request racing commit is not reported as cancellation success", async () => {
  const { api, transfer, view, reload } = setup();
  const gate = deferred<TransferReceipt>();
  api.confirmStateTransfer.mockReturnValue(gate.promise);
  api.cancelStateTransfer.mockResolvedValue({ status: "cancel_requested" });
  await transfer.begin("a.html", "import");
  const pending = transfer.confirm(true, true);
  await transfer.cancel();
  expect(view()?.phase).toBe("unknown");
  expect(reload).not.toHaveBeenCalled();
  gate.resolve(receipt);
  await pending;
  expect(view()?.phase).toBe("completed");
  expect(reload).toHaveBeenCalledOnce();
});
it("ignores an old picker, preview and success receipt after a root switch", async () => {
  for (const phase of ["picker", "preview", "confirm"]) {
    const { api, transfer, changeRoot, reload } = setup();
    if (phase === "picker") {
      const gate = deferred<Awaited<ReturnType<typeof api.chooseStateTransferFile>>>();
      api.chooseStateTransferFile.mockReturnValue(gate.promise);
      const pending = transfer.begin("a.html", "import");
      changeRoot();
      gate.resolve({ fileId: "import", name: "input.json", kind: "import" });
      await pending;
      expect(api.prepareStateTransfer).not.toHaveBeenCalled();
    } else if (phase === "preview") {
      const gate = deferred<TransferPreview>();
      api.prepareStateTransfer.mockReturnValue(gate.promise);
      const pending = transfer.begin("a.html", "import");
      await Promise.resolve();
      changeRoot();
      gate.resolve(preview);
      await pending;
      expect(api.cancelStateTransfer).toHaveBeenCalledWith(context, "plan");
    } else {
      await transfer.begin("a.html", "import");
      const gate = deferred<TransferReceipt>();
      api.confirmStateTransfer.mockReturnValue(gate.promise);
      const pending = transfer.confirm(true, true);
      changeRoot();
      gate.resolve(receipt);
      await pending;
    }
    expect(reload).not.toHaveBeenCalled();
  }
});
it("asks for an explicit new backup and handles picker cancellation without executing", async () => {
  const { api, transfer, view } = setup();
  api.prepareStateTransfer.mockRejectedValueOnce({ code: "explicit_backup_required" });
  await transfer.begin("a.html", "import");
  expect(view()?.phase).toBe("backup");
  api.chooseStateTransferFile.mockResolvedValueOnce(null);
  await transfer.chooseBackup();
  expect(view()?.phase).toBe("backup");
  expect(api.confirmStateTransfer).not.toHaveBeenCalled();
  await transfer.chooseBackup();
  expect(api.prepareStateTransfer).toHaveBeenLastCalledWith(
    expect.objectContaining({ backupFileId: "backup" }),
  );
  expect(view()?.phase).toBe("preview");
});
it("rejects a mismatched receipt and preserves verify failures as unknown", async () => {
  const { api, transfer, view, reload } = setup();
  api.confirmStateTransfer.mockResolvedValue({ ...receipt, documentIdentity: "different" });
  await transfer.begin("a.html", "import");
  await transfer.confirm(true, true);
  expect(view()?.phase).toBe("unknown");
  expect(reload).not.toHaveBeenCalled();
  api.verifyStateTransfer.mockRejectedValue(new Error("offline"));
  await transfer.verify();
  expect(view()?.phase).toBe("unknown");
});
it("exports only the saved snapshot without a view reload", async () => {
  const { api, transfer, reload, view } = setup();
  api.prepareStateTransfer.mockResolvedValue({
    ...preview,
    operation: "export",
    replacesExisting: false,
    stopReloadRequired: false,
  });
  api.confirmStateTransfer.mockResolvedValue({
    ...receipt,
    operation: "export",
    context: undefined,
  });
  await transfer.begin("a.html", "export");
  await transfer.confirm(false, false);
  expect(view()?.phase).toBe("completed");
  expect(reload).not.toHaveBeenCalled();
});

it("a stale rejected operation verification cannot undo a completed cancellation receipt", async () => {
  const { api, transfer, view, reload } = setup();
  api.confirmStateTransfer.mockRejectedValue(new Error("lost"));
  await transfer.begin("a.html", "import");
  await transfer.confirm(true, true);
  const gate = deferred<Awaited<ReturnType<typeof api.verifyStateTransfer>>>();
  api.verifyStateTransfer.mockReturnValue(gate.promise);
  const pending = transfer.verify();
  api.cancelStateTransfer.mockResolvedValue({ status: "completed", receipt });
  await transfer.cancel();
  gate.reject(new Error("late lost"));
  await pending;
  expect(view()?.phase).toBe("completed");
  expect(reload).toHaveBeenCalledOnce();
});
it("current-value checks block execute and their late response cannot overwrite cancellation", async () => {
  const { api, transfer, view } = setup();
  await transfer.begin("a.html", "import");
  const gate = deferred<Awaited<ReturnType<typeof api.verifyStateTransfer>>>();
  api.verifyStateTransfer.mockReturnValue(gate.promise);
  const pending = transfer.verifyCurrentValues();
  await transfer.confirm(true, true);
  expect(api.confirmStateTransfer).not.toHaveBeenCalled();
  await transfer.cancel();
  const message = view()?.message;
  gate.resolve({
    status: "verified_current_values",
    matches: false,
    documentIdentity: "identity",
    provesPastOperation: false,
  });
  await pending;
  expect(view()?.phase).toBe("cancelled");
  expect(view()?.message).toBe(message);
});
