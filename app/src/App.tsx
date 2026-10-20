import { Captions as CaptionsIcon, Download, FolderOpen, Pause, Play, Scissors, SkipBack } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Changes } from "./components/Changes";
import { Chat } from "./components/Chat";
import { Effect, type Look } from "./components/Effect";
import { Timeline, type Effect as Picked } from "./components/Timeline";
import { Transcript, type Selection } from "./components/Transcript";
import { Updates } from "./components/Updates";
import * as backend from "./lib/backend";
import { alignWords } from "./lib/align";
import { captionStrips } from "./lib/captions";
import {
  acceptAll,
  addZoom,
  agentCutAt,
  applyRoughCut,
  clipAt,
  captionCues,
  clearTrims,
  cueAt,
  cutDuration,
  cutSpan,
  cutWords,
  deleteClip,
  editRanges,
  fromDecisions,
  liveClips,
  liveZooms,
  PARAMS,
  pendingCount,
  removeClip,
  removeZoom,
  removeZooms,
  restoreWords,
  segments,
  setAgentStatus,
  setCaptions,
  setClipStatus,
  setClipTimes,
  setZoomLook,
  setZoomStatus,
  setZoomTimes,
  shownKinds,
  timecode,
  trimClip,
  wordAt,
  zoomAt,
  zoomBox,
  zoomPointFor,
  zoomSpan,
  type CaptionStyle,
  type Edits,
  type Word,
} from "./lib/edl";
import { CutPlayer, type PlayerState } from "./lib/player";

type Phase = { kind: "empty" } | { kind: "working"; log: string[]; source: string } | { kind: "ready" } | { kind: "error"; message: string };

interface Project {
  source: string;
  folder: string;
  url: string;
  info: backend.Info;
  words: Word[];
  summary: string;
}

const name = (path: string) => path.split("/").pop() ?? path;
const stem = (path: string) => name(path).replace(/\.[^.]+$/, "");

export default function App() {
  const [phase, setPhase] = useState<Phase>({ kind: "empty" });
  const [project, setProject] = useState<Project | null>(null);
  const [edits, setEdits] = useState<Edits | null>(null);
  const history = useRef<{ undo: Edits[]; redo: Edits[] }>({ undo: [], redo: [] });
  const [peaks, setPeaks] = useState<Uint8Array | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [focus, setFocus] = useState(-1);
  const [state, setState] = useState<PlayerState>({ playing: false, time: 0, source: 0 });
  const [exporting, setExporting] = useState<{ progress: number; dest: string; done: boolean; error?: string } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [tab, setTab] = useState<"changes" | "chat" | "effect">("changes");
  const [effect, setEffect] = useState<Picked | null>(null); // the zoom or clip whose settings show
  const [look, setLook] = useState<Look | null>(null); // a zoom change being dragged, not yet saved
  const [chat, setChat] = useState<backend.Chat>({ session: null, messages: [] });
  const [asking, setAsking] = useState(false);
  const [cutting, setCutting] = useState<{ log: string[]; error?: string } | null>(null);
  const videoA = useRef<HTMLVideoElement>(null);
  const videoB = useRef<HTMLVideoElement>(null);
  const player = useRef<CutPlayer | null>(null);

  // --- Opening a recording -------------------------------------------------

  const open = useCallback(async (path: string) => {
    try {
      player.current?.pause();
      setSelection(null);
      setFocus(-1);
      let opened = await backend.openRecording(path);
      if (!opened.has_cut) {
        // Just the words for now; Luke asks for a rough cut when he wants one.
        setPhase({ kind: "working", log: ["Writing down what you say, on this Mac."], source: path });
        await backend.runRoughCut(path, false);
        opened = await backend.openRecording(path);
      }
      const [loaded, info, url] = await Promise.all([backend.loadCut(opened.folder), backend.probe(path), backend.videoUrl(path)]);
      history.current = { undo: [], redo: [] };
      setEdits(loaded.edits ?? fromDecisions(loaded.decisions));
      setChat((await backend.loadChat(opened.folder).catch(() => null)) ?? { session: null, messages: [] });
      setProject({ source: path, folder: opened.folder, url, info, words: loaded.words, summary: loaded.decisions.summary ?? "" });
      setPhase({ kind: "ready" });
      backend.waveform(path, opened.folder).then(setPeaks, () => setPeaks(null));
    } catch (e) {
      setPhase({ kind: "error", message: String(e) });
    }
  }, []);

  useEffect(() => {
    const offs: Promise<() => void>[] = [
      backend.listen<string>("roughcut-log", (line) =>
        setPhase((p) => (p.kind === "working" ? { ...p, log: [...p.log, line].slice(-14) } : p)),
      ),
      backend.listen<string>("roughcut-log", (line) => setCutting((c) => (c ? { ...c, log: [...c.log, line].slice(-8) } : c))),
      backend.listen<number>("export-progress", (progress) => setExporting((x) => (x ? { ...x, progress } : x))),
      backend.onDrop((paths) => paths[0] && open(paths[0])),
      backend.listen<string>("open-file", (path) => open(path)),
    ];
    backend.launchFile().then((path) => {
      if (path) open(path);
    });
    return () => offs.forEach((o) => o.then((f) => f()));
  }, [open]);

  const choose = async () => {
    const path = await backend.chooseRecording();
    if (path) open(path);
  };

  // --- The edit ------------------------------------------------------------

  // Word times lined up with the sound once the waveform is in.
  const words = useMemo(() => alignWords(project?.words ?? [], peaks), [project, peaks]);
  const ranges = useMemo(
    () => (edits && project ? editRanges(words, edits, project.info.duration) : []),
    [edits, project, words],
  );
  const kinds = useMemo(() => (edits ? shownKinds(words, edits, ranges) : []), [edits, words, ranges]);

  const change = useCallback((next: Edits | ((e: Edits) => Edits)) => {
    setEdits((prev) => {
      if (!prev) return prev;
      const value = typeof next === "function" ? next(prev) : next;
      if (value !== prev) {
        history.current.undo.push(prev);
        history.current.redo = [];
      }
      return value;
    });
  }, []);

  const undo = () => {
    const prev = history.current.undo.pop();
    if (prev && edits) {
      history.current.redo.push(edits);
      setEdits(prev);
    }
  };
  const redo = () => {
    const next = history.current.redo.pop();
    if (next && edits) {
      history.current.undo.push(edits);
      setEdits(next);
    }
  };

  // Save a moment after each change.
  useEffect(() => {
    if (!edits || !project) return;
    const t = setTimeout(() => backend.saveEdits(project.folder, edits).catch(console.error), 300);
    return () => clearTimeout(t);
  }, [edits, project]);

  // Joins in the timeline that hide one of Claude's unreviewed cuts.
  const claudeJoins = useMemo(() => {
    if (!edits) return [];
    const pending = edits.agent.filter((c) => c.status === "pending");
    const joins: number[] = [];
    for (let i = 1; i < ranges.length; i++) {
      const [gapA, gapB] = [ranges[i - 1][1], ranges[i][0]];
      if (pending.some((c) => words[c.first].start < gapB && words[c.last].end > gapA)) joins.push(i);
    }
    return joins;
  }, [edits, ranges, words]);

  const zooms = useMemo(() => (edits ? liveZooms(edits) : []), [edits]);
  const clips = useMemo(() => (edits ? liveClips(edits) : []), [edits]);
  const captions = edits?.captions ?? { on: false, style: "bold" as CaptionStyle };
  const cues = useMemo(
    () => (edits && captions.on ? captionCues(words, new Set(kinds.flatMap((k, i) => (k ? [] : [i]))), ranges) : []),
    [edits, captions.on, words, ranges, kinds],
  );
  // For the transcript: which words sit in a zoom, and whether it's Claude's unreviewed one.
  const zoomKinds = useMemo(() => {
    const k: ("zoom" | "zoom-pending" | null)[] = new Array(words.length).fill(null);
    for (const z of zooms) for (let i = z.first; i <= z.last; i++) k[i] = z.status === "pending" ? "zoom-pending" : "zoom";
    return k;
  }, [zooms, words.length]);

  // --- Claude in the sidebar ----------------------------------------------

  const projectRef = useRef(project);
  projectRef.current = project;

  // Claude's stream: its words, what it did, and a reload of the edit after
  // each change it makes (as one undoable step).
  useEffect(() => {
    const off = backend.onClaudeEvent((e) => {
      const add = (...m: backend.ChatMessage[]) => setChat((c) => ({ ...c, messages: [...c.messages, ...m] }));
      if (e.session_id) setChat((c) => (c.session === e.session_id ? c : { ...c, session: e.session_id }));
      if (e.type === "assistant") {
        for (const block of e.message?.content ?? []) {
          if (block.type === "text" && block.text.trim()) add({ role: "claude", text: block.text.trim() });
          if (block.type === "tool_use")
            add({ role: "action", text: "", tool: String(block.name).replace("mcp__roughcut__", ""), input: block.input });
        }
      } else if (e.type === "user") {
        const changed = (e.message?.content ?? []).some((b: any) => b.type === "tool_result" && !b.is_error);
        const folder = projectRef.current?.folder;
        if (changed && folder)
          backend.loadCut(folder).then((l) => l.edits && change((prev) => (JSON.stringify(prev) === JSON.stringify(l.edits) ? prev : l.edits!)));
      } else if (e.type === "result" && e.is_error) add({ role: "error", text: String(e.result ?? "Claude stopped.") });
    });
    return () => {
      off.then((f) => f());
    };
  }, [change]);

  const ask = async (text: string) => {
    if (!project || !edits || asking) return;
    player.current?.pause();
    setAsking(true);
    const before = { ...chat, messages: [...chat.messages, { role: "you" as const, text }] };
    setChat(before);
    try {
      await backend.saveEdits(project.folder, edits); // so Claude starts from what's on screen
      await backend.askClaude(project.folder, project.source, project.info.duration, text, chat.session);
    } catch (e) {
      setChat((c) => ({ ...c, messages: [...c.messages, { role: "error", text: String(e) }] }));
    } finally {
      setAsking(false);
      setChat((c) => {
        backend.saveChat(project.folder, c).catch(console.error);
        return c;
      });
    }
  };

  // Claude's rough cut, when Luke asks for it. Its cuts arrive unreviewed, in blue.
  const roughCut = async () => {
    if (!project || cutting) return;
    player.current?.pause();
    setCutting({ log: ["Asking Claude for the rough cut. This uses your Claude plan."] });
    try {
      await backend.runRoughCut(project.source, true);
      const loaded = await backend.loadCut(project.folder);
      change((x) => applyRoughCut(x, loaded.decisions));
      setTab("changes");
      setCutting(null);
    } catch (e) {
      setCutting((c) => ({ log: c?.log ?? [], error: String(e) }));
    }
  };

  // --- Playback ------------------------------------------------------------

  useEffect(() => {
    if (phase.kind !== "ready" || !videoA.current || !videoB.current) return;
    const p = new CutPlayer(videoA.current, videoB.current);
    p.onState = setState;
    player.current = p;
    return () => p.destroy();
  }, [phase.kind, project?.url]);

  useEffect(() => {
    player.current?.setRanges(ranges);
  }, [ranges]);

  const current = wordAt(words, state.source + 0.02);
  const showingRemoved = current >= 0 && kinds[current] !== null && words[current].end > state.source;
  const picked = effect?.kind === "zoom" ? edits?.zooms?.[effect.index] : undefined;
  const pickedClip = effect?.kind === "clip" ? edits?.clips?.[effect.index] : undefined;
  // While a zoom's settings are open the video shows whole, with the zoom as a box to drag.
  const zoom = picked ? null : zoomAt(words, zooms, state.source);
  const box = picked ? zoomBox(look ?? picked) : null;
  const frameRef = useRef<HTMLDivElement>(null);
  const dragBox = (e: React.PointerEvent) => {
    if (!picked || !box || !frameRef.current || !effect) return;
    e.preventDefault();
    const rect = frameRef.current.getBoundingClientRect();
    const [x0, y0, start] = [e.clientX, e.clientY, box];
    const scale = (look ?? picked).scale;
    let last: Look | null = null;
    const move = (m: PointerEvent) => {
      const left = Math.min(1 - start.size, Math.max(0, start.left + (m.clientX - x0) / rect.width));
      const top = Math.min(1 - start.size, Math.max(0, start.top + (m.clientY - y0) / rect.height));
      last = { scale, ...zoomPointFor(scale, left, top) };
      setLook(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const index = effect.index;
      if (last) change((x) => setZoomLook(x, index, last!));
      setLook(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const pickEffect = (next: Picked | null) => {
    setEffect(next);
    setLook(null);
    if (!next) setTab((t) => (t === "effect" ? "changes" : t));
    if (!next || !edits) return;
    setTab("effect");
    player.current?.pause();
    const z = next.kind === "zoom" ? edits.zooms?.[next.index] : undefined;
    const c = next.kind === "clip" ? edits.clips?.[next.index] : undefined;
    if (z) player.current?.seekSource(zoomSpan(words, z)[0] + 0.05);
    if (c) player.current?.seekSource(c.start + 0.05);
  };
  const clip = clipAt(clips, state.source);
  const clipVideo = useRef<HTMLVideoElement>(null);
  const [clipUrls, setClipUrls] = useState<Record<string, string>>({});

  // Serve each clip's file to the player.
  useEffect(() => {
    if (!project) return;
    for (const c of clips)
      if (!clipUrls[c.file])
        backend.videoUrl(`${project.folder}/${c.file}`).then((u) => setClipUrls((m) => ({ ...m, [c.file]: u })));
  }, [clips, project, clipUrls]);

  // While a clip is on, it plays in sync with the recording (which goes quiet).
  useEffect(() => {
    player.current?.setQuiet(!!clip);
    const v = clipVideo.current;
    if (!v || !clip) return;
    const want = clip.offset + (state.source - clip.start);
    if (Math.abs(v.currentTime - want) > (state.playing ? 0.25 : 0.02)) v.currentTime = want;
    if (state.playing && v.paused) void v.play();
    if (!state.playing && !v.paused) v.pause();
  }, [clip, state.source, state.playing]);
  const cue = captions.on ? cueAt(cues, state.time) : null;

  const seekWord = (i: number) => {
    setSelection(null);
    const w = words[i];
    if (kinds[i] !== null) {
      // Show what was cut, and point at it in Claude's list.
      player.current?.pause();
      player.current?.seekSource(w.start);
      const c = edits ? agentCutAt(edits, i) : -1;
      if (c >= 0) setFocus(c);
    } else player.current?.seekSource(w.start);
  };

  // Cutting or restoring words in the transcript overrides timeline trims on them.
  const clearWordTrims = (e: Edits, first: number, last: number) =>
    clearTrims(e, words[first].start - PARAMS.padIn, words[last].end + PARAMS.padOut);

  const toggleZoom = (first: number, last: number) => {
    const overlaps = zooms.some((z) => z.first <= last && z.last >= first);
    change((x) => (overlaps ? removeZooms(x, first, last) : addZoom(x, first, last)));
    setSelection(null);
  };

  // --- Keyboard ------------------------------------------------------------

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (phase.kind !== "ready" || exporting) return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === " ") {
        e.preventDefault();
        player.current?.toggle();
      } else if ((e.key === "Backspace" || e.key === "Delete") && effect && !selection) {
        e.preventDefault();
        const picked = effect;
        change((x) => (picked.kind === "zoom" ? removeZoom(x, picked.index) : removeClip(x, picked.index)));
        pickEffect(null);
        setTab("changes");
      } else if ((e.key === "Backspace" || e.key === "Delete") && selection) {
        e.preventDefault();
        change((x) => cutWords(clearWordTrims(x, selection.first, selection.last), selection.first, selection.last));
        setSelection(null);
      } else if (!mod && e.key.toLowerCase() === "z" && selection) {
        e.preventDefault();
        toggleZoom(selection.first, selection.last);
      } else if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (e.key === "Escape") {
        setSelection(null);
        pickEffect(null);
      }
      else if (e.key === "ArrowLeft") player.current?.seek(state.time - (e.shiftKey ? 5 : 1 / (project?.info.fps ?? 30)));
      else if (e.key === "ArrowRight") player.current?.seek(state.time + (e.shiftKey ? 5 : 1 / (project?.info.fps ?? 30)));
      else if (mod && e.key.toLowerCase() === "o") {
        e.preventDefault();
        choose();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  // --- Export --------------------------------------------------------------

  const startExport = async () => {
    if (!project) return;
    player.current?.pause();
    const dir = project.source.slice(0, project.source.lastIndexOf("/") + 1);
    const dest = await backend.chooseExport(`${dir}${stem(project.source)} edit.mp4`);
    if (!dest) return;
    setExporting({ progress: 0, dest, done: false });
    try {
      await backend.exportCut(project.source, segments(ranges, words, zooms, clips, project.folder), captions.on && cues.length ? captionStrips(cues, captions.style, project.info.width, project.info.height) : null, dest);
      setExporting({ progress: 1, dest, done: true });
    } catch (e) {
      setExporting({ progress: 0, dest, done: true, error: String(e) });
    }
  };

  // --- Views ---------------------------------------------------------------

  if (phase.kind !== "ready" || !project || !edits) {
    return (
      <div className="app" style={{ gridTemplateRows: "44px 1fr" }}>
        <div className="toolbar" data-tauri-drag-region>
          <span className="title">Roughcut</span>
          <span className="spacer" data-tauri-drag-region />
          <Updates />
        </div>
        <div
          className="empty"
          onDragOver={(e) => (e.preventDefault(), setDragOver(true))}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => (e.preventDefault(), setDragOver(false))}
        >
          {phase.kind === "working" ? (
            <div>
              <h1>Making the rough cut</h1>
              <p>{name(phase.source)}</p>
              <div className="log">{phase.log.join("\n")}</div>
            </div>
          ) : (
            <div className={`drop ${dragOver ? "over" : ""}`}>
              <h1>Drop a recording here</h1>
              <p>It opens just as you recorded it. Cut it yourself, ask Claude, or click Rough cut when you want Claude's suggestions.</p>
              <button className="btn primary" onClick={choose}>
                <FolderOpen size={16} /> Open recording…
              </button>
              {phase.kind === "error" && <p className="error" style={{ marginTop: 16 }}>{phase.message}</p>}
            </div>
          )}
        </div>
      </div>
    );
  }

  const pending = pendingCount(edits);
  const saved = project.info.duration - cutDuration(ranges);

  return (
    <div className="app">
      <div className="toolbar" data-tauri-drag-region>
        <span className="title">{name(project.source)}</span>
        <span className="sub mono">
          {timecode(project.info.duration)} → {timecode(cutDuration(ranges))}
        </span>
        <span className="sub">{saved > 0 ? `${Math.round((saved / project.info.duration) * 100)}% shorter` : ""}</span>
        <span className="spacer" data-tauri-drag-region />
        <Updates />
        <button className="btn ghost" onClick={roughCut} disabled={!!cutting} title="Claude suggests cuts (fillers, retakes, long pauses) for you to review">
          <Scissors size={16} /> Rough cut
        </button>
        <div className="seg" title="Captions">
          <button className={!captions.on ? "on" : ""} onClick={() => change((x) => setCaptions(x, { ...captions, on: false }))}>
            <CaptionsIcon size={15} /> Off
          </button>
          {(["bold", "clean"] as const).map((st) => (
            <button
              key={st}
              className={captions.on && captions.style === st ? "on" : ""}
              onClick={() => change((x) => setCaptions(x, { on: true, style: st }))}
            >
              {st === "bold" ? "Bold" : "Clean"}
            </button>
          ))}
        </div>
        <button className="btn ghost" onClick={choose}>
          <FolderOpen size={16} /> Open
        </button>
        <button className="btn primary" onClick={startExport} disabled={!ranges.length}>
          <Download size={16} /> Export
        </button>
      </div>

      <div className="main">
        <div className="panel">
          <div className="panel-head">
            Transcript <span className="meta">Select words, then ⌫ to cut or Z to zoom in.</span>
          </div>
          <Transcript
            words={words}
            kinds={kinds}
            zooms={zoomKinds}
            current={current}
            selection={selection}
            onSelect={(s) => {
              setSelection(s);
              const c = s ? agentCutAt(edits, s.first) : -1;
              if (c >= 0) setFocus(c);
            }}
            onSeekWord={seekWord}
            onCut={(s) => (change((x) => cutWords(clearWordTrims(x, s.first, s.last), s.first, s.last)), setSelection(null))}
            onRestore={(s) => (change((x) => restoreWords(clearWordTrims(x, s.first, s.last), s.first, s.last)), setSelection(null))}
            onZoom={(s) => toggleZoom(s.first, s.last)}
          />
        </div>

        <div className="viewer">
          <div className="screen">
            <div
              ref={frameRef}
              className="frame"
              style={{ width: `min(100cqw, calc(100cqh * ${project.info.width || 16} / ${project.info.height || 9}))`, aspectRatio: `${project.info.width || 16} / ${project.info.height || 9}` }}
            >
              <div
                className="zoomer"
                style={zoom ? { transform: `scale(${zoom.scale})`, transformOrigin: `${zoom.x * 100}% ${zoom.y * 100}%` } : undefined}
              >
                <video ref={videoA} src={project.url} />
                <video ref={videoB} src={project.url} />
                {clip && clipUrls[clip.file] && <video ref={clipVideo} className="clip" src={clipUrls[clip.file]} playsInline />}
              </div>
              {box && (
                <svg className="zoomdim" viewBox="0 0 1 1" preserveAspectRatio="none">
                  <path
                    fillRule="evenodd"
                    fill="#000"
                    fillOpacity={0.45}
                    d={`M0 0H1V1H0Z M${box.left} ${box.top}h${box.size}v${box.size}h${-box.size}Z`}
                  />
                </svg>
              )}
              {box && (
                <div
                  className="zoombox"
                  title="Drag to choose where it zooms"
                  onPointerDown={dragBox}
                  style={{ left: `${box.left * 100}%`, top: `${box.top * 100}%`, width: `${box.size * 100}%`, height: `${box.size * 100}%` }}
                />
              )}
              {cue && !showingRemoved && (
                <div className={`caption ${captions.style}`}>
                  <span>
                    {cue.words.map((w, i) => (
                      <span key={i} className={i === cue.active ? "said" : ""}>
                        {w}{" "}
                      </span>
                    ))}
                  </span>
                </div>
              )}
            </div>
            {showingRemoved && !state.playing && <span className="badge">Cut from the edit</span>}
          </div>
          <div className="transport">
            <span className="tc mono now">{timecode(state.time, project.info.fps, true)}</span>
            <button className="btn icon ghost" title="Back to start" onClick={() => player.current?.seek(0)}>
              <SkipBack size={16} />
            </button>
            <button className="btn icon" title="Play (space)" onClick={() => player.current?.toggle()}>
              {state.playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
            </button>
            <span className="tc mono">{timecode(cutDuration(ranges), project.info.fps, true)}</span>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head tabs">
            <button className={tab === "changes" ? "on" : ""} onClick={() => setTab("changes")}>
              Changes {pending > 0 && <span className="count">{pending}</span>}
            </button>
            <button className={tab === "chat" ? "on" : ""} onClick={() => setTab("chat")}>
              Ask Claude {asking && <span className="pulse" />}
            </button>
            {(picked || pickedClip) && (
              <button className={tab === "effect" ? "on" : ""} onClick={() => setTab("effect")}>
                Effect
              </button>
            )}
            <span className="spacer" />
            {tab === "changes" && pending > 0 && (
              <button className="btn" onClick={() => change(acceptAll)}>
                Keep all
              </button>
            )}
          </div>
          {tab === "effect" && (picked || pickedClip) ? (
            <Effect
              words={words}
              zoom={picked}
              clip={pickedClip}
              look={look}
              onLook={setLook}
              onCommit={(l) => {
                if (effect) change((x) => setZoomLook(x, effect.index, l));
                setLook(null);
              }}
              onKeep={() => effect && change((x) => (effect.kind === "zoom" ? setZoomStatus(x, effect.index, "accepted") : setClipStatus(x, effect.index, "accepted")))}
              onRemove={() => {
                if (effect) change((x) => (effect.kind === "zoom" ? removeZoom(x, effect.index) : removeClip(x, effect.index)));
                pickEffect(null);
                setTab("changes");
              }}
            />
          ) : tab === "changes" || tab === "effect" ? (
            <Changes
              words={words}
              cuts={edits.agent}
              summary={project.summary}
              focus={focus}
              onFocus={(i) => {
                setFocus(i);
                const c = edits.agent[i];
                player.current?.pause();
                player.current?.seekSource(Math.max(0, words[c.first].start - 0.5));
              }}
              onAccept={(i) => change((x) => setAgentStatus(x, i, "accepted"))}
              onRestore={(i) => change((x) => setAgentStatus(x, i, "restored"))}
              onUndo={(i) => change((x) => setAgentStatus(x, i, "pending"))}
              zooms={edits.zooms ?? []}
              onZoomFocus={(i) => {
                player.current?.pause();
                player.current?.seekSource(Math.max(0, words[edits.zooms![i].first].start - 0.5));
              }}
              onZoomAccept={(i) => change((x) => setZoomStatus(x, i, "accepted"))}
              onZoomRemove={(i) => change((x) => setZoomStatus(x, i, "restored"))}
              onZoomUndo={(i) => change((x) => setZoomStatus(x, i, "pending"))}
              clips={edits.clips ?? []}
              onClipFocus={(i) => {
                player.current?.pause();
                player.current?.seekSource(edits.clips![i].start);
              }}
              onClipStatus={(i, status) => change((x) => setClipStatus(x, i, status))}
            />
          ) : (
            <Chat
              messages={chat.messages}
              running={asking}
              words={words}
              onSend={ask}
              onStop={() => backend.stopClaude()}
              onSeekWord={(i) => {
                player.current?.pause();
                player.current?.seekSource(Math.max(0, words[i].start - 0.5));
              }}
            />
          )}
        </div>
      </div>

      <Timeline
        ranges={ranges}
        duration={project.info.duration}
        peaks={peaks}
        time={state.time}
        playing={state.playing}
        claudeJoins={claudeJoins}
        fps={project.info.fps}
        words={words}
        zooms={edits.zooms ?? []}
        onZoomEdit={(i, start, end) => change((x) => setZoomTimes(x, words, i, start, end))}
        clips={edits.clips ?? []}
        onClipEdit={(i, start, end, offset) => change((x) => setClipTimes(x, i, start, end, offset))}
        onClipRemove={(i) => change((x) => removeClip(x, i))}
        effect={effect}
        onSelectEffect={pickEffect}
        onTrim={(i, start, end) => change((x) => trimClip(x, ranges, i, start, end))}
        onDeleteClip={(i) => change((x) => deleteClip(x, ranges, i))}
        selection={selection}
        onSelectWords={(first, last) => setSelection({ first, last })}
        onCutPause={(start, end) => change((x) => cutSpan(x, start, end))}
        onScrub={(t) => player.current?.seek(t)}
      />

      {cutting && (
        <div className="sheet">
          <div className="card">
            <h2>{cutting.error ? "The rough cut stopped" : "Making the rough cut…"}</h2>
            {cutting.error ? <p className="error">{cutting.error}</p> : <div className="log">{cutting.log.join("\n")}</div>}
            {!cutting.error && (
              <div className="bar indeterminate">
                <div />
              </div>
            )}
            {cutting.error && (
              <div className="actions">
                <button className="btn primary" onClick={() => setCutting(null)}>
                  Done
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {exporting && (
        <div className="sheet">
          <div className="card">
            <h2>{exporting.done ? (exporting.error ? "Export failed" : "Exported") : "Exporting…"}</h2>
            <p className="summary" style={{ margin: 0 }}>{name(exporting.dest)}</p>
            {!exporting.done && (
              <div className="bar">
                <div style={{ width: `${Math.round(exporting.progress * 100)}%` }} />
              </div>
            )}
            {exporting.error && <p className="error">{exporting.error}</p>}
            {exporting.done && (
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
                {!exporting.error && (
                  <button className="btn" onClick={() => backend.reveal(exporting.dest)}>
                    Show in Finder
                  </button>
                )}
                <button className="btn primary" onClick={() => setExporting(null)}>
                  Done
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
