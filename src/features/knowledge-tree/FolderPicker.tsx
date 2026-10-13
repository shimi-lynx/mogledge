import { useEffect, useId, useRef, useState } from "react";
import { useT } from "../../lib/i18n";

export function FolderPicker({
  folders,
  value,
  label,
  locked,
  autoFocus = false,
  onChange,
}: {
  folders: { path: string; label: string }[];
  value: string;
  label: string;
  locked: boolean;
  autoFocus?: boolean;
  onChange: (path: string) => void;
}) {
  const t = useT();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const selected = folders.find((folder) => folder.path === value);
  const normalized = query.normalize("NFKC").toLowerCase().trim();
  const matches = open
    ? folders.filter((folder) => folder.label.normalize("NFKC").toLowerCase().includes(normalized))
    : [];
  const first = matches.slice(0, 50);
  const options =
    selected && matches.includes(selected) && !first.includes(selected)
      ? [selected, ...first.slice(0, 49)]
      : first;
  const index = Math.max(
    0,
    options.findIndex((folder) => folder.path === active),
  );
  const close = () => {
    setOpen(false);
    setQuery("");
  };
  useEffect(() => {
    if (locked) setOpen(false);
  }, [locked]);
  useEffect(() => {
    if (!open && document.activeElement === input.current) input.current?.select();
  }, [open, value]);
  const show = () => {
    if (locked) return;
    setQuery("");
    setActive(value);
    setOpen(true);
  };
  const choose = (path: string) => {
    if (locked || !folders.some((folder) => folder.path === path)) return;
    onChange(path);
    close();
    input.current?.focus();
  };
  return (
    <div
      className="folder-picker"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) close();
      }}
    >
      <label htmlFor={id}>{label}</label>
      <div className="folder-picker-control">
        <input
          id={id}
          ref={input}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? id + "-list" : undefined}
          aria-activedescendant={open && options.length ? `${id}-option-${index}` : undefined}
          aria-disabled={locked}
          aria-invalid={!selected}
          autoFocus={autoFocus}
          data-mutation-initial-focus={autoFocus || undefined}
          readOnly={locked}
          autoComplete="off"
          maxLength={256}
          value={open ? query : (selected?.label ?? value)}
          placeholder={selected?.label ?? t("フォルダーを選択してください")}
          title={selected?.label}
          onFocus={(event) => event.currentTarget.select()}
          onClick={() => {
            if (!open) show();
          }}
          onChange={(event) => {
            if (locked) return;
            setQuery(event.target.value);
            setActive(null);
            setOpen(true);
          }}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(event) => {
            const ime =
              composing.current ||
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229;
            if (ime) {
              if (event.key === "Enter" || event.key === "Escape") event.preventDefault();
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              if (open && options[index]) choose(options[index].path);
            } else if (event.key === "Escape" && open) {
              event.preventDefault();
              close();
            } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
              if (locked || (!open && event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
              event.preventDefault();
              if (!open) show();
              else {
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? options.length - 1
                      : Math.max(
                          0,
                          Math.min(
                            options.length - 1,
                            index + (event.key === "ArrowDown" ? 1 : -1),
                          ),
                        );
                setActive(options[next]?.path ?? null);
                document
                  .getElementById(`${id}-option-${next}`)
                  ?.scrollIntoView?.({ block: "nearest" });
              }
            }
          }}
        />
        <button
          type="button"
          aria-label={t("{label}の候補を開く", { label })}
          disabled={locked}
          onClick={() => {
            if (open) close();
            else show();
            input.current?.focus();
          }}
        >
          ⌄
        </button>
      </div>
      {open && (
        <div className="folder-picker-popup">
          <div id={id + "-list"} role="listbox" aria-label={t("{label}の候補", { label })}>
            {options.map((folder, optionIndex) => (
              <div
                id={`${id}-option-${optionIndex}`}
                key={folder.path}
                role="option"
                aria-selected={folder.path === value}
                className={optionIndex === index ? "active" : ""}
                title={folder.label}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(folder.path)}
              >
                {folder.label}
              </div>
            ))}
          </div>
          {!matches.length && <p role="status">{t("該当するフォルダーがありません")}</p>}
          {matches.length > options.length && (
            <p role="status">{t("先頭50件を表示しています。文字入力で絞り込んでください。")}</p>
          )}
        </div>
      )}
    </div>
  );
}
