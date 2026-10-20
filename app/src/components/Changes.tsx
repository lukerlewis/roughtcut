import { Check, Film, RotateCcw, Type, Undo2, X, ZoomIn } from "lucide-react";
import { useEffect, useRef } from "react";
import { timecode, wordAt, type AgentCut, type AgentStatus, type Clip, type TextFx, type Word, type Zoom } from "../lib/edl";

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
  texts: TextFx[];
  /** Show one of Claude's effects (kind "clip" or "text"), or set whether it's kept. */
  onEffectFocus: (kind: string, i: number) => void;
  onEffectStatus: (kind: string, i: number, status: AgentStatus) => void;
}

type Item =
  | { kind: "cut"; i: number; c: AgentCut }
  | { kind: "zoom"; i: number; z: Zoom }
  | { kind: "clip"; i: number; m: Clip }
  | { kind: "text"; i: number; t: TextFx };

/** Claude's changes as a change set: blue dot until reviewed. */
export function Changes(p: Props) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    box.current?.querySelector(`[data-c="${p.focus}"]`)?.scrollIntoView({ block: "nearest" });
  }, [p.focus]);

  const firstWord = (it: Item) =>
    it.kind === "cut" ? it.c.first : it.kind === "zoom" ? it.z.first : Math.max(0, wordAt(p.words, it.kind === "clip" ? it.m.start : it.t.start));
  const items: Item[] = [
    ...p.cuts.map((c, i) => ({ kind: "cut" as const, i, c })),
    ...p.zooms.flatMap((z, i) => (z.by === "agent" ? [{ kind: "zoom" as const, i, z }] : [])),
    ...p.clips.flatMap((m, i) => (m.by === "agent" ? [{ kind: "clip" as const, i, m }] : [])),
    ...p.texts.flatMap((t, i) => (t.by === "agent" ? [{ kind: "text" as const, i, t }] : [])),
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
        if (it.kind === "clip" || it.kind === "text") {
          const { i } = it;
          const x = it.kind === "clip" ? it.m : it.t;
          const Icon = it.kind === "clip" ? Film : Type;
          const title = it.kind === "clip" ? it.m.reason || "New clip" : it.t.text;
          const what = it.kind === "clip" ? `New clip · ${(x.end - x.start).toFixed(1)}s` : `Text · ${it.t.reason ?? ""}`;
          const set = (status: AgentStatus) => (e: React.MouseEvent) => (e.stopPropagation(), p.onEffectStatus(it.kind, i, status));
          return (
            <div key={`${it.kind}${i}`} className={`change zoom ${x.status}`} onClick={() => p.onEffectFocus(it.kind, i)}>
              <span className="dot" />
              <div className="text">
                <Icon size={13} /> {title}
              </div>
              <div className="why">{x.status === "restored" ? "Removed" : what}</div>
              <div className="row">
                <span className="mono">{timecode(x.start)}</span>
                {x.status === "pending" && (
                  <>
                    <button className="btn" title="Take it out" onClick={set("restored")}>
                      <X size={14} /> Remove
                    </button>
                    <button className="btn" title="Keep it" onClick={set("accepted")}>
                      <Check size={14} /> Keep
                    </button>
                  </>
                )}
                {x.status !== "pending" && (
                  <button className="btn ghost" onClick={set("pending")}>
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
