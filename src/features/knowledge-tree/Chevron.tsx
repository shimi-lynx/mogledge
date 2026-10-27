export function Chevron({
  expanded = false,
  visible = true,
}: {
  expanded?: boolean;
  visible?: boolean;
}) {
  return (
    <span className={"chevron" + (expanded ? " expanded" : "")} aria-hidden="true">
      {visible && (
        <svg className="chevron-icon" viewBox="0 0 12 16" fill="none">
          <path d="M4.25 4.5 7.75 8 4.25 11.5" />
        </svg>
      )}
    </span>
  );
}
