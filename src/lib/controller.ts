import { rootActionsApi, type RootAction } from "./rootActions";
import type { ArtifactContext } from "./artifactExport";
import { StateTransfer } from "./stateTransfer";
import type { ResidentSelection } from "./resident";
import {
  createNavigationHistory,
  recordNavigation,
  prepareNavigation,
  commitNavigation,
  failNavigation,
  cancelNavigation,
  remapNavigationPaths,
  type NavigationHistory,
  type NavigationRequest,
} from "./navigationHistory";
export type ReloadReason = "background" | "user-reload" | "input-transfer" | "history";
type HistoryFlight = {
  ticket: NavigationRequest;
  column: Column;
  workspace: string;
  view: string;
  revision: number;
  tabId?: string;
  owned?: boolean;
  url?: string;
  anchorRequest?: number;
  anchorResult?: boolean;
  timeout?: ReturnType<typeof setTimeout>;
};
import type {
  AppState,
  Bridge,
  ManagedFolders,
  Snapshot,
  TreeNode,
  Change,
  DocumentTab,
  Column,
  FileAction,
  PathMove,
  TreeMutation,
  RecoveryCandidate,
  DocumentLinkTarget,
  DocumentZoomInput,
  DocumentSelection,
  WorkspaceDocument,
  WorkspaceCaptureItem,
  WorkspaceSets,
  WorkspaceSetShortcutSlot,
} from "./types";

export function contains(nodes: TreeNode[], path: string, includeFolders = false): boolean {
  return nodes.some(
    (node) =>
      ((includeFolders || node.kind === "html") && node.relativePath === path) ||
      contains(node.children, path, includeFolders),
  );
}
const empty: Snapshot = {
  workspaceId: null,
  viewId: "",
  rootPath: null,
  revision: 0,
  nodes: [],
  watchError: null,
};
// StrictMode effect restarts serialize view ownership handshakes. A stale handshake
// finishes before the next one, so it cannot revoke a newer renderer's tabs.
let beginQueue: Promise<unknown> = Promise.resolve();
let nextTab = 0;
type TabRequest = {
  workspace: string;
  view: string;
  native: Promise<string>;
  registered: boolean;
  nativeId?: string;
  lazyDocument?: WorkspaceDocument;
  sessionAdmitted?: boolean;
  request: number;
  closing: boolean;
  registrationFailed: boolean;
  registrationPath: string;
  changeRevision?: number;
  readyUrl?: string;
  visitPending?: boolean;
  historyVisit?: boolean;
  displayFragment?: string;
  confirmedNavigation?: DocumentTab["navigation"];
  userAnchor?: { request: number; fragment: string; success?: boolean };
  expectedIdentity?: string;
};
const workspaceStatusLabels = {
  missing: "見つかりません",
  replaced: "別の文書に置き換わっています",
  unavailable: "一時的に読み取れません",
};
const staleErrors = new Set(["Superseded", "WorkspaceChanged", "ViewChanged", "TabClosed"]);

export class KnowledgeController {
  private transfer?: StateTransfer;
  private histories: [NavigationHistory, NavigationHistory] = [
    createNavigationHistory(),
    createNavigationHistory(),
  ];
  private historyFlights: [HistoryFlight | null, HistoryFlight | null] = [null, null];
  private linkNavigation = 0;
  private state: AppState = {
    snapshot: empty,
    tabs: [],
    columns: [null, null],
    activeColumn: 0,
    split: false,
    closed: [],
    selectedPath: null,
    documentUrl: null,
    loading: true,
    error: null,
    actionBusy: false,
    actionMessage: null,
  };
  private requests = new Map<string, TabRequest>();
  private subscribers = new Set<() => void>();
  private unlisten?: () => void;
  private syncGeneration = 0;
  private stopped = false;
  private lifecycle = 0;
  private workspaceGeneration = 0;
  private actionGeneration = 0;
  private moveRevision = 0;
  private moveReloads = new Set<number>();
  private listGeneration = 0;
  private listRefreshPromise: Promise<void> | null = null;
  private listRefreshQueued = false;
  private listRefreshResolveMoves = false;
  private setReadGeneration = 0;
  private listSelectionGeneration = 0;
  // When an empty left column collapses, reopening its tab must leave the
  // surviving documents on the right when restoring the original layout.
  private collapsedColumn: Column = 0;
  private sessionReady = false;
  private sessionGeneration = 0;
  private sessionFingerprint = "";
  private sessionQueued = false;
  private sessionWriting = false;
  private sessionTimer?: ReturnType<typeof setTimeout>;
  private sessionFlushes = 0;
  private sessionFlight: Promise<void> | null = null;
  private sessionRestoreFlight: Promise<void> | null = null;
  private sessionUnlisten?: () => void;
  private savedRootRetryPending = false;
  constructor(private api: Bridge) {}
  // Only main derives Native IDs/request/revision; opaque HTML supplies none of them.
  artifactContext(id: string, url: string): ArtifactContext | null {
    const tab = this.state.tabs.find((item) => item.id === id);
    const record = this.requests.get(id);
    const snapshot = this.state.snapshot;
    if (
      this.stopped ||
      this.state.loading ||
      this.state.actionBusy ||
      !snapshot.workspaceId ||
      !tab ||
      tab.kind === "help" ||
      tab.missing ||
      tab.loading ||
      tab.deferred ||
      tab.closing ||
      tab.url !== url ||
      !this.visible(id) ||
      !record?.nativeId ||
      record.closing ||
      record.registrationFailed ||
      record.workspace !== snapshot.workspaceId ||
      record.view !== snapshot.viewId
    )
      return null;
    let token: string | undefined;
    try {
      token = new URL(url).pathname.match(/^\/s\/([a-f0-9]{64})\//)?.[1];
    } catch {
      return null;
    }
    if (!token) return null;
    return {
      workspaceId: snapshot.workspaceId,
      viewId: snapshot.viewId,
      tabId: record.nativeId,
      request: record.request,
      revision: snapshot.revision,
      token,
    };
  }
  getSnapshot = () => this.state;
  subscribe = (callback: () => void) => {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  };
  private set(value: Partial<AppState>) {
    if (this.stopped) return;
    if (
      (value.snapshot && value.snapshot.revision !== this.state.snapshot.revision) ||
      value.actionBusy === true
    )
      this.cancelHistory();
    const next = { ...this.state, ...value, navigationHistory: this.histories };
    const active = next.tabs.find((tab) => tab.id === next.columns[next.activeColumn]);
    this.state = {
      ...next,
      selectedPath: active?.kind === "help" ? null : (active?.path ?? null),
      documentUrl: active?.url ?? null,
    };
    this.subscribers.forEach((callback) => callback());
    this.queueTabSession();
  }
  private updateTab(id: string, value: Partial<DocumentTab>) {
    this.set({ tabs: this.state.tabs.map((tab) => (tab.id === id ? { ...tab, ...value } : tab)) });
  }
  private async release(record: TabRequest) {
    // Registration failure cannot have issued a document grant. Allow the error
    // placeholder to close, while still surfacing failures to revoke a live tab.
    if (!record.registered) return;
    const native = await record.native.catch(() => null);
    if (native === null) return;
    try {
      await this.api.closeTab(record.workspace, record.view, native);
    } catch (error) {
      if (!staleErrors.has(String(error))) throw error;
    }
  }
  async start() {
    this.stopped = false;
    const lifecycle = ++this.lifecycle;
    this.set({ loading: true });
    try {
      const unlisten = await this.api.listen((change) => {
        void this.onChange(change);
      });
      if (this.stopped || lifecycle !== this.lifecycle) {
        unlisten();
        return;
      }
      this.unlisten = unlisten;
      if (this.api.listenSessionFlush) {
        const sessionUnlisten = await this.api.listenSessionFlush(
          () => this.flushTabSession(),
          () => {
            this.set({ error: "タブの状態を保存できません: TabSessionSaveFailed" });
          },
        );
        if (this.stopped || lifecycle !== this.lifecycle) {
          sessionUnlisten();
          return;
        }
        this.sessionUnlisten = sessionUnlisten;
      }
      const begin = beginQueue.catch(() => {}).then(() => this.api.beginView());
      beginQueue = begin;
      const snapshot = await begin;
      if (this.stopped || lifecycle !== this.lifecycle) return;
      this.acceptSnapshot(snapshot);
    } catch (error) {
      if (lifecycle === this.lifecycle) this.set({ error: String(error) });
    } finally {
      if (lifecycle === this.lifecycle) this.set({ loading: false });
    }
  }
  stop() {
    this.savedRootRetryPending = false;
    this.sessionReady = false;
    this.sessionGeneration++;
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    this.sessionTimer = undefined;
    this.transfer?.invalidate();
    this.transfer = undefined;
    this.cancelWorkspaceSelection();
    this.listGeneration++;
    this.stopped = true;
    this.lifecycle++;
    this.workspaceGeneration++;
    this.actionGeneration++;
    this.syncGeneration++;
    this.unlisten?.();
    this.unlisten = undefined;
    this.sessionUnlisten?.();
    this.sessionUnlisten = undefined;
    for (const record of this.requests.values()) {
      record.closing = true;
      void this.release(record).catch(() => {});
    }
    this.requests.clear();
    this.histories = [createNavigationHistory(), createNavigationHistory()];
    this.state = {
      ...this.state,
      tabs: [],
      columns: [null, null],
      activeColumn: 0,
      split: false,
      closed: [],
      navigationHistory: this.histories,
      selectedPath: null,
      documentUrl: null,
      actionBusy: false,
      stateTransfer: undefined,
      actionMessage: null,
    };
  }
  private acceptSnapshot(snapshot: Snapshot) {
    const current = this.state.snapshot;
    const same = snapshot.workspaceId === current.workspaceId && snapshot.viewId === current.viewId;
    if (!same) {
      this.sessionReady = false;
      this.sessionGeneration++;
      if (this.sessionTimer) clearTimeout(this.sessionTimer);
      this.sessionTimer = undefined;
      this.sessionFingerprint = "";
      const help = this.state.tabs.find((tab) => tab.kind === "help");
      this.transfer?.invalidate();
      this.transfer = undefined;
      this.cancelWorkspaceSelection();
      this.listGeneration++;
      this.histories = [createNavigationHistory(), createNavigationHistory()];
      this.collapsedColumn = 0;
      this.moveReloads.clear();
      this.moveRevision = snapshot.revision;
      this.actionGeneration++;
      for (const record of this.requests.values()) {
        record.closing = true;
        void this.release(record).catch(() => {});
      }
      this.requests.clear();
      this.set({
        snapshot,
        stateTransfer: undefined,
        workspaceLists: undefined,
        workspaceSets: undefined,
        tabs: help ? [{ ...help, column: 0 }] : [],
        columns: [help?.id ?? null, null],
        activeColumn: 0,
        split: false,
        closed: [],
        actionBusy: false,
        actionMessage: null,
        error: null,
      });
      void this.refreshWorkspaceLists();
      void this.refreshWorkspaceSets();
      const restore = this.restoreTabSession(snapshot);
      this.sessionRestoreFlight = restore;
      void restore.finally(() => {
        if (this.sessionRestoreFlight === restore) this.sessionRestoreFlight = null;
      });
      return;
    }
    // Display scope has an independent ordering: neither a delayed tree read nor
    // an old selection may reverse a newer display change or physical fallback.
    const newerDisplay = (snapshot.displayRevision ?? 0) > (current.displayRevision ?? 0);
    if ((snapshot.displayRevision ?? 0) < (current.displayRevision ?? 0))
      snapshot = {
        ...snapshot,
        displayFolder: current.displayFolder,
        displayRevision: current.displayRevision,
      };
    if (snapshot.revision < current.revision) {
      if (newerDisplay)
        this.set({
          snapshot: {
            ...current,
            displayFolder: snapshot.displayFolder,
            displayRevision: snapshot.displayRevision,
          },
        });
      return;
    }
    this.applyMoves(snapshot.pathMoves ?? []);
    this.cancelHistory();
    this.histories = this.histories.map((history) =>
      remapNavigationPaths(history, (path) => (contains(snapshot.nodes, path) ? path : null)),
    ) as [NavigationHistory, NavigationHistory];
    const tabs = this.state.tabs.map((tab) => {
      if (tab.kind === "help" || contains(snapshot.nodes, tab.path)) return tab;
      const record = this.requests.get(tab.id);
      if (record) record.request++;
      return {
        ...tab,
        url: null,
        loading: false,
        missing: true,
        dirty: true,
        error: "HTMLが削除または移動されました",
      };
    });
    this.set({
      snapshot,
      tabs,
      error: tabs.some((tab) => tab.missing)
        ? "閲覧中のHTMLが削除または移動されました"
        : this.state.error,
    });
  }
  private async restoreTabSession(snapshot: Snapshot) {
    const generation = this.sessionGeneration;
    const current = () =>
      !this.stopped &&
      generation === this.sessionGeneration &&
      snapshot.workspaceId === this.state.snapshot.workspaceId &&
      snapshot.viewId === this.state.snapshot.viewId;
    if (!snapshot.workspaceId) return;
    try {
      const session = await this.api.getTabSession?.(snapshot.workspaceId, snapshot.viewId);
      // Selections made while the read was pending take precedence.
      if (!current()) return;
      if (this.state.tabs.some((tab) => tab.kind !== "help")) {
        this.sessionReady = true;
        return;
      }
      if (session) {
        const paths = new Set<string>();
        const pending = [...this.state.snapshot.nodes];
        while (pending.length) {
          const node = pending.pop()!;
          if (node.kind === "html") paths.add(node.relativePath);
          else pending.push(...node.children);
        }
        const tabs: DocumentTab[] = session.items.map((item) => {
          const id = `tab-${++nextTab}`;
          this.requests.set(id, {
            workspace: snapshot.workspaceId!,
            view: snapshot.viewId,
            native: Promise.resolve(""),
            registered: false,
            request: 0,
            closing: false,
            registrationFailed: false,
            registrationPath: item.document.relativePath,
            expectedIdentity: item.document.identity,
            lazyDocument: item.document,
            visitPending: true,
          });
          const missing = !paths.has(item.document.relativePath);
          return {
            id,
            column: item.column,
            path: item.document.relativePath,
            zoom: item.zoom,
            deferred: true,
            url: null,
            loading: false,
            closing: false,
            dirty: true,
            missing,
            error: missing ? workspaceStatusLabels.missing : null,
          };
        });
        const columns = session.active.map((index) =>
          index === null ? null : (tabs[index]?.id ?? null),
        ) as [string | null, string | null];
        if (session.help) {
          const help = session.help;
          tabs.splice(help.index, 0, {
            id: "app-help",
            kind: "help",
            path: "機能と使い方",
            column: help.column,
            zoom: help.zoom,
            url: null,
            loading: false,
            closing: false,
            dirty: false,
            missing: false,
            error: null,
          });
          if (help.active) columns[help.column] = "app-help";
        }
        this.set({
          tabs,
          split: session.split,
          columns,
          activeColumn: session.activeColumn,
        });
        this.reloadExposedTabs();
      }
      if (current()) {
        this.sessionReady = true;
        if (!session) this.sessionFingerprint = this.tabSessionFingerprint(this.state);
      }
    } catch (error) {
      if (current()) this.set({ error: "前回のタブを復元できません: " + String(error) });
      // A failed read must never overwrite the previous session with an empty layout.
    } finally {
      if (current()) this.queueTabSession();
    }
  }
  private queueTabSession(force = false) {
    if (
      !this.api.captureTabSession ||
      !this.sessionReady ||
      this.stopped ||
      this.state.loading ||
      !this.state.snapshot.workspaceId
    )
      return;
    const documents = this.state.tabs.filter((tab) => tab.kind !== "help");
    if (documents.some((tab) => tab.loading || tab.closing)) return;
    const fingerprint = this.tabSessionFingerprint(this.state);
    if (fingerprint === this.sessionFingerprint && !this.sessionWriting) {
      if (this.sessionTimer) clearTimeout(this.sessionTimer);
      this.sessionTimer = undefined;
      this.sessionQueued = false;
      return;
    }
    this.sessionQueued = true;
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    this.sessionTimer = undefined;
    if (this.sessionWriting) return;
    const write = () => {
      this.sessionTimer = undefined;
      if (this.stopped || !this.sessionReady) return;
      this.sessionWriting = true;
      this.sessionFlight = this.writeTabSession().finally(() => {
        this.sessionWriting = false;
        this.sessionFlight = null;
        if (this.sessionQueued) this.queueTabSession(this.sessionFlushes > 0);
      });
    };
    // Only layout changes debounce disk I/O. Explicit Quit/update/root flushes bypass
    // the delay; one writer preserves order even when a prior capture is slow.
    if (force) write();
    else this.sessionTimer = setTimeout(write, 200);
  }
  private tabSessionFingerprint(state: AppState) {
    return JSON.stringify([
      state.tabs.map((tab) => {
        const record = this.requests.get(tab.id);
        // A successful first retry changes persistence eligibility without changing layout.
        return [
          tab.id,
          tab.path,
          tab.column,
          tab.zoom,
          !!(record?.lazyDocument || record?.sessionAdmitted),
        ];
      }),
      state.columns,
      state.activeColumn,
      state.split,
    ]);
  }
  private async writeTabSession() {
    while (this.sessionQueued && this.sessionReady && !this.stopped) {
      this.sessionQueued = false;
      const state = this.state;
      const generation = this.sessionGeneration;
      const documentTabs = state.tabs.filter((tab) => tab.kind !== "help");
      if (!state.snapshot.workspaceId || documentTabs.some((tab) => tab.loading || tab.closing))
        return;
      // A failed first open has no Native-owned identity to persist. Keep its
      // error tab usable, but do not let it prevent Quit or replace admitted refs.
      const documents = documentTabs.filter((tab) => {
        const record = this.requests.get(tab.id);
        return record?.lazyDocument || record?.sessionAdmitted;
      });
      const fingerprint = this.tabSessionFingerprint(state);
      if (fingerprint === this.sessionFingerprint) continue;
      try {
        const items = await Promise.all(
          documents.map(async (tab) => {
            const record = this.requests.get(tab.id);
            if (!record) throw new Error("TabClosed");
            return {
              ...(record.lazyDocument
                ? { document: record.lazyDocument }
                : { tabId: await record.native }),
              column: tab.column ?? 0,
              zoom: tab.zoom ?? 100,
            } satisfies WorkspaceCaptureItem;
          }),
        );
        if (this.stopped || generation !== this.sessionGeneration) return;
        const active = state.columns.map((id, column) => {
          if (!state.split && column === 1) return null;
          const index = documents.findIndex((tab) => tab.id === id);
          if (index >= 0) return index;
          const fallback = documents.findIndex((tab) => (tab.column ?? 0) === column);
          return fallback < 0 ? null : fallback;
        }) as [number | null, number | null];
        await this.api.captureTabSession!(
          state.snapshot.workspaceId,
          state.snapshot.viewId,
          items,
          active,
          state.activeColumn,
          state.split,
          (() => {
            const index = state.tabs.findIndex((tab) => tab.kind === "help");
            const tab = state.tabs[index];
            const documentIds = new Set(documents.map((document) => document.id));
            return tab
              ? {
                  index: state.tabs.slice(0, index).filter((item) => documentIds.has(item.id))
                    .length,
                  column: tab.column ?? 0,
                  zoom: tab.zoom ?? 100,
                  active: state.columns.includes(tab.id),
                }
              : null;
          })(),
        );
        if (generation === this.sessionGeneration) this.sessionFingerprint = fingerprint;
        if (!this.sessionFlushes) return;
      } catch (error) {
        if (!this.stopped && generation === this.sessionGeneration)
          this.set({ error: "タブの状態を保存できません: " + String(error) });
        if (generation === this.sessionGeneration)
          this.sessionQueued = this.tabSessionFingerprint(this.state) !== fingerprint;
        return;
      }
    }
  }
  async flushTabSession(): Promise<boolean> {
    if (!this.api.captureTabSession || this.stopped || !this.state.snapshot.workspaceId)
      return true;
    this.sessionFlushes++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const save = async () => {
      // Allow an admitted tab's pending registration/read to finish, without polling.
      if (this.state.loading || this.state.tabs.some((tab) => tab.loading || tab.closing)) {
        await new Promise<void>((resolve) => {
          const unlisten = this.subscribe(() => {
            if (
              this.stopped ||
              (!this.state.loading && !this.state.tabs.some((tab) => tab.loading || tab.closing))
            ) {
              unlisten();
              resolve();
            }
          });
          cleanup = unlisten;
        });
      }
      if (this.sessionRestoreFlight) await this.sessionRestoreFlight;
      // Read failure intentionally disables writes; quitting preserves that file.
      if (!this.sessionReady) return true;
      this.queueTabSession(true);
      await Promise.resolve();
      while (this.sessionFlight) {
        await this.sessionFlight;
        await Promise.resolve();
      }
      return this.stopped || this.tabSessionFingerprint(this.state) === this.sessionFingerprint;
    };
    let cleanup: (() => void) | undefined;
    try {
      return await Promise.race([
        save(),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 2500);
        }),
      ]);
    } finally {
      this.sessionFlushes--;
      if (timer) clearTimeout(timer);
      cleanup?.();
    }
  }
  private async synchronize() {
    const sequence = ++this.syncGeneration;
    const snapshot = await this.api.getTree();
    if (this.stopped || sequence !== this.syncGeneration) return;
    const current = this.state.snapshot;
    // Content notifications can advance the revision while the newest structural
    // snapshot is in flight. Keep its tree; a newer structural scan would have
    // changed syncGeneration and discarded this result instead.
    this.acceptSnapshot(
      snapshot.workspaceId === current.workspaceId &&
        snapshot.viewId === current.viewId &&
        snapshot.revision < current.revision
        ? { ...snapshot, revision: current.revision, watchError: current.watchError }
        : snapshot,
    );
  }
  private applyMoves(moves: PathMove[]) {
    const fresh = moves.filter((move) => move.revision > this.moveRevision);
    if (!fresh.length) return;
    const map = (path: string) =>
      fresh.reduce(
        (value, move) =>
          value === move.from
            ? move.to
            : value.startsWith(move.from + "/")
              ? move.to + value.slice(move.from.length)
              : value,
        path,
      );
    this.cancelHistory();
    this.histories = this.histories.map((history) => remapNavigationPaths(history, map)) as [
      NavigationHistory,
      NavigationHistory,
    ];
    const tabs = this.state.tabs.map((tab) => {
      if (tab.kind === "help") return tab;
      const path = map(tab.path);
      if (path === tab.path) return tab;
      const record = this.requests.get(tab.id);
      if (record) {
        record.request++;
        if (record.lazyDocument)
          record.lazyDocument = { ...record.lazyDocument, relativePath: path };
      }
      return { ...tab, path, url: null, loading: false, missing: false, dirty: true, error: null };
    });
    this.moveRevision = Math.max(this.moveRevision, ...fresh.map((move) => move.revision));
    this.set({
      tabs,
      closed: this.state.closed.map((tab) => ({ ...tab, path: map(tab.path) })),
      error: null,
    });
  }
  private async reloadMoved(moves: PathMove[]) {
    const fresh = moves.filter((move) => !this.moveReloads.has(move.revision));
    if (!fresh.length) return;
    for (const move of fresh) this.moveReloads.add(move.revision);
    while (this.moveReloads.size > 256)
      this.moveReloads.delete(this.moveReloads.values().next().value!);
    await Promise.all(
      this.state.tabs
        .filter(
          (tab) =>
            this.visible(tab.id) &&
            !tab.missing &&
            fresh.some((move) => tab.path === move.to || tab.path.startsWith(move.to + "/")),
        )
        .map((tab) => this.reload(tab.id)),
    );
  }
  async mutateTree(mutation: TreeMutation): Promise<string | null> {
    const { snapshot } = this.state;
    if (this.stopped || this.state.loading || this.state.actionBusy || !snapshot.workspaceId)
      return "別の操作が完了するまでお待ちください";
    const generation = ++this.actionGeneration;
    const current = () =>
      !this.stopped &&
      generation === this.actionGeneration &&
      snapshot.workspaceId === this.state.snapshot.workspaceId &&
      snapshot.viewId === this.state.snapshot.viewId;
    this.set({ actionBusy: true, actionMessage: null, error: null });
    try {
      const result = await this.api.mutateTree(snapshot.workspaceId, snapshot.viewId, mutation);
      if (!current()) return "作業フォルダーが変更されました";
      this.acceptSnapshot(result.snapshot);
      this.applyMoves(result.moves);
      this.set({
        error: result.warning ?? null,
        actionMessage:
          result.warning ??
          (mutation.kind === "trash"
            ? "ごみ箱に移動しました。復元はOSのごみ箱で行ってください"
            : mutation.kind === "reorder"
              ? "順序を保存しました"
              : mutation.kind === "move"
                ? "移動しました。相対参照は変更していません"
                : mutation.kind === "renameHtml"
                  ? "名前を変更しました。相対参照は変更していません"
                  : "作成しました"),
      });
      if (mutation.kind === "trash") {
        // A path can be recreated before the committed rescan. Never retain the
        // old iframe or resurrect its grant merely because that path exists.
        const affected = this.state.tabs.filter(
          (tab) => tab.path === mutation.source || tab.path.startsWith(mutation.source + "/"),
        );
        for (const tab of affected) {
          const record = this.requests.get(tab.id);
          if (record) record.request++;
          this.updateTab(tab.id, {
            url: null,
            loading: false,
            missing: true,
            dirty: true,
            error: "HTMLをOSのごみ箱へ移動しました",
          });
        }
        if (affected.length && !result.warning)
          this.set({ error: "閲覧中のHTMLをOSのごみ箱へ移動しました" });
        // A trashed folder can contain shared CSS/JS/images used by other tabs.
        // Missing tabs remain revoked; saved document-state identities are retained.
        await this.reloadChanged(
          this.state.tabs.filter((tab) => !tab.missing),
          result.snapshot.revision,
        );
      }
      await this.reloadMoved(result.moves);
      // Tab cleanup/reloads can clear transient errors. A committed mutation's
      // recovery warning must remain visible after those asynchronous steps.
      if (result.warning && current()) this.set({ error: result.warning });
      return current() ? null : "作業フォルダーが変更されました";
    } catch (error) {
      if (!current()) return "作業フォルダーが変更されました";
      const message = "ファイル操作に失敗しました: " + String(error);
      this.set({ error: message });
      return message;
    } finally {
      if (current()) this.set({ actionBusy: false });
    }
  }
  private async reloadChanged(tabs: DocumentTab[], revision: number) {
    const fresh = tabs.filter((tab) => {
      const record = this.requests.get(tab.id);
      if (!record || record.closing || (record.changeRevision ?? -1) >= revision) return false;
      // Claim synchronously, before reload yields: a mutation's event and RPC
      // response can overlap. Tracking on the request follows tab/view lifetime.
      record.changeRevision = revision;
      return true;
    });
    for (const tab of fresh) this.updateTab(tab.id, { dirty: true });
    // Hidden tabs keep their running state until an explicit reload.
    await Promise.all(
      fresh.filter((tab) => this.visible(tab.id)).map((tab) => this.reload(tab.id)),
    );
  }
  private visible(id: string) {
    return this.state.columns[0] === id || (this.state.split && this.state.columns[1] === id);
  }
  private async onChange(change: Change) {
    if (
      change.workspaceId === this.state.snapshot.workspaceId &&
      change.revision === this.state.snapshot.revision &&
      change.treeOnly &&
      change.changedPaths.length === 0 &&
      !change.moves?.length
    ) {
      void this.refreshWorkspaceLists();
      return;
    }
    if (
      change.workspaceId !== this.state.snapshot.workspaceId ||
      change.revision <= this.state.snapshot.revision
    )
      return;
    const view = this.state.snapshot.viewId;
    try {
      if (change.structureChanged || change.watchError) await this.synchronize();
      else this.set({ snapshot: { ...this.state.snapshot, revision: change.revision } });
      if (
        change.workspaceId !== this.state.snapshot.workspaceId ||
        view !== this.state.snapshot.viewId ||
        this.stopped
      )
        return;
      const newerBatch = this.state.snapshot.revision > change.revision;
      if (change.moves?.length && !newerBatch) {
        await this.reloadMoved(change.moves);
        return;
      }
      if (change.treeOnly && !newerBatch) return;
      if (newerBatch) {
        for (const move of change.moves ?? []) this.moveReloads.add(move.revision);
        while (this.moveReloads.size > 256)
          this.moveReloads.delete(this.moveReloads.values().next().value!);
      }
      // A structural rescan may include newer batches whose notifications will
      // now be stale. Their paths are unknown, so conservatively update all tabs.
      const shared = newerBatch || change.changedPaths.some((path) => !/\.html?$/i.test(path));
      const affected = this.state.tabs.filter(
        (tab) =>
          !tab.missing &&
          (shared ||
            change.changedPaths.includes(tab.path) ||
            (change.moves ?? []).some(
              (move) => tab.path === move.to || tab.path.startsWith(move.to + "/"),
            )),
      );
      await this.reloadChanged(affected, this.state.snapshot.revision);
    } catch (error) {
      if (
        change.workspaceId === this.state.snapshot.workspaceId &&
        view === this.state.snapshot.viewId &&
        !this.stopped
      )
        this.set({ error: String(error) });
    }
  }
  beginStateTransfer(path: string, kind: "import" | "export") {
    if (
      this.stopped ||
      this.state.loading ||
      this.state.actionBusy ||
      !contains(this.state.snapshot.nodes, path)
    )
      return;
    this.transfer ??= new StateTransfer(this.api, {
      context: () => {
        const { workspaceId, viewId } = this.state.snapshot;
        return !this.stopped && workspaceId ? { workspaceId, viewId } : null;
      },
      publish: (stateTransfer) => this.set({ stateTransfer, actionBusy: !!stateTransfer }),
      capture: () => {
        const context = this.state.snapshot;
        const views = this.state.tabs.flatMap((tab) => {
          const record = this.requests.get(tab.id);
          return tab.url && !tab.deferred && !tab.closing && record?.nativeId
            ? [
                {
                  id: tab.id,
                  path: tab.path,
                  url: tab.url,
                  nativeId: record.nativeId,
                  request: record.request,
                  record,
                },
              ]
            : [];
        });
        const current = (view: (typeof views)[number]) => {
          const tab = this.state.tabs.find((tab) => tab.id === view.id);
          return (
            !this.stopped &&
            this.state.snapshot.workspaceId === context.workspaceId &&
            this.state.snapshot.viewId === context.viewId &&
            this.requests.get(view.id) === view.record &&
            view.record.request === view.request &&
            !view.record.closing &&
            view.record.nativeId === view.nativeId &&
            tab?.url === view.url &&
            tab.path === view.path &&
            !tab.deferred &&
            !tab.missing &&
            !tab.loading
          );
        };
        return {
          activeTabIds: views
            .filter((view) => this.state.columns.includes(view.id))
            .map((view) => view.nativeId),
          reload: async (receipt, preview) => {
            const warnings: string[] = [];
            for (const view of views) {
              const affected = preview.affectedViews.find((item) => item.tabId === view.nativeId);
              if (
                !receipt.reloadTabIds.includes(view.nativeId) ||
                !affected?.matchesTargetIdentity ||
                affected.documentIdentity !== receipt.documentIdentity ||
                !current(view)
              )
                continue;
              // A fresh registration binds the new read to the receipt identity,
              // including replacement races after the atomic import decision.
              const native = await this.api.createTab(
                context.workspaceId!,
                context.viewId,
                view.path,
                receipt.documentIdentity,
              );
              if (!current(view)) {
                await this.api.closeTab(context.workspaceId!, context.viewId, native);
                continue;
              }
              // Claim the fresh registration before awaiting old close. A
              // watcher reload or lost close response must never leave a dead
              // Native ID as the controller's recovery target.
              const claimedRequest = ++view.record.request;
              view.record.native = Promise.resolve(native);
              view.record.nativeId = native;
              view.record.expectedIdentity = receipt.documentIdentity;
              view.record.visitPending = false;
              view.record.historyVisit = false;
              view.record.userAnchor = undefined;
              try {
                await this.api.closeTab(context.workspaceId!, context.viewId, view.nativeId);
              } catch (error) {
                warnings.push("旧view解除の応答を確認できません: " + String(error));
              }
              if (
                this.stopped ||
                this.requests.get(view.id) !== view.record ||
                view.record.closing ||
                view.record.nativeId !== native ||
                view.record.request !== claimedRequest ||
                this.state.snapshot.workspaceId !== context.workspaceId ||
                this.state.snapshot.viewId !== context.viewId
              )
                continue;
              await this.reload(view.id, "input-transfer");
              if (this.state.tabs.find((tab) => tab.id === view.id)?.error)
                warnings.push("対象の表示を更新できませんでした。明示再読み込みを行ってください");
            }
            if (warnings.length) throw new Error(warnings.join("\n"));
          },
        };
      },
    });
    void this.transfer.begin(path, kind);
  }
  chooseStateTransferBackup() {
    return this.transfer?.chooseBackup();
  }
  confirmStateTransfer(replace: boolean, stopReload: boolean) {
    return this.transfer?.confirm(replace, stopReload);
  }
  verifyStateTransferCurrentValues() {
    return this.transfer?.verifyCurrentValues();
  }
  dismissUnknownStateTransfer() {
    this.transfer?.dismissUnknown();
  }
  verifyStateTransfer() {
    return this.transfer?.verify();
  }
  cancelStateTransfer() {
    return this.transfer?.cancel();
  }
  dismissStateTransfer() {
    this.transfer?.dismiss();
  }
  dismissActionMessage() {
    this.set({ actionMessage: null });
  }
  async recoverDocumentState(
    path: string,
    confirm: (candidate: RecoveryCandidate) => boolean | Promise<boolean>,
  ) {
    const { snapshot } = this.state;
    if (
      this.stopped ||
      this.state.loading ||
      this.state.actionBusy ||
      !snapshot.workspaceId ||
      !contains(snapshot.nodes, path)
    )
      return;
    const getCandidate = this.api.getDocumentStateRecovery;
    const recover = this.api.recoverDocumentState;
    if (!getCandidate || !recover) {
      this.set({ error: "この環境では入力状態の引き継ぎを利用できません", actionMessage: null });
      return;
    }
    const generation = ++this.actionGeneration;
    const current = () =>
      !this.stopped &&
      generation === this.actionGeneration &&
      snapshot.workspaceId === this.state.snapshot.workspaceId &&
      snapshot.viewId === this.state.snapshot.viewId;
    const targetExists = () => contains(this.state.snapshot.nodes, path);
    this.set({ actionBusy: true, actionMessage: null, error: null });
    try {
      const candidate = await getCandidate(snapshot.workspaceId, snapshot.viewId, path);
      if (!current()) return;
      if (!targetExists()) {
        this.set({ error: "対象のHTMLが見つかりません。ツリーから選び直してください" });
        return;
      }
      if (!candidate) {
        this.set({ error: "このHTMLに引き継げる以前の入力状態はありません" });
        return;
      }
      const accepted = await confirm(candidate);
      if (!current()) return;
      if (!accepted) return;
      if (!targetExists()) {
        this.set({ error: "対象のHTMLが見つかりません。ツリーから選び直してください" });
        return;
      }
      // Native rechecks both identities and the saved revision at commit. The
      // confirmation can outlive external replacement or another document save.
      await recover(snapshot.workspaceId, snapshot.viewId, path, candidate);
      if (!current()) return;
      this.set({ actionMessage: "以前の入力状態を引き継ぎました" });
      await Promise.all(
        this.state.tabs
          .filter((tab) => tab.path === path && !tab.closing && !tab.missing)
          .filter((tab) => !!tab.url && !tab.deferred)
          .map((tab) => this.reload(tab.id, "input-transfer")),
      );
    } catch (error) {
      if (!current()) return;
      const reason = String(error);
      const message = reason.includes("StateConflict")
        ? "このHTMLには入力状態が既に保存されています。以前の状態は上書きできません"
        : reason.includes("RecoveryChanged") || reason.includes("IdentityChanged")
          ? "HTMLまたは以前の入力状態が変更されました。もう一度引き継ぎ操作を行ってください"
          : "入力状態を引き継げません: " + reason;
      this.set({ error: message });
    } finally {
      if (current()) this.set({ actionBusy: false });
    }
  }
  async performFileAction(path: string, action: FileAction) {
    const { snapshot } = this.state;
    if (
      this.stopped ||
      this.state.loading ||
      this.state.actionBusy ||
      !snapshot.workspaceId ||
      !contains(snapshot.nodes, path, action !== "openBrowser")
    )
      return;
    const generation = ++this.actionGeneration;
    const current = () =>
      !this.stopped &&
      generation === this.actionGeneration &&
      snapshot.workspaceId === this.state.snapshot.workspaceId &&
      snapshot.viewId === this.state.snapshot.viewId;
    this.set({ actionBusy: true, actionMessage: null, error: null });
    try {
      await this.api.performFileAction(snapshot.workspaceId, snapshot.viewId, path, action);
      if (!current()) return;
      const message =
        action === "copyPath"
          ? "フルパスをコピーしました"
          : action === "openFolder"
            ? "OSへフォルダーの表示を依頼しました"
            : "既定ブラウザーへ表示を依頼しました。URLは作業フォルダー変更・画面再起動・アプリ終了で失効します";
      this.set({ actionMessage: message });
    } catch (error) {
      if (current()) this.set({ error: "ファイル操作に失敗しました: " + String(error) });
    } finally {
      if (current()) this.set({ actionBusy: false });
    }
  }
  async performRootAction(action: RootAction) {
    const { snapshot } = this.state;
    if (this.stopped || this.state.loading || this.state.actionBusy || !snapshot.workspaceId)
      return;
    const generation = ++this.actionGeneration;
    const current = () =>
      !this.stopped &&
      generation === this.actionGeneration &&
      snapshot.workspaceId === this.state.snapshot.workspaceId &&
      snapshot.viewId === this.state.snapshot.viewId;
    this.set({ actionBusy: true, actionMessage: null, error: null });
    try {
      await rootActionsApi.perform(
        { workspaceId: snapshot.workspaceId, viewId: snapshot.viewId, target: "root" },
        action,
      );
      if (current())
        this.set({
          actionMessage:
            action === "copyPath"
              ? "フルパスをコピーしました"
              : "OSへフォルダーの表示を依頼しました",
        });
    } catch (error) {
      if (current()) this.set({ error: "ファイル操作に失敗しました: " + String(error) });
    } finally {
      if (current()) this.set({ actionBusy: false });
    }
  }
  async choose() {
    if (!this.state.snapshot.rootPath) {
      if (this.state.snapshot.startupRecovery) {
        this.set({ error: "RegisteredRootRecoveryRequired" });
        return;
      }
      await this.registerRoot();
      return;
    }
    const choose = this.api.chooseDisplayFolder;
    if (!choose) {
      this.set({ error: "DisplayFolderSelectionUnavailable" });
      return;
    }
    await this.displayAction(choose);
  }
  async registerRoot() {
    await this.workspaceAction(() => this.api.chooseRoot());
  }
  async selectManagedFolder(id: string, expectedRevision: string) {
    const select = this.api.selectManagedFolder;
    if (!select) throw new Error("専用フォルダーを開けません");
    if (!(await this.workspaceAction(() => select(id, expectedRevision))))
      throw new Error(this.state.error ?? "専用フォルダーを開けません");
  }
  async unregisterManagedFolder(id: string, expectedRevision: string) {
    const unregister = this.api.unregisterManagedFolder;
    if (!unregister) throw new Error("専用フォルダーの登録を解除できません");
    const result: { folders?: ManagedFolders } = {};
    const completed = await this.workspaceAction(async () => {
      result.folders = await unregister(id, expectedRevision);
      return this.api.beginView();
    });
    if (!completed || !result.folders)
      throw new Error(this.state.error ?? "専用フォルダーの登録を解除できません");
    return result.folders;
  }
  async switchDisplayFolder(relativePath: string): Promise<boolean> {
    const select = this.api.setDisplayFolder;
    if (!select) {
      this.set({ error: "DisplayFolderSelectionUnavailable" });
      return false;
    }
    const displayRevision = this.state.snapshot.displayRevision ?? 0;
    return this.displayAction((workspace, view) =>
      select(workspace, view, relativePath, displayRevision),
    );
  }
  private async displayAction(
    action: (workspace: string, view: string) => Promise<Snapshot | null>,
  ): Promise<boolean> {
    const snapshot = this.state.snapshot;
    if (this.stopped || this.state.loading || this.state.actionBusy || !snapshot.workspaceId)
      return false;
    // Display navigation leaves admitted document grants and session save targets
    // intact. Only explicit root management uses workspaceAction and its flush.
    this.cancelWorkspaceSelection();
    const generation = ++this.workspaceGeneration;
    this.set({ actionBusy: true, error: null, actionMessage: null });
    const current = () =>
      !this.stopped &&
      generation === this.workspaceGeneration &&
      snapshot.workspaceId === this.state.snapshot.workspaceId &&
      snapshot.viewId === this.state.snapshot.viewId;
    try {
      const next = await action(snapshot.workspaceId, snapshot.viewId);
      if (!current() || !next) return false;
      // A display-only response must never silently replace storage ownership.
      if (
        next.workspaceId !== snapshot.workspaceId ||
        next.viewId !== snapshot.viewId ||
        next.rootPath !== snapshot.rootPath
      ) {
        this.set({ error: "DisplayFolderOutsideRegisteredRoot" });
        return false;
      }
      if ((next.displayRevision ?? 0) < (this.state.snapshot.displayRevision ?? 0)) return false;
      // Replace pre-selection reads with an authoritative cached read. Display
      // changes themselves never reload documents or mark their content dirty.
      this.syncGeneration++;
      this.acceptSnapshot(next);
      await this.synchronize();
      if (!current()) return false;
      if ((next.displayRevision ?? 0) < (this.state.snapshot.displayRevision ?? 0)) return false;
      return true;
    } catch (error) {
      if (current()) this.set({ error: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      if (current()) this.set({ actionBusy: false });
    }
  }
  async retrySavedRoot() {
    if (
      this.stopped ||
      this.savedRootRetryPending ||
      this.state.loading ||
      this.state.actionBusy ||
      this.state.snapshot.workspaceId ||
      !this.state.snapshot.startupRecovery?.canRetry ||
      !this.api.retrySavedRoot
    )
      return;
    const retry = this.api.retrySavedRoot;
    const view = this.state.snapshot.viewId;
    const lifecycle = this.lifecycle;
    this.savedRootRetryPending = true;
    try {
      await this.workspaceAction(() => retry(view));
    } finally {
      if (lifecycle === this.lifecycle) this.savedRootRetryPending = false;
    }
  }
  async refresh() {
    await this.workspaceAction(() => this.api.refresh());
  }
  private async workspaceAction(action: () => Promise<Snapshot | null>): Promise<boolean> {
    if (!(await this.flushTabSession())) {
      this.set({ error: "タブの状態を保存できません: TabSessionSaveFailed" });
      return false;
    }
    this.cancelWorkspaceSelection();
    const generation = ++this.workspaceGeneration;
    this.actionGeneration++;
    this.syncGeneration++;
    this.set({ loading: true, error: null, actionBusy: false, actionMessage: null });
    try {
      const snapshot = await action();
      if (this.stopped || generation !== this.workspaceGeneration || !snapshot) return false;
      this.acceptSnapshot(snapshot);
      await this.synchronize();
      return true;
    } catch (error) {
      if (generation === this.workspaceGeneration) this.set({ error: String(error) });
      return false;
    } finally {
      if (generation === this.workspaceGeneration) this.set({ loading: false });
    }
  }
  activate(id: string, column: Column = this.state.activeColumn) {
    this.cancelWorkspaceSelection();
    const tab = this.state.tabs.find((item) => item.id === id);
    if (!tab || tab.closing) return;
    const record = this.requests.get(id);
    if (record) {
      record.visitPending = true;
      record.historyVisit = true;
    }
    const existing = this.state.columns.indexOf(id);
    if (existing >= 0 && (existing === 0 || this.state.split)) {
      this.set({ activeColumn: existing as Column });
      this.reloadExposedTabs();
      void this.recordDisplay(id);
      return;
    }
    const targetColumn = this.state.split ? (tab.column ?? column) : 0;
    const columns: [string | null, string | null] = [...this.state.columns];
    columns[targetColumn] = id;
    this.set({
      columns,
      tabs: this.state.tabs.map((item) =>
        item.id === id ? { ...item, column: targetColumn } : item,
      ),
      activeColumn: targetColumn,
      error: null,
    });
    this.reloadExposedTabs();
    void this.recordDisplay(id);
  }
  openHelp() {
    if (this.stopped || this.state.actionBusy) return;
    const existing = this.state.tabs.find((tab) => tab.kind === "help");
    if (existing) {
      this.activate(existing.id);
      return existing.id;
    }
    const id = "app-help";
    this.set({
      tabs: [
        ...this.state.tabs,
        {
          kind: "help",
          id,
          column: this.state.activeColumn,
          path: "機能と使い方",
          url: null,
          loading: false,
          closing: false,
          dirty: false,
          missing: false,
          error: null,
        },
      ],
    });
    this.activate(id);
    return id;
  }
  async refreshWorkspaceSets() {
    const { snapshot } = this.state;
    const read = this.api.getWorkspaceSets;
    if (!read || !snapshot.workspaceId || this.stopped) return;
    const generation = ++this.setReadGeneration;
    try {
      const workspaceSets = await read(snapshot.workspaceId, snapshot.viewId);
      if (
        !this.stopped &&
        generation === this.setReadGeneration &&
        snapshot.workspaceId === this.state.snapshot.workspaceId &&
        snapshot.viewId === this.state.snapshot.viewId
      )
        this.set({ workspaceSets });
    } catch (error) {
      if (
        !this.stopped &&
        generation === this.setReadGeneration &&
        snapshot.workspaceId === this.state.snapshot.workspaceId &&
        snapshot.viewId === this.state.snapshot.viewId
      )
        this.set({ error: "作業セットを読み取れません: " + String(error) });
    }
  }
  async saveWorkspaceSet(name: string): Promise<boolean> {
    const write = this.api.captureWorkspaceSet;
    const state = this.state;
    const documents = state.tabs.filter((tab) => tab.kind !== "help");
    if (
      !write ||
      !state.snapshot.workspaceId ||
      !documents.length ||
      documents.some((tab) => tab.loading || tab.closing)
    )
      return false;
    return this.changeWorkspaceSet(async (workspace, view) => {
      const items = await Promise.all(
        documents.map(async (tab) => {
          const record = this.requests.get(tab.id);
          if (!record) throw new Error("タブが変更されました");
          const reference = record.lazyDocument;
          return {
            ...(reference ? { document: reference } : { tabId: await record.native }),
            column: state.split ? (tab.column ?? 0) : 0,
            zoom: tab.zoom ?? 100,
          } satisfies WorkspaceCaptureItem;
        }),
      );
      const active: [number | null, number | null] = state.columns.map((id, column) => {
        const index = documents.findIndex((tab) => tab.id === id);
        if (index >= 0) return index;
        if (!state.tabs.some((tab) => tab.id === id && tab.kind === "help")) return null;
        const fallback = documents.findIndex(
          (tab) => (state.split ? (tab.column ?? 0) : 0) === column,
        );
        return fallback < 0 ? null : fallback;
      }) as [number | null, number | null];
      const activeColumn =
        active[state.activeColumn] !== null ? state.activeColumn : active[0] !== null ? 0 : 1;
      return write(workspace, view, name, items, active, activeColumn);
    });
  }
  async editWorkspaceSet(id: string, name: string | null): Promise<boolean> {
    const edit = this.api.editWorkspaceSet;
    if (!edit) return false;
    return this.changeWorkspaceSet((workspace, view) => edit(workspace, view, id, name));
  }
  async assignWorkspaceSetShortcut(
    id: string,
    slot: WorkspaceSetShortcutSlot | null,
  ): Promise<boolean> {
    const assign = this.api.assignWorkspaceSetShortcut;
    if (!assign) return false;
    return this.changeWorkspaceSet((workspace, view) => assign(workspace, view, id, slot));
  }
  async restoreWorkspaceSetShortcut(slot: WorkspaceSetShortcutSlot): Promise<boolean> {
    const id = this.state.workspaceSets?.setShortcuts[slot - 1];
    if (!id) return false;
    return this.restoreWorkspaceSet(id, slot);
  }
  private async changeWorkspaceSet(
    action: (workspace: string, view: string) => Promise<WorkspaceSets>,
  ): Promise<boolean> {
    const { snapshot } = this.state;
    if (this.stopped || this.state.loading || this.state.actionBusy || !snapshot.workspaceId)
      return false;
    this.cancelWorkspaceSelection();
    this.setReadGeneration++;
    const generation = ++this.actionGeneration;
    const current = () =>
      !this.stopped &&
      generation === this.actionGeneration &&
      snapshot.workspaceId === this.state.snapshot.workspaceId &&
      snapshot.viewId === this.state.snapshot.viewId;
    this.set({ actionBusy: true, error: null });
    try {
      const workspaceSets = await action(snapshot.workspaceId, snapshot.viewId);
      if (!current()) return false;
      this.setReadGeneration++;
      this.set({ workspaceSets });
      return true;
    } catch (error) {
      if (current()) this.set({ error: "作業セットを保存できません: " + String(error) });
      return false;
    } finally {
      if (current()) this.set({ actionBusy: false });
    }
  }
  async restoreWorkspaceSet(id: string, shortcutSlot?: WorkspaceSetShortcutSlot): Promise<boolean> {
    const resolve = this.api.resolveWorkspaceSet;
    const { snapshot } = this.state;
    if (
      !resolve ||
      !snapshot.workspaceId ||
      this.stopped ||
      this.state.loading ||
      this.state.actionBusy
    )
      return false;
    if (this.state.tabs.some((tab) => tab.loading || tab.closing)) {
      this.set({ error: "タブの読み込み・終了後に作業セットを呼び出してください" });
      return false;
    }
    const requests = new Map(
      this.state.tabs.map((tab) => [tab.id, this.requests.get(tab.id)?.request]),
    );
    this.cancelHistory();
    const generation = ++this.listSelectionGeneration;
    const current = () =>
      !this.stopped &&
      generation === this.listSelectionGeneration &&
      !this.state.loading &&
      !this.state.actionBusy &&
      snapshot.workspaceId === this.state.snapshot.workspaceId &&
      snapshot.viewId === this.state.snapshot.viewId &&
      snapshot.revision === this.state.snapshot.revision &&
      (shortcutSlot === undefined ||
        this.state.workspaceSets?.setShortcuts[shortcutSlot - 1] === id) &&
      this.state.tabs.length === requests.size &&
      this.state.tabs.every((tab) => requests.get(tab.id) === this.requests.get(tab.id)?.request);
    try {
      const resolved =
        shortcutSlot === undefined
          ? await resolve(snapshot.workspaceId, snapshot.viewId, id)
          : await resolve(snapshot.workspaceId, snapshot.viewId, id, shortcutSlot);
      const nativeIds = new Map(
        this.state.tabs.map((tab) => [tab.id, this.requests.get(tab.id)?.nativeId]),
      );
      if (!current()) return false;
      const original = this.state.split
        ? this.state.tabs
        : this.state.tabs.map((tab) => (tab.column === 1 ? { ...tab, column: 0 as Column } : tab));
      const used = new Set<string>();
      const restored: DocumentTab[] = [];
      const unavailable: string[] = [];
      for (const item of resolved.items) {
        const existing = original.find((tab) => {
          if (
            tab.closing ||
            used.has(tab.id) ||
            tab.path !== item.document.relativePath ||
            (this.state.split ? (tab.column ?? 0) : 0) !== item.column
          )
            return false;
          const record = this.requests.get(tab.id);
          return (
            item.reusableTabs.includes(nativeIds.get(tab.id) ?? "") ||
            record?.lazyDocument?.identity === item.document.identity
          );
        });
        if (existing) {
          used.add(existing.id);
          // Keep the exact view, URL, heap and current zoom. Reordering the strip
          // does not reorder iframe DOM nodes (DocumentDeck's stable mount order).
          const record = this.requests.get(existing.id);
          const error = item.status === "available" ? null : workspaceStatusLabels[item.status];
          if (!existing.url && record?.lazyDocument) {
            if (error) unavailable.push(item.document.relativePath + ": " + error);
            restored.push({
              ...existing,
              dirty: true,
              missing: item.status === "missing" || item.status === "replaced",
              error,
            });
          } else restored.push(existing);
          continue;
        }
        const tabId = `tab-${++nextTab}`;
        const record: TabRequest = {
          workspace: snapshot.workspaceId,
          view: snapshot.viewId,
          native: Promise.resolve(""),
          registered: false,
          request: 0,
          closing: false,
          registrationFailed: false,
          registrationPath: item.document.relativePath,
          expectedIdentity: item.document.identity,
          lazyDocument: item.document,
          visitPending: true,
        };
        this.requests.set(tabId, record);
        const error = item.status === "available" ? null : workspaceStatusLabels[item.status];
        if (error) unavailable.push(item.document.relativePath + ": " + error);
        restored.push({
          id: tabId,
          column: item.column,
          path: item.document.relativePath,
          zoom: item.zoom,
          deferred: true,
          url: null,
          loading: false,
          closing: false,
          dirty: true,
          missing: item.status === "missing" || item.status === "replaced",
          error,
        });
        used.add(tabId);
      }
      const remaining = original.filter((tab) => !used.has(tab.id));
      const tabs = [...restored, ...remaining];
      const split = tabs.some((tab) => tab.column === 1);
      const columns: [string | null, string | null] = [...this.state.columns];
      for (const column of [0, 1] as const) {
        const active = resolved.set.active[column];
        if (active !== null) columns[column] = restored[active]?.id ?? columns[column];
      }
      if (!split) columns[1] = null;
      this.set({
        tabs,
        columns,
        split,
        activeColumn: resolved.set.activeColumn,
        error: unavailable.length ? unavailable.join("\n") : null,
        actionMessage: "作業セットを準備しました。既存タブと現在の倍率を保持しています",
      });
      this.reloadExposedTabs();
      for (const visible of columns)
        if (visible) {
          const record = this.requests.get(visible);
          if (record) {
            record.visitPending = true;
            record.historyVisit = true;
          }
          void this.recordDisplay(visible);
        }
      void this.refreshWorkspaceSets();
      return true;
    } catch (error) {
      if (current()) this.set({ error: "作業セットを呼び出せません: " + String(error) });
      return false;
    }
  }
  async refreshWorkspaceLists(resolveMoves = false) {
    const read = this.api.getWorkspaceLists;
    if (!read || !this.state.snapshot.workspaceId || this.stopped || this.state.actionBusy) return;
    this.listRefreshQueued = true;
    this.listRefreshResolveMoves ||= resolveMoves;
    if (this.listRefreshPromise) return this.listRefreshPromise;
    // One in-flight read plus one coalesced latest request. A stale revision
    // retries a cheap snapshot read; document edits never request move scans.
    this.listRefreshPromise = Promise.resolve()
      .then(async () => {
        while (this.listRefreshQueued && !this.stopped) {
          const { snapshot } = this.state;
          const resolve = this.listRefreshResolveMoves;
          this.listRefreshQueued = false;
          this.listRefreshResolveMoves = false;
          if (!snapshot.workspaceId || this.state.actionBusy) break;
          const generation = ++this.listGeneration;
          const sameScope = () =>
            !this.stopped &&
            generation === this.listGeneration &&
            snapshot.workspaceId === this.state.snapshot.workspaceId &&
            snapshot.viewId === this.state.snapshot.viewId;
          try {
            const workspaceLists = await read(snapshot.workspaceId, snapshot.viewId, resolve);
            if (sameScope()) {
              if (snapshot.revision === this.state.snapshot.revision) this.set({ workspaceLists });
              else this.listRefreshQueued = true;
            }
          } catch (error) {
            if (sameScope()) {
              if (snapshot.revision === this.state.snapshot.revision)
                this.set({ error: "端末設定を読み取れません: " + String(error) });
              else this.listRefreshQueued = true;
            }
          }
        }
      })
      .finally(() => {
        this.listRefreshPromise = null;
      });
    return this.listRefreshPromise;
  }
  async setFavorite(path: string, add: boolean) {
    const { snapshot } = this.state;
    const write = this.api.setDocumentFavorite;
    if (
      !write ||
      !snapshot.workspaceId ||
      this.stopped ||
      this.state.actionBusy ||
      this.state.loading
    )
      return;
    const generation = ++this.actionGeneration;
    this.listGeneration++;
    const current = () =>
      !this.stopped &&
      generation === this.actionGeneration &&
      snapshot.workspaceId === this.state.snapshot.workspaceId &&
      snapshot.viewId === this.state.snapshot.viewId;
    this.set({ actionBusy: true, error: null });
    try {
      const workspaceLists = await write(snapshot.workspaceId, snapshot.viewId, path, add);
      if (current()) {
        this.listGeneration++;
        this.set({ workspaceLists });
      }
    } catch (error) {
      if (current()) this.set({ error: "お気に入りを保存できません: " + String(error) });
    } finally {
      if (
        snapshot.workspaceId === this.state.snapshot.workspaceId &&
        snapshot.viewId === this.state.snapshot.viewId
      )
        this.set({ actionBusy: false });
    }
  }
  async selectResidentDocument(
    resolve: (tabId?: string) => Promise<ResidentSelection>,
  ): Promise<boolean> {
    const { snapshot } = this.state;
    if (this.stopped || this.state.loading || this.state.actionBusy) return false;
    this.cancelHistory();
    const generation = ++this.listSelectionGeneration;
    const current = (selection: ResidentSelection) =>
      !this.stopped &&
      generation === this.listSelectionGeneration &&
      !this.state.loading &&
      !this.state.actionBusy &&
      snapshot.workspaceId === selection.workspaceId &&
      snapshot.viewId === selection.viewId &&
      snapshot.revision === selection.revision &&
      snapshot.workspaceId === this.state.snapshot.workspaceId &&
      snapshot.viewId === this.state.snapshot.viewId &&
      snapshot.revision === this.state.snapshot.revision;
    try {
      const selection = await resolve();
      if (!current(selection)) return false;
      if (!selection.document) {
        if (selection.fallback)
          this.set({ actionMessage: "指定したHTMLを確認できません。現在の表示を保持します" });
        return true;
      }
      const document = selection.document;
      const candidates = this.state.tabs.filter(
        (tab) => tab.kind !== "help" && !tab.closing && tab.path === document.relativePath,
      );
      const existing =
        candidates.find((tab) => tab.id === this.state.columns[this.state.activeColumn]) ??
        candidates[0];
      if (existing) {
        const record = this.requests.get(existing.id);
        if (!record || (record.lazyDocument && record.lazyDocument.identity !== document.identity))
          return false;
        const native = record.registered ? await record.native : undefined;
        if (!current(selection)) return false;
        const verified = await resolve(native);
        if (
          !current(verified) ||
          verified.fallback ||
          verified.document?.identity !== document.identity ||
          verified.document.relativePath !== document.relativePath
        )
          return false;
        this.activate(existing.id, existing.column ?? this.state.activeColumn);
        return true;
      }
      return this.selectFromSnapshot({
        workspaceId: selection.workspaceId!,
        viewId: selection.viewId,
        revision: selection.revision,
        relativePath: document.relativePath,
        expectedIdentity: document.identity,
      });
    } catch {
      if (generation === this.listSelectionGeneration)
        this.set({ actionMessage: "呼び出すHTMLを確認できません。現在の表示を保持します" });
      return false;
    }
  }
  async selectWorkspaceDocument(
    document: WorkspaceDocument,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const { snapshot } = this.state;
    const validate = this.api.validateWorkspaceDocument;
    if (
      signal?.aborted ||
      !validate ||
      !snapshot.workspaceId ||
      this.stopped ||
      this.state.loading ||
      this.state.actionBusy
    )
      return false;
    this.cancelHistory();
    const generation = ++this.listSelectionGeneration;
    const cancel = () => {
      if (generation === this.listSelectionGeneration) this.cancelWorkspaceSelection();
    };
    signal?.addEventListener("abort", cancel, { once: true });
    const current = () =>
      !signal?.aborted &&
      !this.stopped &&
      generation === this.listSelectionGeneration &&
      snapshot.workspaceId === this.state.snapshot.workspaceId &&
      snapshot.viewId === this.state.snapshot.viewId &&
      snapshot.revision === this.state.snapshot.revision;
    try {
      const candidates = this.state.tabs.filter(
        (tab) =>
          tab.kind !== "help" &&
          !tab.closing &&
          tab.path === document.relativePath &&
          (!this.state.split || (tab.column ?? 0) === this.state.activeColumn),
      );
      const existing =
        candidates.find((tab) => tab.id === this.state.columns[this.state.activeColumn]) ??
        candidates[0];
      const record = existing ? this.requests.get(existing.id) : undefined;
      if (record?.lazyDocument && record.lazyDocument.identity !== document.identity)
        throw new Error("既存タブは別の文書です。先にそのタブを閉じてください");
      const native = record?.registered ? await record.native : undefined;
      if (!current()) return false;
      const path = await validate(
        snapshot.workspaceId,
        snapshot.viewId,
        {
          relativePath: document.relativePath,
          identity: document.identity,
        },
        native,
      );
      if (!current()) return false;
      return this.selectFromSnapshot({
        expectedIdentity: document.identity,
        relativePath: path,
        workspaceId: snapshot.workspaceId,
        viewId: snapshot.viewId,
        revision: snapshot.revision,
      });
    } catch (error) {
      if (current()) this.set({ error: "文書を開けません: " + String(error) });
      return false;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }
  async selectWorkspaceFolder(
    folder: WorkspaceDocument,
    signal?: AbortSignal,
  ): Promise<DocumentSelection | null> {
    const { snapshot } = this.state;
    const validate = this.api.validateWorkspaceFolder;
    if (
      signal?.aborted ||
      !validate ||
      !snapshot.workspaceId ||
      this.stopped ||
      this.state.loading ||
      this.state.actionBusy
    )
      return null;
    this.cancelHistory();
    const generation = ++this.listSelectionGeneration;
    const cancel = () => {
      if (generation === this.listSelectionGeneration) this.cancelWorkspaceSelection();
    };
    signal?.addEventListener("abort", cancel, { once: true });
    const current = () =>
      !signal?.aborted &&
      !this.stopped &&
      generation === this.listSelectionGeneration &&
      snapshot.workspaceId === this.state.snapshot.workspaceId &&
      snapshot.viewId === this.state.snapshot.viewId &&
      snapshot.revision === this.state.snapshot.revision;
    try {
      const path = await validate(snapshot.workspaceId, snapshot.viewId, {
        relativePath: folder.relativePath,
        identity: folder.identity,
      });
      const hasFolder = (nodes: TreeNode[]): boolean =>
        nodes.some(
          (node) =>
            (node.kind === "folder" && node.relativePath === path) || hasFolder(node.children),
        );
      if (!current() || path !== folder.relativePath || !hasFolder(this.state.snapshot.nodes))
        return null;
      return {
        relativePath: path,
        workspaceId: snapshot.workspaceId,
        viewId: snapshot.viewId,
        revision: snapshot.revision,
      };
    } catch (error) {
      if (current()) this.set({ error: "フォルダーを開けません: " + String(error) });
      return null;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }
  cancelWorkspaceSelection() {
    this.cancelHistory();
    this.listSelectionGeneration++;
  }
  documentReady(id: string, url: string) {
    const tab = this.state.tabs.find((tab) => tab.id === id);
    const record = this.requests.get(id);
    if (!tab || !record || tab.closing || tab.url !== url || this.stopped) return;
    record.readyUrl = url;
    this.finishUserAnchor(id);
    this.finishHistory(id);
    void this.recordDisplay(id);
  }
  documentStorageRequested(id: string, url: string) {
    const tab = this.state.tabs.find((tab) => tab.id === id);
    const record = this.requests.get(id);
    if (
      !tab ||
      !record ||
      tab.closing ||
      record.closing ||
      tab.url !== url ||
      this.stopped ||
      record.workspace !== this.state.snapshot.workspaceId ||
      record.view !== this.state.snapshot.viewId
    )
      return;
    this.updateTab(id, { storageRequested: true });
  }
  private async recordDisplay(id: string) {
    this.recordHistoryDisplay(id);
    const tab = this.state.tabs.find((tab) => tab.id === id);
    const record = this.requests.get(id);
    const write = this.api.recordDocumentDisplay;
    if (
      !write ||
      !tab ||
      !record ||
      !record.visitPending ||
      !tab.url ||
      record.readyUrl !== tab.url ||
      tab.closing ||
      tab.missing ||
      tab.error ||
      this.stopped ||
      !this.state.columns.some(
        (visible, column) => visible === id && (column === 0 || this.state.split),
      )
    )
      return;
    record.visitPending = false;
    const url = tab.url;
    try {
      const native = await record.native;
      if (
        this.stopped ||
        this.requests.get(id) !== record ||
        record.closing ||
        this.state.tabs.find((tab) => tab.id === id)?.url !== url
      )
        return;
      await write(record.workspace, record.view, native, url);
      if (
        !this.stopped &&
        record.workspace === this.state.snapshot.workspaceId &&
        record.view === this.state.snapshot.viewId
      )
        void this.refreshWorkspaceLists();
    } catch (error) {
      if (
        !this.stopped &&
        !staleErrors.has(String(error)) &&
        record.workspace === this.state.snapshot.workspaceId &&
        record.view === this.state.snapshot.viewId
      )
        this.set({ error: "最近の文書を保存できません: " + String(error) });
    }
  }
  private setHistory(column: Column, history: NavigationHistory) {
    this.histories = column === 0 ? [history, this.histories[1]] : [this.histories[0], history];
    this.set({});
  }
  private discardHistoryFlight(column: Column) {
    const flight = this.historyFlights[column];
    this.historyFlights[column] = null;
    if (flight?.timeout) clearTimeout(flight.timeout);
    if (flight?.tabId && flight.anchorRequest !== undefined) {
      const record = this.requests.get(flight.tabId);
      this.updateTab(flight.tabId, { navigation: record?.confirmedNavigation });
    }
    if (!flight?.owned || !flight.tabId) return;
    const record = this.requests.get(flight.tabId);
    if (record) {
      record.closing = true;
      this.requests.delete(flight.tabId);
      void this.release(record).catch(() => {});
    }
    this.set({ tabs: this.state.tabs.filter((tab) => tab.id !== flight.tabId) });
  }
  private cancelUserAnchors() {
    const canceled = new Set<string>();
    for (const [id, record] of this.requests)
      if (record.userAnchor) {
        record.userAnchor = undefined;
        canceled.add(id);
      }
    if (canceled.size)
      this.set({
        tabs: this.state.tabs.map((tab) =>
          canceled.has(tab.id)
            ? { ...tab, navigation: this.requests.get(tab.id)?.confirmedNavigation }
            : tab,
        ),
      });
  }
  private cancelHistory() {
    this.cancelUserAnchors();
    this.histories = [...this.histories];
    for (const column of [0, 1] as const) {
      this.discardHistoryFlight(column);
      this.histories[column] = cancelNavigation(this.histories[column]);
    }
  }
  private historyCurrent(flight: HistoryFlight) {
    return (
      !this.stopped &&
      !this.state.loading &&
      !this.state.actionBusy &&
      this.historyFlights[flight.column] === flight &&
      this.histories[flight.column].pending === flight.ticket &&
      this.state.snapshot.workspaceId === flight.workspace &&
      this.state.snapshot.viewId === flight.view &&
      this.state.snapshot.revision === flight.revision &&
      (flight.column === 0 || this.state.split)
    );
  }
  private recordHistoryDisplay(id: string) {
    const tab = this.state.tabs.find((tab) => tab.id === id);
    const record = this.requests.get(id);
    const column = this.state.columns.indexOf(id);
    if (
      !record?.historyVisit ||
      !!record.userAnchor ||
      !tab?.url ||
      record.readyUrl !== tab.url ||
      tab.loading ||
      tab.error ||
      tab.missing ||
      tab.closing ||
      (column !== 0 && (column !== 1 || !this.state.split))
    )
      return;
    record.historyVisit = false;
    this.discardHistoryFlight(column as Column);
    this.setHistory(
      column as Column,
      recordNavigation(this.histories[column], {
        path: tab.path,
        fragment: record.displayFragment ?? "",
      }),
    );
  }
  private finishHistory(id: string) {
    for (const column of [0, 1] as const) {
      const flight = this.historyFlights[column];
      const tab = this.state.tabs.find((tab) => tab.id === id);
      const record = this.requests.get(id);
      if (
        !flight ||
        flight.tabId !== id ||
        !tab ||
        !record ||
        !this.historyCurrent(flight) ||
        tab.url !== flight.url ||
        record.readyUrl !== tab.url ||
        tab.loading
      )
        continue;
      if (flight.ticket.target.fragment && flight.anchorResult === undefined) return;
      if (flight.anchorResult === false) {
        this.setHistory(column, failNavigation(this.histories[column], flight.ticket));
        this.discardHistoryFlight(column);
        this.set({ error: "履歴のfragmentが見つかりません" });
        return;
      }
      this.historyFlights[column] = null;
      clearTimeout(flight.timeout);
      record.displayFragment = flight.ticket.target.fragment;
      const navigation = {
        fragment: flight.ticket.target.fragment,
        request: ++this.linkNavigation,
      };
      record.confirmedNavigation = navigation;
      record.historyVisit = false;
      record.visitPending = true;
      const columns: [string | null, string | null] = [...this.state.columns];
      columns[column] = id;
      const history = commitNavigation(this.histories[column], flight.ticket);
      this.histories = column === 0 ? [history, this.histories[1]] : [this.histories[0], history];
      this.set({
        columns,
        activeColumn: column,
        tabs: this.state.tabs.map((tab) =>
          tab.id === id ? { ...tab, navigation: record.confirmedNavigation } : tab,
        ),
        error: null,
      });
      void this.recordDisplay(id);
    }
  }
  documentAnchorResult(id: string, url: string, request: number, success: boolean) {
    if (this.state.tabs.find((tab) => tab.id === id)?.url !== url) return;
    const flight = this.historyFlights.find(
      (flight) => flight?.tabId === id && flight.url === url && flight.anchorRequest === request,
    );
    if (!flight || !this.historyCurrent(flight)) {
      const record = this.requests.get(id);
      if (record?.userAnchor?.request !== request) return;
      record.userAnchor.success = success;
      this.finishUserAnchor(id);
      return;
    }
    flight.anchorResult = success;
    this.finishHistory(id);
  }
  private finishUserAnchor(id: string) {
    const tab = this.state.tabs.find((tab) => tab.id === id);
    const record = this.requests.get(id);
    const anchor = record?.userAnchor;
    if (!tab?.url || !record || record.readyUrl !== tab.url || anchor?.success === undefined)
      return;
    record.userAnchor = undefined;
    if (anchor.success) {
      record.displayFragment = anchor.fragment;
      record.confirmedNavigation = tab.navigation;
    } else {
      this.updateTab(id, { navigation: record.confirmedNavigation });
      this.set({ error: "fragmentが見つかりません" });
    }
    record.historyVisit = true;
    this.recordHistoryDisplay(id);
  }
  async navigateHistory(direction: "back" | "forward", column: Column = this.state.activeColumn) {
    const snapshot = this.state.snapshot;
    if (
      !snapshot.workspaceId ||
      this.stopped ||
      this.state.loading ||
      this.state.actionBusy ||
      (column === 1 && !this.state.split)
    )
      return;
    this.cancelUserAnchors();
    const prepared = prepareNavigation(this.histories[column], direction);
    if (!prepared.request) return;
    this.discardHistoryFlight(column);
    this.setHistory(column, prepared.history);
    const flight: HistoryFlight = {
      ticket: prepared.request,
      column,
      workspace: snapshot.workspaceId,
      view: snapshot.viewId,
      revision: snapshot.revision,
    };
    this.historyFlights[column] = flight;
    flight.timeout = setTimeout(() => {
      if (this.historyFlights[column] !== flight) return;
      this.setHistory(column, failNavigation(this.histories[column], flight.ticket));
      this.discardHistoryFlight(column);
      this.set({ error: "履歴の表示確認が完了しませんでした" });
    }, 15000);
    const current = () => this.historyCurrent(flight);
    try {
      const validate = this.api.validateDocumentNavigation;
      if (!validate) throw new Error("この環境では履歴移動を利用できません");
      const target = prepared.request.target;
      const existing = this.state.tabs.find(
        (tab) =>
          tab.path === target.path &&
          !tab.closing &&
          (this.state.split ? (tab.column ?? 0) : 0) === column,
      );
      const record = existing && this.requests.get(existing.id);
      if (existing?.loading) throw new Error("文書の読み込み完了後にもう一度お試しください");
      const document = await validate(
        flight.workspace,
        flight.view,
        target.path,
        target.fragment,
        existing?.url ? record?.nativeId : undefined,
      );
      if (!current()) return;
      if (
        document.relativePath !== target.path ||
        (record?.lazyDocument && record.lazyDocument.identity !== document.identity)
      )
        throw new Error("DocumentChanged");
      let id = existing?.id;
      if (!id) {
        id = `tab-${++nextTab}`;
        const request: TabRequest = {
          workspace: flight.workspace,
          view: flight.view,
          native: Promise.resolve(""),
          registered: false,
          request: 0,
          closing: false,
          registrationFailed: false,
          registrationPath: target.path,
          expectedIdentity: document.identity,
        };
        this.requests.set(id, request);
        flight.owned = true;
        flight.tabId = id;
        this.set({
          tabs: [
            ...this.state.tabs,
            {
              id,
              column,
              path: target.path,
              url: null,
              loading: false,
              closing: false,
              dirty: true,
              missing: false,
              error: null,
            },
          ],
        });
      }
      flight.tabId = id;
      if (!existing?.url) await this.reload(id, "history");
      if (!current()) return;
      const tab = this.state.tabs.find((tab) => tab.id === id);
      if (!tab?.url || tab.error) throw new Error(tab?.error ?? "文書を読み取れません");
      flight.url = tab.url;
      try {
        decodeURIComponent(target.fragment.slice(1));
      } catch {
        throw new Error("fragmentが無効です");
      }
      flight.anchorRequest = ++this.linkNavigation;
      this.updateTab(id, {
        navigation: { fragment: target.fragment, request: flight.anchorRequest },
      });
      this.finishHistory(id);
    } catch (error) {
      if (!current()) return;
      this.setHistory(column, failNavigation(this.histories[column], prepared.request));
      this.discardHistoryFlight(column);
      this.set({ error: "履歴を開けません: " + String(error) });
    }
  }
  reorderTab(id: string, anchor: string, after = false) {
    this.cancelWorkspaceSelection();
    const source = this.state.tabs.find((tab) => tab.id === id);
    const target = this.state.tabs.find((tab) => tab.id === anchor);
    if (!source || !target || source.closing || target.closing || id === anchor) return;
    if (this.state.split && (source.column ?? 0) !== (target.column ?? 0)) return;
    const tabs = this.state.tabs.filter((tab) => tab.id !== id);
    const index = tabs.findIndex((tab) => tab.id === anchor) + Number(after);
    tabs.splice(index, 0, source);
    this.set({ tabs });
  }
  setActiveColumn(column: Column) {
    if (column !== this.state.activeColumn && (column === 0 || this.state.split)) {
      this.cancelWorkspaceSelection();
      this.set({ activeColumn: column });
    }
  }
  focusTab(id: string) {
    const column = this.state.columns.indexOf(id);
    if (column === 0 || (this.state.split && column === 1)) this.setActiveColumn(column as Column);
  }
  toggleSplit() {
    this.cancelWorkspaceSelection();
    this.histories = [this.histories[0], createNavigationHistory()];
    if (this.state.split) {
      this.set({ split: false, columns: [this.state.columns[0], null], activeColumn: 0 });
    } else {
      this.collapsedColumn = 0;
      const candidates = [...this.state.tabs]
        .reverse()
        .filter((tab) => tab.id !== this.state.columns[0] && !tab.closing);
      const other = candidates.find((tab) => tab.column === 1) ?? candidates[0];
      this.set({
        split: true,
        columns: [this.state.columns[0], other?.id ?? null],
        tabs: this.state.tabs.map((tab) => (tab.id === other?.id ? { ...tab, column: 1 } : tab)),
      });
      if (other?.dirty && other.url === null && !other.missing) void this.reload(other.id);
    }
  }
  swapColumns() {
    this.cancelWorkspaceSelection();
    if (this.state.split) this.histories = [this.histories[1], this.histories[0]];
    if (this.state.split)
      this.set({
        columns: [this.state.columns[1], this.state.columns[0]],
        activeColumn: this.state.activeColumn === 0 ? 1 : 0,
        tabs: this.state.tabs.map((tab) => ({ ...tab, column: (tab.column ?? 0) === 0 ? 1 : 0 })),
      });
  }
  moveToOtherColumn(id: string) {
    const tab = this.state.tabs.find((item) => item.id === id);
    if (!tab || tab.closing) return;
    this.moveTab(id, this.state.split && tab.column === 1 ? 0 : 1);
  }
  moveTab(id: string, column: Column, anchor?: string, after = false) {
    this.cancelWorkspaceSelection();
    const source = this.state.tabs.find((tab) => tab.id === id);
    const target = anchor ? this.state.tabs.find((tab) => tab.id === anchor) : undefined;
    if (!source || source.closing || anchor === id) return;
    if (
      anchor &&
      (!target || target.closing || (this.state.split ? (target.column ?? 0) : 0) !== column)
    )
      return;
    const sourceColumn: Column = this.state.split ? (source.column ?? 0) : 0;
    if (sourceColumn === column) {
      if (anchor) this.reorderTab(id, anchor, after);
      return;
    }
    // Moving a view changes presentation only. Even a same-path target remains
    // a separate retained view with its own Native grant and running iframe.
    const tabs = this.state.tabs
      .filter((tab) => tab.id !== id)
      .map((tab) => (this.state.split ? tab : { ...tab, column: 0 as Column }));
    const moved = { ...source, column };
    const lastTarget = tabs.map((tab) => tab.column ?? 0).lastIndexOf(column);
    const index = anchor
      ? tabs.findIndex((tab) => tab.id === anchor) + Number(after)
      : lastTarget >= 0
        ? lastTarget + 1
        : tabs.length;
    tabs.splice(index, 0, moved);
    const columns: [string | null, string | null] = [...this.state.columns];
    if (columns[sourceColumn] === id) {
      const originalIndex = this.state.tabs.findIndex((tab) => tab.id === id);
      const neighbors = [
        ...this.state.tabs.slice(originalIndex + 1),
        ...this.state.tabs.slice(0, originalIndex).reverse(),
      ];
      columns[sourceColumn] =
        neighbors.find(
          (tab) => !tab.closing && (this.state.split ? (tab.column ?? 0) : 0) === sourceColumn,
        )?.id ?? null;
    }
    columns[column] = id;
    this.set({
      split: true,
      columns,
      activeColumn: column,
      tabs,
    });
    this.collapseEmptyColumn();
    this.reloadExposedTabs();
    for (const visible of this.state.columns) {
      const record = visible && this.requests.get(visible);
      if (record) {
        record.historyVisit = true;
        void this.recordDisplay(visible!);
      }
    }
  }
  private collapseEmptyColumn() {
    if (!this.state.split) {
      this.set({ tabs: this.state.tabs.map((tab) => ({ ...tab, column: 0 })) });
      return;
    }
    const hasLeft = this.state.tabs.some((tab) => (tab.column ?? 0) === 0);
    const hasRight = this.state.tabs.some((tab) => tab.column === 1);
    if (hasLeft && hasRight) return;
    const survivingColumn: Column = hasRight ? 1 : 0;
    this.collapsedColumn = survivingColumn;
    this.histories = [this.histories[survivingColumn], createNavigationHistory()];
    const visible = this.state.columns[survivingColumn];
    this.set({
      split: false,
      activeColumn: 0,
      columns: [visible, null],
      tabs: this.state.tabs.map((tab) => ({ ...tab, column: 0 })),
    });
  }
  private reloadExposedTabs() {
    for (const id of this.state.columns) {
      const tab = this.state.tabs.find((item) => item.id === id);
      if (
        tab?.url === null &&
        tab.dirty &&
        !tab.missing &&
        !tab.error &&
        !tab.loading &&
        !tab.closing
      )
        void this.reload(tab.id);
    }
  }
  zoomTab(id: string, change: DocumentZoomInput) {
    this.cancelWorkspaceSelection();
    const tab = this.state.tabs.find((tab) => tab.id === id && !tab.closing && !tab.missing);
    if (!tab?.url || this.stopped) return;
    const current = tab.zoom ?? 100;
    const gesture = typeof change === "object" ? change : null;
    if (
      gesture &&
      (!Number.isFinite(gesture.factor) ||
        gesture.factor < 0.1 ||
        gesture.factor > 10 ||
        !Number.isFinite(gesture.x) ||
        !Number.isFinite(gesture.y) ||
        gesture.x < 0 ||
        gesture.x > 1 ||
        gesture.y < 0 ||
        gesture.y > 1)
    )
      return;
    // Pinch keeps its continuous scale; a key/menu goes to the next fixed 25% step.
    const proposed = gesture
      ? current * gesture.factor
      : change === "reset"
        ? 100
        : change === "in"
          ? (Math.floor(current / 25) + 1) * 25
          : (Math.ceil(current / 25) - 1) * 25;
    const zoom = Math.max(50, Math.min(200, proposed));
    if (zoom === current && gesture) return;
    // Even reset at 100% must reach the frame to invalidate pending pinch work.
    this.set({
      tabs: this.state.tabs.map((tab) =>
        tab.id === id
          ? {
              ...tab,
              zoom,
              zoomAnchor: gesture ? { x: gesture.x, y: gesture.y } : undefined,
              zoomRequest: (tab.zoomRequest ?? 0) + 1,
            }
          : tab,
      ),
    });
  }
  private linkSource(id: string, sourceUrl: string) {
    return this.state.tabs.find(
      (tab) => tab.id === id && tab.url === sourceUrl && !tab.closing && !tab.missing,
    );
  }
  async resolveDocumentLink(
    id: string,
    sourceUrl: string,
    href: string,
  ): Promise<DocumentLinkTarget | null> {
    const { snapshot } = this.state;
    if (
      !snapshot.workspaceId ||
      !this.linkSource(id, sourceUrl) ||
      this.stopped ||
      this.state.loading
    )
      return null;
    const current = () =>
      !this.stopped &&
      this.state.snapshot.workspaceId === snapshot.workspaceId &&
      this.state.snapshot.viewId === snapshot.viewId &&
      !!this.linkSource(id, sourceUrl);
    try {
      if (!this.api.resolveDocumentLink) throw new Error("この環境ではリンク移動を利用できません");
      const target = await this.api.resolveDocumentLink(
        snapshot.workspaceId,
        snapshot.viewId,
        sourceUrl,
        href,
      );
      return current() ? target : null;
    } catch (error) {
      if (current()) this.set({ error: "リンクを開けません: " + String(error) });
      return null;
    }
  }
  async followDocumentLink(
    id: string,
    sourceUrl: string,
    target: Exclude<DocumentLinkTarget, { kind: "external" }>,
  ) {
    const { snapshot } = this.state;
    if (!this.linkSource(id, sourceUrl) || this.stopped || this.state.loading) return;
    const column = this.state.columns.indexOf(id);
    if (column !== 0 && (column !== 1 || !this.state.split)) return;
    if (target.kind === "document") {
      const display = this.select(target.relativePath, column as Column);
      const generation = this.listSelectionGeneration;
      await display;
      if (generation !== this.listSelectionGeneration) return;
    }
    if (
      this.stopped ||
      this.state.snapshot.workspaceId !== snapshot.workspaceId ||
      this.state.snapshot.viewId !== snapshot.viewId ||
      !this.linkSource(id, sourceUrl)
    )
      return;
    const targetId = target.kind === "page" ? id : this.state.columns[column];
    const tab = this.state.tabs.find((tab) => tab.id === targetId && !tab.closing);
    if (!tab || (target.kind === "document" && tab.path !== target.relativePath)) return;
    const navigation = { fragment: target.fragment, request: ++this.linkNavigation };
    const record = this.requests.get(tab.id);
    if (record) record.userAnchor = { request: navigation.request, fragment: target.fragment };
    this.set({
      tabs: this.state.tabs.map((tab) => (tab.id === targetId ? { ...tab, navigation } : tab)),
    });
  }

  async openExternalDocumentLink(id: string, sourceUrl: string, href: string): Promise<boolean> {
    const { snapshot } = this.state;
    if (
      !snapshot.workspaceId ||
      !this.linkSource(id, sourceUrl) ||
      this.stopped ||
      this.state.loading ||
      this.state.actionBusy
    )
      return false;
    const generation = ++this.actionGeneration;
    const current = () =>
      !this.stopped &&
      generation === this.actionGeneration &&
      this.state.snapshot.workspaceId === snapshot.workspaceId &&
      this.state.snapshot.viewId === snapshot.viewId;
    this.set({ actionBusy: true, actionMessage: null, error: null });
    try {
      if (!this.api.openExternalDocumentLink)
        throw new Error("この環境では外部リンクを利用できません");
      await this.api.openExternalDocumentLink(
        snapshot.workspaceId,
        snapshot.viewId,
        sourceUrl,
        href,
      );
      if (!current()) return false;
      this.set({ actionMessage: "既定ブラウザーへ外部リンクの表示を依頼しました" });
      return true;
    } catch (error) {
      if (current()) this.set({ error: "外部リンクを開けません: " + String(error) });
      return false;
    } finally {
      if (current()) this.set({ actionBusy: false });
    }
  }
  async openInColumn(path: string, column: Column) {
    await this.select(path, column);
  }
  selectFromSnapshot(selection: DocumentSelection): boolean {
    const { snapshot } = this.state;
    // A displayed candidate is only a reference to this tree generation. Native
    // create/open still validate the root, file identity and grant at admission.
    if (
      this.stopped ||
      this.state.loading ||
      this.state.actionBusy ||
      snapshot.workspaceId !== selection.workspaceId ||
      snapshot.viewId !== selection.viewId ||
      snapshot.revision !== selection.revision ||
      !contains(snapshot.nodes, selection.relativePath)
    )
      return false;
    void this.select(selection.relativePath, this.state.activeColumn, selection.expectedIdentity);
    return true;
  }
  async select(path: string, column: Column = this.state.activeColumn, expectedIdentity?: string) {
    this.cancelWorkspaceSelection();
    const { snapshot } = this.state;
    if (
      this.stopped ||
      this.state.loading ||
      !snapshot.workspaceId ||
      !contains(snapshot.nodes, path)
    )
      return;
    if (column === 1 && !this.state.split) {
      this.collapsedColumn = 0;
      this.set({
        split: true,
        tabs: this.state.tabs.map((tab) => ({ ...tab, column: 0 })),
      });
    }
    const candidates = this.state.tabs.filter(
      (tab) =>
        !tab.closing && tab.path === path && (!this.state.split || (tab.column ?? 0) === column),
    );
    const existing =
      candidates.find((tab) => tab.id === this.state.columns[column]) ?? candidates[0];
    if (existing) {
      this.activate(existing.id, column);
      if (existing.missing) await this.reload(existing.id);
      return;
    }
    const id = `tab-${++nextTab}`;
    const record: TabRequest = {
      workspace: snapshot.workspaceId,
      view: snapshot.viewId,
      native: Promise.resolve(""),
      registered: false,
      request: 0,
      closing: false,
      registrationFailed: false,
      registrationPath: path,
      expectedIdentity,
    };
    this.register(record, path);
    this.requests.set(id, record);
    this.set({
      tabs: [
        ...this.state.tabs,
        {
          id,
          column,
          path,
          url: null,
          loading: true,
          closing: false,
          dirty: false,
          missing: false,
          error: null,
        },
      ],
    });
    this.activate(id, column);
    await this.reload(id);
  }
  private register(record: TabRequest, path: string) {
    record.registered = true;
    record.nativeId = undefined;
    record.registrationFailed = false;
    record.sessionAdmitted = false;
    record.registrationPath = path;
    const registration = record.expectedIdentity
      ? this.api.createTab(record.workspace, record.view, path, record.expectedIdentity)
      : this.api.createTab(record.workspace, record.view, path);
    record.native = registration
      .then((native) => {
        record.nativeId = native;
        return native;
      })
      .catch((error) => {
        record.registrationFailed = true;
        throw error;
      });
  }
  async reload(id: string, reason: ReloadReason = "background") {
    if (reason !== "history") this.cancelHistory();
    const tab = this.state.tabs.find((item) => item.id === id);
    const record = this.requests.get(id);
    if (!tab || !record || record.closing || this.stopped) return;
    if (!record.registered && !this.visible(id) && reason !== "history") return;
    if (!record.registered || record.registrationFailed) this.register(record, tab.path);
    const request = ++record.request;
    const revision = this.state.snapshot.revision;
    this.updateTab(id, { loading: true, error: null, missing: false });
    try {
      const native = await record.native;
      if (
        this.stopped ||
        record.closing ||
        this.requests.get(id) !== record ||
        request !== record.request
      )
        return;
      const url = await this.api.openDocument(record.workspace, record.view, native, request);
      if (
        this.stopped ||
        record.closing ||
        this.requests.get(id) !== record ||
        request !== record.request
      )
        return;
      record.expectedIdentity = undefined;
      record.lazyDocument = undefined;
      record.sessionAdmitted = true;
      this.updateTab(id, {
        url,
        deferred: false,
        dirty: this.state.snapshot.revision > revision,
        storageRequested: false,
        storageHold: undefined,
      });
      void this.checkDocumentStorage(id, record, native, request, url);
    } catch (error) {
      const latest = this.state.tabs.find((item) => item.id === id);
      if (
        this.requests.get(id) === record &&
        request === record.request &&
        !record.closing &&
        record.registrationFailed &&
        latest &&
        record.registrationPath !== latest.path
      ) {
        await this.reload(id);
        return;
      }
      if (
        this.requests.get(id) === record &&
        request === record.request &&
        !record.closing &&
        !staleErrors.has(String(error))
      ) {
        this.updateTab(id, { error: String(error), url: null });
        this.set({ error: String(error) });
      }
    } finally {
      if (this.requests.get(id) === record && request === record.request)
        this.updateTab(id, { loading: false });
    }
  }
  private async checkDocumentStorage(
    id: string,
    record: TabRequest,
    native: string,
    request: number,
    url: string,
  ) {
    const check = this.api.getDocumentStorageHold;
    const tab = this.state.tabs.find((item) => item.id === id);
    if (!check || !tab) return;
    const path = tab.path;
    const current = () => {
      const latest = this.state.tabs.find((item) => item.id === id);
      return (
        !this.stopped &&
        !record.closing &&
        this.requests.get(id) === record &&
        record.nativeId === native &&
        record.request === request &&
        record.workspace === this.state.snapshot.workspaceId &&
        record.view === this.state.snapshot.viewId &&
        latest?.path === path &&
        latest.url === url
      );
    };
    try {
      // The admitted grant keeps its original hold even if current DB authority
      // changes. HTML may stop initializing when its restoration is rejected.
      const storageHold = await check(record.workspace, record.view, native, request);
      if (current()) this.updateTab(id, { storageHold: storageHold ?? undefined });
    } catch (error) {
      if (current())
        this.updateTab(id, {
          storageHold: { reason: error instanceof Error ? error.message : String(error) },
        });
    }
  }
  async closeTabsToRight(id: string) {
    const index = this.state.tabs.findIndex((tab) => tab.id === id);
    const anchor = this.state.tabs[index];
    if (!anchor || anchor.closing || this.stopped) return;
    const column = this.state.split ? (anchor.column ?? 0) : 0;
    const targets = this.state.tabs
      .slice(index + 1)
      .filter((tab) => !tab.closing && (this.state.split ? (tab.column ?? 0) : 0) === column)
      .reverse();
    // Start every close before awaiting: pending targets must not become exposed
    // replacements and register/load a placeholder that is about to be removed.
    await Promise.all(targets.map((tab) => this.closeTab(tab.id)));
    const targetIds = new Set(targets.map((tab) => tab.id));
    const failed = this.state.tabs.find((tab) => tab.error && targetIds.has(tab.id));
    if (failed && !this.stopped) this.set({ error: "タブを閉じられません: " + failed.error });
  }
  async closeTab(id: string) {
    this.cancelWorkspaceSelection();
    const record = this.requests.get(id);
    const tab = this.state.tabs.find((item) => item.id === id);
    if (tab?.kind === "help") {
      if (tab.closing || this.stopped) return;
      this.updateTab(id, { closing: true });
      // Let a bulk close claim every target before exposing a replacement.
      // Help needs no Native release, but must share that scheduling boundary.
      await Promise.resolve();
      const current = this.state.tabs.find((item) => item.id === id);
      if (!this.stopped && current?.kind === "help" && current.closing) this.finishClose(current);
      return;
    }
    if (!record || !tab || record.closing) return;
    record.closing = true;
    this.updateTab(id, { closing: true });
    try {
      await this.release(record);
      if (this.stopped || this.requests.get(id) !== record) return;
      this.requests.delete(id);
      const closedTab = this.state.tabs.find((item) => item.id === id)!;
      // Keep the pre-close column for history: another concurrent close may
      // collapse the surviving column while the Native release is pending.
      this.finishClose(closedTab, tab.column ?? 0);
    } catch (error) {
      if (this.stopped || this.requests.get(id) !== record) return;
      record.closing = false;
      this.updateTab(id, { closing: false, error: String(error) });
      this.set({ error: "タブを閉じられません: " + String(error) });
    }
  }
  private finishClose(tab: DocumentTab, closedColumn: Column = tab.column ?? 0) {
    const id = tab.id;
    const tabs = this.state.tabs.filter((item) => item.id !== id);
    const columns: [string | null, string | null] = [...this.state.columns];
    const column = columns.indexOf(id);
    if (column >= 0) {
      const index = this.state.tabs.findIndex((item) => item.id === id);
      const neighbors = [
        ...this.state.tabs.slice(index + 1),
        ...this.state.tabs.slice(0, index).reverse(),
      ];
      const replacement = neighbors.find(
        (item) =>
          !columns.includes(item.id) &&
          !item.closing &&
          (!this.state.split || (item.column ?? 0) === column),
      );
      columns[column as Column] = replacement?.id ?? null;
    }
    this.set({
      tabs: tabs.map((item) => {
        const visible = columns.indexOf(item.id);
        return visible >= 0 ? { ...item, column: visible as Column } : item;
      }),
      columns,
      closed:
        tab.kind === "help"
          ? this.state.closed
          : [{ path: tab.path, column: closedColumn }, ...this.state.closed].slice(0, 10),
      error: null,
    });
    this.collapseEmptyColumn();
    this.reloadExposedTabs();
  }
  async reopen() {
    if (this.stopped || this.state.loading || !this.state.snapshot.workspaceId) return;
    const index = this.state.closed.findIndex((tab) =>
      contains(this.state.snapshot.nodes, tab.path),
    );
    const tab = this.state.closed[index];
    // Consume skipped missing entries and the selected view exactly once. A
    // same-column existing view is focused instead of creating another grant.
    this.set({ closed: index < 0 ? [] : this.state.closed.slice(index + 1) });
    if (!tab) return;
    if (
      !this.state.split &&
      this.state.tabs.length &&
      this.collapsedColumn === 1 &&
      tab.column === 0
    ) {
      this.set({
        split: true,
        columns: [null, this.state.columns[0]],
        tabs: this.state.tabs.map((item) => ({ ...item, column: 1 })),
      });
      this.collapsedColumn = 0;
    }
    await this.select(tab.path, this.state.tabs.length ? tab.column : 0);
  }
}
