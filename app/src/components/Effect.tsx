import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bookmark, Check, Clapperboard, EyeOff, Film, Gauge, ImageIcon, LayoutPanelLeft, MessageSquare, Play, Send, Trash2, Type, User, X, ZoomIn } from "lucide-react";
import { useEffect, useState } from "react";
import { motionOf, partsOf } from "../lib/graphics";
import { settingsOf, textsOf, type Setting } from "../lib/graphicView";
import type { CatalogGraphic } from "../lib/backend";
import { MOTION_DEFAULTS, TEXT_DEFAULTS, ZOOM, ZOOM_MAX, type Direction, type Easing, type Motion, type MotionStep, timecode, zoomSpan, type Background, type BlurFx, type Clip, type LayoutMode, type Rendered, type Note, type SpeedFx, type TextFx, type TextStyle, type Word, type Zoom, type Graphic } from "../lib/edl";

export type Look = { scale: number; x: number; y: number };

interface Props {
  words: Word[];
  zoom?: Zoom;
  clip?: Clip;
  text?: TextFx;
  onText: (patch: Partial<TextFx>) => void; // saved as one change
  onSaveAsset: (t: TextFx) => void; // keep this text's look to reuse in any video
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
  onPreview: () => void; // play the effect from just before it
  onMotionDefault: (style: TextStyle, motion: Motion) => void; // new graphics of this kind move like this
  graphic?: Graphic;
  graphicSource: string | null; // its page as made, for its words and settings
  graphicParams: CatalogGraphic["params"];
  onGraphic: (patch: Partial<Graphic>) => void;
  onAskGraphic: (text: string) => void; // Claude changes it
  onSaveGraphic: () => void; // keep it in the Library to use again
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

const KINDS: [MotionStep["type"], string][] = [
  ["none", "None"],
  ["fade", "Fade"],
  ["slide", "Slide"],
  ["pop", "Pop"],
  ["reveal", "Reveal"],
];

// Ready-made motion, after the looks HyperFrames and Remotion use: strong
// ease outs coming in, quicker exits, blur while moving, words a beat apart.
const PRESETS: [string, string, (style: TextStyle) => Motion][] = [
  ["Clean", "The standard for this kind of graphic", (style) => MOTION_DEFAULTS[style]],
  [
    "Word by word",
    "Each word rises out from behind its line",
    () => ({ in: { type: "reveal", from: "down", duration: 0.6, easing: "snappy" }, out: { type: "fade", duration: 0.3, easing: "smooth", blur: 6 }, stagger: 0.06, by: "word" }),
  ],
  ["Spring", "Pops in on a soft spring", () => ({ in: { type: "pop", duration: 0.7, easing: "spring" }, out: { type: "fade", duration: 0.25, easing: "smooth" }, stagger: 0.1 })],
  [
    "Cinematic",
    "A slow blurred fade, slowly growing while it holds",
    () => ({ in: { type: "fade", duration: 1, easing: "gentle", blur: 14 }, out: { type: "fade", duration: 0.7, easing: "gentle", blur: 10 }, stagger: 0.3, drift: 0.04 }),
  ],
  [
    "Across",
    "Slides in from off screen and leaves the way it was going",
    () => ({ in: { type: "slide", from: "left", distance: 1, duration: 0.6, easing: "snappy", blur: 10 }, out: { type: "slide", from: "right", distance: 1, duration: 0.5, easing: "smooth", blur: 10 }, stagger: 0.08 }),
  ],
];
const EASES: [Easing, string, string][] = [
  ["smooth", "Smooth", "Eases to a stop"],
  ["snappy", "Snappy", "Fast, then settles"],
  ["gentle", "Gentle", "Soft and even"],
  ["overshoot", "Bouncy", "Goes a little past, then back"],
  ["spring", "Springy", "A soft physical spring, like Remotion's"],
  ["linear", "Linear", "Same speed throughout"],
];
const SIDES: [Direction, typeof ArrowLeft, string][] = [
  ["left", ArrowLeft, "Left"],
  ["right", ArrowRight, "Right"],
  ["up", ArrowUp, "Top"],
  ["down", ArrowDown, "Bottom"],
];
const PLURAL: Record<TextStyle, string> = { title: "titles", "lower-third": "lower thirds", callout: "callouts", image: "pictures" };

/** How a graphic comes in and goes out: kind, side, distance, time, easing,
 *  blur, and the stagger between its parts. Saved as one change per gesture. */
function MotionSettings({ t, p }: { t: TextFx; p: Props }) {
  const m = motionOf(t);
  const words = t.style === "title" || t.style === "lower-third"; // can reveal, and go word by word
  const [which, setWhich] = useState<"in" | "out">("in");
  const [draft, setDraft] = useState<Motion | null>(null);
  const shown = draft ?? m;
  const step = shown[which];
  const set = (patch: Partial<MotionStep>) => p.onText({ motion: { ...m, [which]: { ...m[which], ...patch } } });
  const slide = (patch: Partial<MotionStep>) => setDraft({ ...shown, [which]: { ...step, ...patch } });
  const commit = () => {
    if (draft) p.onText({ motion: draft });
    setDraft(null);
  };
  const range = (label: string, value: string, v: number, min: number, max: number, on: (v: number) => void) => (
    <>
      <label className="setting">
        <span>{label}</span>
        <span className="mono">{value}</span>
      </label>
      <input type="range" min={min} max={max} value={v} onChange={(e) => on(Number(e.target.value))} onPointerUp={commit} onKeyUp={commit} onBlur={commit} />
    </>
  );
  return (
    <>
      <div className="effect-sub">Motion</div>
      <div className="actions wrap">
        {PRESETS.map(([name, tip, make]) => (
          <button key={name} className="btn" title={tip} onClick={() => p.onText({ motion: make(t.style) })}>
            {name}
          </button>
        ))}
      </div>
      <div className="seg wide">
        <button className={which === "in" ? "on" : ""} onClick={() => setWhich("in")}>
          Coming in
        </button>
        <button className={which === "out" ? "on" : ""} onClick={() => setWhich("out")}>
          Going out
        </button>
      </div>
      <div className="seg wide">
        {KINDS.filter(([k]) => k !== "reveal" || words).map(([k, label]) => (
          <button key={k} className={step.type === k ? "on" : ""} onClick={() => step.type !== k && set({ type: k, from: step.from ?? (which === "in" ? "down" : "up"), distance: step.distance ?? 0.05 })}>
            {label}
          </button>
        ))}
      </div>
      {step.type === "reveal" && (
        <>
          <label className="setting">
            <span>{which === "in" ? "Rises" : "Leaves"}</span>
          </label>
          <div className="seg wide">
            <button className={step.from !== "up" ? "on" : ""} onClick={() => set({ from: "down" })}>
              {which === "in" ? "Up from below" : "Down"}
            </button>
            <button className={step.from === "up" ? "on" : ""} onClick={() => set({ from: "up" })}>
              {which === "in" ? "Down from above" : "Up"}
            </button>
          </div>
        </>
      )}
      {step.type === "slide" && (
        <>
          <label className="setting">
            <span>{which === "in" ? "From" : "Towards"}</span>
          </label>
          <div className="seg wide">
            {SIDES.map(([d, Icon, label]) => (
              <button key={d} className={(step.from ?? "left") === d ? "on" : ""} title={label} onClick={() => set({ from: d })}>
                <Icon size={14} />
              </button>
            ))}
          </div>
          {range("Distance", (step.distance ?? 0.3) >= 1 ? "off screen" : `${Math.round((step.distance ?? 0.3) * 100)}%`, Math.round((step.distance ?? 0.3) * 100), 1, 100, (v) => slide({ distance: v / 100 }))}
        </>
      )}
      {step.type !== "none" && (
        <>
          {range("Takes", `${step.duration.toFixed(2)}s`, Math.round(step.duration * 20), 1, 40, (v) => slide({ duration: v / 20 }))}
          <label className="setting">
            <span>Easing</span>
          </label>
          <div className="seg wide wrap">
            {EASES.map(([e, label, tip]) => (
              <button key={e} className={step.easing === e ? "on" : ""} title={tip} onClick={() => set({ easing: e })}>
                {label}
              </button>
            ))}
          </div>
          {range("Blur while moving", step.blur ? `${step.blur}px` : "none", step.blur ?? 0, 0, 24, (v) => slide({ blur: v }))}
        </>
      )}
      {words && (
        <>
          <label className="setting">
            <span>Moves</span>
          </label>
          <div className="seg wide">
            <button className={m.by !== "word" ? "on" : ""} onClick={() => p.onText({ motion: { ...m, by: "line" } })}>
              Line by line
            </button>
            <button className={m.by === "word" ? "on" : ""} onClick={() => p.onText({ motion: { ...m, by: "word", stagger: m.by === "word" ? m.stagger : 0.06 } })}>
              Word by word
            </button>
          </div>
        </>
      )}
      {partsOf(t) > 1 && range(m.by === "word" ? "Between words" : "Stagger", `${shown.stagger.toFixed(2)}s`, Math.round(shown.stagger * 100), 0, 60, (v) => setDraft({ ...shown, stagger: v / 100 }))}
      {range("Drift while it holds", shown.drift ? `${Math.round(shown.drift * 100)}%` : "none", Math.round((shown.drift ?? 0) * 100), 0, 15, (v) => setDraft({ ...shown, drift: v / 100 }))}
      <div className="actions wrap">
        <button className="btn ghost" onClick={p.onPreview}>
          <Play size={14} /> Play it
        </button>
        <button className="btn" onClick={() => p.onMotionDefault(t.style, m)} title={`New ${PLURAL[t.style]} will move like this, and Claude will use it too`}>
          Use for all {PLURAL[t.style]}
        </button>
      </div>
    </>
  );
}

function TextSettings({ t, p }: { t: TextFx; p: Props }) {
  const { onText, onKeep, onRemove, onSaveAsset } = p;
  const image = t.style === "image";
  const [size, setSize] = useState<number | null>(null);
  const commitSize = () => {
    if (size !== null) onText(image ? { w: size } : { size });
    setSize(null);
  };
  const shownSize = size ?? (image ? (t.w ?? 0.3) : t.size);
  return (
    <div className="panel-body effect">
      <div className="effect-head">
        {image ? <ImageIcon size={15} /> : <Type size={15} />} <span>{image ? "Picture" : "Text"}</span>
        {t.status === "pending" && <span className="dot" title="Claude's, not reviewed yet" />}
      </div>
      <p className="why">
        <span className="mono">
          {timecode(t.start, 30, true)} to {timecode(t.end, 30, true)}
        </span>
      </p>
      {!image && (
      <>
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
      </>
      )}
      <label className="setting">
        <span>{image ? "Width" : "Size"}</span>
        <span className="mono">{Math.round(shownSize * 1000) / 10}%</span>
      </label>
      <input
        type="range"
        min={image ? 30 : 15}
        max={image ? 1000 : 160}
        value={Math.round(shownSize * 1000)}
        onChange={(e) => setSize(Number(e.target.value) / 1000)}
        onPointerUp={commitSize}
        onKeyUp={commitSize}
        onBlur={commitSize}
      />
      {!image && (
        <>
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
        </>
      )}
      <p className="hint">Drag it on the video to move it, or its ends on the timeline to change when it shows.</p>
      <MotionSettings t={t} p={p} />
      <div className="actions">
        {t.status === "pending" && (
          <button className="btn" onClick={onKeep}>
            <Check size={14} /> Keep
          </button>
        )}
        <button className="btn" onClick={() => onSaveAsset(t)} title="Keep this look in your Library to reuse in any video">
          <Bookmark size={14} /> Save as asset
        </button>
        <button className="btn ghost" onClick={onRemove}>
          {t.status === "pending" ? <X size={14} /> : <Trash2 size={14} />} Remove {image ? "picture" : "text"}
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
/** One setting of a motion graphic: a colour, a number or some text. */
function SettingField({ s, value, onSave }: { s: Setting; value: string | number; onSave: (v: string | number) => void }) {
  const [draft, setDraft] = useState<string | number | null>(null);
  const shown = draft ?? value;
  const commit = () => {
    if (draft !== null && draft !== value) onSave(draft);
    setDraft(null);
  };
  if (s.type === "color")
    return (
      <label className="setting color">
        <span>{s.label}</span>
        <input type="color" value={String(shown).slice(0, 7)} onChange={(e) => setDraft(e.target.value)} onBlur={commit} />
      </label>
    );
  if (s.type === "number")
    return (
      <>
        <label className="setting">
          <span>{s.label}</span>
          <span className="mono">{shown}</span>
        </label>
        <input
          type="range"
          min={s.min ?? 0}
          max={s.max ?? Math.max(10, Number(s.default) * 3)}
          step={s.step ?? 1}
          value={Number(shown)}
          onChange={(e) => setDraft(Number(e.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
        />
      </>
    );
  const long = String(value).includes("\n");
  return (
    <>
      <label className="setting">
        <span>{s.label}</span>
      </label>
      {long ? (
        <textarea className="field" rows={5} value={String(shown)} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.stopPropagation()} />
      ) : (
        <Field value={String(value)} placeholder="" onSave={onSave} />
      )}
    </>
  );
}

function GraphicSettings({ g, p }: { g: Graphic; p: Props }) {
  const [ask, setAsk] = useState("");
  const [scale, setScale] = useState<number | null>(null);
  const src = p.graphicSource;
  const words = src ? textsOf(src) : [];
  const settings = src ? settingsOf(src, p.graphicParams) : [];
  const setWord = (i: number, text: string) => {
    const texts = { ...g.texts };
    if (text === words[i]) delete texts[i];
    else texts[i] = text;
    p.onGraphic({ texts });
  };
  const commitScale = () => {
    if (scale !== null) p.onGraphic({ scale });
    setScale(null);
  };
  return (
    <div className="panel-body effect">
      <div className="effect-head">
        <Clapperboard size={15} /> <span>{g.name}</span>
        {g.status === "pending" && <span className="dot" title="Claude's, not reviewed yet" />}
      </div>
      <p className="why">
        {g.reason && <>{g.reason} </>}
        <span className="mono">
          {timecode(g.start, 30, true)} to {timecode(g.end, 30, true)}
        </span>
      </p>
      {!src && <p className="hint">Loading…</p>}
      {words.length > 0 && <div className="effect-sub">Words</div>}
      {words.slice(0, 24).map((w, i) => (
        <Field key={i} value={g.texts?.[i] ?? w} placeholder={w} onSave={(t) => setWord(i, t)} />
      ))}
      {settings.length > 0 && <div className="effect-sub">Settings</div>}
      {settings.map((s) => (
        <SettingField key={s.key} s={s} value={g.params?.[s.key] ?? s.default} onSave={(v) => p.onGraphic({ params: { ...g.params, [s.key]: v } })} />
      ))}
      <div className="effect-sub">Look</div>
      <div className="seg wide">
        <button className={g.brand !== false ? "on" : ""} onClick={() => g.brand === false && p.onGraphic({ brand: true })} title="Your font and colours, from Style">
          Your brand
        </button>
        <button className={g.brand === false ? "on" : ""} onClick={() => g.brand !== false && p.onGraphic({ brand: false })}>
          As made
        </button>
      </div>
      <div className="effect-sub">Place</div>
      <label className="setting">
        <span>Size</span>
        <span className="mono">{Math.round((scale ?? g.scale ?? 1) * 100)}%</span>
      </label>
      <input
        type="range"
        min={20}
        max={200}
        value={Math.round((scale ?? g.scale ?? 1) * 100)}
        onChange={(e) => setScale(Number(e.target.value) / 100)}
        onPointerUp={commitScale}
        onKeyUp={commitScale}
        onBlur={commitScale}
      />
      <p className="hint">Drag it on the video to move it, or its ends on the timeline to change when it shows.</p>
      {(g.x || g.y || (g.scale ?? 1) !== 1) && (
        <button className="btn ghost" onClick={() => p.onGraphic({ x: 0, y: 0, scale: 1 })}>
          Put it back where it was made to sit
        </button>
      )}
      <div className="effect-sub">Ask Claude to change it</div>
      <textarea
        className="field"
        rows={3}
        value={ask}
        placeholder="Make the numbers 12, 40 and 90, and use my green"
        onChange={(e) => setAsk(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !e.shiftKey && ask.trim()) {
            e.preventDefault();
            p.onAskGraphic(ask.trim());
            setAsk("");
          }
        }}
      />
      <div className="actions wrap">
        {g.status === "pending" && (
          <button className="btn" onClick={p.onKeep}>
            <Check size={14} /> Keep
          </button>
        )}
        <button className="btn ghost" onClick={p.onPreview}>
          <Play size={14} /> Play it
        </button>
        <button className="btn ghost" onClick={p.onSaveGraphic} title="Keep it, as set up now, under Yours in the Library, for you and Claude to use again">
          <Bookmark size={14} /> Save to my graphics
        </button>
        <button className="btn ghost" onClick={p.onRemove}>
          {g.status === "pending" ? <X size={14} /> : <Trash2 size={14} />} Remove graphic
        </button>
      </div>
    </div>
  );
}

export function Effect(p: Props) {
  if (p.graphic) return <GraphicSettings g={p.graphic} p={p} />;
  if (p.clip?.layout) return <LayoutSettings c={p.clip} p={p} />;
  if (p.clip?.background) return <BackgroundSettings c={p.clip} p={p} />;
  if (p.speed) return <SpeedSettings x={p.speed} p={p} />;
  if (p.blur) return <BlurSettings x={p.blur} p={p} />;
  if (p.note) return <NoteSettings n={p.note} p={p} />;
  if (p.text) return <TextSettings t={p.text} p={p} />;
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
          <span className="mono">{look.scale <= 1.001 ? "100%, zoomed out" : `${Math.round(look.scale * 100)}%`}</span>
        </label>
        <input
          type="range"
          min={100}
          max={ZOOM_MAX * 100}
          step={1}
          value={Math.round(look.scale * 100)}
          onChange={(e) => p.onLook({ ...look, scale: Number(e.target.value) / 100 })}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
        />
        <div className="actions">
          <button className="btn" onClick={() => p.onCommit({ ...look, scale: ZOOM.scale })} title="Zoom in to 130%">
            Zoom in
          </button>
          <button className="btn" onClick={() => p.onCommit({ ...look, scale: 1 })} title="Go back to the whole frame">
            Zoom out
          </button>
        </div>
        <p className="hint">
          It {look.scale <= 1.001 ? "zooms out" : "zooms"} over {(b - a).toFixed(1)}s and stays there until the next zoom. Drag the block's ends on the timeline: longer is slower.
        </p>
        {look.scale > 1.001 && (
          <>
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
          </>
        )}
        <button className="btn ghost" onClick={p.onPreview}>
          <Play size={14} /> Play it
        </button>
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
