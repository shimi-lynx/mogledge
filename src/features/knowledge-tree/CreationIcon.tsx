import { FolderIcon } from "./FolderIcon";

export function CreationIcon({ kind }: { kind: "folder" | "root" }) {
  return (
    <span className="tree-create-icon" aria-hidden="true">
      <FolderIcon className="tree-create-outline" />
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {kind === "root" && <path d="M7 2h10M12 2v3" />}
        <path d="M12 11v6M9 14h6" />
      </svg>
    </span>
  );
}
