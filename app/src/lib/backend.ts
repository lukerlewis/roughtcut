// Talks to the Rust core. In a plain browser (vite dev, UI tests) it falls
// back to fixtures under /fixtures so the UI can be worked on without the app.

import type { Asset } from "../components/Library";
import type { CaptionStrips } from "./captions";
import type { Decisions, Edits, Motion, Segment, TextStyle, Voice, Word } from "./edl";

export interface Opened {
  source: string;
  folder: string;
  has_cut: boolean;
}

export interface Info {
  duration: number;
  width: number;
  height: number;
  fps: number;
}

export interface Loaded {
  words: Word[];
  decisions: Decisions;
  edits: Edits | null;
}

const inApp = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** The player's URL for a recording, served by the app on 127.0.0.1. */
export async function videoUrl(path: string): Promise<string> {
  if (!inApp) return path;
  return invoke("video_url", { path });
}

export async function chooseRecording(): Promise<string | null> {
  if (!inApp) return "/fixtures/recording.webm";
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Video", extensions: ["mov", "mp4", "m4v", "mkv", "webm"] }],
  });
  return typeof picked === "string" ? picked : null;
}

export async function chooseExport(defaultPath: string): Promise<string | null> {
  if (!inApp) return "/tmp/export.mp4";
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({ defaultPath, filters: [{ name: "Video", extensions: ["mp4"] }] });
}

export async function openRecording(path: string): Promise<Opened> {
  if (!inApp) return { source: path, folder: "/fixtures", has_cut: true };
  return invoke("open_recording", { path });
}

/** Transcribes the recording and, with `cut`, asks Claude for its rough cut. */
export async function runRoughCut(path: string, cut: boolean, guidance?: string): Promise<string> {
  if (!inApp) {
    await new Promise((r) => setTimeout(r, 300));
    return "/fixtures";
  }
  return invoke("run_rough_cut", { path, cut, guidance });
}

export async function loadCut(folder: string): Promise<Loaded> {
  if (!inApp) {
    const get = (f: string) => fetch(`/fixtures/${f}`).then((r) => r.json());
    const saved = localStorage.getItem("roughcut-edits");
    return { words: await get("words.json"), decisions: await get("decisions.json"), edits: saved ? JSON.parse(saved) : null };
  }
  return invoke("load_cut", { folder });
}

export async function saveEdits(folder: string, edits: Edits): Promise<void> {
  if (!inApp) {
    localStorage.setItem("roughcut-edits", JSON.stringify(edits));
    return;
  }
  return invoke("save_edits", { folder, edits });
}

export async function probe(path: string): Promise<Info> {
  if (!inApp) return fetch("/fixtures/info.json").then((r) => r.json());
  return invoke("probe", { path });
}

export async function waveform(path: string, folder: string): Promise<Uint8Array> {
  if (!inApp) return new Uint8Array(await (await fetch("/fixtures/waveform.bin")).arrayBuffer());
  return new Uint8Array(await invoke<number[]>("waveform", { path, folder }));
}

/** Renders the cut: the kept pieces (some zoomed) with the overlay layers (captions, titles) burned in. */
/** A motion graphic for the export: rendered by HyperFrames, laid over the cut from `at` (cut seconds). */
export interface ExportGraphic {
  slug: string;
  at: number;
  x: number;
  y: number;
  scale: number;
}

export async function exportCut(
  source: string,
  segments: Segment[],
  overlays: CaptionStrips[],
  voice: Voice,
  dest: string,
  folder?: string,
  graphics: ExportGraphic[] = [],
): Promise<void> {
  if (!inApp) {
    (window as any).__lastExport = { source, segments, overlays: overlays.map((o) => ({ top: o.top, frames: o.frames.length })), voice, dest, graphics };
    await new Promise((r) => setTimeout(r, 400));
    return;
  }
  return invoke("export", { source, segments, overlays, voice, dest, folder, graphics });
}

// --- Claude in the sidebar -------------------------------------------------

/** One line of `claude -p --output-format stream-json`. */
export type ClaudeEvent = Record<string, any>;

export interface ChatMessage {
  role: "you" | "claude" | "action" | "error";
  text: string;
  tool?: string;
  input?: Record<string, any>;
}

export interface Chat {
  session: string | null;
  messages: ChatMessage[];
}

export async function loadChat(folder: string): Promise<Chat | null> {
  if (!inApp) {
    const saved = localStorage.getItem("roughcut-chat");
    return saved ? JSON.parse(saved) : null;
  }
  return invoke("load_chat", { folder });
}

export async function saveChat(folder: string, chat: Chat): Promise<void> {
  if (!inApp) {
    localStorage.setItem("roughcut-chat", JSON.stringify(chat));
    return;
  }
  return invoke("save_chat", { folder, chat });
}

/** One turn: Claude's stream arrives through onClaudeEvent until this resolves. */
export async function askClaude(folder: string, recording: string, duration: number, prompt: string, resume: string | null) {
  if (!inApp) return mockClaude(prompt);
  return invoke<void>("ask_claude", { folder, recording, duration, prompt, resume });
}

export async function stopClaude(): Promise<void> {
  if (inApp) await invoke("stop_claude");
}

const mockListeners = new Set<(e: ClaudeEvent) => void>();

export async function onClaudeEvent(fn: (e: ClaudeEvent) => void): Promise<() => void> {
  if (!inApp) {
    mockListeners.add(fn);
    return () => mockListeners.delete(fn);
  }
  return listen<ClaudeEvent>("claude-event", fn);
}

/** For working on the UI in a browser: replays /fixtures/claude.json, a list
 *  of stream events, applying any cut_words calls to the saved edits. */
async function mockClaude(_prompt: string) {
  const events: ClaudeEvent[] = await fetch("/fixtures/claude.json").then((r) => r.json());
  for (const e of events) {
    await new Promise((r) => setTimeout(r, e.type === "assistant" ? 700 : 150));
    for (const c of e.message?.content ?? []) {
      if (c.type === "tool_use" && c.name === "mcp__roughcut__cut_words") {
        const edits = JSON.parse(localStorage.getItem("roughcut-edits") ?? "null");
        if (edits) {
          edits.agent.push({ first: c.input.from, last: c.input.to, reason: c.input.reason, status: "pending" });
          edits.log.push({ at: new Date().toISOString(), by: "agent", op: "cut", first: c.input.from, last: c.input.to, note: c.input.reason });
          localStorage.setItem("roughcut-edits", JSON.stringify(edits));
        }
      }
      if (c.type === "tool_use" && (c.name === "mcp__roughcut__zoom_in" || c.name === "mcp__roughcut__set_captions")) {
        const edits = JSON.parse(localStorage.getItem("roughcut-edits") ?? "null");
        if (edits) {
          if (c.name.endsWith("zoom_in"))
            (edits.zooms ??= []).push({ first: c.input.from, last: c.input.to, scale: c.input.scale ?? 1.3, x: 0.5, y: 0.4, by: "agent", status: "pending", reason: c.input.reason });
          else edits.captions = { on: c.input.on, style: c.input.style ?? "bold" };
          localStorage.setItem("roughcut-edits", JSON.stringify(edits));
        }
      }
    }
    mockListeners.forEach((fn) => fn(e));
  }
}

/** A recording the app was opened with, if any. */
export async function launchFile(): Promise<string | null> {
  if (!inApp) return null;
  return invoke("launch_file");
}

/** A recording Luke has edited, with its rough-cut folder. Times are Unix seconds. */
export interface ProjectInfo {
  source: string;
  name: string;
  folder: string;
  opened: number;
  saved: number | null;
}

export async function recentProjects(): Promise<ProjectInfo[]> {
  if (!inApp) {
    const now = Date.now() / 1000;
    return [
      { source: "/fixtures/recording.webm", name: "recording", folder: "/fixtures", opened: now - 600, saved: now - 620 },
      { source: "/Users/luke/Movies/Roughcut/Recording 2026-10-19 14.02.mov", name: "Recording 2026-10-19 14.02", folder: "/Users/luke/Movies/Roughcut", opened: now - 90000, saved: null },
    ];
  }
  return invoke("recent_projects");
}

/** Moves a project to the Trash: a recording made in Roughcut with its whole
 *  folder, or just the edits of a video from elsewhere (the video stays). */
export async function deleteProject(source: string): Promise<void> {
  if (inApp) await invoke("delete_project", { source });
}

/** A still from the recording for the project's card. */
export async function projectThumbnail(source: string): Promise<string | null> {
  if (!inApp) return null;
  return invoke<string>("project_thumbnail", { source }).catch(() => null);
}

/** Tells the app everything is saved, so it can quit. */
export async function savedForQuit(): Promise<void> {
  if (inApp) await invoke("saved_for_quit");
}

export async function reveal(path: string): Promise<void> {
  if (inApp) await invoke("reveal", { path });
}

export async function listen<T>(event: string, fn: (payload: T) => void): Promise<() => void> {
  if (!inApp) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(event, (e) => fn(e.payload));
}

/** Files dropped on the window. */
export async function onDrop(fn: (paths: string[]) => void): Promise<() => void> {
  if (!inApp) return () => {};
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  return getCurrentWebview().onDragDropEvent((e) => {
    if (e.payload.type === "drop") fn(e.payload.paths);
  });
}

export interface UpdateState {
  keySet: boolean;
  current: number;
  available: { build: number; notes: string } | null;
}

/** Whether a newer build is waiting (see update.rs). In a browser it
 *  pretends, so the UI can be worked on. */
export async function checkUpdate(): Promise<UpdateState> {
  if (!inApp) {
    const keySet = localStorage.getItem("roughcut-update-key") === "1";
    return { keySet, current: 1, available: keySet ? { build: 2, notes: "Editor: zoom-ins and captions" } : null };
  }
  return invoke("check_update");
}

export async function setUpdateKey(key: string): Promise<void> {
  if (!inApp) return void localStorage.setItem("roughcut-update-key", key ? "1" : "");
  return invoke("set_update_key", { key });
}

/** Downloads the newer build; the app restarts into it when it's done. */
export async function installUpdate(): Promise<void> {
  if (!inApp) return new Promise((r) => setTimeout(r, 1500));
  return invoke("install_update");
}

export async function openUrl(url: string): Promise<void> {
  if (!inApp) return void window.open(url, "_blank");
  return invoke("open_url", { url });
}

// --- Luke's style: rules and settings for every video ------------------------

export interface Rule {
  text: string;
  on: boolean;
  by?: "you" | "agent";
}

export interface StyleSettings {
  maxPause?: number; // longest pause the rough cut leaves between lines
  padIn?: number; // room kept before a word at a cut
  padOut?: number; // room kept after a word at a cut
}

/** Luke's look, applied to every motion graphic (unless he turns it off for one). */
export interface Brand {
  font?: string; // a font installed on the Mac, by name
  bold?: number; // weight for headlines
  regular?: number; // weight for everything else
  ink?: string; // text colour
  paper?: string; // background colour (cards, full-screen graphics)
  accent?: string; // the colour that stands out
  accent2?: string; // a second one, for charts
  radius?: number; // corner roundness, pixels at 1080p
}

export interface Style {
  rules?: Rule[];
  settings?: StyleSettings;
  motion?: Partial<Record<TextStyle, Motion>>; // Luke's default motion for each kind of graphic
  brand?: Brand;
  graphics?: "off" | "light" | "more"; // how readily Claude suggests graphics
  skills?: Record<string, boolean>; // which Rough cut skills Luke last ticked
}

/** One of Luke's editing skills: a step Rough cut can run. Those with `does`
 *  the app runs itself; the rest are instructions the sidebar Claude follows. */
export interface Skill {
  id: string;
  name: string;
  text: string;
  on: boolean; // ticked unless Luke changed it
  does?: "cut" | "retakes" | "captions" | "graphics";
  needs?: "screen"; // only for videos recorded in Roughcut
  look?: "bold" | "clean"; // captions
  builtIn: boolean;
  edited: boolean;
}

// In the browser (npm run dev), the skills that ship, with changes kept in localStorage.
const SHIPPED = import.meta.glob("../../skills/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const ORDER = ["cut", "retakes", "captions", "graphics", "layouts", "zooms", "chapters", "hooks"];
function devSkills(): Skill[] {
  const parse = (id: string, text: string, builtIn: boolean, edited: boolean): Skill => {
    const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    const meta: Record<string, string> = {};
    for (const line of (m?.[1] ?? "").split("\n")) {
      const i = line.indexOf(":");
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return { id, name: meta.name ?? id, text: (m?.[2] ?? text).trim(), on: meta.on === "true", ...(meta.does ? { does: meta.does as Skill["does"] } : {}), ...(meta.needs ? { needs: "screen" as const } : {}), ...(meta.look ? { look: meta.look as Skill["look"] } : {}), builtIn, edited };
  };
  const changed: Record<string, Skill> = JSON.parse(localStorage.getItem("roughcut-skills") ?? "{}");
  const shipped = ORDER.map((id) => changed[id] ?? parse(id, SHIPPED[`../../skills/${id}.md`] ?? "", true, false));
  return [...shipped, ...Object.values(changed).filter((s) => !s.builtIn)];
}

export async function listSkills(): Promise<Skill[]> {
  if (!inApp) return devSkills();
  return invoke("list_skills");
}

/** Changes a skill (by id) or adds one (no id). */
export async function saveSkill(patch: { id?: string; name?: string; text?: string; on?: boolean; look?: string }): Promise<Skill> {
  if (!inApp) {
    const all = devSkills();
    const was = all.find((s) => s.id === patch.id);
    const id = patch.id ?? (patch.name ?? "skill").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const next = { ...(was ?? { id, name: "", text: "", on: true, builtIn: false }), ...patch, id, edited: true } as Skill;
    const changed = JSON.parse(localStorage.getItem("roughcut-skills") ?? "{}");
    localStorage.setItem("roughcut-skills", JSON.stringify({ ...changed, [id]: next }));
    return next;
  }
  return invoke("save_skill", patch);
}

/** Deletes one of Luke's skills, or puts one that ships back as it came. */
export async function removeSkill(id: string): Promise<void> {
  if (!inApp) {
    const changed = JSON.parse(localStorage.getItem("roughcut-skills") ?? "{}");
    delete changed[id];
    return localStorage.setItem("roughcut-skills", JSON.stringify(changed));
  }
  return invoke("remove_skill", { id });
}

export interface Suggestion {
  text: string;
  why: string;
}

export async function loadStyle(): Promise<Style> {
  if (!inApp) return JSON.parse(localStorage.getItem("roughcut-style") ?? "{}");
  return invoke<Style>("load_style");
}

export async function saveStyle(style: Style): Promise<void> {
  if (!inApp) return localStorage.setItem("roughcut-style", JSON.stringify(style));
  return invoke("save_style", { style });
}

/** Claude reads what Luke corrected in this video and suggests rules. Uses his plan. */
/** "Suggest graphics", first pass: the moments Claude thinks want a graphic
 *  (from the transcript alone), and the request that builds them. */
export interface Moment {
  from: number;
  to: number;
  catalog: string;
  idea: string;
  why: string;
}
export async function spotGraphics(folder: string, guidance?: string): Promise<{ moments: Moment[]; prompt: string }> {
  if (!inApp) {
    await new Promise((r) => setTimeout(r, 600));
    const moments = [{ from: 4, to: 8, catalog: "lt-clean-bar", idea: "Luke Lewis, creator", why: "Introduces him." }];
    return { moments, prompt: `Add these motion graphics: ${JSON.stringify(moments)}` };
  }
  return invoke("spot_graphics", { folder, guidance });
}

export async function suggestRules(folder: string): Promise<Suggestion[]> {
  if (!inApp) {
    await new Promise((r) => setTimeout(r, 600));
    return [{ text: "Keep \"so\" when it starts a sentence", why: "You put back three of Claude's cuts of \"so\"." }];
  }
  return invoke<Suggestion[]>("suggest_rules", { folder });
}

export async function chooseImage(): Promise<string | null> {
  if (!inApp) return "/fixtures/background.jpg";
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ multiple: false, directory: false, filters: [{ name: "Picture", extensions: ["jpg", "jpeg", "png", "heic", "webp"] }] });
  return typeof picked === "string" ? picked : null;
}

/** Renders source seconds start..end with a new background behind Luke (on
 *  the Mac, with Apple's Vision). Returns the clip's path in the folder. */
export async function swapBackground(folder: string, source: string, start: number, end: number, background: object): Promise<string> {
  if (!inApp) {
    await new Promise((r) => setTimeout(r, 500));
    return "clips/bw.webm";
  }
  return invoke<string>("swap_background", { folder, source, start, end, background });
}

// --- Recording ---------------------------------------------------------------

export interface Source {
  id: string;
  name: string;
}

export interface Sources {
  screens: Source[];
  windows?: Source[]; // single app windows ("w" + its number), open now
  screenAllowed: boolean;
  cameras: Source[];
  mics: Source[];
}

export async function recordingSources(): Promise<Sources> {
  if (!inApp)
    return {
      screens: [{ id: "1", name: "Main screen" }],
      windows: [{ id: "w42", name: "Safari: Roughcut planning" }, { id: "w43", name: "Xcode: main.swift" }],
      screenAllowed: true,
      cameras: [{ id: "cam", name: "FaceTime HD Camera" }],
      mics: [{ id: "mic", name: "MacBook Air Microphone" }],
    };
  return invoke<Sources>("recording_sources");
}

/** Starts recording the chosen screen, camera and mic. Returns the folder it records into. */
export async function startRecording(screen: string | null, camera: string | null, mic: string | null): Promise<string> {
  if (!inApp) return "/Users/luke/Movies/Roughcut/Recording";
  return invoke<string>("start_recording", { screen, camera, mic });
}

export async function stopRecording(): Promise<void> {
  if (inApp) await invoke("stop_recording");
}

export interface RecordingParts {
  screen?: { file: string; start: number; width: number; height: number };
  camera?: { file: string; start: number; video: boolean };
  clicks: { t: number; x: number; y: number }[];
}

/** The parts of a video recorded in Roughcut (screen, camera, clicks), or null. */
export async function recordingParts(source: string): Promise<RecordingParts | null> {
  if (!inApp)
    return {
      screen: { file: "screen.mov", start: 0, width: 1920, height: 1080 },
      camera: { file: "camera.mov", start: 0, video: true },
      clicks: [{ t: 4.2, x: 0.3, y: 0.35 }, { t: 5.1, x: 0.34, y: 0.4 }, { t: 40.5, x: 0.7, y: 0.3 }],
    };
  return invoke<RecordingParts | null>("recording_parts", { source });
}

/** Renders source seconds start..end in another layout; returns the clip's path in the folder. */
export async function renderLayout(folder: string, source: string, start: number, end: number, mode: string): Promise<string> {
  if (!inApp) {
    await new Promise((r) => setTimeout(r, 300));
    return "clips/bw.webm";
  }
  return invoke<string>("render_layout", { folder, source, start, end, mode });
}

// --- Versions --------------------------------------------------------------

export interface Version {
  id: string;
  name: string;
  at: string;
  by: "you" | "agent";
  length: number;
  note?: string | null;
}

// In a plain browser, versions live in localStorage.
const mockVersions = (): Record<string, Version & { edits: Edits }> => JSON.parse(localStorage.getItem("roughcut-versions") ?? "{}");

export async function listVersions(folder: string): Promise<Version[]> {
  if (!inApp) return Object.values(mockVersions()).map(({ edits: _, ...v }) => v).sort((a, b) => a.at.localeCompare(b.at));
  return invoke<Version[]>("list_versions", { folder });
}

export async function saveVersion(folder: string, name: string, edits: Edits, length: number): Promise<string> {
  if (!inApp) {
    const all = mockVersions();
    const id = Object.values(all).find((v) => v.name.toLowerCase() === name.trim().toLowerCase())?.id ?? name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
    all[id] = { id, name: name.trim(), at: new Date().toISOString(), by: "you", length, edits };
    localStorage.setItem("roughcut-versions", JSON.stringify(all));
    return id;
  }
  return invoke<string>("save_version", { folder, name, edits, length });
}

export async function openVersion(folder: string, id: string): Promise<Edits> {
  if (!inApp) return mockVersions()[id].edits;
  return invoke<Edits>("open_version", { folder, id });
}

export async function deleteVersion(folder: string, id: string): Promise<void> {
  if (!inApp) {
    const all = mockVersions();
    delete all[id];
    return localStorage.setItem("roughcut-versions", JSON.stringify(all));
  }
  return invoke("delete_version", { folder, id });
}

// --- Assets ----------------------------------------------------------------


export async function loadAssets(): Promise<Asset[]> {
  if (!inApp) return JSON.parse(localStorage.getItem("roughcut-assets") ?? "[]");
  return invoke<Asset[]>("load_assets");
}

export async function saveAssets(assets: Asset[]): Promise<void> {
  if (!inApp) return localStorage.setItem("roughcut-assets", JSON.stringify(assets));
  return invoke("save_assets", { assets });
}

/** Makes this motion the default for new graphics of this kind (Luke's, and Claude's). */
export async function setMotionDefault(style: TextStyle, motion: Motion): Promise<void> {
  if (!inApp) {
    const s: Style = JSON.parse(localStorage.getItem("roughcut-style") ?? "{}");
    return localStorage.setItem("roughcut-style", JSON.stringify({ ...s, motion: { ...s.motion, [style]: motion } }));
  }
  return invoke("set_motion_default", { style, motion });
}

/** Copies an image into Luke's assets folder (so it stays put) and returns its new path. */
export async function importImage(path: string): Promise<string> {
  if (!inApp) return path;
  return invoke<string>("import_image", { path });
}

// --- Motion graphics -----------------------------------------------------------

export interface CatalogGraphic {
  name: string;
  title: string;
  description: string;
  group: string;
  duration: number;
  width: number;
  height: number;
  params: { key?: string; id?: string; label: string; type: string; default: string | number; min?: number; max?: number; step?: number }[];
  poster?: string;
  values?: Record<string, string | number>; // Luke's own: the settings he saved it with
  texts?: Record<string, string>; // and its words
}

/** Keeps a graphic from this project as one of Luke's ("Yours" in the Library). Returns its catalogue name. */
export async function saveGraphicTemplate(folder: string, slug: string, info: Omit<CatalogGraphic, "name" | "group" | "description">): Promise<string> {
  if (!inApp) return `mine/${slug}`;
  return invoke("save_graphic_template", { folder, slug, info });
}

export async function forgetGraphicTemplate(name: string): Promise<void> {
  if (!inApp) return;
  return invoke("forget_graphic_template", { name });
}

/** The motion graphics that ship with the app (from HyperFrames' catalogue). */
export async function graphicsCatalog(): Promise<CatalogGraphic[]> {
  if (!inApp) return fetch("/dev-catalog/catalog.json").then((r) => r.json()).then((c) => c.graphics);
  return invoke("graphics_catalog");
}

/** Copies a catalogue graphic into the project; returns its folder name. */
export async function addCatalogGraphic(folder: string, name: string): Promise<string> {
  if (!inApp) return fetch(`/dev-graphics/add?name=${encodeURIComponent(name)}`).then((r) => r.text());
  return invoke("add_catalog_graphic", { folder, name });
}

export async function graphicSource(folder: string, slug: string): Promise<string> {
  if (!inApp) return fetch(`/dev-graphics/${slug}/source.html`).then((r) => r.text());
  return invoke("graphic_source", { folder, slug });
}

/** Writes the graphic with Luke's settings applied, which plays and renders. */
export async function saveGraphicView(folder: string, slug: string, html: string): Promise<void> {
  if (!inApp) return void (await fetch(`/dev-graphics/view?slug=${encodeURIComponent(slug)}`, { method: "POST", body: html }));
  return invoke("save_graphic_view", { folder, slug, html });
}

/** Where the viewer loads the project's graphics from. */
export async function graphicsUrl(folder: string): Promise<string> {
  if (!inApp) return "/dev-graphics";
  return invoke("graphics_url", { folder });
}
