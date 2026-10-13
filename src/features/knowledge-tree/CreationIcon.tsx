import { FolderIcon } from "./FolderIcon";

export function CreationIcon({ kind }: { kind: "html" | "folder" | "root" }) {
  return (
    <span className="tree-create-icon" aria-hidden="true">
      {kind !== "html" && <FolderIcon className="tree-create-outline" />}
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
        {kind === "html" && <path d="M14 3H5v18h14V8ZM14 3v5h5" />}
        {kind === "root" && <path d="M7 2h10M12 2v3" />}
        <path d="M12 11v6M9 14h6" />
      </svg>
    </span>
  );
}
