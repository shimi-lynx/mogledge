import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TreeNode, FileAction, TreeMutation, PathMove } from "../../lib/types";
import { useT } from "../../lib/i18n";
import { FileContextMenu } from "./FileContextMenu";
import { MutationDialog, type MutationIntent } from "./MutationDialog";
import { displayedNodes, htmlNameParts, renamedHtmlPath, treeLabel, visibleRows } from "./model";
import { FolderIcon } from "./FolderIcon";
import { CreationIcon } from "./CreationIcon";
import { TrashDialog } from "./TrashDialog";
import { rootCreationLabels } from "./rootCreationLabels";
import { useTreeExpansion } from "./expansion";

const ROW_HEIGHT = 32;
type TreeFocusRequest = {
  path: string;
  id: number;
  workspaceId: string;
  viewId: string;
  revision: number;
};
export function KnowledgeTree({
  nodes,
  workspaceId,
  rootPath,
  displayFolder = "",
  viewId,
  selected,
  onSelect,
  onFileAction,
  onOpenColumn,
  onRecoverState,
  onStateTransfer,
  onAiHandoff,
  favoritePaths,
  onFavorite,
  onSearchFolder,
  actionBusy = false,
  onMutation,
  pathMoves,
  focusRequest,
  revision = 0,
  onTrash,
  headerContent,
  hideFiles = false,
  treeReady = true,
}: {
  nodes: TreeNode[];
  workspaceId: string | null;
  rootPath?: string | null;
  displayFolder?: string;
  viewId?: string;
  selected: string | null;
  onSelect: (path: string) => void;
  onFileAction?: (path: string, action: FileAction) => void;
  onOpenColumn?: (path: string, column: 0 | 1) => void;
  onRecoverState?: (path: string) => void;
  onStateTransfer?: (path: string, kind: "import" | "export") => void;
  onAiHandoff?: (path: string, returnFocus: HTMLElement | null) => void;
  favoritePaths?: readonly string[];
  onFavorite?: (path: string, add: boolean) => void;
  onSearchFolder?: (path: string) => void;
  actionBusy?: boolean;
  onMutation?: (mutation: TreeMutation) => Promise<string | null>;
  pathMoves?: PathMove[];
  focusRequest?: TreeFocusRequest;
  revision?: number;
  onTrash?: (source: string, revision: number) => Promise<string | null>;
  headerContent?: ReactNode;
  hideFiles?: boolean;
  treeReady?: boolean;
}) {
  const t = useT();
  const { expanded, setExpanded, reconcileExpanded } = useTreeExpansion(
    rootPath,
    workspaceId,
    nodes,
  );
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(500);
  const [focused, setFocused] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const [intent, setIntent] = useState<MutationIntent | null>(null);
  const [trash, setTrash] = useState<{ node: TreeNode; revision: number } | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ path: string; place: "before" | "after" | "inside" } | null>(
    null,
  );
  const drag = useRef<string | null>(null);
  const moveRevision = useRef(0);
  const pendingFocus = useRef<string | null>(null);
  const pendingTreeFocus = useRef<TreeFocusRequest | null>(null);
  const appliedFocusRequest = useRef<{ workspaceId: string | null; id: number } | null>(null);
  const submitting = useRef(false);
  const container = useRef<HTMLDivElement>(null);
  const rows = useMemo(
    () => visibleRows(displayedNodes(nodes, displayFolder), expanded),
    [nodes, displayFolder, expanded],
  );
  useEffect(() => {
    setFocused(null);
    setMenu(null);
    setIntent(null);
    setTrash(null);
    drag.current = null;
    setDragged(null);
    setDrop(null);
    moveRevision.current = 0;
    appliedFocusRequest.current = null;
    pendingTreeFocus.current = null;
    setScrollTop(0);
    if (container.current) container.current.scrollTop = 0;
  }, [workspaceId, displayFolder]);
  useEffect(() => {
    const fresh = (pathMoves ?? []).filter((move) => move.revision > moveRevision.current);
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
    setExpanded((previous) => new Set([...previous].map(map)));
    setFocused((previous) => (previous ? map(previous) : null));
    moveRevision.current = Math.max(...fresh.map((move) => move.revision));
  }, [pathMoves]);
  useEffect(() => {
    // Apply confirmed path moves first, then prune against the complete registered-root tree.
    // The initial empty/loading snapshot must never replace the saved expansion.
    if (workspaceId && treeReady) reconcileExpanded();
  }, [workspaceId, treeReady, reconcileExpanded]);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (container.current?.querySelector('[role="menu"]')?.contains(document.activeElement))
      container.current.focus();
    setMenu(null);
    setFocused((previous) => {
      const exists = (items: TreeNode[]): boolean =>
        items.some((node) => node.relativePath === previous || exists(node.children));
      // A moved/collapsed folder may temporarily hide a valid focused child.
      // Only a genuinely missing path needs a replacement focus target.
      return previous && !exists(nodes) ? (nodes[0]?.relativePath ?? null) : previous;
    });
  }, [nodes]);
  useEffect(() => {
    if (
      !focusRequest ||
      !workspaceId ||
      focusRequest.workspaceId !== workspaceId ||
      focusRequest.viewId !== viewId ||
      focusRequest.revision !== revision ||
      (appliedFocusRequest.current?.workspaceId === workspaceId &&
        appliedFocusRequest.current.id === focusRequest.id)
    )
      return;
    const findFolder = (items: TreeNode[]): TreeNode | undefined => {
      for (const node of items) {
        if (node.relativePath === focusRequest.path && node.kind === "folder") return node;
        const child = findFolder(node.children);
        if (child) return child;
      }
    };
    const folder = findFolder(nodes);
    if (!folder) return;
    appliedFocusRequest.current = { workspaceId, id: focusRequest.id };
    pendingFocus.current = folder.relativePath;
    pendingTreeFocus.current = focusRequest;
    setFocused(folder.relativePath);
    setExpanded((previous) => {
      const next = new Set(previous);
      const parts = folder.relativePath.split("/");
      for (let index = 1; index <= parts.length; index++) next.add(parts.slice(0, index).join("/"));
      return next;
    });
  }, [focusRequest, nodes, workspaceId, viewId, revision]);
  const closeMenu = (restoreFocus: boolean) => {
    setMenu(null);
    if (restoreFocus) container.current?.focus();
  };
  const openMenu = (path: string, x: number, y: number) => {
    if (
      !onFileAction &&
      !onMutation &&
      !onOpenColumn &&
      !onRecoverState &&
      !onTrash &&
      !onAiHandoff &&
      !onSearchFolder
    )
      return;
    setFocused(path);
    setMenu({ path, x, y });
  };
  const toggle = (path: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");
  const requestTrash = (path: string) => {
    if (actionBusy || submitting.current || intent || trash || !workspaceId) return;
    const node = rows.find((row) => row.node.relativePath === path)?.node;
    if (node) setTrash({ node, revision });
  };
  const siblings = (path: string) =>
    rows.filter((row) => parentOf(row.node.relativePath) === parentOf(path));
  const request = (
    path: string,
    action: "createHtml" | "createFolder" | "renameHtml" | "move" | "up" | "down",
  ) => {
    if (actionBusy || submitting.current) return;
    const node = rows.find((row) => row.node.relativePath === path)?.node;
    if (action === "renameHtml") {
      if (node?.kind === "html")
        setIntent({ kind: action, source: path, name: htmlNameParts(node.name).basename });
      return;
    }
    if (action === "createHtml" || action === "createFolder") {
      setIntent({
        kind: action,
        parent: node?.kind === "folder" || path === displayFolder ? path : parentOf(path),
      });
      return;
    }
    if (action === "move") {
      setIntent({ kind: action, source: path, parent: parentOf(path) });
      return;
    }
    const list = siblings(path);
    const index = list.findIndex((row) => row.node.relativePath === path);
    const target = list[index + (action === "up" ? -1 : 1)];
    if (target)
      void submit({
        kind: "reorder",
        source: path,
        anchor: target.node.relativePath,
        after: action === "down",
      });
  };
  const submit = async (mutation: TreeMutation) => {
    if (actionBusy || submitting.current) return "別の操作が完了するまでお待ちください";
    submitting.current = true;
    let error: string | null;
    try {
      error = (await onMutation?.(mutation)) ?? null;
    } finally {
      submitting.current = false;
    }
    if (!error) {
      const path =
        mutation.kind === "createHtml"
          ? (mutation.parent ? mutation.parent + "/" : "") +
            (/\.html$/i.test(mutation.name) ? mutation.name : mutation.name + ".html")
          : mutation.kind === "createFolder"
            ? (mutation.parent ? mutation.parent + "/" : "") + mutation.name
            : mutation.kind === "renameHtml"
              ? renamedHtmlPath(mutation.source, mutation.name)
              : mutation.kind === "move"
                ? (mutation.parent ? mutation.parent + "/" : "") + mutation.source.split("/").pop()
                : mutation.source;
      pendingFocus.current = path;
      setFocused(path);
      setExpanded((previous) => {
        const next = new Set(previous);
        const parts = parentOf(path).split("/").filter(Boolean);
        for (let i = 1; i <= parts.length; i++) next.add(parts.slice(0, i).join("/"));
        return next;
      });
    }
    return error;
  };
  useLayoutEffect(() => {
    const path = pendingFocus.current;
    if (!path) return;
    const request = pendingTreeFocus.current;
    // A view refresh can arrive after expansion but before the virtual row is exposed.
    if (
      request &&
      (!focusRequest ||
        request.id !== focusRequest.id ||
        request.path !== focusRequest.path ||
        request.workspaceId !== focusRequest.workspaceId ||
        request.viewId !== focusRequest.viewId ||
        request.revision !== focusRequest.revision ||
        request.workspaceId !== workspaceId ||
        request.viewId !== viewId ||
        request.revision !== revision)
    ) {
      pendingFocus.current = null;
      pendingTreeFocus.current = null;
      setFocused((previous) => (previous === path ? null : previous));
      return;
    }
    const index = rows.findIndex((row) => row.node.relativePath === path);
    if (index < 0) return;
    pendingFocus.current = null;
    const element = container.current;
    if (!element) return;
    const top = index * ROW_HEIGHT;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + ROW_HEIGHT > element.scrollTop + height)
      element.scrollTop = top + ROW_HEIGHT - height;
    setScrollTop(element.scrollTop);
    if (pendingTreeFocus.current) {
      pendingTreeFocus.current = null;
      element.focus();
    }
  }, [rows, focused, height, focusRequest, workspaceId, viewId, revision]);
  const activate = (index: number) => {
    const row = rows[index];
    if (!row) return;
    setFocused(row.node.relativePath);
    const element = container.current;
    if (element) {
      const top = index * ROW_HEIGHT;
      if (top < element.scrollTop) element.scrollTop = top;
      else if (top + ROW_HEIGHT > element.scrollTop + height)
        element.scrollTop = top + ROW_HEIGHT - height;
    }
  };
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 6);
  const end = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + 6);
  const menuNode = menu ? rows.find((row) => row.node.relativePath === menu.path)?.node : null;
  const menuSiblings = menu ? siblings(menu.path) : [];
  const menuIndex = menuSiblings.findIndex((row) => row.node.relativePath === menu?.path);
  const creationUnavailable = !workspaceId
    ? "作業フォルダーを選択してください"
    : actionBusy
      ? "操作中のため作成できません"
      : "";
  const creation = rootCreationLabels(rootPath, t);
  const creationSelection = displayFolder
    ? t("選択フォルダー内／HTMLの親、未選択時は表示フォルダー{folder}に作成します", {
        folder: displayFolder,
      })
    : creation.selection;
  return (
    <>
      {onMutation && (
        <div className="tree-tools" hidden={hideFiles}>
          <button
            type="button"
            aria-label={t("HTMLを作成")}
            aria-description={creationUnavailable ? t(creationUnavailable) : creationSelection}
            title={t("{label}：{hint}", {
              label: t("HTMLを作成"),
              hint: creationUnavailable ? t(creationUnavailable) : creationSelection,
            })}
            disabled={actionBusy || !workspaceId}
            onClick={() => request(focused ?? displayFolder, "createHtml")}
          >
            <CreationIcon kind="html" />
          </button>
          <button
            type="button"
            aria-label={t("フォルダーを作成")}
            aria-description={creationUnavailable ? t(creationUnavailable) : creationSelection}
            title={t("{label}：{hint}", {
              label: t("フォルダーを作成"),
              hint: creationUnavailable ? t(creationUnavailable) : creationSelection,
            })}
            disabled={actionBusy || !workspaceId}
            onClick={() => request(focused ?? displayFolder, "createFolder")}
          >
            <CreationIcon kind="folder" />
          </button>
          <button
            type="button"
            aria-label={t("ルートにフォルダーを作成")}
            aria-description={creationUnavailable ? t(creationUnavailable) : creation.initialRoot}
            title={t("{label}：{hint}", {
              label: t("ルートにフォルダーを作成"),
              hint: creationUnavailable ? t(creationUnavailable) : creation.initialRoot,
            })}
            disabled={actionBusy || !workspaceId}
            onClick={() => setIntent({ kind: "createFolder", parent: "" })}
          >
            <CreationIcon kind="root" />
          </button>
        </div>
      )}
      {headerContent}
      <div
        className="tree"
        hidden={hideFiles || !workspaceId}
        ref={container}
        role="tree"
        aria-label={t("knowledge ファイルツリー")}
        tabIndex={0}
        aria-activedescendant={focused ? "tree-" + encodeURIComponent(focused) : undefined}
        onScroll={(event) => {
          setScrollTop(event.currentTarget.scrollTop);
          if (menu) closeMenu(true);
        }}
        onKeyDown={(event) => {
          if (
            event.target !== event.currentTarget ||
            event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229 ||
            actionBusy ||
            intent ||
            trash ||
            document.querySelector("dialog[open]")
          )
            return;
          if (onMutation && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
            event.preventDefault();
            request(focused ?? displayFolder, event.shiftKey ? "createFolder" : "createHtml");
            return;
          }
          const focusedIndex = rows.findIndex((row) => row.node.relativePath === focused);
          const index = Math.max(0, focusedIndex);
          const row = rows[index];
          if (!row) return;
          if (
            (onMutation ||
              onTrash ||
              onFileAction ||
              onAiHandoff ||
              (onSearchFolder && row.node.kind === "folder") ||
              ((onOpenColumn || onRecoverState) && row.node.kind === "html")) &&
            (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
          ) {
            event.preventDefault();
            const rect = document
              .getElementById("tree-" + encodeURIComponent(row.node.relativePath))
              ?.getBoundingClientRect();
            openMenu(row.node.relativePath, rect?.left ?? 8, rect?.bottom ?? 40);
            return;
          }
          const mac = /Mac|iPhone|iPad/.test(navigator.platform);
          if (
            onTrash &&
            focusedIndex >= 0 &&
            document.activeElement === event.currentTarget &&
            !event.repeat &&
            !event.altKey &&
            !event.shiftKey &&
            !event.ctrlKey &&
            (mac
              ? event.metaKey && event.key === "Backspace"
              : !event.metaKey && (event.key === "Delete" || event.key === "Backspace"))
          ) {
            event.preventDefault();
            requestTrash(row.node.relativePath);
            return;
          }
          if (
            onMutation &&
            focusedIndex >= 0 &&
            row.node.kind === "html" &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey &&
            !event.shiftKey &&
            ((mac && event.key === "Enter") || (!mac && event.key === "F2"))
          ) {
            event.preventDefault();
            request(row.node.relativePath, "renameHtml");
            return;
          }
          if (event.key === "ArrowDown") activate(Math.min(rows.length - 1, index + 1));
          else if (event.key === "ArrowUp") activate(Math.max(0, index - 1));
          else if (event.key === "ArrowRight" && row.node.kind === "folder") {
            if (!expanded.has(row.node.relativePath)) toggle(row.node.relativePath);
            else activate(index + 1);
          } else if (event.key === "ArrowLeft") {
            if (expanded.has(row.node.relativePath)) toggle(row.node.relativePath);
            else
              activate(
                rows.findIndex(
                  (item) =>
                    item.node.relativePath ===
                    row.node.relativePath.split("/").slice(0, -1).join("/"),
                ),
              );
          } else if (event.key === "Enter" || event.key === " ") {
            if (row.node.kind === "folder") toggle(row.node.relativePath);
            else onSelect(row.node.relativePath);
          } else return;
          event.preventDefault();
        }}
        onDragOver={(event) => {
          if (!drag.current) return;
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          if (event.clientY < rect.top + 24) event.currentTarget.scrollTop -= 18;
          else if (event.clientY > rect.bottom - 24) event.currentTarget.scrollTop += 18;
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(null);
        }}
        onDrop={(event) => event.preventDefault()}
      >
        <div className="tree-spacer" style={{ height: rows.length * ROW_HEIGHT }}>
          {rows.slice(start, end).map(({ node, depth }, offset) => (
            <div
              role="treeitem"
              aria-label={treeLabel(node) + (node.kind === "html" ? " HTML" : "")}
              id={"tree-" + encodeURIComponent(node.relativePath)}
              key={node.relativePath}
              aria-level={depth + 1}
              aria-selected={selected === node.relativePath}
              aria-expanded={node.kind === "folder" ? expanded.has(node.relativePath) : undefined}
              className={
                "tree-row " +
                (dragged === node.relativePath ? "dragged " : "") +
                (drop?.path === node.relativePath ? "drop-" + drop.place + " " : "") +
                ((focused ?? rows[0]?.node.relativePath) === node.relativePath
                  ? "action-focus-target "
                  : "") +
                (selected === node.relativePath ? "selected " : "") +
                (focused === node.relativePath ? "focused" : "")
              }
              style={{
                top: (start + offset) * ROW_HEIGHT,
                // Keep actions and a readable basename inside even a deeply nested narrow tree.
                paddingLeft: `min(${12 + depth * 18}px, max(12px, calc(100% - 148px)))`,
              }}
              title={node.relativePath}
              data-path={node.relativePath}
              draggable={Boolean(onMutation) && !actionBusy}
              onDragStart={(event) => {
                drag.current = node.relativePath;
                setDragged(node.relativePath);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", node.relativePath);
              }}
              onDragEnd={() => {
                drag.current = null;
                setDragged(null);
                setDrop(null);
              }}
              onDragOver={(event) => {
                if (
                  drag.current &&
                  (node.relativePath === drag.current ||
                    node.relativePath.startsWith(drag.current + "/"))
                ) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "none";
                  setDrop(null);
                  return;
                }
                if (!drag.current || drag.current === node.relativePath || actionBusy) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                const rect = event.currentTarget.getBoundingClientRect();
                const ratio = (event.clientY - rect.top) / rect.height;
                const place =
                  node.kind === "folder" && ratio >= 0.25 && ratio <= 0.75
                    ? "inside"
                    : ratio < 0.5
                      ? "before"
                      : "after";
                if (drop?.path !== node.relativePath || drop.place !== place)
                  setDrop({ path: node.relativePath, place });
              }}
              onDrop={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const source = drag.current;
                const target = drop;
                drag.current = null;
                setDragged(null);
                setDrop(null);
                if (
                  !source ||
                  !target ||
                  target.path !== node.relativePath ||
                  source === target.path ||
                  actionBusy
                )
                  return;
                const parent = target.place === "inside" ? target.path : parentOf(target.path);
                if (parent === parentOf(source) && target.place !== "inside")
                  void submit({
                    kind: "reorder",
                    source,
                    anchor: target.path,
                    after: target.place === "after",
                  });
                else
                  setIntent({
                    kind: "move",
                    source,
                    parent,
                    anchor: target.place === "inside" ? undefined : target.path,
                    after: target.place === "after",
                  });
              }}
              onContextMenu={(event) => {
                if (
                  !onMutation &&
                  !onTrash &&
                  !onFileAction &&
                  !onAiHandoff &&
                  (node.kind !== "folder" || !onSearchFolder) &&
                  (node.kind !== "html" || (!onOpenColumn && !onRecoverState))
                )
                  return;
                event.preventDefault();
                openMenu(node.relativePath, event.clientX, event.clientY);
              }}
              onClick={() => {
                setFocused(node.relativePath);
                container.current?.focus();
                if (node.kind === "folder") toggle(node.relativePath);
                else onSelect(node.relativePath);
              }}
            >
              <span
                aria-hidden="true"
                className={"chevron " + (expanded.has(node.relativePath) ? "expanded" : "")}
              >
                {node.kind === "folder" ? "›" : ""}
              </span>
              {node.kind === "folder" ? (
                <FolderIcon expanded={expanded.has(node.relativePath)} />
              ) : (
                <svg
                  aria-hidden="true"
                  className={"file-icon " + node.kind}
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M14 3H5v18h14V8ZM14 3v5h5M8 12h8M8 16h6" />
                </svg>
              )}
              <span className="filename">{treeLabel(node)}</span>
              {(onFavorite || onAiHandoff) && (
                <span
                  className="tree-row-actions"
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
                      event.preventDefault();
                    else if (event.key === "Escape") {
                      event.preventDefault();
                      container.current?.focus();
                    }
                  }}
                  onDragStart={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                >
                  {onFavorite && (
                    <button
                      type="button"
                      className={favoritePaths?.includes(node.relativePath) ? "favorited" : ""}
                      aria-label={t(
                        favoritePaths?.includes(node.relativePath)
                          ? "お気に入りから解除"
                          : "お気に入りに追加",
                      )}
                      title={t(
                        favoritePaths?.includes(node.relativePath)
                          ? "お気に入りから解除"
                          : "お気に入りに追加",
                      )}
                      aria-pressed={favoritePaths?.includes(node.relativePath) ?? false}
                      disabled={actionBusy || !workspaceId}
                      tabIndex={
                        (focused ?? rows[0]?.node.relativePath) === node.relativePath ? 0 : -1
                      }
                      draggable={false}
                      onFocus={() => setFocused(node.relativePath)}
                      onPointerDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        event.currentTarget.focus();
                      }}
                      onClick={() =>
                        onFavorite(node.relativePath, !favoritePaths?.includes(node.relativePath))
                      }
                    >
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        strokeLinejoin="round"
                      >
                        <path d="m12 3 2.8 5.7 6.3.9-4.6 4.5 1.1 6.3L12 17.4l-5.6 3 1.1-6.3L3 9.6l6.2-.9Z" />
                      </svg>
                    </button>
                  )}
                  {onAiHandoff && (
                    <button
                      type="button"
                      aria-label={t("AIに渡す")}
                      title={t("AIに渡す")}
                      disabled={actionBusy || !workspaceId}
                      tabIndex={
                        (focused ?? rows[0]?.node.relativePath) === node.relativePath ? 0 : -1
                      }
                      draggable={false}
                      onFocus={() => setFocused(node.relativePath)}
                      onPointerDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        event.currentTarget.focus();
                      }}
                      onClick={(event) => onAiHandoff(node.relativePath, event.currentTarget)}
                    >
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="m12 3 1.8 6.2L20 11l-6.2 1.8L12 19l-1.8-6.2L4 11l6.2-1.8ZM20 3v4M18 5h4" />
                      </svg>
                    </button>
                  )}
                </span>
              )}
            </div>
          ))}
        </div>
        {menu && (
          <FileContextMenu
            path={menu.path}
            x={menu.x}
            y={menu.y}
            busy={actionBusy}
            onClose={closeMenu}
            onAction={onFileAction ? (action) => onFileAction(menu.path, action) : undefined}
            onOpenColumn={onOpenColumn}
            onRecoverState={onRecoverState}
            onStateTransfer={onStateTransfer}
            onAiHandoff={onAiHandoff ? (path) => onAiHandoff(path, container.current) : undefined}
            favorite={favoritePaths?.includes(menu.path)}
            onFavorite={onFavorite}
            onSearchFolder={onSearchFolder}
            onTrash={onTrash ? () => requestTrash(menu.path) : undefined}
            kind={menuNode?.kind ?? "html"}
            onTreeAction={onMutation ? (action) => request(menu.path, action) : undefined}
            reorderDisabled={[menuIndex <= 0, menuIndex >= menuSiblings.length - 1]}
          />
        )}
        {rows.length === 0 && <p className="tree-empty">{t("このフォルダにHTMLはありません")}</p>}
      </div>
      {intent && onMutation && (
        <MutationDialog
          intent={intent}
          nodes={nodes}
          rootPath={rootPath}
          busy={actionBusy}
          onSubmit={submit}
          onClose={() => {
            setIntent(null);
            requestAnimationFrame(() => container.current?.focus());
          }}
        />
      )}
      {trash && onTrash && (
        <TrashDialog
          node={trash.node}
          busy={actionBusy}
          stale={revision !== trash.revision}
          onSubmit={() => onTrash(trash.node.relativePath, trash.revision)}
          onClose={() => {
            setTrash(null);
            requestAnimationFrame(() => container.current?.focus());
          }}
        />
      )}
    </>
  );
}
