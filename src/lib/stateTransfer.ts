import type { Bridge } from "./types";

export type TransferContext = { workspaceId: string; viewId: string };
export type TransferFile = { fileId: string; kind: "import" | "export" | "backup"; name: string };
export type TransferPreview = {
  planId: string;
  context: TransferContext;
  operation: "import" | "export";
  documentIdentity: string;
  logicalBytes: number;
  incomingApps: { appId: string; schemaVersion: number }[];
  source?: { relativePath: string; revision: number };
  previousApps?: { appId: string; schemaVersion: number }[] | null;
  replacesExisting: boolean;
  backupRequired: boolean;
  stopReloadRequired: boolean;
  affectedViews: {
    tabId: string;
    documentIdentity: string | null;
    matchesTargetIdentity: boolean;
    visibility: "active" | "hidden";
    saveAcknowledgement: "unknown";
  }[];
  browserGrants: number;
  openingRequests: number;
  unflushedInput: "unknown";
};
export type TransferReceipt = {
  operationId: string;
  operation: "import" | "export";
  context?: TransferContext;
  documentIdentity: string;
  reloadTabIds: string[];
  previousStateBackedUp?: boolean;
  revokedBrowserGrants: number;
};
export type TransferVerification =
  | { status: "completed"; receipt: TransferReceipt }
  | {
      status: "verified_current_values";
      matches: boolean;
      documentIdentity: string;
      provesPastOperation: false;
    }
  | {
      status: "failed";
      code: string;
      grantsRevoked: boolean;
      backupPublished: boolean;
      exportPublished: boolean;
    }
  | { status: "pending" | "processing" | "cancel_requested" | "cancelled" | "expired" };
export type TransferView = {
  path: string;
  kind: "import" | "export";
  phase:
    | "selecting"
    | "backup"
    | "preview"
    | "processing"
    | "unknown"
    | "completed"
    | "cancelled"
    | "failed";
  busy: boolean;
  checking?: boolean;
  fileName?: string;
  backupName?: string;
  preview?: TransferPreview;
  message?: string;
};
type Capture = {
  activeTabIds: string[];
  reload: (receipt: TransferReceipt, preview: TransferPreview) => Promise<void>;
};
type Ticket = {
  context: TransferContext;
  path: string;
  kind: "import" | "export";
  file?: TransferFile;
  backup?: TransferFile;
  preview?: TransferPreview;
  capture?: Capture;
  applied: boolean;
  cancelling?: boolean;
  intent: number;
  view: TransferView;
};
const transferFailureMessages: Readonly<Record<string, string>> = {
  capacity_exceeded: "DBの技術上限またはdiskの容量制約に達しました。既存の保存値と入力を保持します",
  resource_unavailable:
    "処理に必要なメモリなどの資源を確保できません。既存の保存値と入力を保持します",
};
const transferFailureCodes = new Set([
  "backup_not_needed",
  "cancelled",
  "command_limit",
  "context_changed",
  "expired_plan",
  "explicit_backup_required",
  "explicit_confirmation_required",
  "explicit_replace_confirmation_required",
  "explicit_stop_reload_confirmation_required",
  "file_handle_limit",
  "invalid_active_views",
  "invalid_app",
  "invalid_app_version",
  "invalid_arguments",
  "invalid_command",
  "invalid_document_identity",
  "invalid_format",
  "invalid_html_target",
  "invalid_schema",
  "invalid_selected_file_kind",
  "invalid_source",
  "operation_cancelled",
  "operation_interrupted",
  "plan_limit",
  "plan_not_pending",
  "profile_file_forbidden",
  "quota_exceeded",
  "revision_limit",
  "saved_state_unavailable",
  "schema_conflict",
  "selected_file_changed",
  "selected_file_limit",
  "selected_file_required",
  "source_unavailable_hold",
  "state_busy",
  "state_changed",
  "state_corrupt",
  "state_operation_failed",
  "state_unavailable",
  "target_changed",
  "target_identity_changed",
  "target_quarantined_hold",
  "target_unavailable",
  "transfer_busy",
  "transfer_file_changed",
  "transfer_file_exists",
  "transfer_file_publish_failed",
  "transfer_file_sync_failed",
  "transfer_file_unavailable",
  "transfer_file_write_failed",
  "transfer_limit",
  "unexpected_backup",
  "unknown_or_consumed_plan",
  "unknown_plan",
  "unsafe_profile",
  "unsafe_transfer_file",
  "unsafe_transfer_path",
  "unsupported_format",
  "views_changed",
]);
export function transferErrorCode(error: unknown): string {
  const code =
    error && typeof error === "object" && "code" in error
      ? error.code
      : error instanceof Error
        ? error.message
        : error;
  if (typeof code === "string") {
    if (Object.hasOwn(transferFailureMessages, code)) return transferFailureMessages[code];
    if (transferFailureCodes.has(code) || code === "照合応答が対象と一致しません") return code;
  }
  // Transport failures may contain paths or payloads. Keep only finite app
  // diagnostics; checking an unknown operation remains an explicit action.
  return "転送の詳細を確認できません。処理結果を照会してください";
}

// One explicit operation, no polling or automatic confirm retry. Native owns
// filesystem paths, freshness, consent IDs and the atomic decision.
export class StateTransfer {
  private ticket?: Ticket;
  constructor(
    private api: Bridge,
    private host: {
      context: () => TransferContext | null;
      capture: () => Capture;
      publish: (view: TransferView | undefined) => void;
    },
  ) {}
  private current(ticket: Ticket) {
    const context = this.host.context();
    return (
      this.ticket === ticket &&
      context?.workspaceId === ticket.context.workspaceId &&
      context.viewId === ticket.context.viewId
    );
  }
  private publish(ticket: Ticket, value: Partial<TransferView>) {
    if (!this.current(ticket)) return;
    if (value.phase && value.phase !== ticket.view.phase) {
      ticket.intent++;
      value = { ...value, checking: false };
    }
    ticket.view = { ...ticket.view, ...value };
    this.host.publish(ticket.view);
  }
  invalidate() {
    const ticket = this.ticket;
    this.ticket = undefined;
    if (ticket?.preview)
      void this.api.cancelStateTransfer?.(ticket.context, ticket.preview.planId).catch(() => {});
  }
  async begin(path: string, kind: "import" | "export") {
    if (this.ticket) return;
    const context = this.host.context();
    if (!context || !this.api.chooseStateTransferFile || !this.api.prepareStateTransfer) return;
    const ticket: Ticket = {
      context,
      path,
      kind,
      applied: false,
      intent: 0,
      view: { path, kind, phase: "selecting", busy: true },
    };
    this.ticket = ticket;
    this.publish(ticket, {});
    try {
      const file = await this.api.chooseStateTransferFile(context, kind);
      if (!this.current(ticket)) return;
      if (!file) {
        this.dismiss();
        return;
      }
      ticket.file = file;
      this.publish(ticket, { fileName: file.name });
      await this.prepare(ticket);
    } catch (error) {
      this.publish(ticket, { phase: "failed", busy: false, message: transferErrorCode(error) });
    }
  }
  private async prepare(ticket: Ticket) {
    if (!ticket.file || !this.api.prepareStateTransfer) return;
    const capture = this.host.capture();
    this.publish(ticket, { phase: "selecting", busy: true, message: undefined });
    try {
      const preview = await this.api.prepareStateTransfer({
        context: ticket.context,
        relativePath: ticket.path,
        fileId: ticket.file.fileId,
        backupFileId: ticket.backup?.fileId ?? null,
        activeTabIds: capture.activeTabIds,
      });
      if (!this.current(ticket)) {
        void this.api.cancelStateTransfer?.(ticket.context, preview.planId).catch(() => {});
        return;
      }
      ticket.preview = preview;
      ticket.capture = capture;
      this.publish(ticket, { phase: "preview", preview, busy: false });
    } catch (error) {
      const code = transferErrorCode(error);
      this.publish(ticket, {
        phase: code === "explicit_backup_required" ? "backup" : "failed",
        busy: false,
        message:
          code === "explicit_backup_required"
            ? "既存の保存状態を置換するため、先に新しい平文backup先を選んでください。"
            : code,
      });
    }
  }
  async chooseBackup() {
    const ticket = this.ticket;
    if (
      !ticket ||
      ticket.view.busy ||
      ticket.view.phase !== "backup" ||
      !this.api.chooseStateTransferFile
    )
      return;
    this.publish(ticket, { busy: true });
    try {
      const backup = await this.api.chooseStateTransferFile(ticket.context, "backup");
      if (!this.current(ticket)) return;
      if (!backup) {
        this.publish(ticket, { busy: false });
        return;
      }
      ticket.backup = backup;
      this.publish(ticket, { backupName: backup.name });
      await this.prepare(ticket);
    } catch (error) {
      this.publish(ticket, { busy: false, message: transferErrorCode(error) });
    }
  }
  async confirm(replace: boolean, stopReload: boolean) {
    const ticket = this.ticket;
    const preview = ticket?.preview;
    if (
      !ticket ||
      !preview ||
      ticket.view.busy ||
      ticket.view.checking ||
      ticket.view.phase !== "preview" ||
      (preview.replacesExisting && !replace) ||
      (preview.stopReloadRequired && !stopReload) ||
      !this.api.confirmStateTransfer
    )
      return;
    this.publish(ticket, { phase: "processing", busy: true, message: undefined });
    try {
      const receipt = await this.api.confirmStateTransfer({
        context: ticket.context,
        planId: preview.planId,
        confirmation: preview.planId,
        replaceConfirmation: replace ? preview.planId : null,
        stopReloadConfirmation: stopReload ? preview.planId : null,
      });
      await this.completed(ticket, receipt);
    } catch (error) {
      if (ticket.applied || ["cancelled", "failed"].includes(ticket.view.phase)) return;
      // A rejected IPC can mean the committed response was lost. Preserve the
      // ticket and ask for operation verification before any new execution.
      this.publish(ticket, {
        phase: "unknown",
        busy: false,
        message:
          "結果を確認できません。再実行せず「処理結果を照会」を使ってください: " +
          transferErrorCode(error),
      });
    }
  }
  private async completed(ticket: Ticket, receipt: TransferReceipt) {
    if (!this.current(ticket) || ticket.applied || !ticket.preview) return;
    if (
      receipt.operationId !== ticket.preview.planId ||
      receipt.documentIdentity !== ticket.preview.documentIdentity ||
      receipt.operation !== ticket.kind ||
      (ticket.kind === "import" &&
        (receipt.context?.workspaceId !== ticket.context.workspaceId ||
          receipt.context.viewId !== ticket.context.viewId))
    ) {
      this.publish(ticket, {
        phase: "unknown",
        busy: false,
        message: "応答が確認した対象と一致しません。処理結果を照会してください。",
      });
      return;
    }
    ticket.applied = true;
    this.publish(ticket, { phase: "processing", busy: true });
    try {
      if (receipt.operation === "import") await ticket.capture?.reload(receipt, ticket.preview);
      this.publish(ticket, {
        phase: "completed",
        busy: false,
        message:
          receipt.operation === "import"
            ? "保存済み入力を取り込みました。対象の実表示タブを再読み込みしました。外部ブラウザーは明示的に開き直してください。"
            : "確定済みの保存状態を書き出しました。未確認の入力全体が保存されたことを意味しません。",
      });
    } catch (error) {
      this.publish(ticket, {
        phase: "completed",
        busy: false,
        message:
          "取り込みは完了しましたが、表示更新または旧view解除を確認できません: " +
          transferErrorCode(error),
      });
    }
  }
  async verify() {
    const ticket = this.ticket;
    if (!ticket?.preview || ticket.view.busy || ticket.applied || !this.api.verifyStateTransfer)
      return;
    ticket.intent++;
    this.publish(ticket, { busy: true, checking: false });
    try {
      const result = await this.api.verifyStateTransfer({
        kind: "operation",
        context: ticket.context,
        planId: ticket.preview.planId,
      });
      await this.result(ticket, result);
    } catch (error) {
      if (ticket.applied || ["cancelled", "failed"].includes(ticket.view.phase)) return;
      this.publish(ticket, {
        phase: "unknown",
        busy: false,
        message: "照会できません。結果は不明のままです: " + transferErrorCode(error),
      });
    }
  }
  private async result(ticket: Ticket, result: TransferVerification) {
    if (
      !this.current(ticket) ||
      ticket.applied ||
      ticket.view.phase === "cancelled" ||
      ticket.view.phase === "failed"
    )
      return;
    if (result.status === "completed") {
      await this.completed(ticket, result.receipt);
      return;
    }
    if (result.status === "verified_current_values") return;
    if (result.status === "cancelled") {
      this.publish(ticket, {
        phase: "cancelled",
        busy: false,
        message: "取り消しました。タブは閉じていません。",
      });
      return;
    }
    if (result.status === "failed") {
      this.publish(ticket, {
        phase: "failed",
        busy: false,
        message: `処理失敗: ${transferErrorCode({ code: result.code })}。grant失効: ${result.grantsRevoked ? "あり（自動復活しません。必要なタブを明示再読み込み）" : "なし"}。backup公開: ${result.backupPublished ? "あり" : "なし"}。export公開: ${result.exportPublished ? "あり" : "なし"}。`,
      });
      return;
    }
    this.publish(ticket, {
      phase: "unknown",
      busy: false,
      message: `処理状態: ${result.status}。取消要求や期限切れだけでは実行結果を断定できません。必要なら再照会してください。`,
    });
  }
  async cancel() {
    const ticket = this.ticket;
    if (!ticket || ticket.applied || ticket.cancelling) return;
    if (!ticket.preview) {
      this.invalidate();
      this.host.publish(undefined);
      return;
    }
    if (!this.api.cancelStateTransfer) return;
    ticket.cancelling = true;
    ticket.intent++;
    this.publish(ticket, { checking: false });
    try {
      const result = await this.api.cancelStateTransfer(ticket.context, ticket.preview.planId);
      await this.result(ticket, result);
    } catch (error) {
      if (ticket.applied || ["cancelled", "failed"].includes(ticket.view.phase)) return;
      this.publish(ticket, {
        phase: "unknown",
        busy: false,
        message: "取消結果は不明です。処理結果を照会してください: " + transferErrorCode(error),
      });
    } finally {
      ticket.cancelling = false;
    }
  }
  async verifyCurrentValues() {
    const ticket = this.ticket;
    if (
      !ticket?.file ||
      !ticket.preview ||
      ticket.kind !== "import" ||
      ticket.view.busy ||
      ticket.view.checking ||
      !this.api.verifyStateTransfer
    )
      return;
    const intent = ticket.intent;
    this.publish(ticket, { checking: true });
    try {
      const result = await this.api.verifyStateTransfer({
        kind: "import",
        context: ticket.context,
        relativePath: ticket.path,
        documentIdentity: ticket.preview.documentIdentity,
        fileId: ticket.file.fileId,
      });
      if (!this.current(ticket) || ticket.intent !== intent) return;
      if (
        result.status !== "verified_current_values" ||
        result.documentIdentity !== ticket.preview.documentIdentity
      )
        throw new Error("照合応答が対象と一致しません");
      this.publish(ticket, {
        message:
          (result.matches
            ? "現在の保存値は選択ファイルと一致します。"
            : "現在の保存値は選択ファイルと一致しません。") +
          "過去の処理成功・取消・未保存入力の保全を証明しません。",
      });
    } catch (error) {
      if (ticket.intent !== intent) return;
      this.publish(ticket, { message: "現在値を照合できません: " + transferErrorCode(error) });
    } finally {
      if (ticket.intent === intent) this.publish(ticket, { checking: false });
    }
  }
  dismissUnknown() {
    if (this.ticket?.view.phase !== "unknown" || this.ticket.view.busy) return;
    this.invalidate();
    this.host.publish(undefined);
  }
  dismiss() {
    const phase = this.ticket?.view.phase;
    if (
      this.ticket &&
      !["selecting", "backup", "preview", "completed", "cancelled", "failed"].includes(phase!)
    )
      return;
    this.invalidate();
    this.host.publish(undefined);
  }
}
