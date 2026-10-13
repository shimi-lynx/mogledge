import { invoke } from "@tauri-apps/api/core";

export type HtmlAuthoringContext = { workspaceId: string; viewId: string; revision: number };
export type HtmlAuthoringStatus = {
  rootIdentity: string;
  enabled: boolean;
  preferenceHash: string | null;
  readOnly: boolean;
  guideAvailable: boolean;
  error: string | null;
};
export type HtmlAuthoringFile = {
  path: string;
  action: "create" | "current" | "conflict";
};
export type HtmlAuthoringPreview = {
  planId: string;
  kitVersion: number;
  files: HtmlAuthoringFile[];
  readOnly: boolean;
  error: string | null;
};
export type HtmlAuthoringResult = { written: string[]; skipped: string[]; error: string | null };
export interface HtmlAuthoringApi {
  status: (context: HtmlAuthoringContext) => Promise<HtmlAuthoringStatus>;
  preview: (context: HtmlAuthoringContext) => Promise<HtmlAuthoringPreview>;
  cancel: (context: HtmlAuthoringContext, planId: string) => Promise<void>;
  install: (context: HtmlAuthoringContext, planId: string) => Promise<HtmlAuthoringResult>;
  setEnabled: (
    context: HtmlAuthoringContext,
    preferenceHash: string | null,
    enabled: boolean,
  ) => Promise<HtmlAuthoringStatus>;
}
export const htmlAuthoringApi: HtmlAuthoringApi = {
  status: (context) => invoke("get_html_authoring_status", { context }),
  preview: (context) => invoke("preview_html_authoring_kit", { context }),
  cancel: (context, planId) => invoke("cancel_html_authoring_kit", { context, planId }),
  install: (context, planId) => invoke("install_html_authoring_kit", { context, planId }),
  setEnabled: (context, preferenceHash, enabled) =>
    invoke("set_html_authoring_enabled", { context, preferenceHash, enabled }),
};
