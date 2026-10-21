import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  key?: string; // its keyboard shortcut, shown on the right
  on?: boolean; // ticked
  disabled?: boolean;
  onClick: () => void;
}

/** A toolbar button that opens a short list of choices. */
export function Menu({ label, title, items }: { label: ReactNode; title?: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <div className="menu-wrap" ref={box}>
      <button className={`btn ghost ${open ? "open" : ""}`} title={title} onClick={() => setOpen((o) => !o)}>
        {label} <ChevronDown size={13} />
      </button>
      {open && (
        <div className="menu" role="menu">
          {items.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              disabled={it.disabled}
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
            >
              <span className="mi-icon">{it.on ? <Check size={14} /> : it.icon}</span>
              <span className="mi-label">{it.label}</span>
              {it.key && <kbd>{it.key}</kbd>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
