import { Check, Film, Trash2, X, ZoomIn } from "lucide-react";
import { timecode, zoomSpan, type Clip, type Word, type Zoom } from "../lib/edl";

export type Look = { scale: number; x: number; y: number };

interface Props {
  words: Word[];
  zoom?: Zoom;
  clip?: Clip;
  look: Look | null; // a change in progress, not yet saved
  onLook: (look: Look | null) => void; // while sliding
  onCommit: (look: Look) => void; // when the slider is let go
  onKeep: () => void;
  onRemove: () => void;
}

/** The settings of the effect picked on the timeline. */
export function Effect(p: Props) {
  if (p.zoom) {
    const z = p.zoom;
    const look = p.look ?? { scale: z.scale, x: z.x, y: z.y };
    const [a, b] = zoomSpan(p.words, z);
    const commit = () => p.look && p.onCommit(p.look);
    const preset = (x: number, y: number) => p.onCommit({ ...look, x, y });
    return (
      <div className="panel-body effect">
        <div className="effect-head">
          <ZoomIn size={15} /> <span>Zoom</span>
          {z.status === "pending" && <span className="dot" title="Claude's, not reviewed yet" />}
        </div>
        <p className="why">
          {p.words.slice(z.first, z.last + 1).map((w) => w.text).join(" ")}
          <br />
          <span className="mono">
            {timecode(a, 30, true)} to {timecode(b, 30, true)}
          </span>
        </p>
        <label className="setting">
          <span>Amount</span>
          <span className="mono">{Math.round(look.scale * 100)}%</span>
        </label>
        <input
          type="range"
          min={105}
          max={250}
          step={1}
          value={Math.round(look.scale * 100)}
          onChange={(e) => p.onLook({ ...look, scale: Number(e.target.value) / 100 })}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
        />
        <label className="setting">
          <span>Where it zooms</span>
        </label>
        <p className="hint">Drag the box on the video to pick the spot.</p>
        <div className="actions left">
          <button className="btn" onClick={() => preset(0.5, 0.5)}>
            Centre
          </button>
          <button className="btn" onClick={() => preset(0.5, 0.4)}>
            Face
          </button>
        </div>
        <div className="actions left">
          {z.status === "pending" && (
            <button className="btn" onClick={p.onKeep}>
              <Check size={14} /> Keep
            </button>
          )}
          <button className="btn ghost" onClick={p.onRemove}>
            {z.status === "pending" ? <X size={14} /> : <Trash2 size={14} />} Remove zoom
          </button>
        </div>
      </div>
    );
  }
  if (p.clip) {
    const c = p.clip;
    return (
      <div className="panel-body effect">
        <div className="effect-head">
          <Film size={15} /> <span>Claude clip</span>
          {c.status === "pending" && <span className="dot" title="Claude's, not reviewed yet" />}
        </div>
        <p className="why">{c.reason}</p>
        <label className="setting">
          <span>Plays over</span>
          <span className="mono">
            {timecode(c.start, 30, true)} to {timecode(c.end, 30, true)}
          </span>
        </label>
        <label className="setting">
          <span>File</span>
          <span className="mono">{c.file}</span>
        </label>
        <p className="hint">Drag it on the timeline to move it, or its ends to trim it. To change how it looks, ask Claude to remake it.</p>
        <div className="actions left">
          {c.status === "pending" && (
            <button className="btn" onClick={p.onKeep}>
              <Check size={14} /> Keep
            </button>
          )}
          <button className="btn ghost" onClick={p.onRemove}>
            {c.status === "pending" ? <X size={14} /> : <Trash2 size={14} />} Remove clip
          </button>
        </div>
      </div>
    );
  }
  return null;
}
