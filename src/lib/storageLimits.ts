import { invoke } from "@tauri-apps/api/core";
import type { ManagementContext } from "./stateManagement";

export type LimitsContext = ManagementContext;
export const MIB = 1024 * 1024;
export const MAX_LIMITS_MIB = Math.floor(Number.MAX_SAFE_INTEGER / MIB);
export const LIMITS_RESPONSE_DEADLINE_MS = 10_000;
function responseDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject("response_timeout"), LIMITS_RESPONSE_DEADLINE_MS);
  });
  // This bounds UI waiting only. It neither cancels Native work nor proves its
  // outcome. Promise.race consumes a late reply without attaching it to state.
  return Promise.race([operation, deadline]).finally(() => clearTimeout(timer));
}
export type LimitsSnapshot = {
  documentMiB: number;
  totalMiB: number;
  revision: number;
  generation: number;
  usageBytes: number;
  largestDocumentBytes: number;
  recoveryBytes: number | null;
  largestRecoveryDocumentBytes: number | null;
  requiresCompatibilityAcknowledgement: boolean;
  capabilities: {
    maximumDocumentBytes: number;
    maximumRequestBytes: number;
    maximumDatabaseBytes: number;
    recoveryBudgetBytes: number;
  };
};
export type LimitsRequest = {
  context: LimitsContext;
  expectedRevision: number;
  expectedGeneration: number;
  documentMiB: number;
  totalMiB: number;
  acknowledgeCompatibility: boolean;
};
export type LimitsApi = {
  get: (context: LimitsContext) => Promise<LimitsSnapshot>;
  set: (request: LimitsRequest) => Promise<LimitsSnapshot>;
};
export const storageLimitsApi: LimitsApi = {
  get: (context) => invoke("get_storage_limits", { context }),
  set: (request) => invoke("set_storage_limits", { request }),
};
export const limitsMessages: Readonly<Record<string, string>> = {
  limits_invalid: "正確に扱える範囲の1以上の整数MiBを指定し、全体を文書以上にしてください",
  limits_changed: "保存データまたは上限が変わりました。現在値を確認してから適用してください",
  limits_below_usage: "現在の保存量や文書・回復コピーの最大容量を下回る上限にはできません",
  limits_compatibility_required: "旧版との互換性とbackupを確認してください",
  context_changed: "ルートまたは表示世代が変わりました。適用値を確認してください",
  state_busy: "保存データは使用中です。処理が終わってから現在値を確認してください",
  state_corrupt: "保存データの整合性を確認できません。入力と設定を保持します",
  state_unavailable: "保存上限を確認できません。入力と設定を保持します",
  capacity_exceeded: "DBの技術上限またはdiskの容量制約に達しました。既存の保存値と入力を保持します",
  resource_unavailable:
    "処理に必要なメモリなどの資源を確保できません。既存の保存値と入力を保持します",
  inspection_limit: "有限の点検範囲を超えたため、上限の変更を保留します",
  main_host_required: "保存上限はアプリの設定画面で変更してください",
};
function knownError(error: unknown): string | null {
  const code =
    error && typeof error === "object" && "code" in error
      ? error.code
      : error instanceof Error
        ? error.message
        : error;
  return typeof code === "string" && Object.hasOwn(limitsMessages, code) ? code : null;
}
export function limitsDiagnostic(error: unknown): string {
  return limitsMessages[knownError(error) ?? "state_unavailable"];
}
const safe = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export function limitsSnapshot(value: unknown): LimitsSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  if (
    Object.keys(fields).sort().join() !==
    "capabilities,documentMiB,generation,largestDocumentBytes,largestRecoveryDocumentBytes,recoveryBytes,requiresCompatibilityAcknowledgement,revision,totalMiB,usageBytes"
  )
    return null;
  for (const key of [
    "documentMiB",
    "totalMiB",
    "revision",
    "generation",
    "usageBytes",
    "largestDocumentBytes",
  ])
    if (!safe(fields[key])) return null;
  for (const key of ["recoveryBytes", "largestRecoveryDocumentBytes"])
    if (fields[key] !== null && !safe(fields[key])) return null;
  if (typeof fields.requiresCompatibilityAcknowledgement !== "boolean") return null;
  const capabilities = fields.capabilities;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return null;
  if (
    Object.keys(capabilities).sort().join() !==
    "maximumDatabaseBytes,maximumDocumentBytes,maximumRequestBytes,recoveryBudgetBytes"
  )
    return null;
  for (const capacity of Object.values(capabilities))
    if (!safe(capacity) || capacity === 0) return null;
  // All numeric/null fields and exact keys were validated before this boundary cast.
  const snapshot = fields as LimitsSnapshot;
  if (
    snapshot.documentMiB < 1 ||
    snapshot.documentMiB > MAX_LIMITS_MIB ||
    snapshot.totalMiB < snapshot.documentMiB ||
    snapshot.totalMiB > MAX_LIMITS_MIB ||
    snapshot.largestDocumentBytes > snapshot.capabilities.maximumDocumentBytes ||
    snapshot.largestDocumentBytes > snapshot.usageBytes ||
    (snapshot.recoveryBytes !== null &&
      snapshot.recoveryBytes > snapshot.capabilities.recoveryBudgetBytes) ||
    (snapshot.largestRecoveryDocumentBytes !== null &&
      (snapshot.largestRecoveryDocumentBytes > snapshot.capabilities.maximumDocumentBytes ||
        snapshot.recoveryBytes === null ||
        snapshot.largestRecoveryDocumentBytes > snapshot.recoveryBytes))
  )
    return null;
  return { ...snapshot, capabilities: { ...snapshot.capabilities } };
}
export function parseLimits(document: string, total: string) {
  if (document.length > 16 || total.length > 16) return null;
  if (!/^\d+$/.test(document) || !/^\d+$/.test(total)) return null;
  const documentMiB = Number(document),
    totalMiB = Number(total);
  return safe(documentMiB) &&
    safe(totalMiB) &&
    documentMiB >= 1 &&
    documentMiB <= MAX_LIMITS_MIB &&
    totalMiB >= documentMiB &&
    totalMiB <= MAX_LIMITS_MIB
    ? { documentMiB, totalMiB }
    : null;
}
const sameContext = (a: LimitsContext, b: LimitsContext) =>
  a.viewId === b.viewId && a.workspaceId === b.workspaceId;
const validContext = (context: LimitsContext) =>
  typeof context.viewId === "string" &&
  context.viewId.length > 0 &&
  context.viewId.length <= 128 &&
  (context.workspaceId === null ||
    (typeof context.workspaceId === "string" &&
      context.workspaceId.length > 0 &&
      context.workspaceId.length <= 128));
type LimitsView = {
  snapshot: LimitsSnapshot | null;
  document: string;
  total: string;
  editing: boolean;
  accepted: boolean;
  busy: boolean;
  uncertain: boolean;
  error: string | null;
  notice: "applied" | "current" | null;
};
const initial = (): LimitsView => ({
  snapshot: null,
  document: "5",
  total: "512",
  editing: false,
  accepted: false,
  busy: false,
  uncertain: false,
  error: null,
  notice: null,
});

// One finite session survives modal/category closure. Only explicit get can
// resolve an unknown set response; there is no queued or automatic set retry.
export class StorageLimitsSession {
  private view = initial();
  private context: LimitsContext = { workspaceId: null, viewId: "" };
  private epoch = 0;
  private pendingSet = false;
  private listeners = new Set<() => void>();
  constructor(private api: LimitsApi = storageLimitsApi) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.view;
  private set(patch: Partial<LimitsView>) {
    this.view = { ...this.view, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  matches(context: LimitsContext) {
    return sameContext(this.context, context);
  }
  bind(context: LimitsContext) {
    if (this.matches(context)) return;
    this.context = { ...context };
    this.epoch++;
    const uncertain = this.view.uncertain || this.pendingSet;
    this.set({
      ...initial(),
      busy: this.pendingSet,
      uncertain,
      error: uncertain || !validContext(context) ? "context_changed" : null,
    });
  }
  async load(preserveDraft = false, preserveError = false) {
    if (this.view.busy || this.pendingSet || !validContext(this.context)) return;
    const epoch = ++this.epoch;
    const context = { ...this.context };
    const showCurrentNotice = this.view.uncertain || this.view.snapshot !== null;
    this.set({ busy: true, notice: null, ...(preserveError ? {} : { error: null }) });
    try {
      const snapshot = limitsSnapshot(await responseDeadline(this.api.get(context)));
      if (epoch !== this.epoch) return;
      if (!snapshot) throw "invalid_response";
      this.set({
        snapshot,
        accepted: false,
        uncertain: false,
        notice: showCurrentNotice ? "current" : null,
        ...(!preserveDraft
          ? {
              document: String(snapshot.documentMiB),
              total: String(snapshot.totalMiB),
              editing: false,
              accepted: false,
            }
          : {}),
      });
    } catch (error) {
      if (epoch === this.epoch) this.set({ error: knownError(error) ?? "state_unavailable" });
    } finally {
      if (epoch === this.epoch) this.set({ busy: false });
    }
  }
  edit() {
    const snapshot = this.view.snapshot;
    if (!snapshot || this.view.busy || this.view.uncertain) return;
    this.set({
      editing: true,
      document: String(snapshot.documentMiB),
      total: String(snapshot.totalMiB),
      accepted: false,
      error: null,
      notice: null,
    });
  }
  change(field: "document" | "total", value: string) {
    if (!this.view.editing || this.view.busy || this.view.uncertain) return;
    if (value.length > 16) {
      this.set({ accepted: false, error: "limits_invalid" });
      return;
    }
    this.set({ [field]: value, accepted: false, error: null, notice: null });
  }
  accept(value: boolean) {
    if (this.view.editing && !this.view.busy && !this.view.uncertain) this.set({ accepted: value });
  }
  defaults() {
    if (this.view.editing && !this.view.busy && !this.view.uncertain)
      this.set({ document: "5", total: "512", accepted: false, error: null });
  }
  cancel() {
    const snapshot = this.view.snapshot;
    if (snapshot && !this.view.busy && !this.view.uncertain)
      this.set({
        document: String(snapshot.documentMiB),
        total: String(snapshot.totalMiB),
        editing: false,
        accepted: false,
        error: null,
      });
  }
  changed() {
    const values = parseLimits(this.view.document, this.view.total),
      snapshot = this.view.snapshot;
    return (
      !!values &&
      !!snapshot &&
      (values.documentMiB !== snapshot.documentMiB || values.totalMiB !== snapshot.totalMiB)
    );
  }
  belowUsage() {
    const values = parseLimits(this.view.document, this.view.total),
      snapshot = this.view.snapshot;
    return (
      !!values &&
      !!snapshot &&
      (values.totalMiB * MIB < snapshot.usageBytes ||
        values.documentMiB * MIB <
          Math.max(snapshot.largestDocumentBytes, snapshot.largestRecoveryDocumentBytes ?? 0))
    );
  }
  canApply() {
    return (
      this.view.editing &&
      !this.view.busy &&
      !this.view.uncertain &&
      this.view.snapshot !== null &&
      this.view.snapshot.revision < Number.MAX_SAFE_INTEGER &&
      this.view.snapshot.generation < Number.MAX_SAFE_INTEGER &&
      this.changed() &&
      !this.belowUsage() &&
      (!this.view.snapshot?.requiresCompatibilityAcknowledgement || this.view.accepted)
    );
  }
  async apply() {
    if (!this.canApply() || this.pendingSet || !validContext(this.context)) return;
    const values = parseLimits(this.view.document, this.view.total)!;
    const snapshot = this.view.snapshot!;
    const epoch = this.epoch;
    const request: LimitsRequest = {
      context: { ...this.context },
      expectedRevision: snapshot.revision,
      expectedGeneration: snapshot.generation,
      ...values,
      acknowledgeCompatibility: this.view.accepted,
    };
    this.pendingSet = true;
    this.set({ busy: true, error: null, notice: null });
    let refresh = false;
    try {
      const result = limitsSnapshot(await responseDeadline(this.api.set(request)));
      if (epoch !== this.epoch) {
        this.set({ uncertain: true, error: "context_changed" });
        return;
      }
      if (
        !result ||
        result.documentMiB !== values.documentMiB ||
        result.totalMiB !== values.totalMiB ||
        result.revision !== snapshot.revision + 1 ||
        result.generation !== snapshot.generation + 1
      )
        throw "invalid_response";
      this.set({
        snapshot: result,
        document: String(result.documentMiB),
        total: String(result.totalMiB),
        editing: false,
        accepted: false,
        uncertain: false,
        notice: "applied",
      });
    } catch (error) {
      if (epoch !== this.epoch) this.set({ uncertain: true, error: "context_changed" });
      else {
        const code = knownError(error);
        // Infrastructure/physical verification errors can occur after commit.
        const rejected =
          code !== null &&
          [
            "limits_invalid",
            "limits_changed",
            "limits_below_usage",
            "limits_compatibility_required",
            "context_changed",
            "main_host_required",
          ].includes(code);
        this.set({ uncertain: !rejected, error: code ?? "state_unavailable" });
        refresh = code === "limits_changed";
      }
    } finally {
      this.pendingSet = false;
      this.set({ busy: false });
    }
    if (refresh && epoch === this.epoch) await this.load(true, true);
  }
}
