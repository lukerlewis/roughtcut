//! Recording: the native roughcut-recorder helper captures the screen, the
//! camera and the mic into a folder (it runs on its own, with a menu bar
//! item, so the editor can close), and this puts the parts together into one
//! video to edit, the camera in a corner of the screen. The parts stay in the
//! folder for other layouts.

use crate::tools;
use serde_json::Value;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::Mutex;

/// The recording in progress: the helper's process id.
#[derive(Default)]
pub struct Recording(pub Mutex<Option<u32>>);

pub fn helper() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("ROUGHCUT_RECORDER").map(PathBuf::from) {
        return p.is_file().then_some(p);
    }
    let p = std::env::current_exe().ok()?.parent()?.join("roughcut-recorder");
    p.is_file().then_some(p)
}

fn missing() -> String {
    "Recording needs the newest Roughcut build: click Update.".into()
}

/// The screens, cameras and microphones to choose from.
pub fn list() -> Result<Value, String> {
    let out = tools::command(helper().ok_or_else(missing)?).arg("list").output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())
}

/// ~/Movies/Roughcut/<date and time>, for a new recording's parts.
pub fn new_folder() -> PathBuf {
    let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    let stamp = crate::edits::now().replace('T', " ").replace(':', ".").trim_end_matches('Z').to_string();
    home.join("Movies/Roughcut").join(format!("Recording {stamp}"))
}

/// Starts recording into `folder`; returns once it's actually recording.
pub fn start(state: &Recording, folder: &Path, screen: Option<&str>, camera: Option<&str>, mic: Option<&str>) -> Result<Child, String> {
    if state.0.lock().unwrap().is_some() {
        return Err("Already recording.".into());
    }
    let mut cmd = tools::command(helper().ok_or_else(missing)?);
    cmd.arg("record").arg(folder);
    for (flag, v) in [("--screen", screen), ("--camera", camera), ("--mic", mic)] {
        if let Some(v) = v {
            cmd.args([flag, v]);
        }
    }
    let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("Couldn't start recording: {e}"))?;
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    match lines.next() {
        Some(Ok(l)) if l.trim() == "recording" => {}
        _ => {
            let mut err = String::new();
            let _ = child.stderr.take().map(|mut e| e.read_to_string(&mut err));
            let _ = child.wait();
            return Err(if err.trim().is_empty() { "The recording didn't start.".into() } else { err.trim().into() });
        }
    }
    Ok(child)
}

/// Asks the recording to stop; it finishes its files and exits.
pub fn stop(state: &Recording) -> Result<(), String> {
    let pid = state.0.lock().unwrap().ok_or("Not recording.")?;
    let ok = tools::command("kill").args(["-INT", &pid.to_string()]).status().map(|s| s.success()).unwrap_or(false);
    if ok {
        Ok(())
    } else {
        Err("Couldn't stop the recording.".into())
    }
}

/// The ffmpeg arguments that put the parts in `info` (recording.json)
/// together: the screen with the camera in a round-cornered square at the
/// bottom right, and the mic's sound. None when there's nothing to combine.
pub fn compose_args(info: &Value) -> Option<Vec<String>> {
    let screen = info.get("screen")?;
    let camera = info.get("camera")?;
    let (w, h) = (screen["width"].as_f64()? as i64, screen["height"].as_f64()? as i64);
    let (w, h) = (w - w % 2, h - h % 2);
    let delay = camera["start"].as_f64()? - screen["start"].as_f64()?;
    let mut args: Vec<String> = vec!["-i".into(), screen["file"].as_str()?.into()];
    if delay >= 0.0 {
        args.extend(["-itsoffset".into(), format!("{delay:.3}")]);
    } else {
        args.extend(["-ss".into(), format!("{:.3}", -delay)]);
    }
    args.extend(["-i".into(), camera["file"].as_str()?.into()]);
    let audio = "[1:a]aresample=async=1:first_pts=0[a]";
    let graph = if camera["video"] == true {
        let size = (h as f64 * 0.28).round() as i64 / 2 * 2;
        let margin = (h as f64 * 0.04).round() as i64;
        format!(
            "[0:v]scale={w}:{h},setsar=1[s];[1:v]crop='min(iw,ih)':'min(iw,ih)',scale={size}:{size},setsar=1[c];\
             [s][c]overlay={x}:{y}:eof_action=pass[v];{audio}",
            x = w - size - margin,
            y = h - size - margin
        )
    } else {
        format!("[0:v]scale={w}:{h},setsar=1[v];{audio}")
    };
    args.extend(["-filter_complex".into(), graph, "-map".into(), "[v]".into(), "-map".into(), "[a]".into()]);
    Some(args)
}

/// Puts a finished recording's parts together; returns the video to edit.
pub fn compose(folder: &Path) -> Result<PathBuf, String> {
    let text = std::fs::read_to_string(folder.join("recording.json")).map_err(|_| "The recording didn't save.".to_string())?;
    let info: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let Some(args) = compose_args(&info) else {
        // Just one part: edit it as it is.
        let part = info["camera"]["file"].as_str().or(info["screen"]["file"].as_str()).ok_or("Nothing was recorded.")?;
        return Ok(folder.join(part));
    };
    let dest = folder.join("recording.mp4");
    let mut encoders: Vec<Vec<&str>> = Vec::new();
    if cfg!(target_os = "macos") {
        encoders.push(vec!["-c:v", "h264_videotoolbox", "-b:v", "16M"]);
    }
    encoders.push(vec!["-c:v", "libx264", "-preset", "veryfast", "-crf", "18"]);
    let mut last = String::new();
    for video in encoders {
        let out = tools::command(tools::ffmpeg())
            .current_dir(folder)
            .args(["-v", "error", "-y"])
            .args(&args)
            .args(video)
            .args(["-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"])
            .arg(&dest)
            .output()
            .map_err(|e| format!("Couldn't run ffmpeg: {e}"))?;
        if out.status.success() {
            return Ok(dest);
        }
        last = String::from_utf8_lossy(&out.stderr).trim().to_string();
    }
    Err(format!("Couldn't put the recording together: {last}"))
}

/// Waits for the helper to finish, then reports the folder (or why it failed).
pub fn wait(mut child: Child) -> Result<(), String> {
    let mut err = String::new();
    let _ = child.stderr.take().map(|mut e| e.read_to_string(&mut err));
    let status = child.wait().map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(if err.trim().is_empty() { "The recording stopped unexpectedly.".into() } else { err.trim().into() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn puts_screen_and_camera_together() {
        let info = json!({
            "screen": { "file": "screen.mov", "start": 100.0, "width": 2940.0, "height": 1912.0 },
            "camera": { "file": "camera.mov", "start": 100.25, "video": true },
        });
        let args = compose_args(&info).unwrap();
        assert_eq!(&args[..6], ["-i", "screen.mov", "-itsoffset", "0.250", "-i", "camera.mov"]);
        let graph = &args[7];
        assert!(graph.contains("scale=534:534"), "{graph}");
        assert!(graph.contains("overlay=2330:1302"), "{graph}");
        let early = json!({ "screen": info["screen"], "camera": { "file": "camera.mov", "start": 99.5, "video": false } });
        let args = compose_args(&early).unwrap();
        assert_eq!(&args[2..4], ["-ss", "0.500"]);
        assert!(args[7].starts_with("[0:v]scale=2940:1912,setsar=1[v];"));
        assert!(compose_args(&json!({ "camera": { "file": "camera.mov", "start": 1.0 } })).is_none());
    }

    /// Puts real parts together with ffmpeg.
    #[test]
    fn composes_with_ffmpeg() {
        let dir = std::env::temp_dir().join("roughcut-recorder-test");
        std::fs::create_dir_all(&dir).unwrap();
        let make = |args: &[&str]| {
            let ok = tools::command(tools::ffmpeg()).current_dir(&dir).args(["-v", "error", "-y"]).args(args).status().unwrap().success();
            assert!(ok);
        };
        make(&["-f", "lavfi", "-i", "testsrc2=size=640x400:rate=30", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "screen.mov"]);
        make(&["-f", "lavfi", "-i", "testsrc=size=320x240:rate=30", "-f", "lavfi", "-i", "sine", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "camera.mov"]);
        let info = json!({
            "screen": { "file": "screen.mov", "start": 10.0, "width": 640.0, "height": 400.0 },
            "camera": { "file": "camera.mov", "start": 10.2, "video": true },
        });
        std::fs::write(dir.join("recording.json"), info.to_string()).unwrap();
        let out = compose(&dir).unwrap();
        let probe = crate::media::probe(&out).unwrap();
        assert_eq!((probe.width, probe.height), (640, 400));
        assert!(probe.audio);
        std::fs::remove_dir_all(&dir).ok();
    }
}

/// A recording made in Roughcut: its folder's recording.json, with the
/// clicks read in. None for videos from elsewhere.
pub fn parts(source: &Path) -> Option<(PathBuf, Value)> {
    let dir = source.parent()?.to_path_buf();
    let mut info: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("recording.json")).ok()?).ok()?;
    let clicks = info["clicks"].as_str().and_then(|f| std::fs::read_to_string(dir.join(f)).ok()).and_then(|t| serde_json::from_str::<Value>(&t).ok());
    info["clicks"] = clicks.unwrap_or(Value::Array(vec![]));
    Some((dir, info))
}

#[cfg(test)]
pub const LAYOUTS: [&str; 3] = ["camera", "screen", "side"];

/// ffmpeg arguments rendering source seconds start..end of a Roughcut
/// recording (times as in the put-together video, which follows the screen)
/// in another layout: the camera full frame, the screen alone, or the two
/// side by side. Paths are relative to the recording's folder.
pub fn layout_args(info: &Value, start: f64, end: f64, mode: &str) -> Result<Vec<String>, String> {
    let screen = info.get("screen").ok_or("This recording has no screen part.")?;
    let camera = info.get("camera").ok_or("This recording has no camera part.")?;
    if mode != "screen" && camera["video"] != true {
        return Err("This recording has no camera picture.".into());
    }
    let (w, h) = (screen["width"].as_f64().unwrap_or(1920.0) as i64, screen["height"].as_f64().unwrap_or(1080.0) as i64);
    let (w, h) = (w - w % 2, h - h % 2);
    let delay = camera["start"].as_f64().unwrap_or(0.0) - screen["start"].as_f64().unwrap_or(0.0);
    let len = end - start;
    let cam_at = start - delay; // where this stretch is in camera.mov
    let mut args: Vec<String> = vec!["-ss".into(), format!("{:.3}", start.max(0.0)), "-t".into(), format!("{len:.3}"), "-i".into(), screen["file"].as_str().unwrap_or("screen.mov").into()];
    let cam_len = len - (-cam_at).max(0.0);
    args.extend(["-ss".into(), format!("{:.3}", cam_at.max(0.0)), "-t".into(), format!("{cam_len:.3}"), "-i".into(), camera["file"].as_str().unwrap_or("camera.mov").into()]);
    // Camera footage before the camera started is held on its first frame.
    let lead = if cam_at < 0.0 { format!(",tpad=start_duration={:.3}:start_mode=clone", -cam_at) } else { String::new() };
    let audio = if cam_at < 0.0 { format!("[1:a]adelay={0}|{0},aresample=48000[a]", (-cam_at * 1000.0).round()) } else { "[1:a]aresample=48000[a]".into() };
    let fill = |cw: i64, ch: i64| format!("scale={cw}:{ch}:force_original_aspect_ratio=increase,crop={cw}:{ch},setsar=1");
    let graph = match mode {
        "camera" => format!("[1:v]{}{lead}[v];{audio}", fill(w, h)),
        "screen" => format!("[0:v]scale={w}:{h},setsar=1[v];{audio}"),
        "side" => {
            let sw = (w as f64 * 0.64) as i64 / 2 * 2;
            format!(
                "[0:v]scale={sw}:{h}:force_original_aspect_ratio=decrease,pad={sw}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1[s];[1:v]{}{lead}[c];[s][c]hstack=inputs=2[v];{audio}",
                fill(w - sw, h)
            )
        }
        other => return Err(format!("Unknown layout `{other}`: use camera, screen or side.")),
    };
    args.extend(["-filter_complex".into(), graph, "-map".into(), "[v]".into(), "-map".into(), "[a]".into(), "-t".into(), format!("{len:.3}")]);
    Ok(args)
}

/// Renders a layout clip into the project's clips/ folder; returns its path there.
pub fn render_layout(folder: &Path, source: &Path, start: f64, end: f64, mode: &str) -> Result<String, String> {
    let (dir, info) = parts(source).ok_or("Layouts work on videos recorded in Roughcut.")?;
    let args = layout_args(&info, start, end, mode)?;
    std::fs::create_dir_all(folder.join("clips")).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let rel = format!("clips/layout-{stamp}.mp4");
    let dest = folder.join(&rel);
    let mut encoders: Vec<Vec<&str>> = Vec::new();
    if cfg!(target_os = "macos") {
        encoders.push(vec!["-c:v", "h264_videotoolbox", "-b:v", "16M"]);
    }
    encoders.push(vec!["-c:v", "libx264", "-preset", "veryfast", "-crf", "18"]);
    let mut last = String::new();
    for video in encoders {
        let out = tools::command(tools::ffmpeg())
            .current_dir(&dir)
            .args(["-v", "error", "-y"])
            .args(&args)
            .args(video)
            .args(["-r", "30", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k"])
            .arg(&dest)
            .output()
            .map_err(|e| format!("Couldn't run ffmpeg: {e}"))?;
        if out.status.success() {
            return Ok(rel);
        }
        last = String::from_utf8_lossy(&out.stderr).trim().to_string();
    }
    Err(format!("Couldn't make the layout: {last}"))
}

/// Zooms that follow Luke's clicks: one per burst of clicks (clicks under
/// `gap` seconds apart join), from just before the first to a little after
/// the last, centred where he clicked. [(start, end, x, y)] in seconds.
pub fn click_zooms(clicks: &Value, gap: f64) -> Vec<(f64, f64, f64, f64)> {
    let mut out: Vec<(f64, f64, f64, f64, usize)> = vec![];
    for c in clicks.as_array().into_iter().flatten() {
        let (Some(t), Some(x), Some(y)) = (c["t"].as_f64(), c["x"].as_f64(), c["y"].as_f64()) else { continue };
        match out.last_mut() {
            Some(last) if t - last.1 + 2.0 < gap => {
                // Same burst: stretch it, and centre on the clicks' average.
                let n = last.4 as f64;
                *last = (last.0, t + 2.0, (last.2 * n + x) / (n + 1.0), (last.3 * n + y) / (n + 1.0), last.4 + 1);
            }
            _ => out.push(((t - 0.4).max(0.0), t + 2.0, x, y, 1)),
        }
    }
    out.into_iter().map(|(a, b, x, y, _)| (a, b, x.clamp(0.0, 1.0), y.clamp(0.0, 1.0))).collect()
}

#[cfg(test)]
mod layout_tests {
    use super::*;
    use serde_json::json;

    fn info() -> Value {
        json!({
            "screen": { "file": "screen.mov", "start": 10.0, "width": 640.0, "height": 400.0 },
            "camera": { "file": "camera.mov", "start": 10.5, "video": true },
        })
    }

    #[test]
    fn layouts() {
        let a = layout_args(&info(), 2.0, 4.0, "camera").unwrap();
        assert_eq!(&a[..12], ["-ss", "2.000", "-t", "2.000", "-i", "screen.mov", "-ss", "1.500", "-t", "2.000", "-i", "camera.mov"]);
        assert!(a[13].starts_with("[1:v]scale=640:400:force_original_aspect_ratio=increase,crop=640:400"), "{}", a[13]);
        let early = layout_args(&info(), 0.2, 1.0, "side").unwrap();
        assert!(early[13].contains("tpad=start_duration=0.300"), "{}", early[13]);
        assert!(early[13].contains("adelay=300|300"), "{}", early[13]);
        assert!(early[13].contains("hstack"), "{}", early[13]);
        assert!(layout_args(&info(), 0.0, 1.0, "wobble").is_err());
    }

    #[test]
    fn zooms_follow_click_bursts() {
        let clicks = json!([{ "t": 1.0, "x": 0.2, "y": 0.2 }, { "t": 2.5, "x": 0.4, "y": 0.4 }, { "t": 12.0, "x": 0.9, "y": 0.1 }]);
        let z = click_zooms(&clicks, 3.0);
        assert_eq!(z.len(), 2);
        assert!((z[0].0 - 0.6).abs() < 1e-9 && (z[0].1 - 4.5).abs() < 1e-9);
        assert!((z[0].2 - 0.3).abs() < 1e-9);
        assert_eq!(z[1], (11.6, 14.0, 0.9, 0.1));
    }

    /// Renders each layout from real parts with ffmpeg.
    #[test]
    fn renders_layouts() {
        let base = std::env::temp_dir().join("roughcut-layout-test");
        let (dir, folder) = (base.clone(), base.join("recording rough cut"));
        std::fs::create_dir_all(&folder).unwrap();
        let make = |args: &[&str]| assert!(tools::command(tools::ffmpeg()).current_dir(&dir).args(["-v", "error", "-y"]).args(args).status().unwrap().success());
        make(&["-f", "lavfi", "-i", "testsrc2=size=640x400:rate=30", "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "screen.mov"]);
        make(&["-f", "lavfi", "-i", "testsrc=size=320x240:rate=30", "-f", "lavfi", "-i", "sine", "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "camera.mov"]);
        std::fs::write(dir.join("recording.json"), info().to_string()).unwrap();
        for mode in LAYOUTS {
            let rel = render_layout(&folder, &dir.join("recording.mp4"), 0.2, 2.2, mode).unwrap();
            let p = crate::media::probe(&folder.join(&rel)).unwrap();
            assert_eq!((p.width, p.height), (640, 400), "{mode}");
            assert!((p.duration - 2.0).abs() < 0.15, "{mode} {}", p.duration);
            assert!(p.audio, "{mode}");
        }
        std::fs::remove_dir_all(&base).ok();
    }
}
