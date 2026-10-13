import { invoke } from "@tauri-apps/api/core";

export const ARTIFACT_MAX_BYTES = 5 * 1024 * 1024;
export type ArtifactFormat = "png" | "jpeg" | "csv" | "json" | "text";
export type ArtifactContext = {
  workspaceId: string;
  viewId: string;
  tabId: string;
  request: number;
  revision: number;
  token: string;
};
export type ArtifactProposal = { format: ArtifactFormat; name: string; data: string };
export type ArtifactReceipt =
  | { status: "saved"; name: string; bytes: number }
  | { status: "cancelled" };
export type ArtifactExportApi = (
  request: ArtifactProposal & { context: ArtifactContext },
) => Promise<ArtifactReceipt>;
export const artifactExportApi: ArtifactExportApi = (request) =>
  invoke("save_html_artifact", { request });

export function artifactProposal(value: Record<string, unknown>): ArtifactProposal | null {
  if (
    typeof value.format !== "string" ||
    !["png", "jpeg", "csv", "json", "text"].includes(value.format) ||
    typeof value.name !== "string" ||
    !value.name ||
    value.name.length > 1024 ||
    new TextEncoder().encode(value.name).length > 1024 ||
    typeof value.data !== "string" ||
    !value.data.length ||
    value.data.length > Math.ceil(ARTIFACT_MAX_BYTES / 3) * 4 ||
    value.data.length % 4 !== 0 ||
    /[^A-Za-z0-9+/]/.test(value.data.replace(/={1,2}$/, ""))
  )
    return null;
  const bytes = artifactBytes(value.data);
  if (!bytes || bytes > ARTIFACT_MAX_BYTES) return null;
  // Verify canonical padding bits before showing a proposal. Native repeats decoding/format checks.
  const end = value.data.endsWith("==") ? 3 : value.data.endsWith("=") ? 2 : 0;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (end && alphabet.indexOf(value.data.at(-end)!) & (end === 3 ? 15 : 3)) return null;
  return { format: value.format as ArtifactFormat, name: value.name, data: value.data };
}
export function artifactBytes(data: string) {
  return (data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
}
export function artifactError(error: unknown): string {
  const code = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  if (code === "ArtifactPublishedUnconfirmed" || code === "ArtifactResultUnknown")
    return "保存結果を確認できません。自動で再試行せず、選んだ保存先を確認してください。";
  if (code === "ArtifactSourceChanged")
    return "文書が変わったため保存できません。現在の文書から操作し直してください。";
  if (code === "ArtifactBusy" || code === "ArtifactCooldown")
    return "別の書き出し処理中、または操作間隔が短すぎます。少し待ってください。";
  return "ファイルを書き出せませんでした。形式、容量、名前、保存先を確認してください。ブラウザー保存には切り替えません。";
}
export function artifactErrorCode(error: unknown): string {
  const code = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  const known = [
    "ArtifactSourceChanged",
    "ArtifactBusy",
    "ArtifactCooldown",
    "ArtifactFormatInvalid",
    "ArtifactTooLargeOrInvalid",
    "ArtifactEncodingInvalid",
    "ArtifactNameInvalid",
    "ArtifactExtensionInvalid",
    "ArtifactDestinationInvalid",
    "ArtifactSaveFailed",
    "ArtifactPublishedUnconfirmed",
    "ArtifactResultUnknown",
    "ArtifactUnavailable",
  ];
  // After dispatch, an unknown transport failure cannot prove that no file was published.
  return known.includes(code) ? code : "ArtifactResultUnknown";
}
