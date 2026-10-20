import { Check, ChevronDown, ChevronRight, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import type { Skill } from "../lib/backend";

interface Props {
  skills: Skill[];
  ticked: Record<string, boolean>; // Luke's last choices, over each skill's default
  recordedHere: boolean; // has screen, camera and clicks
  graphics: "off" | "light" | "more";
  onTick: (id: string, on: boolean) => void;
  onGraphics: (level: "light" | "more") => void;
  onSave: (patch: { id?: string; name?: string; text?: string; look?: string }) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onRun: (skills: Skill[]) => void;
  onClose: () => void;
}

export const isTicked = (s: Skill, ticked: Record<string, boolean>) => ticked[s.id] ?? s.on;

/** What each step does, for the ones the app runs itself. */
const LABEL: Record<string, string> = {
  cut: "Guidance for the cut",
  graphics: "Guidance for picking graphics",
};

/** Rough cut: the editing skills to run on this video, ticked or not. */
export function RoughCut(p: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: "", text: "" });
  const [error, setError] = useState<string | null>(null);
  const usable = (s: Skill) => s.needs !== "screen" || p.recordedHere;
  const chosen = p.skills.filter((s) => usable(s) && isTicked(s, p.ticked));
  const claude = chosen.some((s) => s.does !== "retakes" && s.does !== "captions");
  const tryTo = (work: Promise<void>) => work.then(() => setError(null), (e) => setError(String(e)));

  return (
    <div className="sheet" onKeyDown={(e) => e.stopPropagation()}>
      <div className="card roughcut">
        <h2>Rough cut</h2>
        <p className="hint">Choose what Claude does to this video. Your ticks are remembered for next time.</p>
        <div className="skills">
          {p.skills.map((s) => {
            const on = usable(s) && isTicked(s, p.ticked);
            const expanded = open === s.id;
            return (
              <div key={s.id} className={`skill ${usable(s) ? "" : "unusable"}`}>
                <div className="skill-row">
                  <button className={`tick ${on ? "on" : ""}`} disabled={!usable(s)} onClick={() => p.onTick(s.id, !on)} aria-pressed={on} title={on ? "Untick" : "Tick"}>
                    {on && <Check size={12} />}
                  </button>
                  <span className="skill-name" onClick={() => usable(s) && p.onTick(s.id, !on)}>
                    {s.name}
                    {!usable(s) && <span className="why"> · for videos recorded in Roughcut</span>}
                  </span>
                  <button className="btn ghost icon" title={expanded ? "Close" : "See or change what it does"} onClick={() => setOpen(expanded ? null : s.id)}>
                    {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                </div>
                {expanded && <SkillDetails s={s} graphics={p.graphics} onGraphics={p.onGraphics} onSave={(patch) => tryTo(p.onSave({ id: s.id, ...patch }))} onRemove={() => tryTo(p.onRemove(s.id).then(() => setOpen(null)))} />}
              </div>
            );
          })}
        </div>
        {adding ? (
          <div className="skill-new">
            <input className="field" autoFocus placeholder="Name, e.g. Add a subscribe reminder at the end" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <textarea className="field" rows={4} placeholder="What Claude should do, in plain words" value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
            <div className="actions">
              <button className="btn ghost" onClick={() => setAdding(false)}>
                Cancel
              </button>
              <button
                className="btn"
                disabled={!draft.name.trim() || !draft.text.trim()}
                onClick={() => tryTo(p.onSave({ name: draft.name.trim(), text: draft.text.trim() }).then(() => (setAdding(false), setDraft({ name: "", text: "" }))))}
              >
                Save skill
              </button>
            </div>
          </div>
        ) : (
          <button className="btn ghost add-skill" onClick={() => setAdding(true)}>
            <Plus size={14} /> New skill
          </button>
        )}
        {error && <p className="error">{error}</p>}
        <div className="actions">
          {claude && <span className="hint grow">Uses your Claude plan.</span>}
          <button className="btn ghost" onClick={p.onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!chosen.length} onClick={() => p.onRun(chosen)}>
            Run {chosen.length === 1 ? "1 skill" : `${chosen.length} skills`}
          </button>
        </div>
      </div>
    </div>
  );
}

function SkillDetails({ s, graphics, onGraphics, onSave, onRemove }: { s: Skill; graphics: Props["graphics"]; onGraphics: Props["onGraphics"]; onSave: (patch: { name?: string; text?: string; look?: string }) => void; onRemove: () => void }) {
  const [name, setName] = useState(s.name);
  const [text, setText] = useState(s.text);
  const fixed = s.does === "retakes" || s.does === "captions";
  const changed = name.trim() !== s.name || text.trim() !== s.text;
  return (
    <div className="skill-details">
      {s.does === "captions" && (
        <div className="seg wide">
          {(["bold", "clean"] as const).map((k) => (
            <button key={k} className={(s.look ?? "bold") === k ? "on" : ""} onClick={() => onSave({ look: k })}>
              {k === "bold" ? "Bold" : "Clean"}
            </button>
          ))}
        </div>
      )}
      {s.does === "graphics" && (
        <div className="seg wide">
          {(["light", "more"] as const).map((k) => (
            <button key={k} className={(graphics === "off" ? "light" : graphics) === k ? "on" : ""} onClick={() => onGraphics(k)}>
              {k === "light" ? "A few" : "More"}
            </button>
          ))}
        </div>
      )}
      {fixed ? (
        <p className="hint">{s.text}</p>
      ) : (
        <>
          {!s.builtIn && <input className="field" value={name} onChange={(e) => setName(e.target.value)} />}
          <label className="setting">
            <span>{LABEL[s.does ?? ""] ?? "What Claude does"}</span>
          </label>
          <textarea className="field" rows={s.does ? 3 : 6} value={text} onChange={(e) => setText(e.target.value)} />
        </>
      )}
      <div className="actions">
        {s.builtIn && s.edited && (
          <button className="btn ghost" onClick={onRemove} title="Undo your changes to this skill">
            <RotateCcw size={13} /> Put back as it came
          </button>
        )}
        {!s.builtIn && (
          <button className="btn ghost" onClick={onRemove}>
            <Trash2 size={13} /> Delete skill
          </button>
        )}
        {!fixed && (
          <button className="btn" disabled={!changed || !text.trim()} onClick={() => onSave({ ...(name.trim() !== s.name ? { name: name.trim() } : {}), text: text.trim() })}>
            Save changes
          </button>
        )}
      </div>
    </div>
  );
}
