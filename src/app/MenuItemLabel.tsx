export function menuModifier() {
  return /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
}

export function MenuItemLabel({ label, shortcut }: { label: string; shortcut?: string }) {
  return (
    <>
      <span className="menu-item-label">{label}</span>
      {shortcut && (
        <kbd aria-hidden="true" className="menu-item-shortcut">
          {shortcut}
        </kbd>
      )}
    </>
  );
}
