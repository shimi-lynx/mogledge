import { vi } from "vite-plus/test";
import type {
  ManagementApi,
  ManagementPage,
  SavedEntry,
  ManagementPlan,
  ManagementReceipt,
} from "./stateManagement";
export const context = { workspaceId: "root", viewId: "view" };
export const page: ManagementPage<SavedEntry> = {
  snapshotId: "snapshot",
  databaseSchemaVersion: 2,
  usage: {
    logicalBytes: 100,
    records: 2,
    recoveryLogicalBytes: 20,
    recoveryRecords: 1,
    databaseBytes: 8192,
    journalBytes: 0,
    freeDatabasePageBytes: 4096,
  },
  entries: [
    {
      documentIdentity: "a".repeat(64),
      rootIdentity: "b".repeat(64),
      relativePath: "日本語 <img onerror=fail> ${path}.html",
      logicalBytes: 80,
      revision: 4,
      sourceAvailability: "same_identity_present",
      lastViewedAt: null,
      eligible: true,
      holdReason: null,
    },
    {
      documentIdentity: "c".repeat(64),
      rootIdentity: "b".repeat(64),
      relativePath: null,
      logicalBytes: 20,
      revision: 1,
      sourceAvailability: "unavailable",
      lastViewedAt: null,
      eligible: false,
      holdReason: "unavailable",
    },
  ],
  offset: 0,
  limit: 20,
  hasMore: false,
};
export const plan: ManagementPlan = {
  planId: "plan",
  operation: "quarantine",
  snapshotId: "snapshot",
  candidateId: "a".repeat(64),
  documentIdentity: "a".repeat(64),
  relativePath: page.entries[0].relativePath,
  logicalBytes: 80,
  appCount: 2,
  canConfirm: true,
  blockedReason: null,
  expiresInMs: 300000,
};
export const receipt: ManagementReceipt = {
  operationId: "plan",
  operation: "quarantine",
  documentIdentity: "a".repeat(64),
  recoveryId: "plan",
  recoverable: true,
  permanentDeletion: false,
};
export function fixtureApi(): ManagementApi {
  return {
    list: vi.fn(async () => structuredClone(page)),
    recoveryList: vi.fn(async () => ({ ...structuredClone(page), entries: [] })),
    prepare: vi.fn(async () => ({ ...plan })),
    confirm: vi.fn(async () => ({ ...receipt })),
    cancel: vi.fn<ManagementApi["cancel"]>(async () => ({
      status: "cancelled",
      verifyRequired: true,
    })),
    verify: vi.fn<ManagementApi["verify"]>(async () => ({
      status: "completed",
      receipt: { ...receipt },
    })),
  };
}
