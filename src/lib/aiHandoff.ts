export type AiDestination = "codexApp" | "claudeApp" | "codexCli" | "claudeCli";
export type AiHandoffContext =
  | { workspaceId: string; viewId: string; relativePath: string; target?: never }
  | { workspaceId: string; viewId: string; target: "root"; relativePath?: never };
export type AiHandoffPreview = {
  selectedPath: string;
  workingDirectory: string;
  revision: number;
  kind: "file" | "folder";
  guideInstruction?: string;
};
export type AiHandoffRequest = {
  context: AiHandoffContext;
  preview: AiHandoffPreview;
  instruction: string;
  destination: AiDestination;
  copy: boolean;
};
export interface AiHandoffApi {
  prepare(this: void, context: AiHandoffContext): Promise<AiHandoffPreview>;
  perform(this: void, request: AiHandoffRequest): Promise<void>;
}
export const aiDestinations: { value: AiDestination; label: string; hint: string }[] = [
  {
    value: "codexApp",
    label: "ChatGPT / Codex アプリ",
    hint: "未送信の下書きを開きます。登録済みの codex リンク対応アプリを使います。",
  },
  {
    value: "claudeApp",
    label: "Claude Code アプリ",
    hint: "未送信の下書きを開きます。作業フォルダーはClaude側でも確認されます。本文12,000文字まで。",
  },
  {
    value: "codexCli",
    label: "Codex CLI（コピー）",
    hint: "コピーのみです。codex を手動で起動し、依頼文を貼り付けて確認・送信してください。",
  },
  {
    value: "claudeCli",
    label: "Claude Code CLI",
    hint: "未送信の下書きをターミナルで開きます。確認後にEnterで送信します。本文5,000文字まで。初回の対話CLIで依頼文を送信した後にhandlerが登録されます。",
  },
];
export function aiInstruction(preview: AiHandoffPreview, instruction: string) {
  return preview.guideInstruction
    ? instruction
      ? instruction + "\n\n" + preview.guideInstruction
      : preview.guideInstruction
    : instruction;
}
export function aiDraft(preview: AiHandoffPreview, instruction: string) {
  instruction = aiInstruction(preview, instruction);
  if (preview.selectedPath === preview.workingDirectory) return instruction;
  return instruction ? preview.selectedPath + "\n\n" + instruction : preview.selectedPath;
}
export function aiDraftLimit(destination: AiDestination) {
  return destination === "claudeApp" ? 12_000 : destination === "claudeCli" ? 5_000 : 65_536;
}

// Only these exact Native diagnostics are safe to project into the UI. Unknown
// IPC failures may follow a completed copy, so do not assert an empty clipboard.
export function aiCopyFailureMessage(failure: unknown): string {
  const diagnostic =
    typeof failure === "string" ? failure : failure instanceof Error ? failure.message : null;
  switch (diagnostic) {
    case "パスをコピーできません":
      return "クリップボードにコピーできませんでした。入力した依頼文は保持しています。もう一度コピーしてください。";
    case "クリップボードを開けません。再試行してください":
      return "クリップボードを使用できませんでした。少し待ってから、もう一度コピーしてください。";
    case "このOSのクリップボード操作は未対応です":
      return "このOSでは依頼文のコピーに対応していません。";
    case "対象が変更されました。確認画面を開き直してください":
      return "対象が変更されました。入力した依頼文を控えてから、確認画面を開き直してください。";
    case "依頼文は65,536文字以内にし、不可視制御文字を除いてください":
      return "依頼文は65,536文字以内にし、不可視制御文字を除いてください。入力した依頼文は保持しています。";
    default:
      return "コピーの完了を確認できませんでした。入力した依頼文は保持しています。クリップボードの内容を確認し、必要ならもう一度コピーしてください。";
  }
}
