import { useEffect, useRef, useState } from "react";
import type { Graphic } from "../lib/edl";

/** A graphic placed in the cut: when it starts and ends there (cut seconds). */
export interface PlacedGraphic {
  g: Graphic;
  index: number;
  start: number;
  end: number;
}

interface Props {
  placed: PlacedGraphic[];
  time: number; // cut seconds
  base: string | null; // where the project's graphics folder is served
  versions: Record<string, number>; // bumped when a graphic's page is rewritten, to reload it
  picked: number | null; // the graphic whose settings are open: it can be dragged
  onMove: (index: number, x: number, y: number) => void;
}

// Graphics are loaded a little before they show, so they're ready in time.
const AHEAD = 1.5;

/** Motion graphics over the video: each one a HyperFrames page in a frame,
 *  scaled to the viewer and sought to the playhead. */
export function GraphicsLayer({ placed, time, base, versions, picked, onMove }: Props) {
  const frames = useRef(new Map<string, HTMLIFrameElement>());
  const [sizes, setSizes] = useState<Record<string, { w: number; h: number }>>({});
  const [box, setBox] = useState({ w: 0, h: 0 });
  const layer = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<{ index: number; x: number; y: number } | null>(null);

  useEffect(() => {
    const el = layer.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A graphic says it's ready (and how big it was made).
  useEffect(() => {
    const on = (e: MessageEvent) => {
      const m = e.data;
      if (!m || m.roughcut !== "graphic" || !m.ready) return;
      for (const [key, f] of frames.current)
        if (f.contentWindow === e.source) {
          setSizes((s) => ({ ...s, [key]: { w: m.width || 1920, h: m.height || 1080 } }));
          f.contentWindow?.postMessage({ roughcut: "seek", t: Math.max(0, timeRef.current - (placedRef.current.find((p) => keyOf(p) === key)?.start ?? 0)) }, "*");
        }
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, []);
  const timeRef = useRef(time);
  timeRef.current = time;
  const placedRef = useRef(placed);
  placedRef.current = placed;

  const near = placed.filter((p) => time >= p.start - AHEAD && time <= p.end + 0.25);
  // Seek every graphic near the playhead.
  useEffect(() => {
    for (const p of near) frames.current.get(keyOf(p))?.contentWindow?.postMessage({ roughcut: "seek", t: Math.max(0, time - p.start) }, "*");
  });

  const drag = (e: React.PointerEvent, p: PlacedGraphic) => {
    if (picked !== p.index || !layer.current) return;
    e.preventDefault();
    const rect = layer.current.getBoundingClientRect();
    const [x0, y0, sx, sy] = [e.clientX, e.clientY, p.g.x ?? 0, p.g.y ?? 0];
    let last: { index: number; x: number; y: number } | null = null;
    const move = (ev: PointerEvent) => {
      last = { index: p.index, x: sx + (ev.clientX - x0) / rect.width, y: sy + (ev.clientY - y0) / rect.height };
      setDraft(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (last) onMove(last.index, Math.round(last.x * 1000) / 1000, Math.round(last.y * 1000) / 1000);
      setDraft(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div ref={layer} className="graphics-layer">
      {base &&
        near.map((p) => {
          const key = keyOf(p);
          const size = sizes[key] ?? { w: 1920, h: 1080 };
          const fit = Math.min(box.w / size.w, box.h / size.h) * (p.g.scale ?? 1);
          const at = draft?.index === p.index ? draft : { x: p.g.x ?? 0, y: p.g.y ?? 0 };
          const showing = time >= p.start && time <= p.end;
          return (
            <div
              key={key}
              className={`graphic ${picked === p.index ? "editing" : ""}`}
              style={{
                width: size.w,
                height: size.h,
                visibility: showing ? "visible" : "hidden",
                transform: `translate(${box.w / 2 + at.x * box.w - (size.w * fit) / 2}px, ${box.h / 2 + at.y * box.h - (size.h * fit) / 2}px) scale(${fit})`,
              }}
              onPointerDown={(e) => drag(e, p)}
              title={picked === p.index ? "Drag to move the graphic" : undefined}
            >
              <iframe
                ref={(f) => {
                  if (f) frames.current.set(key, f);
                  else frames.current.delete(key);
                }}
                src={`${base}/${p.g.slug}/index.html?preview&v=${versions[p.g.slug] ?? 0}`}
                title={p.g.name}
                width={size.w}
                height={size.h}
                tabIndex={-1}
              />
            </div>
          );
        })}
    </div>
  );
}

const keyOf = (p: PlacedGraphic) => `${p.g.slug}@${p.index}`;
