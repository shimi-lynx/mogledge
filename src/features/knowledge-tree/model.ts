import type { TreeNode } from "../../lib/types";
export type Row = { node: TreeNode; depth: number };
export function displayedNodes(nodes: TreeNode[], folder: string): TreeNode[] {
  if (!folder) return nodes;
  for (const node of nodes) {
    if (node.kind !== "folder") continue;
    if (node.relativePath === folder) return node.children;
    if (folder.startsWith(node.relativePath + "/")) return displayedNodes(node.children, folder);
  }
  return [];
}
export function htmlNameParts(name: string): { basename: string; extension: string } {
  const extension = name.match(/\.html?$/i)?.[0] ?? "";
  return { basename: extension ? name.slice(0, -extension.length) : name, extension };
}
export function treeLabel(node: TreeNode): string {
  return node.kind === "html" ? htmlNameParts(node.name).basename || node.name : node.name;
}
export function renamedHtmlPath(source: string, name: string): string {
  const slash = source.lastIndexOf("/");
  const { extension } = htmlNameParts(source.slice(slash + 1));
  return source.slice(0, slash + 1) + name + extension;
}
export function visibleRows(nodes: TreeNode[], expanded: Set<string>, depth = 0): Row[] {
  const rows: Row[] = [];
  for (const node of nodes) {
    rows.push({ node, depth });
    if (node.kind === "folder" && expanded.has(node.relativePath))
      rows.push(...visibleRows(node.children, expanded, depth + 1));
  }
  return rows;
}
export function countDocuments(nodes: TreeNode[]): number {
  return nodes.reduce(
    (sum, node) => sum + (node.kind === "html" ? 1 : countDocuments(node.children)),
    0,
  );
}
