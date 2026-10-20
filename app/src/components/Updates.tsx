import { ArrowDownToLine, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import * as backend from "../lib/backend";

const KEY_URL = "https://github.com/settings/personal-access-tokens/new";

/** The toolbar's update button: asks for a GitHub key once, then offers each
 *  new build as it's published and installs it in place. */
export function Updates() {
  const [state, setState] = useState<backend.UpdateState | null>(null);
  const [error, setError] = useState("");
  const [sheet, setSheet] = useState<"key" | "installing" | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);

  const check = () =>
    backend
      .checkUpdate()
      .then((s) => (setState(s), setError("")))
      .catch((e) => setError(String(e)));

  useEffect(() => {
    check();
    const t = setInterval(check, 30 * 60 * 1000);
    return () => clearInterval(t);
  }, []);

  const save = async () => {
    setBusy(true);
    try {
      await backend.setUpdateKey(key);
      setKey("");
      setSheet(null);
      await check();
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
  };

  const install = async () => {
    setSheet("installing");
    setError("");
    try {
      await backend.installUpdate(); // the app restarts when this works
    } catch (e) {
      setError(String(e));
    }
  };

  const keyProblem = error.includes("key");
  let button = null;
  if (state && (!state.keySet || keyProblem))
    button = (
      <button className="btn ghost" onClick={() => setSheet("key")}>
        <RefreshCw size={16} /> {keyProblem ? "Fix updates" : "Turn on updates"}
      </button>
    );
  else if (state?.available)
    button = (
      <button className="btn" onClick={install} title={state.available.notes}>
        <ArrowDownToLine size={16} /> Update
      </button>
    );

  return (
    <>
      {button}
      {sheet && (
        <div className="sheet" onKeyDown={(e) => e.stopPropagation()}>
          <div className="card">
            {sheet === "key" ? (
              <>
                <h2>Turn on updates</h2>
                <p className="summary">
                  Roughcut gets new builds from your private GitHub repo with a read-only key. You make it once:
                </p>
                <ol className="steps">
                  <li>
                    Open{" "}
                    <a href={KEY_URL} onClick={(e) => (e.preventDefault(), backend.openUrl(KEY_URL))}>
                      GitHub's new key page
                    </a>
                    .
                  </li>
                  <li>Name it Roughcut updates and set Expiration to No expiration.</li>
                  <li>Under Repository access, pick Only select repositories, then roughtcut.</li>
                  <li>Under Permissions, set Contents to Read-only.</li>
                  <li>Click Generate token, copy it and paste it here.</li>
                </ol>
                <input
                  className="field mono"
                  placeholder="github_pat_…"
                  value={key}
                  autoFocus
                  onChange={(e) => setKey(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && key.trim() && save()}
                />
                {error && <p className="error">{error}</p>}
                <div className="actions">
                  <button className="btn ghost" onClick={() => (setSheet(null), setError(""))}>
                    Cancel
                  </button>
                  <button className="btn primary" disabled={!key.trim() || busy} onClick={save}>
                    {busy ? "Checking…" : "Save"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2>{error ? "Update failed" : `Updating to build ${state?.available?.build ?? ""}…`}</h2>
                <p className="summary">{error || "Roughcut will restart on its own when it's done. Your edits are saved."}</p>
                {!error && (
                  <div className="bar indeterminate">
                    <div />
                  </div>
                )}
                {error && (
                  <div className="actions">
                    <button className="btn primary" onClick={() => (setSheet(null), setError(""))}>
                      Done
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
