import { RotateCcw, Scissors, ZoomIn, ZoomOut } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { timecode, type CutKind, type Word } from "../lib/edl";

export interface Selection {
  first: number;
  last: number;
}

interface Props {
  words: Word[];
  kinds: CutKind[];
  zooms: ("zoom" | "zoom-pending" | null)[];
  current: number; // word under the playhead
  selection: Selection | null;
  onSelect: (s: Selection | null) => void;
  onSeekWord: (i: number) => void;
  onCut: (s: Selection) => void;
  onRestore: (s: Selection) => void;
  onZoom: (s: Selection) => void;
}

const PARAGRAPH_PAUSE = 1.0;

/** Paragraphs break at long pauses and sentence ends after one. */
function paragraphs(words: Word[]): number[][] {
  const out: number[][] = [];
  words.forEach((w, i) => {
    const prev = words[i - 1];
    const breaks = !prev || (w.start - prev.end >= PARAGRAPH_PAUSE && /[.?!]$/.test(prev.text)) || w.start - prev.end >= 2.5;
    if (breaks) out.push([i]);
    else out[out.length - 1].push(i);
  });
  return out;
}

const Para = memo(function Para(props: {
  idx: number[];
  words: Word[];
  kinds: CutKind[];
  zooms: ("zoom" | "zoom-pending" | null)[];
  current: number;
  sel: Selection | null;
}) {
  const { idx, words, kinds, zooms, current, sel } = props;
  const inSel = (i: number) => !!sel && i >= sel.first && i <= sel.last;
  return (
    <p>
      <span className="stamp">{timecode(words[idx[0]].start)}</span>
      {idx.map((i) => {
        const k = kinds[i];
        const cls = [
          "w",
          k ? "cut" : "",
          k ?? "",
          zooms[i] ?? "",
          words[i].text.startsWith("[") ? "hes" : "",
          inSel(i) ? "sel" : "",
          inSel(i) && !inSel(i - 1) ? "sel-first" : "",
          inSel(i) && !inSel(i + 1) ? "sel-last" : "",
          i === current ? "now" : "",
        ].join(" ");
        return (
          <span key={i}>
            <span className={cls} data-i={i}>
              {words[i].text}
            </span>
            {/* The space joins a selection into one band. */}
            <span className={inSel(i) && inSel(i + 1) ? "gap sel" : "gap"} data-g={i}> </span>
          </span>
        );
      })}
    </p>
  );
});

/** The word nearest a point in the transcript: the one under it, else the
 *  closest on the line it's on, else the closest line. So drags through
 *  spaces, margins and between paragraphs never lose their place. */
function wordNear(root: HTMLElement, x: number, y: number): number | null {
  const under = document.elementFromPoint(x, y);
  const hit = under instanceof HTMLElement ? under.closest<HTMLElement>("[data-i], [data-g]") : null;
  if (hit && root.contains(hit)) return Number(hit.dataset.i ?? hit.dataset.g); // a space counts as the word before it
  let best: { i: number; d: number } | null = null;
  for (const el of root.querySelectorAll<HTMLElement>("[data-i]")) {
    const r = el.getBoundingClientRect();
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    const d = dy * 1000 + dx; // same line first, then nearest along it
    if (!best || d < best.d) best = { i: Number(el.dataset.i), d };
  }
  return best?.i ?? null;
}

const sentenceAround = (words: Word[], i: number): Selection => {
  let first = i;
  while (first > 0 && !/[.?!]$/.test(words[first - 1].text)) first--;
  let last = i;
  while (last < words.length - 1 && !/[.?!]$/.test(words[last].text)) last++;
  return { first, last };
};

export function Transcript(p: Props) {
  const paras = useMemo(() => paragraphs(p.words), [p.words]);
  const anchor = useRef<number | null>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean; id: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [selecting, setSelecting] = useState(false);
  const scroller = useRef(0);

  // Keep the playing word in view (not while Luke is selecting).
  useEffect(() => {
    if (p.current < 0 || !box.current || drag.current) return;
    const el = box.current.querySelector<HTMLElement>(`[data-i="${p.current}"]`);
    if (!el) return;
    const b = box.current.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.top < b.top + 40 || r.bottom > b.bottom - 40) el.scrollIntoView({ block: "center" });
  }, [p.current]);

  const extendTo = (x: number, y: number) => {
    const i = text.current && wordNear(text.current, x, y);
    if (i === null || i === undefined || anchor.current === null) return;
    p.onSelect({ first: Math.min(anchor.current, i), last: Math.max(anchor.current, i) });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !text.current) return;
    const i = wordNear(text.current, e.clientX, e.clientY);
    if (i === null) return;
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur(); // so keys go to the edit, not a text box
    if (e.shiftKey && (p.selection || anchor.current !== null)) {
      const a = anchor.current ?? p.selection!.first;
      p.onSelect({ first: Math.min(a, i), last: Math.max(a, i) });
      return;
    }
    anchor.current = i;
    drag.current = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
    setSelecting(true);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    // A few pixels of wobble is still a click.
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return;
    d.moved = true;
    d.x = e.clientX;
    d.y = e.clientY;
    extendTo(e.clientX, e.clientY);
    // Scroll when dragging past the top or bottom, and keep extending.
    const b = box.current!.getBoundingClientRect();
    const speed = e.clientY < b.top + 24 ? -(b.top + 24 - e.clientY) : e.clientY > b.bottom - 24 ? e.clientY - (b.bottom - 24) : 0;
    cancelAnimationFrame(scroller.current);
    if (speed) {
      const step = () => {
        if (!drag.current) return;
        box.current!.scrollTop += Math.max(-30, Math.min(30, speed / 2));
        extendTo(drag.current.x, drag.current.y);
        scroller.current = requestAnimationFrame(step);
      };
      scroller.current = requestAnimationFrame(step);
    }
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    cancelAnimationFrame(scroller.current);
    setSelecting(false);
    // A plain click moves the playhead there.
    if (d && !d.moved && anchor.current !== null) p.onSeekWord(anchor.current);
  };

  const sel = p.selection;
  const selKinds = sel ? p.kinds.slice(sel.first, sel.last + 1) : [];
  const anyKept = selKinds.some((k) => k === null);
  const anyCut = selKinds.some((k) => k !== null);
  const n = sel ? sel.last - sel.first + 1 : 0;
  const zoomed = sel ? p.zooms.slice(sel.first, sel.last + 1).some((z) => z !== null) : false;

  return (
    <div className="transcript-wrap">
      {sel && n > 0 && !selecting && (
        <div className="selbar">
          <span>
            {n} word{n === 1 ? "" : "s"}
          </span>
          <span className="spacer" />
          {anyCut && (
            <button className="btn" onClick={() => p.onRestore(sel)}>
              <RotateCcw size={14} /> Restore
            </button>
          )}
          <button className="btn" onClick={() => p.onZoom(sel)}>
            {zoomed ? <ZoomOut size={14} /> : <ZoomIn size={14} />} {zoomed ? "Unzoom" : "Zoom"} <span className="mono">Z</span>
          </button>
          {anyKept && (
            <button className="btn" onClick={() => p.onCut(sel)}>
              <Scissors size={14} /> Cut <span className="mono">⌫</span>
            </button>
          )}
        </div>
      )}
      <div className="panel-body" ref={box}>
        <div className="transcript" ref={text} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
          onDoubleClick={(e) => {
            // The whole sentence.
            const i = text.current && wordNear(text.current, e.clientX, e.clientY);
            if (i === null || i === undefined) return;
            const s = sentenceAround(p.words, i);
            anchor.current = s.first;
            p.onSelect(s);
          }}>
          {paras.map((idx) => (
            <Para
              key={idx[0]}
              idx={idx}
              words={p.words}
              kinds={p.kinds}
              zooms={p.zooms}
              current={idx.includes(p.current) ? p.current : -1}
              sel={sel && sel.last >= idx[0] && sel.first <= idx[idx.length - 1] ? sel : null}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
