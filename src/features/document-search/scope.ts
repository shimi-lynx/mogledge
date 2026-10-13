import type { Snapshot } from "../../lib/types";
import type { FolderSearchScope } from "./types";

export interface SelectedSearchScope extends FolderSearchScope {
  workspaceId: string;
  revision: number;
}

export function reconcileSearchScope(
  scope: SelectedSearchScope | null,
  snapshot: Snapshot,
): SelectedSearchScope | null {
  if (!scope || scope.workspaceId !== snapshot.workspaceId || scope.viewId !== snapshot.viewId)
    return null;
  const relativePath = (snapshot.pathMoves ?? [])
    .filter((move) => move.revision > scope.revision)
    .reduce(
      (path, move) =>
        path === move.from
          ? move.to
          : path.startsWith(move.from + "/")
            ? move.to + path.slice(move.from.length)
            : path,
      scope.relativePath,
    );
  const parts = relativePath.split("/");
  let nodes = snapshot.nodes;
  for (const [index, part] of parts.entries()) {
    const node = nodes.find((candidate) => candidate.name === part && candidate.kind === "folder");
    if (!node || (index === parts.length - 1 && node.relativePath !== relativePath)) return null;
    nodes = node.children;
  }
  if (scope.relativePath === relativePath && scope.revision === snapshot.revision) return scope;
  return { ...scope, relativePath, revision: snapshot.revision };
}
