import { Circle, RefreshCw, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { recordingSources, startRecording, stopRecording, type Sources } from "../lib/backend";

const NONE = "";

/** Choosing what to record, then the recording itself. The recording runs on
 *  its own, with a Stop item in the menu bar, so Roughcut can be closed. */
export function Record({ saving, onClose }: { saving: boolean; onClose: () => void }) {
  const [sources, setSources] = useState<Sources | null>(null);
  const [screen, setScreen] = useState(NONE);
  const [camera, setCamera] = useState(NONE);
  const [mic, setMic] = useState(NONE);
  const [started, setStarted] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    recordingSources()
      .then((s) => {
        setSources(s);
        setScreen(s.screens[0]?.id ?? NONE);
        setCamera(s.cameras[0]?.id ?? NONE);
        setMic(s.mics[0]?.id ?? NONE);
      })
      .catch((e) => setError(String(e)));
  }, []);
  // Windows come and go: look again, keeping the choice if it's still open.
  const refresh = () =>
    recordingSources()
      .then((s) => {
        setSources(s);
        if (screen && ![...s.screens, ...(s.windows ?? [])].some((x) => x.id === screen)) setScreen(s.screens[0]?.id ?? NONE);
      })
      .catch((e) => setError(String(e)));
  useEffect(() => {
    if (started === null) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [started]);

  const start = async () => {
    setError(null);
    try {
      await startRecording(screen || null, camera || null, mic || null);
      setStarted(Date.now());
    } catch (e) {
      setError(String(e));
    }
  };
  const stop = () => stopRecording().catch((e) => setError(String(e)));
  const secs = started === null ? 0 : Math.floor((now - started) / 1000);

  if (saving)
    return (
      <div className="sheet">
        <div className="card">
          <h2>Putting your recording together…</h2>
          <div className="bar indeterminate">
            <div />
          </div>
        </div>
      </div>
    );

  if (started !== null)
    return (
      <div className="sheet">
        <div className="card record">
          <h2>
            <span className="rec" /> Recording {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}
          </h2>
          <p className="summary">You can hide Roughcut while you record. Stop it here or from the menu bar at the top of the screen.</p>
          {error && <p className="error">{error}</p>}
          <div className="actions">
            <button className="btn primary" onClick={stop}>
              <Square size={14} /> Stop
            </button>
          </div>
        </div>
      </div>
    );

  const pick = (label: string, value: string, set: (v: string) => void, list: { id: string; name: string }[], none?: string) => (
    <label className="pick">
      <span>{label}</span>
      <select className="field" value={value} onChange={(e) => set(e.target.value)}>
        {none && <option value={NONE}>{none}</option>}
        {list.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="sheet">
      <div className="card record">
        <h2>Record</h2>
        {!sources && !error && <p className="summary">Looking for your screen, camera and microphone…</p>}
        {sources && (
          <>
            <label className="pick">
              <span>Screen</span>
              <span className="pick-row">
                <select className="field" value={screen} onChange={(e) => setScreen(e.target.value)}>
                  <option value={NONE}>Don't record the screen</option>
                  <optgroup label="Whole screen">
                    {sources.screens.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </optgroup>
                  {!!sources.windows?.length && (
                    <optgroup label="One window">
                      {sources.windows.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
                <button className="btn ghost icon" title="Look for windows again" onClick={() => void refresh()}>
                  <RefreshCw size={14} />
                </button>
              </span>
            </label>
            {screen.startsWith("w") && <p className="hint">Only this window is recorded, even when others are in front of it. Clicks are followed as it moves.</p>}
            {!sources.screenAllowed && (
              <p className="hint">
                To record your screen, allow Roughcut in System Settings, Privacy &amp; Security, Screen &amp; System Audio Recording, then open Roughcut again.
              </p>
            )}
            {pick("Camera", camera, setCamera, sources.cameras, "No camera")}
            {pick("Microphone", mic, setMic, sources.mics)}
            <p className="hint">Your recording is saved in Movies, Roughcut. The screen, camera and where you click are kept separately for layouts and zooms.</p>
          </>
        )}
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!sources || !mic || (!screen && !camera)} onClick={start}>
            <Circle size={14} /> Start recording
          </button>
        </div>
      </div>
    </div>
  );
}
