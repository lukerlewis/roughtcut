// Talks to the Rust core. In a plain browser (vite dev, UI tests) it falls
// back to fixtures under /fixtures so the UI can be worked on without the app.

import type { Decisions, Edits, Word } from "./edl";

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

export async function videoUrl(path: string): Promise<string> {
  if (!inApp) return path;
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  return convertFileSrc(path);
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

export async function runRoughCut(path: string): Promise<string> {
  if (!inApp) return "/fixtures";
  return invoke("run_rough_cut", { path });
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

export async function exportCut(source: string, ranges: [number, number][], dest: string): Promise<void> {
  if (!inApp) {
    await new Promise((r) => setTimeout(r, 400));
    return;
  }
  return invoke("export", { source, ranges, dest });
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
