export interface IndexStatus {
  workspaceId: string;
  rootId: string;
  phase: "pending" | "building" | "ready" | "failed";
  generation: number;
  requestRevision: number;
  indexed: number;
  pending: number;
  unavailable: number;
  failed: number;
  truncated: number;
  databaseBytes: number;
  complete: boolean;
  limited: boolean;
  rebuilt: boolean;
  error: string | null;
}

export type SearchMode = "and" | "or";

export interface FolderSearchScope {
  relativePath: string;
  viewId: string;
}

export interface MatchRange {
  // Half-open Unicode scalar offsets from the native normalization mapper.
  start: number;
  end: number;
}

export interface SearchHit {
  documentId: string;
  relativePath: string;
  title: string;
  snippet: string;
  titleMatches: MatchRange[];
  snippetMatches: MatchRange[];
  truncated: boolean;
}

export interface SearchPage {
  generation: number;
  requestRevision: number;
  hits: SearchHit[];
  hasMore: boolean;
  normalizedQuery: string;
}

export interface SearchBridge {
  getStatus(workspaceId: string): Promise<IndexStatus>;
  search(
    workspaceId: string,
    query: string,
    limit: number,
    offset: number,
    mode?: SearchMode,
    scope?: FolderSearchScope,
  ): Promise<SearchPage>;
  rebuild(workspaceId: string): Promise<IndexStatus>;
}
