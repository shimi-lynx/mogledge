import { invoke } from "@tauri-apps/api/core";

export type RootAction = "copyPath" | "openFolder";
export type RootActionContext = { workspaceId: string; viewId: string; target: "root" };

export const rootActionsApi = {
  perform: (context: RootActionContext, action: RootAction): Promise<void> =>
    invoke("perform_root_action", { context, action }),
};
