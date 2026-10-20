import { Captions as CaptionsIcon, Download, FolderOpen, Pause, Play, MessageSquarePlus, Scissors, SkipBack, Type } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Changes } from "./components/Changes";
import { Chat } from "./components/Chat";
import { Style } from "./components/Style";
import { Effect, type Look } from "./components/Effect";
import { Timeline, type Effect as Picked } from "./components/Timeline";
import { Transcript, type Selection } from "./components/Transcript";
import { Updates } from "./components/Updates";
import * as backend from "./lib/backend";
import { alignWords } from "./lib/align";
import { captionStrips } from "./lib/captions";
import { effectStart, effectTracks, moveEffect, removeEffect, setEffectStatus } from "./lib/effects";
import { drawAt, graphicsLayer, type Placed } from "./lib/graphics";
import {
  acceptAll,
  addText,
  addNote,
  setNote,
  openNotes,
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
  editRanges,
  fromDecisions,
  liveClips,
  liveZooms,
  PARAMS,
  pendingCount,
  removeZooms,
  restoreWords,
  segments,
  setAgentStatus,
  setCaptions,
  setText,
  sourceToCut,
  cutToSource,
  setZoomLook,
  setZoomStatus,
  shownKinds,
  timecode,
  trimClip,
  wordAt,
  zoomAt,
  zoomBox,
  zoomPointFor,
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
  const [tab, setTab] = useState<"changes" | "chat" | "effect" | "style">("changes");
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

  const ask = async (text: string, current = edits, shown = text) => {
    if (!project || !current || asking) return;
    player.current?.pause();
    setAsking(true);
    const before = { ...chat, messages: [...chat.messages, { role: "you" as const, text: shown }] };
    setChat(before);
    try {
      await backend.saveEdits(project.folder, current); // so Claude starts from what's on screen
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
  const pickedText = effect?.kind === "text" ? edits?.texts?.[effect.index] : undefined;
  const pickedNote = effect?.kind === "note" ? edits?.notes?.[effect.index] : undefined;
  const pickedAny = picked || pickedClip || pickedText || pickedNote;
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
    const at = effectStart(edits, words, next);
    // Only jump if the playhead isn't already inside it.
    const item = effectTracks(edits, words).flatMap((t) => t.items).find((i) => i.effect.kind === next.kind && i.effect.index === next.index);
    if (at !== null && !(item && state.source >= item.start && state.source <= item.end)) player.current?.seekSource(at);
  };

  // Text: drawn over the video, and dragged there to move it while its settings are open.
  const [textDraft, setTextDraft] = useState<{ index: number; x: number; y: number } | null>(null);
  const placed: Placed[] = useMemo(
    () =>
      (edits?.texts ?? []).flatMap((t, i) => {
        if (t.status === "restored") return [];
        const shown = textDraft && textDraft.index === i ? { ...t, x: textDraft.x, y: textDraft.y } : t;
        const [a, b] = [sourceToCut(ranges, t.start), sourceToCut(ranges, t.end)];
        const full = effect?.kind === "text" && effect.index === i;
        return b - a > 0.05 ? [{ t: shown, start: a, end: b, full }] : [];
      }),
    [edits, ranges, textDraft, effect],
  );
  const gfx = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = gfx.current;
    if (!c) return;
    const w = c.clientWidth * (window.devicePixelRatio || 1);
    const h = c.clientHeight * (window.devicePixelRatio || 1);
    if (c.width !== Math.round(w) || c.height !== Math.round(h)) [c.width, c.height] = [Math.round(w), Math.round(h)];
    const g = c.getContext("2d")!;
    g.clearRect(0, 0, c.width, c.height);
    drawAt(g, placed, state.time, c.width, c.height);
  });
  const dragText = (e: React.PointerEvent) => {
    if (!pickedText || !effect || !frameRef.current) return;
    e.preventDefault();
    const rect = frameRef.current.getBoundingClientRect();
    const [x0, y0, sx, sy, index] = [e.clientX, e.clientY, pickedText.x, pickedText.y, effect.index];
    let last: { index: number; x: number; y: number } | null = null;
    const move = (m: PointerEvent) => {
      last = {
        index,
        x: Math.min(1, Math.max(0, sx + (m.clientX - x0) / rect.width)),
        y: Math.min(1, Math.max(0, sy + (m.clientY - y0) / rect.height)),
      };
      setTextDraft(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (last) change((x) => setText(x, index, { x: last!.x, y: last!.y }));
      setTextDraft(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** Adds text over the selected words, or for three seconds from the playhead, and opens its settings. */
  const newText = () => {
    if (!edits || !project) return;
    player.current?.pause();
    // Work in the cut, so a title never lands on words that don't play.
    let a = selection ? sourceToCut(ranges, words[selection.first].start) : state.time;
    let b = selection ? sourceToCut(ranges, words[selection.last].end) : a + 3;
    if (b - a < 0.5) [a, b] = [state.time, state.time + 3];
    const length = sourceToCut(ranges, project.info.duration);
    if (b > length) [a, b] = [Math.max(0, length - 3), length];
    const [start, end] = [cutToSource(ranges, a).source, cutToSource(ranges, b).source];
    const index = edits.texts?.length ?? 0;
    change((x) => addText(x, "title", "Your title", start, end));
    setSelection(null);
    setTimeout(() => pickEffect({ kind: "text", index }), 0);
  };
  // Notes: N drops one at the playhead; Return in it carries on playing if it was.
  const resumeAfterNote = useRef(false);
  const newNote = () => {
    if (!edits) return;
    resumeAfterNote.current = state.playing;
    player.current?.pause();
    const index = edits.notes?.length ?? 0;
    change((x) => addNote(x, state.source));
    setSelection(null);
    setTimeout(() => pickEffect({ kind: "note", index }), 0);
  };
  const noteSaved = () => {
    pickEffect(null);
    if (resumeAfterNote.current) player.current?.play();
    resumeAfterNote.current = false;
  };
  const sendNotes = (draft?: string) => {
    if (!edits) return;
    // The note being typed may not be saved yet.
    const current = draft !== undefined && effect?.kind === "note" ? setNote(edits, effect.index, { text: draft }) : edits;
    if (current !== edits) change(() => current);
    const list = openNotes(current).map(({ note, index }) => {
      const near = words.findIndex((w) => w.end >= note.at);
      const said = near >= 0 ? ` (near word ${near}, "${words.slice(near, near + 6).map((w) => w.text).join(" ")}")` : "";
      return `- Note ${index} at ${timecode(note.at)} in the recording${said}: ${note.text.trim()}`;
    });
    if (!list.length) return;
    setTab("chat");
    setEffect(null);
    void ask(`My notes on the edit. Work through each one, then mark it done with resolve_note and a short reply.\n${list.join("\n")}`, current, list.length === 1 ? `My note: ${openNotes(current)[0].note.text.trim()}` : `My ${list.length} notes:\n${openNotes(current).map(({ note }) => `${timecode(note.at)} ${note.text.trim()}`).join("\n")}`);
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
        change((x) => removeEffect(x, picked));
        pickEffect(null);
      } else if ((e.key === "Backspace" || e.key === "Delete") && selection) {
        e.preventDefault();
        change((x) => cutWords(clearWordTrims(x, selection.first, selection.last), selection.first, selection.last));
        setSelection(null);
      } else if (!mod && e.key.toLowerCase() === "n") {
        e.preventDefault();
        newNote();
      } else if (!mod && e.key.toLowerCase() === "t") {
        e.preventDefault();
        newText();
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
      const layers = [
        captions.on && cues.length ? captionStrips(cues, captions.style, project.info.width, project.info.height) : null,
        await graphicsLayer(placed.map((p) => ({ ...p, full: false })), project.info.width, project.info.height, project.info.fps),
      ].filter((l) => l !== null);
      await backend.exportCut(project.source, segments(ranges, words, zooms, clips, project.folder), layers, dest);
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
  const tracks = effectTracks(edits, words);
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
        <button className="btn ghost" onClick={newText} title="Add a title over the selected words or at the playhead (T)">
          <Type size={16} /> Text
        </button>
        <button className="btn ghost" onClick={newNote} title="Leave a note at the playhead, for you or for Claude (N)">
          <MessageSquarePlus size={16} /> Note
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
              <canvas
                ref={gfx}
                className={`graphics ${pickedText ? "editing" : ""}`}
                onPointerDown={dragText}
                title={pickedText ? "Drag to move the text" : undefined}
              />
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
            <button className={tab === "style" ? "on" : ""} onClick={() => setTab("style")}>
              Style
            </button>
            {pickedAny && (
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
          {tab === "style" ? (
            <Style folder={project.folder} />
          ) : tab === "effect" && pickedAny ? (
            <Effect
              key={effect ? `${effect.kind}:${effect.index}` : ""}
              words={words}
              zoom={picked}
              clip={pickedClip}
              text={pickedText}
              onText={(patch) => effect && change((x) => setText(x, effect.index, patch))}
              note={pickedNote}
              onNote={(patch) => effect && change((x) => setNote(x, effect.index, patch))}
              onNoteSaved={noteSaved}
              openNotes={openNotes(edits).length + (pickedNote && !pickedNote.text.trim() ? 1 : 0)}
              onSendNotes={sendNotes}
              look={look}
              onLook={setLook}
              onCommit={(l) => {
                if (effect) change((x) => setZoomLook(x, effect.index, l));
                setLook(null);
              }}
              onKeep={() => effect && change((x) => setEffectStatus(x, effect, "accepted"))}
              onRemove={() => {
                if (effect) change((x) => removeEffect(x, effect));
                pickEffect(null);
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
              texts={edits.texts ?? []}
              onEffectFocus={(kind, index) => pickEffect({ kind, index })}
              onEffectStatus={(kind, index, status) => change((x) => setEffectStatus(x, { kind, index }, status))}
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
        tracks={tracks}
        onFxEdit={(fx, start, end, mode) => change((x) => moveEffect(x, words, fx, start, end, mode))}
        pins={(edits.notes ?? []).map((n, index) => ({ index, at: n.at, done: !!n.done, forClaude: n.by === "you" }))}
        onPin={(index) => pickEffect({ kind: "note", index })}
        effect={effect}
        onSelectEffect={pickEffect}
        onTrim={(i, start, end) => change((x) => trimClip(x, ranges, i, start, end))}
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
