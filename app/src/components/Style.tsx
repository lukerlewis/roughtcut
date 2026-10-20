import { Check, Plus, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import { loadStyle, saveStyle, suggestRules, type Style as StyleData, type StyleSettings, type Suggestion } from "../lib/backend";

const DEFAULTS: Required<StyleSettings> = { maxPause: 0.35, padIn: 0.08, padOut: 0.15 };

const SETTINGS: { key: keyof StyleSettings; label: string; min: number; max: number }[] = [
  { key: "maxPause", label: "Longest pause between lines", min: 0.1, max: 1.5 },
  { key: "padIn", label: "Room before a cut", min: 0, max: 0.3 },
  { key: "padOut", label: "Room after a cut", min: 0, max: 0.5 },
];

/** Luke's rules and settings, the same for every video. Claude follows the
 *  rules in the rough cut and the sidebar, and can suggest new ones. */
export function Style({ folder }: { folder: string }) {
  const [style, setStyle] = useState<StyleData | null>(null);
  const [draft, setDraft] = useState("");
  const [slider, setSlider] = useState<{ key: keyof StyleSettings; value: number } | null>(null);
  const [learning, setLearning] = useState(false);
  const [ideas, setIdeas] = useState<Suggestion[] | null>(null);
  const [found, setFound] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadStyle().then(setStyle).catch((e) => setError(String(e)));
  }, []);
  if (!style) return <div className="panel-body effect style" />;

  const rules = style.rules ?? [];
  const settings = { ...DEFAULTS, ...style.settings };
  const save = (next: StyleData) => {
    setStyle(next);
    saveStyle(next).catch((e) => setError(String(e)));
  };
  const setRules = (next: typeof rules) => save({ ...style, rules: next });
  const add = (text: string, by: "you" | "agent" = "you") => {
    const t = text.trim();
    if (!t || rules.some((r) => r.text.toLowerCase() === t.toLowerCase())) return;
    setRules([...rules, { text: t, on: true, by }]);
  };
  const learn = async () => {
    setLearning(true);
    setError(null);
    try {
      const got = await suggestRules(folder);
      const fresh = got.filter((s) => !rules.some((r) => r.text.toLowerCase() === s.text.toLowerCase()));
      setIdeas(fresh);
      setFound(fresh.length);
    } catch (e) {
      setError(String(e));
    } finally {
      setLearning(false);
    }
  };

  return (
    <div className="panel-body effect style">
      <p className="hint">Rules Claude follows in every video, in the rough cut and when you ask it things.</p>
      <ul className="rules">
        {rules.map((r, i) => (
          <li key={i} className={r.on ? "" : "off"}>
            <button
              className={`tick ${r.on ? "on" : ""}`}
              title={r.on ? "Switch this rule off" : "Switch this rule on"}
              onClick={() => setRules(rules.map((x, j) => (j === i ? { ...x, on: !x.on } : x)))}
            >
              {r.on && <Check size={11} />}
            </button>
            <RuleText value={r.text} onSave={(text) => setRules(text.trim() ? rules.map((x, j) => (j === i ? { ...x, text: text.trim() } : x)) : rules.filter((_, j) => j !== i))} />
            <button className="btn ghost icon" title="Delete rule" onClick={() => setRules(rules.filter((_, j) => j !== i))}>
              <X size={13} />
            </button>
          </li>
        ))}
      </ul>
      <form
        className="add-rule"
        onSubmit={(e) => {
          e.preventDefault();
          add(draft);
          setDraft("");
        }}
      >
        <input className="field" value={draft} placeholder="Add a rule, like “Never cut my jokes”" onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        <button className="btn" type="submit" disabled={!draft.trim()}>
          <Plus size={14} />
        </button>
      </form>

      <div className="learn">
        <button className="btn" onClick={learn} disabled={learning}>
          <Sparkles size={14} /> {learning ? "Looking at your changes…" : "Learn from this video"}
        </button>
        <p className="hint">Claude looks at what you changed about its edit here and suggests rules. This uses your Claude plan.</p>
        {ideas && found === 0 && <p className="hint">Nothing that looks like a pattern yet. Try again after more edits.</p>}
        {ideas?.map((s, i) => (
          <div key={i} className="idea">
            <div>
              <div>{s.text}</div>
              <div className="why">{s.why}</div>
            </div>
            <button className="btn" onClick={() => { add(s.text, "agent"); setIdeas(ideas.filter((_, j) => j !== i)); }}>
              Add
            </button>
            <button className="btn ghost icon" title="Not this one" onClick={() => setIdeas(ideas.filter((_, j) => j !== i))}>
              <X size={13} />
            </button>
          </div>
        ))}
      </div>

      <div className="settings">
        <div className="section-title">Rough cut</div>
        {SETTINGS.map(({ key, label, min, max }) => {
          const value = slider?.key === key ? slider.value : settings[key];
          const commit = () => {
            if (slider?.key === key) save({ ...style, settings: { ...style.settings, [key]: slider.value } });
            setSlider(null);
          };
          return (
            <div key={key}>
              <label className="setting">
                <span>{label}</span>
                <span className="mono">{value.toFixed(2)}s</span>
              </label>
              <input
                type="range"
                min={min * 100}
                max={max * 100}
                value={Math.round(value * 100)}
                onChange={(e) => setSlider({ key, value: Number(e.target.value) / 100 })}
                onPointerUp={commit}
                onKeyUp={commit}
                onBlur={commit}
              />
            </div>
          );
        })}
        <p className="hint">Used the next time you press Rough cut.</p>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function RuleText({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      className="rule-text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onSave(draft)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}
