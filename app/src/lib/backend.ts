// Talks to the Rust core. In a plain browser (vite dev, UI tests) it falls
// back to fixtures under /fixtures so the UI can be worked on without the app.

import type { CaptionStrips } from "./captions";
import type { Decisions, Edits, Segment, Voice, Word } from "./edl";

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
export async function runRoughCut(path: string, cut: boolean): Promise<string> {
  if (!inApp) {
    await new Promise((r) => setTimeout(r, 300));
    return "/fixtures";
  }
  return invoke("run_rough_cut", { path, cut });
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
export async function exportCut(
  source: string,
  segments: Segment[],
  overlays: CaptionStrips[],
  voice: Voice,
  dest: string,
): Promise<void> {
  if (!inApp) {
    (window as any).__lastExport = { source, segments, overlays: overlays.map((o) => ({ top: o.top, frames: o.frames.length })), voice, dest };
    await new Promise((r) => setTimeout(r, 400));
    return;
  }
  return invoke("export", { source, segments, overlays, voice, dest });
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

export interface Style {
  rules?: Rule[];
  settings?: StyleSettings;
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
