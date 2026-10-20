import { Check, Film, RotateCcw, Undo2, X, ZoomIn } from "lucide-react";
import { useEffect, useRef } from "react";
import { timecode, wordAt, type AgentCut, type Clip, type Word, type Zoom } from "../lib/edl";

interface Props {
  words: Word[];
  cuts: AgentCut[];
  zooms: Zoom[];
  summary: string;
  focus: number;
  onFocus: (i: number) => void;
  onAccept: (i: number) => void;
  onRestore: (i: number) => void;
  onUndo: (i: number) => void;
  onZoomFocus: (i: number) => void;
  onZoomAccept: (i: number) => void;
  onZoomRemove: (i: number) => void;
  onZoomUndo: (i: number) => void;
  clips: Clip[];
  onClipFocus: (i: number) => void;
  onClipStatus: (i: number, status: "pending" | "accepted" | "restored") => void;
}

type Item = { kind: "cut"; i: number; c: AgentCut } | { kind: "zoom"; i: number; z: Zoom } | { kind: "clip"; i: number; m: Clip };

/** Claude's changes as a change set: blue dot until reviewed. */
export function Changes(p: Props) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    box.current?.querySelector(`[data-c="${p.focus}"]`)?.scrollIntoView({ block: "nearest" });
  }, [p.focus]);

  const firstWord = (it: Item) => (it.kind === "cut" ? it.c.first : it.kind === "zoom" ? it.z.first : Math.max(0, wordAt(p.words, it.m.start)));
  const items: Item[] = [
    ...p.cuts.map((c, i) => ({ kind: "cut" as const, i, c })),
    ...p.zooms.flatMap((z, i) => (z.by === "agent" ? [{ kind: "zoom" as const, i, z }] : [])),
    ...p.clips.flatMap((m, i) => (m.by === "agent" ? [{ kind: "clip" as const, i, m }] : [])),
  ].sort((a, b) => firstWord(a) - firstWord(b));

  const text = (first: number, last: number) =>
    p.words
      .slice(first, last + 1)
      .map((w) => w.text)
      .join(" ");

  return (
    <div className="panel-body" ref={box}>
      {p.summary && <p className="summary">{p.summary}</p>}
      {items.map((it) => {
        if (it.kind === "cut") {
          const { c, i } = it;
          return (
            <div
              key={`c${i}`}
              data-c={i}
              className={`change ${c.status} ${i === p.focus ? "focus" : ""}`}
              onClick={() => p.onFocus(i)}
            >
              <span className="dot" />
              <div className="text">{text(c.first, c.last)}</div>
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
        }
        if (it.kind === "clip") {
          const { m, i } = it;
          return (
            <div key={`m${i}`} className={`change zoom ${m.status}`} onClick={() => p.onClipFocus(i)}>
              <span className="dot" />
              <div className="text">
                <Film size={13} /> {m.reason || "New clip"}
              </div>
              <div className="why">{m.status === "restored" ? "Clip removed" : `New clip · ${(m.end - m.start).toFixed(1)}s · ${m.file}`}</div>
              <div className="row">
                <span className="mono">{timecode(m.start)}</span>
                {m.status === "pending" && (
                  <>
                    <button className="btn" title="Take this clip out" onClick={(e) => (e.stopPropagation(), p.onClipStatus(i, "restored"))}>
                      <X size={14} /> Remove
                    </button>
                    <button className="btn" title="Keep this clip" onClick={(e) => (e.stopPropagation(), p.onClipStatus(i, "accepted"))}>
                      <Check size={14} /> Keep
                    </button>
                  </>
                )}
                {m.status !== "pending" && (
                  <button className="btn ghost" onClick={(e) => (e.stopPropagation(), p.onClipStatus(i, "pending"))}>
                    <Undo2 size={14} /> Undo
                  </button>
                )}
              </div>
            </div>
          );
        }
        const { z, i } = it;
        return (
          <div key={`z${i}`} className={`change zoom ${z.status}`} onClick={() => p.onZoomFocus(i)}>
            <span className="dot" />
            <div className="text">
              <ZoomIn size={13} /> {text(z.first, z.last)}
            </div>
            <div className="why">{z.status === "restored" ? "Zoom removed" : `Zoom in · ${z.reason ?? ""}`}</div>
            <div className="row">
              <span className="mono">{timecode(p.words[z.first]?.start ?? 0)}</span>
              {z.status === "pending" && (
                <>
                  <button className="btn" title="Take this zoom out" onClick={(e) => (e.stopPropagation(), p.onZoomRemove(i))}>
                    <X size={14} /> Remove
                  </button>
                  <button className="btn" title="Keep this zoom" onClick={(e) => (e.stopPropagation(), p.onZoomAccept(i))}>
                    <Check size={14} /> Keep
                  </button>
                </>
              )}
              {z.status !== "pending" && (
                <button className="btn ghost" onClick={(e) => (e.stopPropagation(), p.onZoomUndo(i))}>
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
