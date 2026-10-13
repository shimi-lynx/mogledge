import { expect, test, vi } from "vite-plus/test";
import {
  ManagementSession,
  managementError,
  managementMessages,
  type ManagementApi,
  type ManagementPlan,
} from "./stateManagement";
import { translate } from "./i18n";
import { context, fixtureApi, page, plan, receipt } from "./stateManagement.test-fixtures";
async function selected(api: ManagementApi) {
  const session = new ManagementSession(api);
  session.bind(context);
  await session.load();
  session.select(plan.candidateId);
  return session;
}
test("inspection has no default selection or mutation and enforces bounded pages", async () => {
  const api = fixtureApi();
  const session = await selected(api);
  expect(api.list).toHaveBeenCalledWith({ context, offset: 0, limit: 20, snapshotId: null });
  expect(api.prepare).not.toHaveBeenCalled();
  await session.load();
  expect(session.getSnapshot().selected).toBeNull();
  session.select(page.entries[1].documentIdentity);
  expect(session.getSnapshot().selected).toBeNull();
  api.list = vi.fn(async () => ({
    ...page,
    entries: Array.from({ length: 21 }, () => page.entries[0]),
  }));
  await session.load();
  expect(session.getSnapshot().page).toBeNull();
  expect(session.getSnapshot().error).toBe("response_mismatch");
});
test("lost confirmation cannot retry; cancellation wake-up requires verification", async () => {
  const api = fixtureApi();
  api.confirm = vi.fn(async () => {
    throw "lost-response";
  });
  const session = await selected(api);
  await session.prepare("quarantine");
  await session.confirm();
  expect(session.getSnapshot().phase).toBe("unknown");
  await session.confirm();
  expect(api.confirm).toHaveBeenCalledOnce();
  await session.cancel();
  expect(session.getSnapshot().phase).toBe("unknown");
  await session.verify();
  expect(session.getSnapshot().phase).toBe("completed");
  expect(api.confirm).toHaveBeenCalledOnce();
});
test("a mismatched commit receipt remains unknown and cannot be confirmed again", async () => {
  const api = fixtureApi();
  api.confirm = vi.fn(async () => ({ ...receipt, documentIdentity: "other" }));
  const session = await selected(api);
  await session.prepare("quarantine");
  await session.confirm();
  expect(session.getSnapshot().phase).toBe("unknown");
  await session.confirm();
  expect(api.confirm).toHaveBeenCalledOnce();
});
test("a root change cannot reuse selection or an in-flight preview", async () => {
  const api = fixtureApi();
  let reply!: (value: ManagementPlan) => void;
  api.prepare = vi.fn(
    () =>
      new Promise<ManagementPlan>((resolve) => {
        reply = resolve;
      }),
  );
  const session = await selected(api);
  const pending = session.prepare("quarantine");
  session.bind({ workspaceId: "other", viewId: "new-view" });
  reply(plan);
  await pending;
  expect(session.getSnapshot().selected).toBeNull();
  expect(session.getSnapshot().plan).toBeNull();
  expect(api.cancel).toHaveBeenCalledWith(context, plan.planId);
  expect(api.confirm).not.toHaveBeenCalled();
});
test("an already prepared preview is bound to its original view", async () => {
  const api = fixtureApi();
  const session = await selected(api);
  await session.prepare("quarantine");
  session.bind({ ...context, viewId: "new-view" });
  await session.confirm();
  expect(api.confirm).not.toHaveBeenCalled();
  expect(session.isCurrentPlan()).toBe(false);
});
test("read and prepare failures do not execute a mutation", async () => {
  const api = fixtureApi();
  api.prepare = vi.fn(async () => {
    throw { code: "restore_conflict" };
  });
  const session = await selected(api);
  await session.prepare("quarantine");
  expect(session.getSnapshot().error).toBe("restore_conflict");
  await session.confirm();
  expect(api.confirm).not.toHaveBeenCalled();
});
test.each(["capacity_exceeded", "resource_unavailable"])(
  "typed %s management errors retain the original page and cannot retry an unknown confirmation",
  async (code) => {
    const api = fixtureApi(),
      session = await selected(api);
    await session.prepare("quarantine");
    const originalPage = session.getSnapshot().page;
    api.confirm = vi.fn(async () => {
      throw { code, message: "/private/profile/state.db secret payload" };
    });
    await session.confirm();
    expect(session.getSnapshot()).toMatchObject({ phase: "unknown", error: code });
    expect(session.getSnapshot().page).toBe(originalPage);
    expect(managementError({ code, message: "/private/profile/state.db" })).toBe(code);
    expect(managementError({ code: "/private/profile/state.db" })).toBe("saved_state_unavailable");
    const message = managementMessages[code];
    expect(message).not.toContain("/private/");
    expect(message).toContain("既存の保存値と入力を保持します");
    expect(translate(message, "en")).toContain("Existing saved values and input are retained.");
    await session.confirm();
    expect(api.confirm).toHaveBeenCalledOnce();
  },
);
