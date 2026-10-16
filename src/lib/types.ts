export type TreeNode = {
  relativePath: string;
  name: string;
  kind: "folder" | "html";
  children: TreeNode[];
};
export type ManagedFolder = {
  id: string;
  name: string;
  path: string;
  status: "ready" | "missing" | "incomplete";
  kitUpdate: "current" | "available" | "blocked";
  error: string | null;
};
export type ManagedFolders = {
  revision: string;
  folders: ManagedFolder[];
  selectedId: string | null;
};
export type DocumentIdentityStatus = {
  status: "ready" | "missing" | "invalid" | "duplicate";
  uuid: string | null;
  canAssign: boolean;
  canShare: boolean;
};
export type DocumentIdentityAction = "add" | "share" | "new";
export type StartupRecovery = {
  reason:
    | "confirmationRequired"
    | "storageIdentityConfirmationRequired"
    | "pathUnavailable"
    | "permissionDenied"
    | "syncUnavailable"
    | "unsupportedRoot"
    | "identityChanged"
    | "unavailable";
  canRetry: boolean;
};
export type Snapshot = {
  startupRecovery?: StartupRecovery;
  pathMoves?: PathMove[];
  workspaceId: string | null;
  // The registered root owns document identities, tabs and saved inputs.
  rootPath: string | null;
  // Display navigation never changes root-relative document paths or ownership.
  displayFolder?: WorkspaceDocument;
  displayRevision?: number;
  storageHold?: { reason: string };
  revision: number;
  nodes: TreeNode[];
  // Native snapshots pair completeness with nodes, independently of watcher/order warnings.
  treeComplete?: boolean;
  watchError: string | null;
  scanDurationMs?: number;
  viewId: string;
  documentOrigin?: string;
};
export type Change = {
  moves?: PathMove[];
  treeOnly?: boolean;
  workspaceId: string;
  revision: number;
  changedPaths: string[];
  structureChanged: boolean;
  watchError: string | null;
};
export type FileAction = "copyPath" | "openFolder" | "openBrowser";
export type RecoveryCandidate = {
  currentIdentity: string;
  sourceIdentity: string;
  sourceRevision: number;
  appCount: number;
};
export type PathMove = { from: string; to: string; revision: number };
export type TreeMutation =
  | { kind: "trash"; source: string; revision: number }
  | { kind: "createHtml"; parent: string; name: string }
  | { kind: "createFolder"; parent: string; name: string }
  | { kind: "renameHtml"; source: string; name: string }
  | { kind: "move"; source: string; parent: string; anchor?: string; after?: boolean }
  | { kind: "reorder"; source: string; anchor: string; after: boolean };
export type MutationResult = {
  snapshot: Snapshot;
  createdPath: string | null;
  moves: PathMove[];
  warning: string | null;
};
export type Column = 0 | 1;
export type DocumentSelection = {
  expectedIdentity?: string;
  relativePath: string;
  workspaceId: string;
  viewId: string;
  revision: number;
};
export type WorkspaceDocument = { relativePath: string; identity: string };
export type WorkspaceListEntry = WorkspaceDocument & {
  status: "available" | "missing" | "unavailable" | "replaced";
};
export type WorkspaceLists = {
  favorites: WorkspaceListEntry[];
  folderFavorites?: WorkspaceListEntry[];
  recent: WorkspaceListEntry[];
  error: string | null;
  readOnly: boolean;
};
export type WorkspaceSetItem = { document: WorkspaceDocument; column: Column; zoom: number };
export type WorkspaceSet = {
  id: string;
  name: string;
  items: WorkspaceSetItem[];
  active: [number | null, number | null];
  activeColumn: Column;
};
export type TabSession = {
  items: WorkspaceSetItem[];
  active: [number | null, number | null];
  activeColumn: Column;
  split: boolean;
  help?: { index: number; column: Column; zoom: number; active: boolean } | null;
};
export type WorkspaceSetShortcutSlot = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
export type WorkspaceSetShortcuts = [
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
];
export type WorkspaceSets = {
  sets: WorkspaceSet[];
  setShortcuts: WorkspaceSetShortcuts;
  error: string | null;
  readOnly: boolean;
};
export type WorkspaceCaptureItem = {
  tabId?: string;
  document?: WorkspaceDocument;
  column: Column;
  zoom: number;
};
export type ResolvedWorkspaceSet = {
  set: WorkspaceSet;
  items: (WorkspaceSetItem & { status: WorkspaceListEntry["status"]; reusableTabs: string[] })[];
};
export type ClosedTab = { path: string; column: Column };
export type DocumentZoomChange = "in" | "out" | "reset";
export type DocumentZoomGesture = { factor: number; x: number; y: number };
export type DocumentZoomInput = DocumentZoomChange | DocumentZoomGesture;
export type DocumentTab = {
  kind?: "help";
  deferred?: boolean;
  zoom?: number;
  zoomAnchor?: { x: number; y: number };
  zoomRequest?: number;
  navigation?: { fragment: string; request: number };
  id: string;
  column?: Column;
  path: string;
  url: string | null;
  loading: boolean;
  closing: boolean;
  dirty: boolean;
  missing: boolean;
  error: string | null;
  storageHold?: { reason: string };
};
export type AppState = {
  stateTransfer?: import("./stateTransfer").TransferView;
  navigationHistory?: [
    import("./navigationHistory").NavigationHistory,
    import("./navigationHistory").NavigationHistory,
  ];
  workspaceLists?: WorkspaceLists;
  workspaceSets?: WorkspaceSets;
  snapshot: Snapshot;
  tabs: DocumentTab[];
  columns: [string | null, string | null];
  activeColumn: Column;
  split: boolean;
  closed: ClosedTab[];
  selectedPath: string | null;
  documentUrl: string | null;
  loading: boolean;
  error: string | null;
  actionBusy: boolean;
  actionMessage: string | null;
};
export type DocumentLinkTarget =
  | { kind: "page"; fragment: string }
  | { kind: "document"; relativePath: string; fragment: string }
  | { kind: "external"; url: string };

export interface Bridge {
  chooseStateTransferFile?(
    this: void,
    context: import("./stateTransfer").TransferContext,
    kind: "import" | "export" | "backup",
  ): Promise<import("./stateTransfer").TransferFile | null>;
  prepareStateTransfer?(
    this: void,
    request: {
      context: import("./stateTransfer").TransferContext;
      relativePath: string;
      fileId: string;
      backupFileId: string | null;
      activeTabIds: string[];
    },
  ): Promise<import("./stateTransfer").TransferPreview>;
  confirmStateTransfer?(
    this: void,
    confirmation: {
      context: import("./stateTransfer").TransferContext;
      planId: string;
      confirmation: string;
      replaceConfirmation: string | null;
      stopReloadConfirmation: string | null;
    },
  ): Promise<import("./stateTransfer").TransferReceipt>;
  cancelStateTransfer?(
    this: void,
    context: import("./stateTransfer").TransferContext,
    planId: string,
  ): Promise<import("./stateTransfer").TransferVerification>;
  verifyStateTransfer?(
    this: void,
    request:
      | {
          kind: "operation";
          context: import("./stateTransfer").TransferContext;
          planId: string;
        }
      | {
          kind: "import";
          context: import("./stateTransfer").TransferContext;
          relativePath: string;
          documentIdentity: string;
          fileId: string;
        },
  ): Promise<import("./stateTransfer").TransferVerification>;
  validateDocumentNavigation?(
    this: void,
    workspaceId: string,
    viewId: string,
    relativePath: string,
    fragment: string,
    tabId?: string,
  ): Promise<WorkspaceDocument>;
  listenSessionFlush?(
    this: void,
    flush: () => Promise<boolean>,
    failed: () => void,
  ): Promise<() => void>;
  getTabSession?(this: void, workspaceId: string, viewId: string): Promise<TabSession | null>;
  captureTabSession?(
    this: void,
    workspaceId: string,
    viewId: string,
    items: WorkspaceCaptureItem[],
    active: [number | null, number | null],
    activeColumn: Column,
    split: boolean,
    help?: TabSession["help"],
  ): Promise<void>;
  getWorkspaceSets?(this: void, workspaceId: string, viewId: string): Promise<WorkspaceSets>;
  captureWorkspaceSet?(
    this: void,
    workspaceId: string,
    viewId: string,
    name: string,
    items: WorkspaceCaptureItem[],
    active: [number | null, number | null],
    activeColumn: Column,
  ): Promise<WorkspaceSets>;
  editWorkspaceSet?(
    this: void,
    workspaceId: string,
    viewId: string,
    id: string,
    name: string | null,
  ): Promise<WorkspaceSets>;
  resolveWorkspaceSet?(
    this: void,
    workspaceId: string,
    viewId: string,
    id: string,
    shortcutSlot?: WorkspaceSetShortcutSlot,
  ): Promise<ResolvedWorkspaceSet>;
  assignWorkspaceSetShortcut?(
    this: void,
    workspaceId: string,
    viewId: string,
    id: string,
    slot: WorkspaceSetShortcutSlot | null,
  ): Promise<WorkspaceSets>;
  getWorkspaceLists?(
    this: void,
    workspaceId: string,
    viewId: string,
    resolveMoves: boolean,
  ): Promise<WorkspaceLists>;
  setDocumentFavorite?(
    this: void,
    workspaceId: string,
    viewId: string,
    relativePath: string,
    add: boolean,
  ): Promise<WorkspaceLists>;
  validateWorkspaceDocument?(
    this: void,
    workspaceId: string,
    viewId: string,
    document: WorkspaceDocument,
    tabId?: string,
  ): Promise<string>;
  validateWorkspaceFolder?(
    this: void,
    workspaceId: string,
    viewId: string,
    folder: WorkspaceDocument,
  ): Promise<string>;
  recordDocumentDisplay?(
    this: void,
    workspaceId: string,
    viewId: string,
    tabId: string,
    sourceUrl: string,
  ): Promise<void>;
  resolveDocumentLink?(
    this: void,
    workspaceId: string,
    viewId: string,
    sourceUrl: string,
    href: string,
  ): Promise<DocumentLinkTarget>;
  openExternalDocumentLink?(
    this: void,
    workspaceId: string,
    viewId: string,
    sourceUrl: string,
    href: string,
  ): Promise<void>;
  getDocumentStateRecovery?(
    this: void,
    workspaceId: string,
    viewId: string,
    relativePath: string,
  ): Promise<RecoveryCandidate | null>;
  getDocumentStorageHold?(
    this: void,
    workspaceId: string,
    viewId: string,
    tabId: string,
    requestId: number,
  ): Promise<{ reason: string } | null>;
  recoverDocumentState?(
    this: void,
    workspaceId: string,
    viewId: string,
    relativePath: string,
    candidate: RecoveryCandidate,
  ): Promise<void>;
  mutateTree(
    this: void,
    workspaceId: string,
    viewId: string,
    mutation: TreeMutation,
  ): Promise<MutationResult>;
  performFileAction(
    this: void,
    workspaceId: string,
    viewId: string,
    relativePath: string,
    action: FileAction,
  ): Promise<void>;
  beginView(this: void): Promise<Snapshot>;
  getTree(this: void): Promise<Snapshot>;
  chooseRoot(this: void): Promise<Snapshot | null>;
  getManagedFolders?(this: void): Promise<ManagedFolders>;
  createManagedFolder?(
    this: void,
    name: string,
    expectedRevision: string,
  ): Promise<ManagedFolders | null>;
  registerManagedFolder?(this: void, expectedRevision: string): Promise<ManagedFolders | null>;
  selectManagedFolder?(this: void, id: string, expectedRevision: string): Promise<Snapshot>;
  unregisterManagedFolder?(
    this: void,
    id: string,
    expectedRevision: string,
  ): Promise<ManagedFolders>;
  getDocumentIdentityStatus?(
    this: void,
    workspaceId: string,
    viewId: string,
    relativePath: string,
  ): Promise<DocumentIdentityStatus>;
  configureDocumentIdentity?(
    this: void,
    workspaceId: string,
    viewId: string,
    relativePath: string,
    action: DocumentIdentityAction,
  ): Promise<void>;
  chooseDisplayFolder?(this: void, workspaceId: string, viewId: string): Promise<Snapshot | null>;
  setDisplayFolder?(
    this: void,
    workspaceId: string,
    viewId: string,
    relativePath: string,
    expectedDisplayRevision: number,
  ): Promise<Snapshot>;
  refresh(this: void): Promise<Snapshot>;
  retrySavedRoot?(this: void, viewId: string): Promise<Snapshot>;
  createTab(
    this: void,
    workspaceId: string,
    viewId: string,
    relativePath: string,
    expectedIdentity?: string,
  ): Promise<string>;
  closeTab(this: void, workspaceId: string, viewId: string, tabId: string): Promise<void>;
  openDocument(
    this: void,
    workspaceId: string,
    viewId: string,
    tabId: string,
    requestId: number,
  ): Promise<string>;
  listen(this: void, callback: (change: Change) => void): Promise<() => void>;
}
