import { Circle, Film, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import * as backend from "../lib/backend";

/** "just now", "5 minutes ago", "yesterday", "12 Oct", from Unix seconds. */
export function ago(seconds: number, now = Date.now() / 1000): string {
  const s = Math.max(0, now - seconds);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} minute${s < 120 ? "" : "s"} ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hour${s < 7200 ? "" : "s"} ago`;
  if (s < 172800) return "yesterday";
  if (s < 604800) return `${Math.floor(s / 86400)} days ago`;
  return new Date(seconds * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

const recordedHere = (p: backend.ProjectInfo) => p.source.includes("/Movies/Roughcut/");

interface Props {
  projects: backend.ProjectInfo[];
  onOpen: (source: string) => void;
  onNew: () => void;
  onRecord: () => void;
  onDelete: (source: string) => Promise<void>;
  error?: string;
}

/** The start screen: every project, newest first, to open or delete, and a new one. */
export function Projects(p: Props) {
  return (
    <div className="projects-home">
      <div className="projects-head">
        <h1>Projects</h1>
        <span className="spacer" />
        <button className="btn" onClick={p.onRecord}>
          <Circle size={16} /> Record
        </button>
        <button className="btn primary" onClick={p.onNew}>
          <Plus size={16} /> New project
        </button>
      </div>
      {p.error && <p className="error">{p.error}</p>}
      {p.projects.length ? (
        <div className="project-grid">
          {p.projects.map((x) => (
            <ProjectCard key={x.source} p={x} onOpen={() => p.onOpen(x.source)} onDelete={() => p.onDelete(x.source)} />
          ))}
        </div>
      ) : (
        <div className="projects-none">
          <p>No projects yet. Start a new one, or drop a recording here.</p>
        </div>
      )}
    </div>
  );
}

function ProjectCard({ p, onOpen, onDelete }: { p: backend.ProjectInfo; onOpen: () => void; onDelete: () => Promise<void> }) {
  const [thumb, setThumb] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    backend.projectThumbnail(p.source).then((t) => live && setThumb(t));
    return () => {
      live = false;
    };
  }, [p.source]);
  return (
    <div className="project-card" onClick={() => !asking && onOpen()} title={p.source}>
      <div className="project-thumb">{thumb ? <img src={thumb} alt="" /> : <Film size={22} />}</div>
      <div className="project-info">
        <span className="project-name">{p.name}</span>
        <span className="project-when">{p.saved ? `Edited ${ago(p.saved)}` : `Opened ${ago(p.opened)}`}</span>
      </div>
      {!asking && (
        <button className="btn ghost icon project-delete" title="Delete project" onClick={(e) => (e.stopPropagation(), setAsking(true))}>
          <Trash2 size={14} />
        </button>
      )}
      {asking && (
        <div className="project-confirm" onClick={(e) => e.stopPropagation()}>
          <p>
            {recordedHere(p)
              ? "Move this recording and its edits to the Trash?"
              : "Move this project's edits to the Trash? The video itself stays where it is."}
          </p>
          {error && <p className="error">{error}</p>}
          <div className="actions">
            <button className="btn ghost" onClick={() => (setAsking(false), setError(null))}>
              Cancel
            </button>
            <button className="btn danger" onClick={() => onDelete().catch((e) => setError(String(e)))}>
              <Trash2 size={14} /> Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
