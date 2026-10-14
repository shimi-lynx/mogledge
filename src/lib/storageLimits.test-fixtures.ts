import { vi } from "vite-plus/test";
import type { LimitsApi, LimitsSnapshot } from "./storageLimits";
export const limitsContext = { workspaceId: null, viewId: "view" };
export const limitsFixture: LimitsSnapshot = {
  documentMiB: 5,
  totalMiB: 512,
  revision: 0,
  generation: 7,
  usageBytes: 80,
  largestDocumentBytes: 80,
  recoveryBytes: 20,
  largestRecoveryDocumentBytes: 20,
  requiresCompatibilityAcknowledgement: true,
  capabilities: {
    maximumDocumentBytes: 1_000_000_000,
    maximumRequestBytes: 1_000_001_024,
    maximumDatabaseBytes: 17_592_186_036_224,
    recoveryBudgetBytes: 512 * 1024 * 1024,
  },
};
export function limitsFixtureApi(): LimitsApi {
  return {
    get: vi.fn<LimitsApi["get"]>(async () => ({ ...limitsFixture })),
    set: vi.fn<LimitsApi["set"]>(async (request) => ({
      ...limitsFixture,
      documentMiB: Math.floor(request.documentMiB),
      documentBytes: request.documentMiB * 1048576,
      totalMiB: Math.floor(request.totalMiB),
      totalBytes: request.totalMiB * 1048576,
      revision: request.expectedRevision + 1,
      generation: request.expectedGeneration + 1,
      requiresCompatibilityAcknowledgement: false,
    })),
  };
}
