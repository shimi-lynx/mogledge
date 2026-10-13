export function FolderIcon({
  expanded = false,
  className = "file-icon folder",
}: {
  expanded?: boolean;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path
        d={
          expanded
            ? "M3 19V6a1 1 0 0 1 1-1h5l2 2h9v4M3 19l3-8h16l-3 8Z"
            : "M3 7V6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1ZM3 8h18"
        }
      />
    </svg>
  );
}
