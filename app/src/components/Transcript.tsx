import { RotateCcw, Scissors } from "lucide-react";
import { memo, useEffect, useMemo, useRef } from "react";
import { timecode, type CutKind, type Word } from "../lib/edl";

export interface Selection {
  first: number;
  last: number;
}

interface Props {
  words: Word[];
  kinds: CutKind[];
  current: number; // word under the playhead
  selection: Selection | null;
  onSelect: (s: Selection | null) => void;
  onSeekWord: (i: number) => void;
  onCut: (s: Selection) => void;
  onRestore: (s: Selection) => void;
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
  current: number;
  sel: Selection | null;
  onDown: (i: number, shift: boolean) => void;
  onEnter: (i: number) => void;
}) {
  const { idx, words, kinds, current, sel } = props;
  return (
    <p>
      <span className="stamp">{timecode(words[idx[0]].start)}</span>
      {idx.map((i) => {
        const k = kinds[i];
        const cls = [
          "w",
          k ? "cut" : "",
          k ?? "",
          words[i].text.startsWith("[") ? "hes" : "",
          sel && i >= sel.first && i <= sel.last ? "sel" : "",
          i === current ? "now" : "",
        ].join(" ");
        return (
          <span key={i}>
            <span
              className={cls}
              data-i={i}
              onMouseDown={(e) => {
                e.preventDefault();
                props.onDown(i, e.shiftKey);
              }}
              onMouseEnter={() => props.onEnter(i)}
            >
              {words[i].text}
            </span>{" "}
          </span>
        );
      })}
    </p>
  );
});

export function Transcript(p: Props) {
  const paras = useMemo(() => paragraphs(p.words), [p.words]);
  const anchor = useRef<number | null>(null);
  const dragging = useRef(false);
  const moved = useRef(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const up = () => {
      if (dragging.current && !moved.current && anchor.current !== null) {
        // A plain click: move the playhead there and drop the selection.
        p.onSeekWord(anchor.current);
      }
      dragging.current = false;
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, [p]);

  // Keep the playing word in view.
  useEffect(() => {
    if (p.current < 0 || !box.current) return;
    const el = box.current.querySelector<HTMLElement>(`[data-i="${p.current}"]`);
    if (!el) return;
    const b = box.current.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.top < b.top + 40 || r.bottom > b.bottom - 40) el.scrollIntoView({ block: "center" });
  }, [p.current]);

  const onDown = (i: number, shift: boolean) => {
    if (shift && p.selection) {
      const a = anchor.current ?? p.selection.first;
      p.onSelect({ first: Math.min(a, i), last: Math.max(a, i) });
      return;
    }
    anchor.current = i;
    dragging.current = true;
    moved.current = false;
    p.onSelect({ first: i, last: i });
  };

  const onEnter = (i: number) => {
    if (!dragging.current || anchor.current === null) return;
    moved.current = moved.current || i !== anchor.current;
    p.onSelect({ first: Math.min(anchor.current, i), last: Math.max(anchor.current, i) });
  };

  const sel = p.selection;
  const selKinds = sel ? p.kinds.slice(sel.first, sel.last + 1) : [];
  const anyKept = selKinds.some((k) => k === null);
  const anyCut = selKinds.some((k) => k !== null);
  const n = sel ? sel.last - sel.first + 1 : 0;

  return (
    <div className="panel-body" ref={box}>
      {sel && n > 0 && (
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
          {anyKept && (
            <button className="btn" onClick={() => p.onCut(sel)}>
              <Scissors size={14} /> Cut <span className="mono">⌫</span>
            </button>
          )}
        </div>
      )}
      <div className="transcript">
        {paras.map((idx) => (
          <Para
            key={idx[0]}
            idx={idx}
            words={p.words}
            kinds={p.kinds}
            current={idx.includes(p.current) ? p.current : -1}
            sel={sel && sel.last >= idx[0] && sel.first <= idx[idx.length - 1] ? sel : null}
            onDown={onDown}
            onEnter={onEnter}
          />
        ))}
      </div>
    </div>
  );
}
