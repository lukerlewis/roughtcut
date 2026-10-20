import { Captions as CaptionsIcon, Download, FolderOpen, Pause, Play, Circle, MessageSquareX, Sparkles, Mic, Scissors, SkipBack } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Changes } from "./components/Changes";
import { Chat } from "./components/Chat";
import { Style } from "./components/Style";
import { Record } from "./components/Record";
import { Menu } from "./components/Menu";
import { Versions } from "./components/Versions";
import { Library, type Asset, type LibraryItem } from "./components/Library";
import { Effect, type Look } from "./components/Effect";
import { Timeline, type Effect as Picked } from "./components/Timeline";
import { Transcript, type Selection } from "./components/Transcript";
import { Updates } from "./components/Updates";
import * as backend from "./lib/backend";
import { alignWords } from "./lib/align";
import { captionStrips } from "./lib/captions";
import { effectStart, effectTracks, moveEffect, removeEffect, setEffectStatus } from "./lib/effects";
import { drawAt, graphicsLayer, loadImage, type Placed } from "./lib/graphics";
import {
  acceptAll,
  addText,
  MOTION_DEFAULTS,
  type Motion,
  addNote,
  addRendered,
  rerender,
  addClickZooms,
  addRetakeCuts,
  type Rendered,
  addSpeed,
  addBlur,
  setTimed,
  liveBlurs,
  setVoice,
  type Rect,
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
  zoomScaleAt,
  setZoomEase,
  zoomPointFor,
  type CaptionStyle,
  type Edits,
  type Word,
  type TextFx,
  type TextStyle,
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
  const [parts, setParts] = useState<backend.RecordingParts | null>(null); // screen, camera and clicks, for recordings made here
  const [selection, setSelection] = useState<Selection | null>(null);
  const [focus, setFocus] = useState(-1);
  const [state, setState] = useState<PlayerState>({ playing: false, time: 0, source: 0 });
  const [exporting, setExporting] = useState<{ progress: number; dest: string; done: boolean; error?: string } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [left, setLeft] = useState<"transcript" | "library">("transcript");
  const [tab, setTab] = useState<"changes" | "chat" | "effect" | "style" | "versions">("changes");
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
      backend.recordingParts(path).then(setParts, () => setParts(null));
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
      backend.listen("recording-saving", () => setRecording("saving")),
      backend.listen<{ path?: string; error?: string }>("recording-finished", (r) => {
        setRecording(null);
        if (r.path) open(r.path);
        else setPhase({ kind: "error", message: r.error ?? "The recording didn't save." });
      }),
    ];
    backend.launchFile().then((path) => {
      if (path) open(path);
    });
    return () => offs.forEach((o) => o.then((f) => f()));
  }, [open]);

  // Recording: choosing, recording, then "saving" while the parts are put together.
  const [recording, setRecording] = useState<"open" | "saving" | null>(null);

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

  const [claudeChanged, setClaudeChanged] = useState(0); // counts Claude's changes, so lists reload
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
        if (changed) setClaudeChanged((n) => n + 1);
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

  // Alternative openings, each saved as a version for Luke to compare.
  const hooks = () => {
    setTab("chat");
    void ask(
      "Cut three alternative openings (hooks) for this video. First save the current edit as a version named \"Before hooks\". " +
        "For each hook, open_version \"Before hooks\", then change only how the video opens (roughly its first 5 to 15 seconds): you can't move lines, " +
        "so choose where it starts and what's trimmed from the intro, for example starting on the most striking line, a question or the result. " +
        "Save each with save_version as \"Hook 1: <a few words>\" (then 2 and 3) with a one-line note. Finish by opening \"Before hooks\" again, " +
        "and tell me in a sentence each what the three hooks do.",
      edits,
      "Try three other openings for this video.",
    );
  };

  // Claude's rough cut, when Luke asks for it. Its cuts arrive unreviewed, in blue.
  const roughCut = async () => {
    if (!project || cutting) return;
    player.current?.pause();
    setCutting({ log: ["Asking Claude for the rough cut. This uses your Claude plan."] });
    try {
      await backend.runRoughCut(project.source, true);
      const loaded = await backend.loadCut(project.folder);
      change((x) => addRetakeCuts(applyRoughCut(x, loaded.decisions), words).edits);
      setTab("changes");
      setCutting(null);
    } catch (e) {
      setCutting((c) => ({ log: c?.log ?? [], error: String(e) }));
    }
  };

  // Takes Luke marked while filming by saying "cut that", as cuts to review.
  const cutRetakes = () => {
    if (!edits) return;
    const r = addRetakeCuts(edits, words);
    if (!r.added) return setNotice("No marked takes found. While filming, say \u201ccut that\u201d after a bad take.");
    change(() => r.edits);
    setTab("changes");
    setNotice(`Found ${r.added} marked take${r.added === 1 ? "" : "s"}. They're in blue for you to review.`);
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
  const voiceOn = !!(edits?.voice?.level || edits?.voice?.clean);
  const pickedSpeed = effect?.kind === "speed" ? edits?.speeds?.[effect.index] : undefined;
  const pickedBlur = effect?.kind === "blur" ? edits?.blurs?.[effect.index] : undefined;
  const pickedAny = picked || pickedClip || pickedText || pickedNote || pickedSpeed || pickedBlur;
  // While a zoom's or blur's settings are open the video shows whole, with a box to drag.
  const zoom = picked || pickedBlur ? null : zoomAt(words, zooms, state.source);
  // Blurs: shown live over the video; the picked one is a box to move and resize.
  const [blurDraft, setBlurDraft] = useState<Rect | null>(null);
  const blurBox = pickedBlur ? (blurDraft ?? pickedBlur) : null;
  const blursShowing = edits ? liveBlurs(edits).filter((b) => !(effect?.kind === "blur" && effect.index === edits.blurs!.indexOf(b)) && b.start <= state.source && state.source <= b.end) : [];
  // Drawn from the playing video each frame: scaled down and back up, which
  // reads as a strong blur and works in any webview.
  const blurCanvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = blurCanvas.current;
    if (!c) return;
    const boxes = blurBox ? [...blursShowing, blurBox] : blursShowing;
    const [w, h] = [c.clientWidth, c.clientHeight];
    if (c.width !== w || c.height !== h) [c.width, c.height] = [w, h];
    const g = c.getContext("2d")!;
    g.clearRect(0, 0, w, h);
    const video = [videoA.current, videoB.current].find((v) => v && v.style.visibility !== "hidden" && v.videoWidth);
    if (!video || !boxes.length) return;
    const tiny = document.createElement("canvas");
    const t = tiny.getContext("2d")!;
    for (const b of boxes) {
      const [sx, sy, sw, sh] = [b.x * video.videoWidth, b.y * video.videoHeight, b.w * video.videoWidth, b.h * video.videoHeight];
      [tiny.width, tiny.height] = [Math.max(2, Math.round((b.w * w) / 14)), Math.max(2, Math.round((b.h * h) / 14))];
      t.imageSmoothingEnabled = true;
      t.drawImage(video, sx, sy, sw, sh, 0, 0, tiny.width, tiny.height);
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = "high";
      g.drawImage(tiny, 0, 0, tiny.width, tiny.height, b.x * w, b.y * h, b.w * w, b.h * h);
    }
  });
  const dragBlur = (e: React.PointerEvent, mode: "move" | "size") => {
    if (!pickedBlur || !blurBox || !frameRef.current || !effect) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = frameRef.current.getBoundingClientRect();
    const [x0, y0, start, index] = [e.clientX, e.clientY, { x: blurBox.x, y: blurBox.y, w: blurBox.w, h: blurBox.h }, effect.index];
    let last: Rect | null = null;
    const move = (m: PointerEvent) => {
      const [dx, dy] = [(m.clientX - x0) / rect.width, (m.clientY - y0) / rect.height];
      last =
        mode === "move"
          ? { ...start, x: Math.min(1 - start.w, Math.max(0, start.x + dx)), y: Math.min(1 - start.h, Math.max(0, start.y + dy)) }
          : { ...start, w: Math.min(1 - start.x, Math.max(0.03, start.w + dx)), h: Math.min(1 - start.y, Math.max(0.03, start.h + dy)) };
      setBlurDraft(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (last) change((x) => setTimed(x, "blurs", index, last!));
      setBlurDraft(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
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

  // Where a dragged library item was dropped, in seconds into the cut, while it's being added.
  const placing = useRef<number | null>(null);

  /** Adds text (a style, or one of Luke's assets) where it was dropped, over
   *  the selected words, or for three seconds from the playhead, and opens its settings. */
  const newText = (style: TextStyle = "title", asset?: Asset) => {
    if (!edits || !project) return;
    player.current?.pause();
    // Work in the cut, so a title never lands on words that don't play.
    const from = placing.current ?? state.time;
    let a = placing.current === null && selection ? sourceToCut(ranges, words[selection.first].start) : from;
    let b = placing.current === null && selection ? sourceToCut(ranges, words[selection.last].end) : a + 3;
    if (b - a < 0.5) [a, b] = [from, from + 3];
    const length = sourceToCut(ranges, project.info.duration);
    if (b > length) [a, b] = [Math.max(0, length - 3), length];
    const [start, end] = [cutToSource(ranges, a).source, cutToSource(ranges, b).source];
    const index = edits.texts?.length ?? 0;
    const words0 = { title: "Your title", "lower-third": "Your name", callout: "Look here", image: "" }[style];
    change((x) => {
      const added = addText(x, asset?.style ?? style, asset?.text ?? words0, start, end, motionDefaults[asset?.style ?? style]);
      if (!asset) return added;
      const { id: _, name, ...look } = asset;
      return setText(added, index, { ...look, text: asset.text || name });
    });
    setSelection(null);
    // Show it on the video straight away (pickEffect below can't see it yet).
    if (state.source < start || state.source > end) player.current?.seekSource(start + 0.01);
    setTimeout(() => pickEffect({ kind: "text", index }), 0);
  };

  /** A zoom over the words where it was dropped (or the selection, or from the playhead). */
  const newZoom = () => {
    const span = spanForNew();
    if (!edits || !span) return;
    const first = words.findIndex((w) => w.end > span[0]);
    let last = first;
    while (last + 1 < words.length && words[last + 1].start < span[1]) last++;
    if (first < 0) return;
    change((x) => addZoom(x, first, last));
    setSelection(null);
    setTimeout(() => setEdits((cur) => {
      const index = cur?.zooms?.findIndex((z) => z.first === first && z.by === "you") ?? -1;
      if (index >= 0) pickEffect({ kind: "zoom", index });
      return cur;
    }), 0);
  };

  // Luke's saved assets (title cards and the like), the same in every video.
  const [assets, setAssets] = useState<Asset[]>([]);
  useEffect(() => {
    backend.loadAssets().then(setAssets, () => setAssets([]));
  }, []);

  // How each kind of graphic moves unless Luke changes it: his saved defaults over the built-in ones.
  const [motionDefaults, setMotionDefaults] = useState<Record<TextStyle, Motion>>(MOTION_DEFAULTS);
  useEffect(() => {
    backend.loadStyle().then((s) => setMotionDefaults({ ...MOTION_DEFAULTS, ...s.motion }), () => {});
  }, []);
  const makeMotionDefault = (style: TextStyle, motion: Motion) => {
    setMotionDefaults((m) => ({ ...m, [style]: motion }));
    backend.setMotionDefault(style, motion).then(
      () => setNotice(`New ${style === "lower-third" ? "lower thirds" : `${style}s`} will move like this. Claude will use it too.`),
      (e) => setNotice(String(e)),
    );
  };

  // Pictures (in the edit and in Luke's assets), served to the viewer and loaded for drawing.
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [, setImagesLoaded] = useState(0);
  useEffect(() => {
    const srcs = new Set([...(edits?.texts ?? []).map((t) => t.src), ...assets.map((a) => a.src)].filter((s): s is string => !!s));
    for (const src of srcs)
      if (!imageUrls[src])
        backend.videoUrl(src).then((u) => {
          setImageUrls((m) => ({ ...m, [src]: u }));
          loadImage(src, u).then(() => setImagesLoaded((n) => n + 1), () => {});
        });
  }, [edits, assets, imageUrls]);
  const addImage = async () => {
    const path = await backend.chooseImage();
    if (!path) return;
    try {
      const src = await backend.importImage(path);
      const name = (path.split("/").pop() ?? "Picture").replace(/\.[^.]+$/, "");
      const asset: Asset = { id: `${Date.now()}`, name, style: "image", src, text: "", size: 0.3, w: 0.3, x: 0.5, y: 0.5 };
      saveAssets([...assets, asset]);
      setNotice(`Added \u201c${name}\u201d to your assets. Drag it onto the timeline.`);
    } catch (e) {
      setNotice(String(e));
    }
  };
  const saveAssets = (next: Asset[]) => {
    setAssets(next);
    backend.saveAssets(next).catch((e) => setNotice(String(e)));
  };
  const saveAsset = (t: TextFx) => {
    const name = t.text.trim() || (t.style === "image" ? "Picture" : "Untitled");
    const asset: Asset = { id: `${Date.now()}`, name, style: t.style, text: t.text, sub: t.sub, size: t.size, look: t.look, x: t.x, y: t.y, src: t.src, w: t.w, motion: t.motion };
    saveAssets([...assets.filter((a) => a.name !== name), asset]);
    setNotice(`Saved \u201c${name}\u201d to your assets. Drag it from Library into any video.`);
  };

  /** A library item clicked (at the playhead) or dropped on the timeline. */
  const addFromLibrary = (item: LibraryItem, at: { clientX: number; clientY: number } | null) => {
    placing.current = at ? timelineTime.current(at.clientX) : null;
    try {
      if (item.kind === "text") newText(item.style);
      else if (item.kind === "asset") {
        const asset = assets.find((a) => a.id === item.id);
        if (asset) newText(asset.style, asset);
      } else if (item.kind === "zoom") newZoom();
      else if (item.kind === "speed" || item.kind === "blur") newTimed(item.kind);
      else if (item.kind === "background") newBackground();
      else if (item.kind === "layout") newLayout();
      else if (item.kind === "note") newNote();
    } finally {
      placing.current = null;
    }
  };
  const timelineTime = useRef<(clientX: number) => number>(() => state.time);

  // Background swap: rendered on the Mac by a small helper, then played as a clip.
  const [rendering, setRendering] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);
  const renderKind = useRef<"layout" | "background">("background");
  useEffect(() => {
    const off = backend.listen<number>("background-progress", (p) => setRendering(p));
    return () => void off.then((f) => f());
  }, []);
  // Layouts (for recordings made in Roughcut) are rendered the same way, with FFmpeg.
  const renderClip = async (settings: Rendered, at: { start: number; end: number; index?: number }) => {
    if (!project || rendering !== null) return;
    player.current?.pause();
    setRendering(0);
    renderKind.current = settings.layout ? "layout" : "background";
    try {
      const file = settings.layout
        ? await backend.renderLayout(project.folder, project.source, at.start, at.end, settings.layout.mode)
        : await backend.swapBackground(project.folder, project.source, at.start, at.end, settings.background!);
      if (at.index === undefined) {
        change((x) => addRendered(x, file, at.start, at.end, settings));
        setTimeout(() =>
          setEdits((cur) => {
            const index = cur?.clips?.findIndex((c) => c.file === file && c.start === at.start) ?? -1;
            if (index >= 0) pickEffect({ kind: "clip", index });
            return cur;
          }),
        );
      } else {
        const i = at.index;
        change((x) => rerender(x, i, file, settings));
      }
    } catch (e) {
      setNotice(String(e).replace(/^Error: /, ""));
    } finally {
      setRendering(null);
    }
  };
  const newBackground = () => {
    const span = spanForNew();
    if (span && span[1] - span[0] > 0.1) void renderClip({ background: { mode: "blur", strength: 30 } }, { start: span[0], end: span[1] });
    setSelection(null);
  };
  const newLayout = () => {
    const span = spanForNew();
    if (!parts?.camera?.video || !parts.screen) return setNotice("Layouts work on videos you record in Roughcut, with your screen and camera.");
    if (span && span[1] - span[0] > 0.1) void renderClip({ layout: { mode: "camera" } }, { start: span[0], end: span[1] });
    setSelection(null);
  };
  const zoomToClicks = () => {
    if (!parts?.clicks.length) return setNotice("There are no clicks to follow: they're saved when you record your screen in Roughcut.");
    change((x) => addClickZooms(x, words, parts.clicks));
  };

  // Speed-ups and blurs: over the selected words, or a few seconds from the playhead.
  const spanForNew = (): [number, number] | null => {
    if (!project) return null;
    if (placing.current !== null) return [cutToSource(ranges, placing.current).source, cutToSource(ranges, placing.current + 3).source];
    if (selection) return [words[selection.first].start, words[selection.last].end];
    return [state.source, cutToSource(ranges, state.time + 3).source];
  };
  const newTimed = (kind: "speed" | "blur") => {
    const span = spanForNew();
    if (!edits || !span || span[1] - span[0] < 0.1) return;
    player.current?.pause();
    const list = kind === "speed" ? "speeds" : "blurs";
    change((x) => (kind === "speed" ? addSpeed(x, span[0], span[1]) : addBlur(x, span[0], span[1])));
    setSelection(null);
    // addSpeed may drop overlapping ones, so find the new one by its times.
    setTimeout(() => {
      setEdits((cur) => {
        const index = ((cur?.[list] ?? []) as { start: number; end: number }[]).findIndex((x) => x.start === span[0] && x.end === span[1]);
        if (index >= 0) pickEffect({ kind, index });
        return cur;
      });
    }, 0);
  };

  // Notes: N drops one at the playhead; Return in it carries on playing if it was.
  const resumeAfterNote = useRef(false);
  const newNote = () => {
    if (!edits) return;
    resumeAfterNote.current = state.playing;
    player.current?.pause();
    const index = edits.notes?.length ?? 0;
    const at = placing.current !== null ? cutToSource(ranges, placing.current).source : state.source;
    change((x) => addNote(x, at));
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

  const shuttle = useRef(1);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (phase.kind !== "ready" || exporting) return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.target instanceof HTMLElement && e.target.closest("input[type=text], input:not([type]), textarea, [contenteditable]")) return;
      if (e.key === " ") {
        e.preventDefault();
        shuttle.current = 1;
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
      } else if (!mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        newTimed("speed");
      } else if (!mod && e.key.toLowerCase() === "g") {
        e.preventDefault();
        newBackground();
      } else if (!mod && e.key.toLowerCase() === "v") {
        e.preventDefault();
        newLayout();
      } else if (!mod && ["j", "k", "l"].includes(e.key.toLowerCase())) {
        // Final Cut's shuttle: L plays (again for faster), J backwards, K stops.
        e.preventDefault();
        const k = e.key.toLowerCase();
        const was = state.playing ? shuttle.current : 0;
        const rate = k === "k" ? 0 : k === "l" ? (was > 0 ? Math.min(8, was * 2) : 1) : was < 0 ? Math.max(-8, was * 2) : -1;
        shuttle.current = rate;
        player.current?.shuttleTo(rate);
      } else if (!mod && (e.key.toLowerCase() === "i" || e.key.toLowerCase() === "o") && current >= 0) {
        // Mark the selection's start (I) or end (O) at the word playing.
        e.preventDefault();
        const [a, b] = selection ? [selection.first, selection.last] : [current, current];
        setSelection(e.key.toLowerCase() === "i" ? { first: current, last: Math.max(current, b) } : { first: Math.min(a, current), last: current });
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        // Jump to the previous or next edit point.
        e.preventDefault();
        const points = ranges.map((r) => sourceToCut(ranges, r[0]));
        const t = state.time;
        const to = e.key === "ArrowUp" ? [...points].reverse().find((p) => p < t - 0.05) ?? 0 : points.find((p) => p > t + 0.05);
        if (to !== undefined) player.current?.seek(to);
      } else if (!mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        newTimed("blur");
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
      // Every picture has to be loaded before the frames are drawn.
      await Promise.all((edits?.texts ?? []).filter((t) => t.src).map(async (t) => loadImage(t.src!, await backend.videoUrl(t.src!))));
      const layers = [
        captions.on && cues.length ? captionStrips(cues, captions.style, project.info.width, project.info.height) : null,
        await graphicsLayer(placed.map((p) => ({ ...p, full: false })), project.info.width, project.info.height, project.info.fps),
      ].filter((l) => l !== null);
      await backend.exportCut(project.source, segments(ranges, words, zooms, clips, project.folder, edits ? liveBlurs(edits) : []), layers, edits?.voice ?? {}, dest);
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
              <div className="actions">
                <button className="btn primary" onClick={choose}>
                  <FolderOpen size={16} /> Open recording…
                </button>
                <button className="btn" onClick={() => setRecording("open")}>
                  <Circle size={16} /> Record
                </button>
              </div>
              {phase.kind === "error" && <p className="error" style={{ marginTop: 16 }}>{phase.message}</p>}
            </div>
          )}
        </div>
        {recording && <Record saving={recording === "saving"} onClose={() => setRecording(null)} />}
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
        <Menu
          label={
            <>
              <Scissors size={16} /> <span className="lbl">Rough cut</span>
            </>
          }
          title="Cuts for you to review"
          items={[
            { label: "Claude's rough cut", icon: <Scissors size={14} />, disabled: !!cutting, onClick: roughCut },
            { label: "Takes I marked (\u201ccut that\u201d)", icon: <MessageSquareX size={14} />, onClick: cutRetakes },
            { label: "Other openings (hooks)", icon: <Sparkles size={14} />, disabled: asking, onClick: hooks },
          ]}
        />
        <Menu
          label={
            <>
              <CaptionsIcon size={16} /> <span className="lbl">Captions</span>
            </>
          }
          items={[
            { label: "No captions", on: !captions.on, onClick: () => change((x) => setCaptions(x, { ...captions, on: false })) },
            { label: "Bold", on: captions.on && captions.style === "bold", onClick: () => change((x) => setCaptions(x, { on: true, style: "bold" })) },
            { label: "Clean", on: captions.on && captions.style === "clean", onClick: () => change((x) => setCaptions(x, { on: true, style: "clean" })) },
          ]}
        />
        <Menu
          label={
            <>
              <Mic size={16} /> <span className="lbl">Voice</span>
            </>
          }
          title="Polished evens out loudness and cleans up hiss in the export"
          items={[
            { label: "As recorded", on: !voiceOn, onClick: () => change((x) => setVoice(x, {})) },
            { label: "Polished", on: voiceOn, onClick: () => change((x) => setVoice(x, { level: true, clean: true })) },
          ]}
        />
        <button className="btn ghost" onClick={() => setRecording("open")} title="Record your screen, camera and voice">
          <Circle size={16} /> <span className="lbl">Record</span>
        </button>
        <button className="btn ghost" onClick={choose} title="Open a recording">
          <FolderOpen size={16} /> <span className="lbl">Open</span>
        </button>
        <button className="btn primary" onClick={startExport} disabled={!ranges.length}>
          <Download size={16} /> Export
        </button>
      </div>

      <div className="main">
        <div className="panel">
          <div className="panel-head tabs">
            <button className={left === "transcript" ? "on" : ""} onClick={() => setLeft("transcript")}>
              Transcript
            </button>
            <button className={left === "library" ? "on" : ""} onClick={() => setLeft("library")}>
              Library
            </button>
            <span className="spacer" />
          </div>
          {left === "library" ? (
            <Library
              assets={assets}
              recordedHere={!!parts?.camera?.video && !!parts.screen}
              onAdd={addFromLibrary}
              onDeleteAsset={(id) => saveAssets(assets.filter((a) => a.id !== id))}
              onZoomToClicks={zoomToClicks}
              onAddImage={() => void addImage()}
              imageUrl={(src) => imageUrls[src]}
            />
          ) : (
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
          )}
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
                style={zoom ? { transform: `scale(${zoomScaleAt(words, zoom, state.source)})`, transformOrigin: `${zoom.x * 100}% ${zoom.y * 100}%` } : undefined}
              >
                <video ref={videoA} src={project.url} />
                <video ref={videoB} src={project.url} />
                {clip && clipUrls[clip.file] && <video ref={clipVideo} className="clip" src={clipUrls[clip.file]} playsInline />}
                <canvas ref={blurCanvas} className="blurs" />
              </div>
              {blurBox && (
                <div
                  className="blurbox editing"
                  title="Drag to move the blur"
                  onPointerDown={(e) => dragBlur(e, "move")}
                  style={{ left: `${blurBox.x * 100}%`, top: `${blurBox.y * 100}%`, width: `${blurBox.w * 100}%`, height: `${blurBox.h * 100}%` }}
                >
                  <span className="handle" title="Drag to resize" onPointerDown={(e) => dragBlur(e, "size")} />
                </div>
              )}
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
              {(notice || (rendering !== null && !pickedClip?.background && !pickedClip?.layout)) && (
                <div className="toast" onClick={() => setNotice(null)}>
                  {notice ??
                    (renderKind.current === "layout" ? "Making the layout…" : `Cutting you out of the background… ${Math.round((rendering ?? 0) * 100)}%`)}
                </div>
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
              Claude {asking && <span className="pulse" />}
            </button>
            <button className={tab === "versions" ? "on" : ""} onClick={() => setTab("versions")}>
              Versions
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
          ) : tab === "versions" ? (
            <Versions
              folder={project.folder}
              edits={edits}
              length={cutDuration(ranges)}
              reload={claudeChanged}
              onOpen={(next) => change(() => next)}
              onHooks={hooks}
              busy={asking}
            />
          ) : tab === "effect" && pickedAny ? (
            <Effect
              key={effect ? `${effect.kind}:${effect.index}` : ""}
              words={words}
              zoom={picked}
              clip={pickedClip}
              text={pickedText}
              onText={(patch) => effect && change((x) => setText(x, effect.index, patch))}
              onSaveAsset={saveAsset}
              onRender={(settings) => effect && pickedClip && void renderClip(settings, { start: pickedClip.start, end: pickedClip.end, index: effect.index })}
              onChooseImage={backend.chooseImage}
              rendering={rendering}
              speed={pickedSpeed}
              blur={pickedBlur}
              onTimed={(patch) => effect && change((x) => setTimed(x, effect.kind === "speed" ? "speeds" : "blurs", effect.index, patch))}
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
              onZoomEase={(ease) => effect && change((x) => setZoomEase(x, effect.index, ease))}
              onMotionDefault={makeMotionDefault}
              onPreview={() => {
                if (!effect) return;
                const at = effectStart(edits, words, effect);
                pickEffect(null);
                if (at !== null) player.current?.seekSource(Math.max(0, at - 0.5));
                setTimeout(() => player.current?.play(), 50);
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
        onFxEdit={(fx, start, end, mode) => {
          change((x) => moveEffect(x, words, fx, start, end, mode));
          // A background stretched past what was rendered is rendered again.
          const c = fx.kind === "clip" ? edits.clips?.[fx.index] : undefined;
          if ((c?.background || c?.layout) && (start < c.start - c.offset - 0.01 || end > c.start - c.offset + c.length + 0.01))
            void renderClip({ background: c.background, layout: c.layout }, { start, end, index: fx.index });
        }}
        pins={(edits.notes ?? []).map((n, index) => ({ index, at: n.at, done: !!n.done, forClaude: n.by === "you" }))}
        onPin={(index) => pickEffect({ kind: "note", index })}
        effect={effect}
        onSelectEffect={pickEffect}
        onTrim={(i, start, end) => change((x) => trimClip(x, ranges, i, start, end))}
        selection={selection}
        onSelectWords={(first, last) => setSelection({ first, last })}
        onCutPause={(start, end) => change((x) => cutSpan(x, start, end))}
        onScrub={(t) => player.current?.seek(t)}
        timeAt={timelineTime}
      />

      {recording && <Record saving={recording === "saving"} onClose={() => setRecording(null)} />}

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
