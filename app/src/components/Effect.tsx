import { Check, EyeOff, Film, Gauge, ImageIcon, LayoutPanelLeft, MessageSquare, Send, Trash2, Type, User, X, ZoomIn } from "lucide-react";
import { useEffect, useState } from "react";
import { TEXT_DEFAULTS, timecode, zoomSpan, type Background, type BlurFx, type Clip, type LayoutMode, type Rendered, type Note, type SpeedFx, type TextFx, type TextStyle, type Word, type Zoom } from "../lib/edl";

export type Look = { scale: number; x: number; y: number };

interface Props {
  words: Word[];
  zoom?: Zoom;
  clip?: Clip;
  text?: TextFx;
  onText: (patch: Partial<TextFx>) => void; // saved as one change
  onRender: (settings: Rendered) => void; // re-render with these settings
  onChooseImage: () => Promise<string | null>;
  rendering: number | null; // progress of a background being rendered
  speed?: SpeedFx;
  blur?: BlurFx;
  onTimed: (patch: Partial<SpeedFx & BlurFx>) => void;
  note?: Note;
  onNote: (patch: Partial<Note>) => void;
  onNoteSaved: () => void; // Return in the note: carry on watching
  openNotes: number; // notes not yet sent or done, this one included
  onSendNotes: (draft: string) => void;
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

function NoteSettings({ n, p }: { n: Note; p: Props }) {
  const [draft, setDraft] = useState(n.text);
  useEffect(() => setDraft(n.text), [n.text]);
  const save = () => draft !== n.text && p.onNote({ text: draft });
  return (
    <div className="panel-body effect">
      <div className="effect-head">
        <MessageSquare size={15} /> <span>{n.by === "agent" ? "Note from Claude" : "Note"}</span>
      </div>
      <p className="why">
        <span className="mono">{timecode(n.at, 30, true)}</span>
      </p>
      {n.by === "agent" ? (
        <p>{n.text}</p>
      ) : (
        <textarea
          className="field note"
          autoFocus={!n.text}
          value={draft}
          rows={4}
          placeholder="What should change here? Return to save and keep watching."
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              save();
              p.onNoteSaved();
            } else if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur();
          }}
        />
      )}
      {n.reply && (
        <>
          <label className="setting">
            <span>Claude</span>
          </label>
          <p className="why">{n.reply}</p>
        </>
      )}
      <p className="hint">Press N while watching to drop a note. Send them to Claude when you're done, and it works through each one.</p>
      <div className="actions">
        {p.openNotes > 0 && (
          <button className="btn" onClick={() => p.onSendNotes(draft)}>
            <Send size={14} /> Send {p.openNotes === 1 ? "note" : `${p.openNotes} notes`} to Claude
          </button>
        )}
      </div>
      <div className="actions">
        {n.by === "you" && (
          <button className="btn ghost" onClick={() => p.onNote({ done: !n.done })}>
            <Check size={14} /> {n.done ? "Not done" : "Done"}
          </button>
        )}
        <button className="btn ghost" onClick={p.onRemove}>
          <Trash2 size={14} /> Delete note
        </button>
      </div>
    </div>
  );
}

function Status({ pending, onKeep, onRemove, what }: { pending: boolean; onKeep: () => void; onRemove: () => void; what: string }) {
  return (
    <div className="actions">
      {pending && (
        <button className="btn" onClick={onKeep}>
          <Check size={14} /> Keep
        </button>
      )}
      <button className="btn ghost" onClick={onRemove}>
        {pending ? <X size={14} /> : <Trash2 size={14} />} Remove {what}
      </button>
    </div>
  );
}

function SpeedSettings({ x, p }: { x: SpeedFx; p: Props }) {
  const [rate, setRate] = useState<number | null>(null);
  const commit = () => {
    if (rate !== null) p.onTimed({ rate });
    setRate(null);
  };
  const shown = rate ?? x.rate;
  return (
    <div className="panel-body effect">
      <div className="effect-head">
        <Gauge size={15} /> <span>Speed-up</span>
        {x.status === "pending" && <span className="dot" title="Claude's, not reviewed yet" />}
      </div>
      <p className="why">
        {x.reason && (
          <>
            {x.reason}
            <br />
          </>
        )}
        <span className="mono">
          {timecode(x.start, 30, true)} to {timecode(x.end, 30, true)}
        </span>
      </p>
      <label className="setting">
        <span>Speed</span>
        <span className="mono">{shown.toFixed(2)}x</span>
      </label>
      <input
        type="range"
        min={110}
        max={400}
        step={5}
        value={Math.round(shown * 100)}
        onChange={(e) => setRate(Number(e.target.value) / 100)}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <div className="actions">
        {[1.5, 2, 3].map((r) => (
          <button key={r} className="btn" onClick={() => p.onTimed({ rate: r })}>
            {r}x
          </button>
        ))}
      </div>
      <p className="hint">The voice keeps its pitch. Drag the block's ends on the timeline to change what's sped up.</p>
      <Status pending={x.status === "pending"} onKeep={p.onKeep} onRemove={p.onRemove} what="speed-up" />
    </div>
  );
}

function BlurSettings({ x, p }: { x: BlurFx; p: Props }) {
  return (
    <div className="panel-body effect">
      <div className="effect-head">
        <EyeOff size={15} /> <span>Blur</span>
        {x.status === "pending" && <span className="dot" title="Claude's, not reviewed yet" />}
      </div>
      <p className="why">
        {x.reason && (
          <>
            {x.reason}
            <br />
          </>
        )}
        <span className="mono">
          {timecode(x.start, 30, true)} to {timecode(x.end, 30, true)}
        </span>
      </p>
      <label className="setting">
        <span>Area</span>
        <span className="mono">
          {Math.round(x.w * 100)}% × {Math.round(x.h * 100)}%
        </span>
      </label>
      <p className="hint">Drag the box on the video to move it, and its corner to resize it. Drag the block's ends on the timeline to change when it shows.</p>
      <Status pending={x.status === "pending"} onKeep={p.onKeep} onRemove={p.onRemove} what="blur" />
    </div>
  );
}

function BackgroundSettings({ c, p }: { c: Clip; p: Props }) {
  const [b, setB] = useState<Background>(c.background!);
  useEffect(() => setB(c.background!), [c.background]);
  const changed = JSON.stringify(b) !== JSON.stringify(c.background);
  const ready = b.mode !== "image" || !!b.image;
  return (
    <div className="panel-body effect">
      <div className="effect-head">
        <User size={15} /> <span>Background</span>
        {c.status === "pending" && <span className="dot" title="Claude's, not reviewed yet" />}
      </div>
      <p className="why">
        {c.reason && (
          <>
            {c.reason}
            <br />
          </>
        )}
        <span className="mono">
          {timecode(c.start, 30, true)} to {timecode(c.end, 30, true)}
        </span>
      </p>
      <div className="seg wide">
        {(["blur", "color", "image"] as const).map((m) => (
          <button key={m} className={b.mode === m ? "on" : ""} onClick={() => setB({ ...b, mode: m })}>
            {m === "blur" ? "Blur" : m === "color" ? "Colour" : "Picture"}
          </button>
        ))}
      </div>
      {b.mode === "blur" && (
        <>
          <label className="setting">
            <span>Strength</span>
            <span className="mono">{b.strength ?? 30}</span>
          </label>
          <input type="range" min={4} max={100} value={b.strength ?? 30} onChange={(e) => setB({ ...b, strength: Number(e.target.value) })} />
        </>
      )}
      {b.mode === "color" && (
        <label className="setting">
          <span>Colour</span>
          <input type="color" value={b.color ?? "#1f1f1f"} onChange={(e) => setB({ ...b, color: e.target.value })} />
        </label>
      )}
      {b.mode === "image" && (
        <div className="actions">
          <button className="btn" onClick={() => p.onChooseImage().then((image) => image && setB({ ...b, image }))}>
            <ImageIcon size={14} /> {b.image ? b.image.split("/").pop() : "Choose a picture…"}
          </button>
        </div>
      )}
      {p.rendering !== null ? (
        <p className="hint">Cutting you out of the background… {Math.round(p.rendering * 100)}%</p>
      ) : (
        changed && (
          <div className="actions">
            <button className="btn" disabled={!ready} onClick={() => p.onRender({ background: b })}>
              Apply
            </button>
          </div>
        )
      )}
      <p className="hint">Done on your Mac. Drag the block's ends to change where it shows, and it renders the new stretch.</p>
      <Status pending={c.status === "pending"} onKeep={p.onKeep} onRemove={p.onRemove} what="background" />
    </div>
  );
}

const LAYOUTS: [LayoutMode, string][] = [
  ["camera", "Camera"],
  ["screen", "Screen"],
  ["side", "Side by side"],
];

function LayoutSettings({ c, p }: { c: Clip; p: Props }) {
  return (
    <div className="panel-body effect">
      <div className="effect-head">
        <LayoutPanelLeft size={15} /> <span>Layout</span>
        {c.status === "pending" && <span className="dot" title="Claude's, not reviewed yet" />}
      </div>
      <p className="why">
        {c.reason && (
          <>
            {c.reason}
            <br />
          </>
        )}
        <span className="mono">
          {timecode(c.start, 30, true)} to {timecode(c.end, 30, true)}
        </span>
      </p>
      <div className="seg wide">
        {LAYOUTS.map(([m, label]) => (
          <button key={m} className={c.layout?.mode === m ? "on" : ""} disabled={p.rendering !== null} onClick={() => c.layout?.mode !== m && p.onRender({ layout: { mode: m } })}>
            {label}
          </button>
        ))}
      </div>
      {p.rendering !== null && <p className="hint">Making the layout…</p>}
      <p className="hint">Elsewhere the video shows your screen with the camera in the corner. Drag the block's ends to change where this layout shows.</p>
      <Status pending={c.status === "pending"} onKeep={p.onKeep} onRemove={p.onRemove} what="layout" />
    </div>
  );
}

/** The settings of the effect picked on the timeline. */
export function Effect(p: Props) {
  if (p.clip?.layout) return <LayoutSettings c={p.clip} p={p} />;
  if (p.clip?.background) return <BackgroundSettings c={p.clip} p={p} />;
  if (p.speed) return <SpeedSettings x={p.speed} p={p} />;
  if (p.blur) return <BlurSettings x={p.blur} p={p} />;
  if (p.note) return <NoteSettings n={p.note} p={p} />;
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
