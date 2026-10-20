//! Roughcut's Rust core: finds the recording's rough-cut folder, runs the
//! command-line rough cut, reads and saves edits, draws the waveform and
//! exports the finished video. FFmpeg and the `roughcut` CLI do the heavy work
//! as separate programs; the UI is web code drawn by macOS's own WebKit.

mod assets;
mod claude;
mod edits;
mod markers;
mod mcp;
mod matte;
mod media;
mod recorder;
mod server;
mod style;
mod tools;
mod update;
mod versions;

use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
#[cfg(target_os = "macos")]
use tauri::Manager;

/// A recording handed to the app at launch: from the command line, or from
/// Finder's "Open With" before the window was ready.
#[derive(Default)]
struct Launch(Mutex<Option<String>>);

#[derive(Serialize)]
struct Opened {
    source: String,
    folder: String,
    /// The rough cut has been made (words.json and decisions.json exist).
    has_cut: bool,
}

/// "<name> rough cut" next to the recording, as the CLI makes it.
fn cut_folder(source: &Path) -> PathBuf {
    let stem = source.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    source.with_file_name(format!("{stem} rough cut"))
}

#[tauri::command]
fn open_recording(path: String) -> Result<Opened, String> {
    let source = PathBuf::from(&path);
    if !source.is_file() {
        return Err(format!("Can't find {path}"));
    }
    let folder = cut_folder(&source);
    let has_cut = folder.join("words.json").is_file() && folder.join("decisions.json").is_file();
    Ok(Opened { source: path, folder: folder.to_string_lossy().into(), has_cut })
}

/// Runs `roughcut cut` on the recording, streaming its progress lines to the
/// window as "roughcut-log" events. Without `cut` it only writes the words
/// down, so the recording opens uncut.
#[tauri::command]
async fn run_rough_cut(app: AppHandle, path: String, cut: bool) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cli = tools::roughcut_cli().ok_or(
            "Can't find the roughcut command. Run the setup in your Roughcut folder first (bash scripts/setup-mac.sh).",
        )?;
        let style = style::load();
        let mut cmd = tools::command(&cli);
        cmd.args(["cut", &path, "--no-preview"]);
        if cut {
            // Luke's settings and rules shape the rough cut too.
            cmd.args(style::cut_args(&style));
            let rules = style::rules_text(&style);
            if !rules.is_empty() {
                cmd.env("ROUGHCUT_CLAUDE_ARGS", format!("--append-system-prompt {}", style::shell_quote(&rules)));
            }
        } else {
            cmd.arg("--transcribe-only");
        }
        let mut child = cmd
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Couldn't start the rough cut: {e}"))?;
        let stderr = child.stderr.take().unwrap();
        let mut tail: Vec<String> = Vec::new();
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let line = line.trim_start_matches("› ").to_string();
            let _ = app.emit("roughcut-log", &line);
            tail.push(line);
            if tail.len() > 8 {
                tail.remove(0);
            }
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!("The rough cut stopped: {}", tail.join(" ")));
        }
        Ok(cut_folder(Path::new(&path)).to_string_lossy().into())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn read_json(path: &Path) -> Result<Value, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("Can't read {}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{} isn't valid: {e}", path.display()))
}

/// Everything the editor needs from the rough-cut folder, as raw JSON.
#[tauri::command]
fn load_cut(folder: String) -> Result<Value, String> {
    let dir = PathBuf::from(&folder);
    let edits = dir.join("edits.json");
    Ok(serde_json::json!({
        "words": read_json(&dir.join("words.json"))?,
        "decisions": read_json(&dir.join("decisions.json"))?,
        "edits": if edits.is_file() { read_json(&edits)? } else { Value::Null },
    }))
}

/// Saves the edit state, writing a temp file first so a crash never leaves
/// half a file behind.
#[tauri::command]
fn save_edits(folder: String, edits: Value) -> Result<(), String> {
    let dir = PathBuf::from(&folder);
    let tmp = dir.join(".edits.json.tmp");
    let text = serde_json::to_string_pretty(&edits).map_err(|e| e.to_string())?;
    fs::write(&tmp, text).map_err(|e| format!("Couldn't save: {e}"))?;
    fs::rename(&tmp, dir.join("edits.json")).map_err(|e| format!("Couldn't save: {e}"))
}

#[tauri::command]
fn load_assets() -> Value {
    assets::load()
}

#[tauri::command]
fn save_assets(assets: Value) -> Result<(), String> {
    assets::save(&assets)
}

#[tauri::command]
fn list_versions(folder: String) -> Value {
    Value::Array(versions::list(Path::new(&folder)))
}

#[tauri::command]
fn save_version(folder: String, name: String, edits: Value, length: f64) -> Result<String, String> {
    versions::save(Path::new(&folder), &name, &edits, length, "you", None)
}

#[tauri::command]
fn open_version(folder: String, id: String) -> Result<Value, String> {
    versions::load(Path::new(&folder), &id)
}

#[tauri::command]
fn delete_version(folder: String, id: String) -> Result<(), String> {
    versions::remove(Path::new(&folder), &id)
}

#[tauri::command]
async fn probe(path: String) -> Result<media::Info, String> {
    tauri::async_runtime::spawn_blocking(move || media::probe(Path::new(&path))).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn waveform(path: String, folder: String) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || media::waveform(Path::new(&path), &PathBuf::from(folder).join("waveform.bin")))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn export(
    app: AppHandle,
    source: String,
    segments: Vec<media::Segment>,
    overlays: Vec<media::Captions>,
    voice: Option<media::Voice>,
    dest: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        media::export(Path::new(&source), &segments, &overlays, voice.unwrap_or_default(), Path::new(&dest), |done| {
            let _ = app.emit("export-progress", done);
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One turn of the sidebar conversation. Claude's stream arrives as
/// "claude-event"s; this returns when the turn is over.
#[tauri::command]
async fn ask_claude(
    app: AppHandle,
    folder: String,
    recording: String,
    duration: f64,
    prompt: String,
    resume: Option<String>,
) -> Result<(), String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let running = app.state::<claude::Running>();
        claude::ask(Path::new(&folder), &recording, duration, &prompt, resume.as_deref(), &running, |event| {
            let _ = app.emit("claude-event", event);
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Renders a stretch of the recording with a new background; returns the
/// clip's path inside the folder.
#[tauri::command]
async fn swap_background(app: AppHandle, folder: String, source: String, start: f64, end: f64, background: Value) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        matte::render(Path::new(&folder), Path::new(&source), start, end, &background, |p| {
            let _ = app.emit("background-progress", p);
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A Roughcut recording's parts and clicks, or null for other videos.
#[tauri::command]
fn recording_parts(source: String) -> Value {
    recorder::parts(Path::new(&source)).map(|(_, info)| info).unwrap_or(Value::Null)
}

/// Renders source seconds start..end in another layout; returns the clip's path in the folder.
#[tauri::command]
async fn render_layout(folder: String, source: String, start: f64, end: f64, mode: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || recorder::render_layout(Path::new(&folder), Path::new(&source), start, end, &mode))
        .await
        .map_err(|e| e.to_string())?
}

/// The screens, cameras and mics Luke can record.
#[tauri::command]
async fn recording_sources() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(recorder::list).await.map_err(|e| e.to_string())?
}

/// Starts recording. When it stops (from the app or the menu bar), the parts
/// are put together and `recording-finished` brings the video to open.
#[tauri::command]
async fn start_recording(app: AppHandle, screen: Option<String>, camera: Option<String>, mic: Option<String>) -> Result<String, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let folder = recorder::new_folder();
        let state = app.state::<recorder::Recording>();
        let child = recorder::start(&state, &folder, screen.as_deref(), camera.as_deref(), mic.as_deref())?;
        *state.0.lock().unwrap() = Some(child.id());
        let (app2, dir) = (app.clone(), folder.clone());
        std::thread::spawn(move || {
            let result = recorder::wait(child).and_then(|_| {
                let _ = app2.emit("recording-saving", ());
                recorder::compose(&dir)
            });
            *app2.state::<recorder::Recording>().0.lock().unwrap() = None;
            let _ = app2.emit(
                "recording-finished",
                match result {
                    Ok(path) => serde_json::json!({ "path": path }),
                    Err(error) => serde_json::json!({ "error": error }),
                },
            );
        });
        Ok(folder.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn stop_recording(state: tauri::State<recorder::Recording>) -> Result<(), String> {
    recorder::stop(&state)
}

/// Luke's rules and settings, the same for every video.
#[tauri::command]
fn load_style() -> Value {
    style::load()
}

#[tauri::command]
fn save_style(style: Value) -> Result<(), String> {
    style::save(&style)
}

/// Rules Claude suggests from what Luke corrected in this project.
#[tauri::command]
async fn suggest_rules(folder: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || style::suggest(Path::new(&folder))).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn stop_claude(running: tauri::State<claude::Running>) {
    claude::stop(&running);
}

/// The sidebar conversation, kept next to the edit so it survives a restart.
#[tauri::command]
fn load_chat(folder: String) -> Value {
    read_json(&PathBuf::from(folder).join("chat.json")).unwrap_or(Value::Null)
}

#[tauri::command]
fn save_chat(folder: String, chat: Value) -> Result<(), String> {
    let dir = PathBuf::from(&folder);
    let tmp = dir.join(".chat.json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(&chat).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::rename(&tmp, dir.join("chat.json")).map_err(|e| e.to_string())
}

#[tauri::command]
fn launch_file(launch: tauri::State<Launch>) -> Option<String> {
    launch.0.lock().unwrap().take()
}

/// Where the player loads a recording from (see server.rs).
#[tauri::command]
fn video_url(server: tauri::State<server::Server>, path: String) -> String {
    server.url(Path::new(&path))
}

/// Opens a GitHub page in the browser (the update key steps link there).
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://github.com/") {
        return Err("Only GitHub links open from here.".into());
    }
    tools::command("open").arg(url).status().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn reveal(path: String) -> Result<(), String> {
    tools::reveal(Path::new(&path))
}

/// Whether there's a newer build to install (see update.rs).
#[tauri::command]
async fn check_update(app: tauri::AppHandle) -> Result<Value, String> {
    let current = update::build_number(&app.package_info().version.to_string());
    let found = tauri::async_runtime::spawn_blocking(move || update::check(current)).await.map_err(|e| e.to_string())??;
    Ok(serde_json::json!({ "keySet": update::key().is_some(), "current": current, "available": found }))
}

#[tauri::command]
async fn set_update_key(key: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || update::set_key(&key)).await.map_err(|e| e.to_string())?
}

/// Downloads the newer build, swaps it in and restarts into it.
#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    let current = update::build_number(&app.package_info().version.to_string());
    let target = tauri::async_runtime::spawn_blocking(move || {
        let found = update::check(current)?.ok_or("You're already on the newest build.")?;
        update::install(&found)
    })
    .await
    .map_err(|e| e.to_string())??;
    update::relaunch(&target);
    app.exit(0);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `Roughcut --mcp <folder> <duration>`: serve the edit to Claude and exit.
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--mcp") {
        let folder = PathBuf::from(args.get(2).cloned().unwrap_or_default());
        let duration = args.get(3).and_then(|d| d.parse().ok()).unwrap_or(0.0);
        return mcp::serve(folder, duration);
    }
    // Write any crash's cause where it can be found later.
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let dir = PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join("Library/Logs/Roughcut");
        let _ = fs::create_dir_all(&dir);
        if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(dir.join("crash.log")) {
            use std::io::Write;
            let _ = writeln!(f, "{info}\n{}", std::backtrace::Backtrace::force_capture());
        }
        default_hook(info);
    }));
    let from_args = std::env::args().skip(1).find(|a| Path::new(a).is_file());
    tauri::Builder::default()
        .manage(Launch(Mutex::new(from_args)))
        .manage(claude::Running::default())
        .manage(recorder::Recording::default())
        .manage(server::Server::start().expect("couldn't start the video server"))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            open_recording,
            run_rough_cut,
            load_cut,
            save_edits,
            list_versions,
            load_assets,
            save_assets,
            save_version,
            open_version,
            delete_version,
            probe,
            waveform,
            export,
            reveal,
            launch_file,
            video_url,
            ask_claude,
            stop_claude,
            load_style,
            recording_sources,
            recording_parts,
            render_layout,
            start_recording,
            stop_recording,
            swap_background,
            save_style,
            suggest_rules,
            load_chat,
            save_chat,
            check_update,
            set_update_key,
            install_update,
            open_url
        ])
        .build(tauri::generate_context!())
        .expect("error while starting Roughcut")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = event {
                if let Some(path) = urls.iter().find_map(|u| u.to_file_path().ok()) {
                    let path = path.to_string_lossy().to_string();
                    *app.state::<Launch>().0.lock().unwrap() = Some(path.clone());
                    let _ = app.emit("open-file", path);
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
