import { invoke } from "@tauri-apps/api/core";

export type ManagementContext = { workspaceId: string | null; viewId: string };
export type ManagementOperation = "upgrade" | "quarantine" | "restore";
export type SavedUsage = {
  logicalBytes: number;
  records: number;
  recoveryLogicalBytes: number | null;
  recoveryRecords: number | null;
  databaseBytes: number;
  journalBytes: number;
  freeDatabasePageBytes: number;
};
export type SavedEntry = {
  documentIdentity: string;
  rootIdentity: string;
  relativePath: string | null;
  logicalBytes: number;
  revision: number;
  sourceAvailability: string;
  lastViewedAt: null;
  eligible: boolean;
  holdReason: string | null;
};
export type RecoveryEntry = {
  recoveryId: string;
  documentIdentity: string;
  rootIdentity: string;
  relativePath: string | null;
  sourceRevision: number;
  logicalBytes: number;
  status: "quarantined" | "restored";
  restoredRevision: number | null;
  restorable: boolean;
  holdReason: string | null;
};
export type ManagementPage<T> = {
  snapshotId: string;
  databaseSchemaVersion: number;
  usage: SavedUsage;
  entries: T[];
  offset: number;
  limit: number;
  hasMore: boolean;
};
export type ManagementPlan = {
  planId: string;
  operation: ManagementOperation;
  snapshotId: string;
  candidateId: string;
  documentIdentity: string | null;
  relativePath: string | null;
  logicalBytes: number;
  appCount: number;
  canConfirm: boolean;
  blockedReason: string | null;
  expiresInMs: number;
};
export type ManagementReceipt = {
  operationId: string;
  operation: ManagementOperation;
  documentIdentity?: string;
  revision?: number;
  databaseGeneration?: number;
  recoveryId?: string;
  recoverable: true;
  permanentDeletion: false;
  schemaVersion?: 2;
};
export type ManagementVerification = {
  status: "pending" | "cancelled" | "failed" | "completed" | "unknown";
  receipt?: ManagementReceipt;
  code?: string;
  currentSchemaVersion?: number;
};
type PageRequest = {
  context: ManagementContext;
  offset: number;
  limit: number;
  snapshotId?: string | null;
};
export type ManagementApi = {
  list: (request: PageRequest) => Promise<ManagementPage<SavedEntry>>;
  recoveryList: (request: PageRequest) => Promise<ManagementPage<RecoveryEntry>>;
  prepare: (request: {
    context: ManagementContext;
    operation: ManagementOperation;
    candidateId?: string | null;
    snapshotId: string;
  }) => Promise<ManagementPlan>;
  confirm: (confirmation: {
    context: ManagementContext;
    planId: string;
    confirmation: string;
  }) => Promise<ManagementReceipt>;
  cancel: (
    context: ManagementContext,
    planId: string,
  ) => Promise<{
    status: "cancel_requested" | "cancelled" | "completed" | "failed";
    verifyRequired: boolean;
    code?: string;
    receipt?: ManagementReceipt;
  }>;
  verify: (context: ManagementContext, planId: string) => Promise<ManagementVerification>;
};
export const managementApi: ManagementApi = {
  list: (request) => invoke("inspect_saved_state", { request }),
  recoveryList: (request) => invoke("list_saved_state_recovery", { request }),
  prepare: (request) => invoke("prepare_saved_state_management", { request }),
  confirm: (confirmation) => invoke("confirm_saved_state_management", { confirmation }),
  cancel: (context, planId) => invoke("cancel_saved_state_management", { context, planId }),
  verify: (context, planId) => invoke("verify_saved_state_management", { context, planId }),
};
export function managementError(error: unknown): string {
  const code =
    error && typeof error === "object" && "code" in error
      ? error.code
      : typeof error === "string"
        ? error
        : "saved_state_unavailable";
  return typeof code === "string" && Object.hasOwn(managementMessages, code)
    ? code
    : "saved_state_unavailable";
}
export const managementMessages: Readonly<Record<string, string>> = {
  invalid_arguments: "操作の指定を確認できません",
  state_unavailable: "保存データを確認できません。原本を保持します",
  capacity_exceeded: "DBの技術上限またはdiskの容量制約に達しました。既存の保存値と入力を保持します",
  resource_unavailable:
    "処理に必要なメモリなどの資源を確保できません。既存の保存値と入力を保持します",
  unsafe_path: "保存先を安全に確認できません。原本を保持します",
  context_changed: "ルートまたは表示世代が変わりました。点検し直してください",
  inspection_limit: "有限の点検範囲を超えました。対象は保留します",
  explicit_confirmation_required: "実行前に対象と影響を確認してください",
  explicit_upgrade_required: "先に回復可能な形式への変更を確認してください",
  upgrade_not_needed: "回復可能な形式へ変更済みです。点検し直してください",
  plan_limit: "確認の上限に達しました。以前の確認を取り消してください",
  unknown_or_consumed_plan: "この確認は利用できません。操作結果を照会してください",
  expired_plan: "確認の期限が切れました。点検し直してください",
  plan_not_pending: "この確認は処理済みまたは処理中です。結果を照会してください",
  management_busy: "保存データは使用中です。処理の終了後に再確認してください",
  source_changed: "原本が変わりました。点検し直して選択してください",
  source_unavailable_hold: "ルートまたは原本を確認できないため保留します",
  in_use_hold:
    "対象HTMLは使用中か保存権限が残っているため、いまは整理できません。外部ブラウザーの登録が残る場合はアプリを再起動してから再点検してください",
  restore_conflict_or_quota: "復元先の値または容量制限により復元できません。既存値を保持します",
  recovery_capacity_reached: "回復領域の上限に達しました。既存の回復コピーを保持します",
  cancelled: "操作の取消を確認しました",
  clock_unavailable: "確認の期限を安全に確認できません。実行せず保留します",
  main_host_required: "この操作はアプリの設定画面で行ってください",
  state_busy: "保存データは使用中です。処理の終了後に再確認してください",
  live_document_busy:
    "対象HTMLは使用中です。表示中・非表示のタブと外部ブラウザーを閉じてから再確認してください",
  state_changed: "保存データが変わりました。点検し直して選択してください",
  candidate_unavailable: "対象の状態を確認できないため保留します",
  root_unavailable: "ルートを確認できないため保留します",
  plan_expired: "確認の期限が切れました。点検し直してください",
  plan_stale: "確認した対象が変わりました。点検し直してください",
  restore_conflict: "復元先に保存された入力があるため上書きしません",
  recovery_conflict: "復元先に保存された入力があるため上書きしません",
  unsupported_state: "この保存形式には対応していません。原本を保持します",
  state_corrupt: "保存データの整合性を確認できません。原本を保持します",
  saved_state_unavailable: "保存データを確認できません。原本を保持します",
  unavailable: "ルートまたは原本を確認できないため保留します",
  not_found_single_scan: "一度の点検で見つからないだけでは整理しません",
  different_identity_recovery_history: "原本の識別情報が異なるため回復用に保持します",
  same_identity_present: "同じ原本を確認しました",
  same_identity_relocated: "同じ原本を別の場所で確認しました",
  response_mismatch: "応答が確認した操作と一致しません。処理結果を照会してください",
};

type View = {
  kind: "active" | "recovery";
  page: ManagementPage<SavedEntry> | ManagementPage<RecoveryEntry> | null;
  selected: string | null;
  busy: boolean;
  phase: "idle" | "preview" | "processing" | "unknown" | "completed" | "cancelled" | "failed";
  error: string | null;
  plan: ManagementPlan | null;
};
const initial = (): View => ({
  kind: "active",
  page: null,
  selected: null,
  busy: false,
  phase: "idle",
  error: null,
  plan: null,
});
const sameContext = (a: ManagementContext, b: ManagementContext) =>
  a.workspaceId === b.workspaceId && a.viewId === b.viewId;
// Retain one bounded ticket in the footer across page/dialog closure. Never retry
// a mutation after a lost response; the user can request operation verification.
export class ManagementSession {
  private view = initial();
  private context: ManagementContext = { workspaceId: null, viewId: "" };
  private ticketContext: ManagementContext | null = null;
  private generation = 0;
  private listeners = new Set<() => void>();
  constructor(private api: ManagementApi = managementApi) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.view;
  private set(patch: Partial<View>) {
    this.view = { ...this.view, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  bind(context: ManagementContext) {
    if (sameContext(context, this.context)) return;
    this.context = { ...context };
    this.generation++;
    this.set({
      page: null,
      selected: null,
      ...(this.view.plan ? { error: "state_changed" } : { busy: false }),
    });
  }
  isCurrentPlan() {
    return !!this.ticketContext && sameContext(this.context, this.ticketContext);
  }
  async load(kind: View["kind"] = this.view.kind, offset = 0) {
    if (this.view.busy || this.view.plan) return;
    const generation = ++this.generation;
    const context = { ...this.context };
    const snapshotId = offset > 0 && kind === this.view.kind ? this.view.page?.snapshotId : null;
    this.set({ busy: true, kind, selected: null, error: null, phase: "idle" });
    try {
      const request = { context, offset, limit: 20, snapshotId };
      const page =
        kind === "active" ? await this.api.list(request) : await this.api.recoveryList(request);
      if (generation !== this.generation) return;
      if (page.entries.length > 20 || page.limit > 20 || page.offset !== offset)
        throw "response_mismatch";
      this.set({ page });
    } catch (error) {
      if (generation === this.generation) this.set({ page: null, error: managementError(error) });
    } finally {
      if (generation === this.generation) this.set({ busy: false });
    }
  }
  select(id: string) {
    if (
      this.view.busy ||
      this.view.plan ||
      !this.view.page?.entries.some(
        (entry) =>
          ("recoveryId" in entry ? entry.recoveryId : entry.documentIdentity) === id &&
          ("restorable" in entry ? entry.restorable : entry.eligible),
      )
    )
      return;
    this.set({ selected: id });
  }
  async prepare(operation: ManagementOperation) {
    const page = this.view.page;
    if (
      this.view.busy ||
      this.view.plan ||
      !page ||
      (operation !== "upgrade" && !this.view.selected)
    )
      return;
    const generation = ++this.generation;
    const context = { ...this.context };
    const candidateId = operation === "upgrade" ? null : this.view.selected;
    this.set({ busy: true, error: null });
    try {
      const plan = await this.api.prepare({
        context,
        operation,
        candidateId,
        snapshotId: page.snapshotId,
      });
      if (generation !== this.generation) {
        void this.api.cancel(context, plan.planId).catch(() => {});
        return;
      }
      if (
        plan.operation !== operation ||
        plan.snapshotId !== page.snapshotId ||
        (candidateId !== null && plan.candidateId !== candidateId)
      )
        throw "response_mismatch";
      this.ticketContext = context;
      this.set({ plan, phase: "preview" });
    } catch (error) {
      if (generation === this.generation) this.set({ error: managementError(error) });
    } finally {
      if (generation === this.generation) this.set({ busy: false });
    }
  }
  private receipt(receipt?: ManagementReceipt) {
    const plan = this.view.plan;
    if (
      !plan ||
      !receipt ||
      receipt.operationId !== plan.planId ||
      receipt.operation !== plan.operation ||
      receipt.permanentDeletion !== false ||
      receipt.recoverable !== true ||
      (plan.documentIdentity && receipt.documentIdentity !== plan.documentIdentity)
    ) {
      this.set({ phase: "unknown", error: "response_mismatch" });
      return;
    }
    this.set({ phase: "completed", error: null });
  }
  async confirm() {
    const plan = this.view.plan;
    if (
      !plan ||
      this.view.busy ||
      this.view.phase !== "preview" ||
      !plan.canConfirm ||
      !this.isCurrentPlan() ||
      !this.ticketContext
    )
      return;
    this.set({ busy: true, phase: "processing", error: null });
    try {
      this.receipt(
        await this.api.confirm({
          context: this.ticketContext,
          planId: plan.planId,
          confirmation: plan.planId,
        }),
      );
    } catch (error) {
      this.set({ phase: "unknown", error: managementError(error) });
    } finally {
      this.set({ busy: false });
    }
  }
  async verify() {
    const plan = this.view.plan;
    if (!plan || this.view.busy || !this.ticketContext) return;
    this.set({ busy: true, error: null });
    try {
      const result = await this.api.verify(this.ticketContext, plan.planId);
      if (result.status === "completed") this.receipt(result.receipt);
      else if (result.status === "cancelled" || result.status === "failed")
        this.set({ phase: result.status, error: result.code ?? null });
      else this.set({ phase: "unknown", error: result.code ?? null });
    } catch (error) {
      this.set({ phase: "unknown", error: managementError(error) });
    } finally {
      this.set({ busy: false });
    }
  }
  async cancel() {
    const plan = this.view.plan;
    if (!plan || this.view.busy || !this.ticketContext) return;
    this.set({ busy: true });
    try {
      const result = await this.api.cancel(this.ticketContext, plan.planId);
      this.set({
        phase: result.status === "cancelled" && !result.verifyRequired ? "cancelled" : "unknown",
        error: null,
      });
    } catch (error) {
      this.set({ phase: "unknown", error: managementError(error) });
    } finally {
      this.set({ busy: false });
    }
  }
  finish(acknowledgeUnknown = false) {
    if (
      this.view.busy ||
      (!["completed", "cancelled", "failed"].includes(this.view.phase) &&
        !(acknowledgeUnknown && this.view.phase === "unknown"))
    )
      return;
    this.ticketContext = null;
    this.set({ plan: null, selected: null, phase: "idle" });
    void this.load();
  }
}
