import { afterEach, expect, test, vi } from "vite-plus/test";
import { invoke } from "@tauri-apps/api/core";
import {
  limitsDiagnostic,
  limitsSnapshot,
  LIMITS_RESPONSE_DEADLINE_MS,
  MAX_LIMITS_MIB,
  MIB,
  parseLimits,
  StorageLimitsSession,
  storageLimitsApi,
  type LimitsApi,
  type LimitsSnapshot,
} from "./storageLimits";
import { limitsContext, limitsFixture, limitsFixtureApi } from "./storageLimits.test-fixtures";
import { translate } from "./i18n";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => vi.useRealTimers());
test("decimal editing retains the existing whole-MiB IPC fields", async () => {
  await storageLimitsApi.set({
    context: limitsContext,
    expectedRevision: 2,
    expectedGeneration: 7,
    documentMiB: 5,
    totalMiB: 512,
    acknowledgeCompatibility: true,
  });
  expect(invoke).toHaveBeenLastCalledWith("set_storage_limits", {
    request: {
      context: limitsContext,
      expectedRevision: 2,
      expectedGeneration: 7,
      documentMiB: 5,
      totalMiB: 512,
      acknowledgeCompatibility: true,
    },
  });
});
test("opening existing bytes and switching every decimal unit preserves exact values without writes", async () => {
  const api = limitsFixtureApi();
  api.get = vi.fn(async () => ({ ...limitsFixture }));
  const session = new StorageLimitsSession(api);
  session.bind(limitsContext);
  await session.load();
  session.edit();
  expect(session.getSnapshot().document).toBe("5.24288");
  for (const unit of ["B", "KB", "GB", "MB"] as const) {
    session.changeUnit("document", unit);
    session.changeUnit("total", unit);
    expect(session.changed()).toBe(false);
    await session.apply();
  }
  expect(session.getSnapshot().document).toBe("5.24288");
  expect(api.set).not.toHaveBeenCalled();
  session.change("document", "8.388608");
  session.accept(true);
  await session.apply();
  expect(api.set).toHaveBeenCalledWith(expect.objectContaining({ documentMiB: 8, totalMiB: 512 }));
  expect(session.getSnapshot().notice).toBe("applied");
});
async function prepared(api = limitsFixtureApi()) {
  const session = new StorageLimitsSession(api);
  session.bind(limitsContext);
  await session.load();
  session.edit();
  return session;
}
test("decimal capacities require exact whole-MiB values and reject invalid input without rounding", () => {
  for (const pair of [
    ["", "512"],
    ["NaN", "512"],
    ["Infinity", "512"],
    ["1.0000001", "512"],
    ["1e0", "512"],
    ["0", "512"],
    ["5", "4"],
    [String((MAX_LIMITS_MIB + 1) * MIB), String((MAX_LIMITS_MIB + 1) * MIB)],
    ["9007199254740992", "512"],
    ["1".repeat(100), "512"],
  ])
    expect(parseLimits(...(pair as [string, string]))).toBeNull();
  expect(parseLimits("1.048576", "1.048576")).toEqual({ documentMiB: 1, totalMiB: 1 });
  expect(parseLimits("1.5", "2")).toBeNull();
  expect(parseLimits("5.242881", "536.870912")).toBeNull();
  expect(parseLimits("8388.608", "1.073741824", "KB", "GB")).toEqual({
    documentMiB: 8,
    totalMiB: 1024,
  });
  expect(parseLimits("8.388608", "1073.741824")).toEqual({ documentMiB: 8, totalMiB: 1024 });
  expect(parseLimits(String(MAX_LIMITS_MIB * MIB), String(MAX_LIMITS_MIB * MIB), "B", "B")).toEqual(
    {
      documentMiB: MAX_LIMITS_MIB,
      totalMiB: MAX_LIMITS_MIB,
    },
  );
  expect(Number.isSafeInteger(MAX_LIMITS_MIB * MIB)).toBe(true);
  expect(Number.isSafeInteger((MAX_LIMITS_MIB + 1) * MIB)).toBe(false);
});
test("snapshot boundary rejects unsafe stats/shape and diagnostics never disclose unknown paths", () => {
  for (const bad of [
    { ...limitsFixture, usageBytes: NaN },
    { ...limitsFixture, generation: Infinity },
    { ...limitsFixture, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...limitsFixture, documentMiB: MAX_LIMITS_MIB + 1 },
    { ...limitsFixture, totalMiB: 1 },
    { ...limitsFixture, documentBytes: 1_500_001, totalBytes: 2_000_001 },
    { ...limitsFixture, documentBytes: 5 * MIB },
    { ...limitsFixture, usageBytes: -1 },
    { ...limitsFixture, recoveryBytes: 513 * MIB },
    { ...limitsFixture, privatePath: "/private/state.db" },
    { ...limitsFixture, capabilities: undefined },
    { ...limitsFixture, capabilities: { ...limitsFixture.capabilities, maximumDocumentBytes: 0 } },
    { ...limitsFixture, capabilities: { ...limitsFixture.capabilities, maximumRequestBytes: NaN } },
    {
      ...limitsFixture,
      capabilities: {
        ...limitsFixture.capabilities,
        maximumDatabaseBytes: Number.MAX_SAFE_INTEGER + 1,
      },
    },
    {
      ...limitsFixture,
      capabilities: { ...limitsFixture.capabilities, recoveryBudgetBytes: null },
    },
    {
      ...limitsFixture,
      capabilities: { ...limitsFixture.capabilities, privatePath: "/private/state.db" },
    },
    { ...limitsFixture, largestDocumentBytes: 81 },
    { ...limitsFixture, capabilities: { ...limitsFixture.capabilities, maximumDocumentBytes: 79 } },
  ])
    expect(limitsSnapshot(bad)).toBeNull();
  expect(
    limitsSnapshot({ ...limitsFixture, recoveryBytes: null, largestRecoveryDocumentBytes: null }),
  ).toBeTruthy();
  expect(
    limitsSnapshot({
      ...limitsFixture,
      documentMiB: MAX_LIMITS_MIB,
      totalMiB: MAX_LIMITS_MIB,
      usageBytes: 2048 * MIB,
      largestDocumentBytes: 9 * MIB,
    }),
  ).toBeTruthy();
  expect(limitsDiagnostic({ code: "/private/state.db" })).not.toContain("/private/");
  expect(limitsDiagnostic("constructor")).not.toContain("constructor");
});
test("large representable quotas can exceed runtime capacities while an existing format still requires acknowledgement", async () => {
  const api = limitsFixtureApi();
  api.get = vi.fn(async () => ({ ...limitsFixture, revision: 3 }));
  const session = await prepared(api);
  session.changeUnit("document", "B");
  session.changeUnit("total", "B");
  session.change("document", String(MAX_LIMITS_MIB * MIB));
  session.change("total", String(MAX_LIMITS_MIB * MIB));
  expect(session.canApply()).toBe(false);
  session.accept(true);
  expect(session.canApply()).toBe(true);
  await session.apply();
  expect(api.set).toHaveBeenCalledExactlyOnceWith({
    context: limitsContext,
    expectedRevision: 3,
    expectedGeneration: 7,
    documentMiB: MAX_LIMITS_MIB,
    totalMiB: MAX_LIMITS_MIB,
    acknowledgeCompatibility: true,
  });
  expect(session.getSnapshot()).toMatchObject({
    notice: "applied",
    snapshot: { documentMiB: MAX_LIMITS_MIB, totalMiB: MAX_LIMITS_MIB },
  });
});
test("no-root context is valid but editing/default/cancel/no-change never writes or creates configuration", async () => {
  const api = limitsFixtureApi(),
    session = await prepared(api);
  expect(api.get).toHaveBeenCalledWith(limitsContext);
  session.defaults();
  session.accept(true);
  await session.apply();
  expect(api.set).not.toHaveBeenCalled();
  session.change("document", "8.388608");
  session.accept(true);
  session.cancel();
  expect(session.getSnapshot().document).toBe("5.24288");
  expect(api.set).not.toHaveBeenCalled();
  session.bind({ ...limitsContext, viewId: "" });
  await session.load();
  expect(api.get).toHaveBeenCalledOnce();
});
test("explicit acknowledgement and one finite set apply immediately even when called twice", async () => {
  const api = limitsFixtureApi(),
    session = await prepared(api);
  session.change("document", "8.388608");
  await session.apply();
  expect(api.set).not.toHaveBeenCalled();
  session.accept(true);
  await Promise.all([session.apply(), session.apply()]);
  expect(api.set).toHaveBeenCalledExactlyOnceWith({
    context: limitsContext,
    expectedRevision: 0,
    expectedGeneration: 7,
    documentMiB: 8,
    totalMiB: 512,
    acknowledgeCompatibility: true,
  });
  expect(session.getSnapshot().snapshot?.documentMiB).toBe(8);
  expect(session.getSnapshot().notice).toBe("applied");
});
test("active and recovery floors reject lowering before dispatch", async () => {
  const api = limitsFixtureApi();
  api.get = vi.fn(async () => ({
    ...limitsFixture,
    usageBytes: 3 * MIB,
    largestDocumentBytes: 2 * MIB,
    recoveryBytes: 4 * MIB,
    largestRecoveryDocumentBytes: 3 * MIB,
  }));
  const session = await prepared(api);
  session.change("document", "2.097152");
  session.accept(true);
  expect(session.belowUsage()).toBe(true);
  await session.apply();
  session.change("document", "3.145728");
  session.change("total", "3.145728");
  session.accept(true);
  expect(session.canApply()).toBe(true);
  session.change("total", "2.097152");
  await session.apply();
  expect(api.set).not.toHaveBeenCalled();
});
test("usage/CAS conflict refreshes by get only and retains draft while resetting confirmation", async () => {
  const api = limitsFixtureApi(),
    session = await prepared(api);
  api.set = vi.fn(async () => {
    throw { code: "limits_changed" };
  });
  api.get = vi.fn(async () => ({ ...limitsFixture, generation: 8, usageBytes: 81 }));
  session.change("document", "8.388608");
  session.accept(true);
  await session.apply();
  expect(session.getSnapshot()).toMatchObject({
    document: "8.388608",
    accepted: false,
    uncertain: false,
    error: "limits_changed",
  });
  expect(api.get).toHaveBeenCalledOnce();
  expect(api.set).toHaveBeenCalledOnce();
});
test.each([
  "/private/transport.db",
  { code: "/private/state.db" },
  { code: "state_busy" },
  { code: "state_unavailable" },
  { code: "state_corrupt" },
  { code: "inspection_limit" },
  "invalid_response",
])("unknown/postcommit errors retain one outcome and never redispatch (%j)", async (error) => {
  const api = limitsFixtureApi(),
    session = await prepared(api);
  api.set = vi.fn(async () => {
    throw error;
  });
  session.change("document", "8.388608");
  session.accept(true);
  await session.apply();
  expect(session.getSnapshot().uncertain).toBe(true);
  expect(session.getSnapshot().error).not.toContain("/private/");
  await session.apply();
  expect(api.set).toHaveBeenCalledOnce();
  api.get = vi.fn(async () => ({
    ...limitsFixture,
    documentMiB: 8,
    revision: 1,
    generation: 8,
    requiresCompatibilityAcknowledgement: false,
  }));
  await session.load(true);
  expect(session.getSnapshot()).toMatchObject({
    uncertain: false,
    notice: "current",
    document: "8.388608",
  });
  expect(api.set).toHaveBeenCalledOnce();
});
test("invalid or wrong save responses are unknown and stale read/set responses cannot attach to another context", async () => {
  const api = limitsFixtureApi(),
    session = await prepared(api);
  api.set = vi.fn(async () => ({ ...limitsFixture, revision: 1, generation: 8 }));
  session.change("document", "8.388608");
  session.accept(true);
  await session.apply();
  expect(session.getSnapshot().uncertain).toBe(true);
  await session.load();
  session.edit();
  session.change("document", "8.388608");
  session.accept(true);
  let resolve!: (value: LimitsSnapshot) => void;
  api.set = vi.fn<LimitsApi["set"]>(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const pending = session.apply();
  session.bind({ workspaceId: "other", viewId: "new" });
  expect(session.getSnapshot().snapshot).toBeNull();
  expect(session.getSnapshot().busy).toBe(true);
  resolve({ ...limitsFixture, documentMiB: 8, revision: 1, generation: 8 });
  await pending;
  expect(session.getSnapshot()).toMatchObject({ snapshot: null, uncertain: true, busy: false });
  let reply!: (value: LimitsSnapshot) => void;
  api.get = vi.fn<LimitsApi["get"]>(
    () =>
      new Promise((r) => {
        reply = r;
      }),
  );
  const read = session.load();
  session.bind({ workspaceId: null, viewId: "newer" });
  reply(limitsFixture);
  await read;
  expect(session.getSnapshot().snapshot).toBeNull();
});
test("a never-resolved save has one deadline, preserves draft, and late replies cannot overwrite a fresh get", async () => {
  const api = limitsFixtureApi(),
    session = await prepared(api);
  vi.useFakeTimers();
  let reply!: (value: LimitsSnapshot) => void;
  api.set = vi.fn<LimitsApi["set"]>(
    () =>
      new Promise((resolve) => {
        reply = resolve;
      }),
  );
  session.change("document", "8.388608");
  session.accept(true);
  const save = session.apply();
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(LIMITS_RESPONSE_DEADLINE_MS);
  await save;
  expect(vi.getTimerCount()).toBe(0);
  expect(session.getSnapshot()).toMatchObject({
    document: "8.388608",
    editing: true,
    busy: false,
    uncertain: true,
    notice: null,
  });
  await session.apply();
  expect(api.set).toHaveBeenCalledOnce();
  api.get = vi.fn(async () => ({
    ...limitsFixture,
    documentMiB: 6,
    revision: 2,
    generation: 9,
    requiresCompatibilityAcknowledgement: false,
  }));
  await session.load(true);
  expect(session.getSnapshot()).toMatchObject({
    uncertain: false,
    document: "8.388608",
    notice: "current",
    snapshot: { documentMiB: 6, revision: 2 },
  });
  reply({ ...limitsFixture, documentMiB: 8, revision: 1, generation: 8 });
  await Promise.resolve();
  expect(session.getSnapshot()).toMatchObject({
    notice: "current",
    snapshot: { documentMiB: 6, revision: 2 },
  });
  expect(vi.getTimerCount()).toBe(0);
});
test("get deadlines leave unknown outcomes unresolved and never attach a late private or stale response", async () => {
  const api = limitsFixtureApi(),
    session = await prepared(api);
  api.set = vi.fn(async () => {
    throw "transport_failure";
  });
  session.change("document", "8.388608");
  session.accept(true);
  await session.apply();
  vi.useFakeTimers();
  let reply!: (value: LimitsSnapshot) => void;
  api.get = vi.fn<LimitsApi["get"]>(
    () =>
      new Promise((resolve) => {
        reply = resolve;
      }),
  );
  const read = session.load(true);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(LIMITS_RESPONSE_DEADLINE_MS);
  await read;
  expect(session.getSnapshot()).toMatchObject({
    busy: false,
    uncertain: true,
    error: "state_unavailable",
    document: "8.388608",
  });
  expect(vi.getTimerCount()).toBe(0);
  reply({ ...limitsFixture, documentMiB: 8, revision: 1, generation: 8 });
  await Promise.resolve();
  expect(session.getSnapshot()).toMatchObject({ uncertain: true, snapshot: { documentMiB: 5 } });
  expect(api.set).toHaveBeenCalledOnce();
});
test("later reads replace prior apply notices and failed reads cannot retain a success claim", async () => {
  const api = limitsFixtureApi(),
    session = await prepared(api);
  session.change("document", "8.388608");
  session.accept(true);
  await session.apply();
  expect(session.getSnapshot().notice).toBe("applied");
  api.get = vi.fn(async () => ({
    ...limitsFixture,
    documentMiB: 6,
    totalMiB: 600,
    revision: 2,
    generation: 9,
    requiresCompatibilityAcknowledgement: false,
  }));
  await session.load();
  expect(session.getSnapshot()).toMatchObject({
    notice: "current",
    document: "6.291456",
    total: "629.1456",
  });
  api.get = vi.fn(async () => {
    throw "/private/read.db";
  });
  await session.load();
  expect(session.getSnapshot()).toMatchObject({ notice: null, error: "state_unavailable" });
});
test.each(["capacity_exceeded", "resource_unavailable"])(
  "typed %s failures keep the quota draft and redact private causes without retrying",
  async (code) => {
    const api = limitsFixtureApi(),
      session = await prepared(api);
    api.set = vi.fn(async () => {
      throw { code, message: "/private/state.db secret payload" };
    });
    session.change("document", "9.437184");
    session.accept(true);
    await session.apply();
    expect(session.getSnapshot()).toMatchObject({
      error: code,
      uncertain: true,
      document: "9.437184",
      snapshot: { documentMiB: 5 },
    });
    const message = limitsDiagnostic({ code, message: "/private/state.db" });
    expect(message).toContain("既存の保存値と入力を保持します");
    expect(translate(message, "en")).toContain("Existing saved values and input are retained.");
    expect(message).not.toContain("/private/");
    expect(message).not.toContain("secret");
    expect(message).toContain(code === "capacity_exceeded" ? "容量制約" : "資源を確保できません");
    await session.apply();
    expect(api.set).toHaveBeenCalledOnce();
  },
);
