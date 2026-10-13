import type { TreeNode } from "../../lib/types";

export const QUICK_OPEN_LIMIT = 20;
export const QUICK_OPEN_QUERY_LIMIT = 256;

type Candidate = {
  relativePath: string;
  name: string;
  pathKey: string;
  nameKey: string;
  fileKey: string;
};
const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replaceAll("\\", "/");

export function quickOpenCandidates(nodes: TreeNode[]): Candidate[] {
  const candidates: Candidate[] = [];
  const visit = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      if (node.kind === "html")
        candidates.push({
          relativePath: node.relativePath,
          name: node.name,
          pathKey: normalize(node.relativePath),
          nameKey: normalize(node.name.replace(/\.html?$/i, "")),
          fileKey: normalize(node.name),
        });
      else visit(node.children);
    }
  };
  visit(nodes);
  return candidates;
}

export function matchQuickOpen(candidates: Candidate[], input: string) {
  const query = normalize(input.slice(0, QUICK_OPEN_QUERY_LIMIT).trim());
  if (query.length > QUICK_OPEN_QUERY_LIMIT) return { items: [], hasMore: false };
  // Bound retained results, including for an empty query. Scan metadata once;
  // never sort or mount every match, read HTML, or build a persistent index.
  const groups: Candidate[][] = [[], [], []];
  let count = 0;
  for (const candidate of candidates) {
    const { pathKey, nameKey, fileKey } = candidate;
    const rank =
      !query || nameKey === query || fileKey === query || pathKey === query
        ? 0
        : nameKey.startsWith(query) || fileKey.startsWith(query) || pathKey.startsWith(query)
          ? 1
          : nameKey.includes(query) || pathKey.includes(query)
            ? 2
            : -1;
    if (rank < 0) continue;
    count++;
    if (groups[rank].length < QUICK_OPEN_LIMIT) groups[rank].push(candidate);
  }
  return { items: groups.flat().slice(0, QUICK_OPEN_LIMIT), hasMore: count > QUICK_OPEN_LIMIT };
}
