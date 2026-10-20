import { EyeOff, ImageIcon, ImagePlus, Gauge, LayoutPanelLeft, MessageSquare, MousePointerClick, PanelBottom, Square, Type, User, X, ZoomIn } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import type { CatalogGraphic } from "../lib/backend";
import type { Motion, TextStyle } from "../lib/edl";

/** Something Luke can drop on the timeline. */
export type LibraryItem =
  | { kind: "text"; style: TextStyle }
  | { kind: "zoom" | "speed" | "blur" | "background" | "layout" | "note" }
  | { kind: "asset"; id: string }
  | { kind: "graphic"; name: string }; // from the motion graphics catalogue

export interface Asset {
  id: string;
  name: string;
  style: TextStyle; // "image" for a picture
  text: string;
  sub?: string;
  size: number;
  look?: "plain" | "box";
  x: number;
  y: number;
  src?: string; // an image's file, kept in Luke's assets folder
  w?: number;
  motion?: Motion;
}

const TILES: { title: string; items: { item: LibraryItem; label: string; icon: ReactNode; key?: string; needsParts?: boolean }[] }[] = [
  {
    title: "Text",
    items: [
      { item: { kind: "text", style: "title" }, label: "Title", icon: <Type size={16} />, key: "T" },
      { item: { kind: "text", style: "lower-third" }, label: "Lower third", icon: <PanelBottom size={16} /> },
      { item: { kind: "text", style: "callout" }, label: "Callout", icon: <Square size={16} /> },
    ],
  },
  {
    title: "Effects",
    items: [
      { item: { kind: "zoom" }, label: "Zoom", icon: <ZoomIn size={16} />, key: "Z" },
      { item: { kind: "speed" }, label: "Speed-up", icon: <Gauge size={16} />, key: "S" },
      { item: { kind: "blur" }, label: "Blur", icon: <EyeOff size={16} />, key: "B" },
      { item: { kind: "background" }, label: "Background", icon: <User size={16} />, key: "G" },
      { item: { kind: "layout" }, label: "Layout", icon: <LayoutPanelLeft size={16} />, key: "V", needsParts: true },
      { item: { kind: "note" }, label: "Note", icon: <MessageSquare size={16} />, key: "N" },
    ],
  },
];

/** Effects and Luke's saved assets. Drag one onto the timeline to place it
 *  there, or click it to add it at the playhead (or over selected words).
 *  Dragging is done by hand rather than with the browser's drag and drop,
 *  which the app window keeps for files dropped from Finder. */
export function Library(p: {
  assets: Asset[];
  recordedHere: boolean; // has screen, camera and clicks
  onAdd: (item: LibraryItem, at: { clientX: number; clientY: number } | null) => void;
  onDeleteAsset: (id: string) => void;
  onZoomToClicks: () => void;
  onAddImage: () => void;
  imageUrl: (src: string) => string | undefined; // for thumbnails
  catalog: CatalogGraphic[];
}) {
  const ghost = useRef<HTMLDivElement | null>(null);
  const [find, setFind] = useState("");
  const [open, setOpen] = useState<string | null>(null); // the catalogue group shown in full
  const q = find.trim().toLowerCase();
  const shown = p.catalog.filter((g) => !q || `${g.title} ${g.description} ${g.group}`.toLowerCase().includes(q));
  const groups = [...new Set(shown.map((g) => g.group))];

  const start = (e: React.PointerEvent, item: LibraryItem, label: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const [x0, y0] = [e.clientX, e.clientY];
    let dragging = false;
    const move = (m: PointerEvent) => {
      if (!dragging && Math.hypot(m.clientX - x0, m.clientY - y0) < 5) return;
      if (!dragging) {
        dragging = true;
        const g = document.createElement("div");
        g.className = "drag-ghost";
        g.textContent = label;
        document.body.appendChild(g);
        ghost.current = g;
        document.body.classList.add("dragging-fx");
      }
      ghost.current!.style.transform = `translate(${m.clientX + 10}px, ${m.clientY + 10}px)`;
      window.dispatchEvent(new CustomEvent("roughcut-dragover", { detail: { x: m.clientX, y: m.clientY } }));
    };
    const up = (u: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      ghost.current?.remove();
      ghost.current = null;
      document.body.classList.remove("dragging-fx");
      window.dispatchEvent(new CustomEvent("roughcut-dragover", { detail: null }));
      if (!dragging) return p.onAdd(item, null); // a click
      const over = document.elementFromPoint(u.clientX, u.clientY);
      if (over?.closest(".timeline canvas")) p.onAdd(item, { clientX: u.clientX, clientY: u.clientY });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const tile = (item: LibraryItem, label: string, icon: ReactNode, key?: string, disabled = false, extra?: ReactNode) => (
    <div
      key={label + (item.kind === "asset" ? item.id : "")}
      className={`tile ${disabled ? "disabled" : ""}`}
      title={disabled ? "Only for videos you record in Roughcut" : "Drag onto the timeline, or click to add at the playhead"}
      onPointerDown={(e) => !disabled && start(e, item, label)}
    >
      <span className="icon">{icon}</span>
      <span className="label">{label}</span>
      {key && <span className="key mono">{key}</span>}
      {extra}
    </div>
  );

  return (
    <div className="panel-body library">
      <p className="hint">Drag onto the timeline, or click to add at the playhead (or over the words you selected).</p>
      {TILES.map((group) => (
        <section key={group.title}>
          <div className="section-title">{group.title}</div>
          <div className="tiles">{group.items.map((t) => tile(t.item, t.label, t.icon, t.key, t.needsParts && !p.recordedHere))}</div>
        </section>
      ))}
      <section>
        <div className="section-title">Motion graphics</div>
        <input className="field find" placeholder="Find a graphic" value={find} onChange={(e) => setFind(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        {groups.map((group) => {
          const all = shown.filter((g) => g.group === group);
          const list = q || open === group ? all : all.slice(0, 4);
          return (
            <div key={group} className="graphic-group">
              <div className="group-head">
                <span>{group}</span>
                {!q && all.length > 4 && (
                  <button className="btn ghost" onClick={() => setOpen(open === group ? null : group)}>
                    {open === group ? "Fewer" : `All ${all.length}`}
                  </button>
                )}
              </div>
              <div className="cards">
                {list.map((g) => (
                  <div
                    key={g.name}
                    className="card"
                    title={`${g.description}\n\nDrag onto the timeline, or click to add at the playhead`}
                    onPointerDown={(e) => start(e, { kind: "graphic", name: g.name }, g.title)}
                  >
                    <div className="poster">
                      {g.poster ? <img src={g.poster} alt="" draggable={false} loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} /> : null}
                    </div>
                    <span className="label">{g.title}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        {!shown.length && <p className="hint">No graphic matches. Ask Claude to make one.</p>}
      </section>
      <section>
        <div className="section-title">Your assets</div>
        {p.assets.length ? (
          <div className="tiles">
            {p.assets.map((a) =>
              tile(
                { kind: "asset", id: a.id },
                a.name,
                a.style === "image" ? (
                  p.imageUrl(a.src ?? "") ? <img className="thumb" src={p.imageUrl(a.src ?? "")} alt="" draggable={false} /> : <ImageIcon size={16} />
                ) : a.style === "lower-third" ? (
                  <PanelBottom size={16} />
                ) : a.style === "callout" ? (
                  <Square size={16} />
                ) : (
                  <Type size={16} />
                ),
                undefined,
                false,
                <button
                  className="btn ghost icon remove"
                  title="Delete this asset"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => p.onDeleteAsset(a.id)}
                >
                  <X size={12} />
                </button>,
              ),
            )}
          </div>
        ) : (
          <p className="hint">Make a title or lower third look right, then click “Save as asset” in its settings to reuse it in any video.</p>
        )}
        <button className="btn add-image" onClick={p.onAddImage}>
          <ImagePlus size={14} /> Add an image…
        </button>
      </section>
      {p.recordedHere && (
        <section>
          <div className="section-title">This recording</div>
          <button className="btn" onClick={p.onZoomToClicks}>
            <MousePointerClick size={14} /> Zoom to my clicks
          </button>
        </section>
      )}
    </div>
  );
}
