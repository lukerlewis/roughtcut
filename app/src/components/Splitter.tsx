import { useRef } from "react";

interface Props {
  /** "col" sits between side-by-side panels and drags sideways; "row" drags up and down. */
  dir: "col" | "row";
  style?: React.CSSProperties;
  /** Called while dragging with how far the pointer has moved since the drag began. */
  onDrag: (moved: number) => void;
  onStart: () => void;
  /** Double-click puts the panel back to its usual size. */
  onReset: () => void;
}

/** A thin edge between panels that resizes them when dragged. */
export function Splitter(p: Props) {
  const from = useRef(0);
  return (
    <div
      className={`splitter ${p.dir}`}
      style={p.style}
      title="Drag to resize (double-click to reset)"
      onDoubleClick={p.onReset}
      onPointerDown={(e) => {
        e.preventDefault();
        from.current = p.dir === "col" ? e.clientX : e.clientY;
        p.onStart();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        el.classList.add("dragging");
        document.body.classList.add(`resizing-${p.dir}`);
        const move = (m: PointerEvent) => p.onDrag((p.dir === "col" ? m.clientX : m.clientY) - from.current);
        const up = () => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          el.removeEventListener("pointercancel", up);
          el.classList.remove("dragging");
          document.body.classList.remove(`resizing-${p.dir}`);
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", up);
      }}
    />
  );
}
