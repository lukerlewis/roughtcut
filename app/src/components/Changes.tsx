import { Check, RotateCcw, Undo2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { timecode, type AgentCut, type Word } from "../lib/edl";

interface Props {
  words: Word[];
  cuts: AgentCut[];
  summary: string;
  focus: number;
  onFocus: (i: number) => void;
  onAccept: (i: number) => void;
  onRestore: (i: number) => void;
  onUndo: (i: number) => void;
}

/** Claude's cuts as a change set: blue dot until reviewed. */
export function Changes(p: Props) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    box.current?.querySelector(`[data-c="${p.focus}"]`)?.scrollIntoView({ block: "nearest" });
  }, [p.focus]);

  return (
    <div className="panel-body" ref={box}>
      {p.summary && <p className="summary">{p.summary}</p>}
      {p.cuts.map((c, i) => {
        const text = p.words.slice(c.first, c.last + 1).map((w) => w.text).join(" ");
        return (
          <div
            key={`${c.first}-${c.last}`}
            data-c={i}
            className={`change ${c.status} ${i === p.focus ? "focus" : ""}`}
            onClick={() => p.onFocus(i)}
          >
            <span className="dot" />
            <div className="text">{text}</div>
            <div className="why">{c.status === "restored" ? "Restored" : c.reason}</div>
            <div className="row">
              <span className="mono">{timecode(p.words[c.first]?.start ?? 0)}</span>
              {c.status === "pending" && (
                <>
                  <button className="btn" title="Put these words back" onClick={(e) => (e.stopPropagation(), p.onRestore(i))}>
                    <RotateCcw size={14} /> Restore
                  </button>
                  <button className="btn" title="Keep this cut" onClick={(e) => (e.stopPropagation(), p.onAccept(i))}>
                    <Check size={14} /> Keep cut
                  </button>
                </>
              )}
              {c.status !== "pending" && (
                <button className="btn ghost" onClick={(e) => (e.stopPropagation(), p.onUndo(i))}>
                  <Undo2 size={14} /> Undo
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
