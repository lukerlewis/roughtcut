import { Check, Film, Trash2, Type, X, ZoomIn } from "lucide-react";
import { useEffect, useState } from "react";
import { TEXT_DEFAULTS, timecode, zoomSpan, type Clip, type TextFx, type TextStyle, type Word, type Zoom } from "../lib/edl";

export type Look = { scale: number; x: number; y: number };

interface Props {
  words: Word[];
  zoom?: Zoom;
  clip?: Clip;
  text?: TextFx;
  onText: (patch: Partial<TextFx>) => void; // saved as one change
  look: Look | null; // a change in progress, not yet saved
  onLook: (look: Look | null) => void; // while sliding
  onCommit: (look: Look) => void; // when the slider is let go
  onKeep: () => void;
  onRemove: () => void;
}

const STYLES: [TextStyle, string][] = [
  ["title", "Title"],
  ["lower-third", "Lower third"],
  ["callout", "Callout"],
];

/** A text field that saves when Luke leaves it or presses Return, so typing is one undo step. */
function Field({ value, placeholder, onSave }: { value: string; placeholder: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const save = () => draft !== value && onSave(draft);
  return (
    <input
      className="field"
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

function TextSettings({ t, onText, onKeep, onRemove }: { t: TextFx; onText: Props["onText"]; onKeep: () => void; onRemove: () => void }) {
  const [size, setSize] = useState<number | null>(null);
  const commitSize = () => {
    if (size !== null) onText({ size });
    setSize(null);
  };
  return (
    <div className="panel-body effect">
      <div className="effect-head">
        <Type size={15} /> <span>Text</span>
        {t.status === "pending" && <span className="dot" title="Claude's, not reviewed yet" />}
      </div>
      <p className="why">
        <span className="mono">
          {timecode(t.start, 30, true)} to {timecode(t.end, 30, true)}
        </span>
      </p>
      <div className="seg wide">
        {STYLES.map(([k, label]) => (
          <button key={k} className={t.style === k ? "on" : ""} onClick={() => t.style !== k && onText({ style: k, ...TEXT_DEFAULTS[k] })}>
            {label}
          </button>
        ))}
      </div>
      <label className="setting">
        <span>Text</span>
      </label>
      <Field value={t.text} placeholder="What it says" onSave={(text) => onText({ text })} />
      {t.style !== "callout" && (
        <>
          <label className="setting">
            <span>{t.style === "title" ? "Subtitle" : "Second line"}</span>
          </label>
          <Field value={t.sub ?? ""} placeholder="Optional" onSave={(sub) => onText({ sub })} />
        </>
      )}
      <label className="setting">
        <span>Size</span>
        <span className="mono">{Math.round((size ?? t.size) * 1000) / 10}%</span>
      </label>
      <input
        type="range"
        min={15}
        max={160}
        value={Math.round((size ?? t.size) * 1000)}
        onChange={(e) => setSize(Number(e.target.value) / 1000)}
        onPointerUp={commitSize}
        onKeyUp={commitSize}
        onBlur={commitSize}
      />
      <label className="setting">
        <span>Look</span>
      </label>
      <div className="seg wide">
        <button className={(t.look ?? "plain") === "plain" ? "on" : ""} onClick={() => onText({ look: "plain" })}>
          Plain
        </button>
        <button className={t.look === "box" ? "on" : ""} onClick={() => onText({ look: "box" })}>
          On a card
        </button>
      </div>
      <p className="hint">Drag it on the video to move it, or its ends on the timeline to change when it shows.</p>
      <div className="actions">
        {t.status === "pending" && (
          <button className="btn" onClick={onKeep}>
            <Check size={14} /> Keep
          </button>
        )}
        <button className="btn ghost" onClick={onRemove}>
          {t.status === "pending" ? <X size={14} /> : <Trash2 size={14} />} Remove text
        </button>
      </div>
    </div>
  );
}

/** The settings of the effect picked on the timeline. */
export function Effect(p: Props) {
  if (p.text) return <TextSettings t={p.text} onText={p.onText} onKeep={p.onKeep} onRemove={p.onRemove} />;
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
        <div className="actions">
          <button className="btn" onClick={() => preset(0.5, 0.5)}>
            Centre
          </button>
          <button className="btn" onClick={() => preset(0.5, 0.4)}>
            Face
          </button>
        </div>
        <div className="actions">
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
        <div className="actions">
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
