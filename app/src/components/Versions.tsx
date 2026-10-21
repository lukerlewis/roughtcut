import { Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import { deleteVersion, listVersions, openVersion, saveVersion, type Version } from "../lib/backend";
import { timecode, type Edits } from "../lib/edl";

// Two edits are the same version if everything but the log matches.
const same = (a: Edits, b: Edits) => JSON.stringify({ ...a, log: [] }) === JSON.stringify({ ...b, log: [] });
const when = (at: string) => {
  const d = new Date(at);
  return isNaN(+d) ? "" : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};

/** Named snapshots of the edit, to switch between or branch from. Claude
 *  saves its alternatives (like hook variants) here too. */
export function Versions(p: {
  folder: string;
  edits: Edits;
  length: number;
  reload: number; // bumps when Claude may have saved one
  onOpen: (edits: Edits) => void;
  onHooks: () => void;
  busy: boolean;
}) {
  const [list, setList] = useState<Version[]>([]);
  const [saved, setSaved] = useState<Record<string, Edits>>({});
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const got = await listVersions(p.folder);
      setList(got);
      const all = await Promise.all(got.map((v) => openVersion(p.folder, v.id).then((e) => [v.id, e] as const)));
      setSaved(Object.fromEntries(all));
    } catch (e) {
      setError(String(e));
    }
  };
  useEffect(() => {
    void refresh();
  }, [p.folder, p.reload]);

  const current = list.find((v) => saved[v.id] && same(saved[v.id], p.edits));
  const save = async (name: string) => {
    if (!name.trim()) return;
    await saveVersion(p.folder, name, p.edits, p.length).catch((e) => setError(String(e)));
    await refresh();
  };
  const open = async (v: Version) => {
    try {
      // Keep what's on screen if it isn't saved anywhere yet.
      if (!current) await saveVersion(p.folder, "Before switching", p.edits, p.length);
      p.onOpen(saved[v.id] ?? (await openVersion(p.folder, v.id)));
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="panel-body effect versions">
      <p className="hint">Save the edit as it is now, then try something else. Open a version to switch to it or carry on from it.</p>
      <form
        className="add-rule"
        onSubmit={(e) => {
          e.preventDefault();
          void save(draft);
          setDraft("");
        }}
      >
        <input className="field" value={draft} placeholder="Name this version, like “Tighter”" onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        <button className="btn" type="submit" disabled={!draft.trim()}>
          Save
        </button>
      </form>
      {list.length > 0 && (
        <ul className="version-list">
          {[...list].reverse().map((v) => (
            <li key={v.id} className={current?.id === v.id ? "current" : ""}>
              <div className="what">
                <div className="name">{v.name}</div>
                <div className="meta">
                  <span className="mono">{timecode(v.length)}</span> · {v.by === "agent" ? "Claude" : "You"} · {when(v.at)}
                </div>
                {v.note && <div className="meta">{v.note}</div>}
              </div>
              {current?.id === v.id ? (
                <span className="tag">Showing</span>
              ) : (
                <button className="btn" onClick={() => void open(v)}>
                  Open
                </button>
              )}
              <button
                className="btn ghost icon"
                title="Delete this version"
                onClick={() => void deleteVersion(p.folder, v.id).then(refresh, (e) => setError(String(e)))}
              >
                <X size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="learn">
        <button className="btn" onClick={p.onHooks} disabled={p.busy}>
          <Sparkles size={14} /> Try other openings
        </button>
        <p className="hint">Claude cuts three different hooks for the first seconds and saves each as a version here. This uses your Claude plan.</p>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
