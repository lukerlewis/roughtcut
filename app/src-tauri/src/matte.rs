//! Background swap: the native roughcut-matte helper (Apple's Vision person
//! segmentation, on the Mac) renders part of the recording with a new
//! background into the project's clips/ folder, as a clip with settings
//! Luke can change and re-render.

use crate::tools;
use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;

/// Inside the app next to Roughcut itself, or $ROUGHCUT_MATTE.
pub fn helper() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("ROUGHCUT_MATTE").map(PathBuf::from) {
        return p.is_file().then_some(p);
    }
    let exe = std::env::current_exe().ok()?;
    let p = exe.parent()?.join("roughcut-matte");
    p.is_file().then_some(p)
}

/// The helper's background argument from a clip's settings:
/// {mode: blur|color|image, strength, color, image}.
pub fn background_arg(b: &Value) -> Result<String, String> {
    match b["mode"].as_str().unwrap_or("blur") {
        "blur" => Ok(format!("blur:{:.0}", b["strength"].as_f64().unwrap_or(30.0).clamp(2.0, 120.0))),
        "color" => {
            let c = b["color"].as_str().unwrap_or("#1f1f1f");
            let ok = c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|ch| ch.is_ascii_hexdigit());
            if ok {
                Ok(format!("color:{c}"))
            } else {
                Err("The colour must look like #1f1f1f.".into())
            }
        }
        "image" => match b["image"].as_str() {
            Some(p) if Path::new(p).is_file() => Ok(format!("image:{p}")),
            _ => Err("Pick a picture for the background.".into()),
        },
        other => Err(format!("Unknown background `{other}`: use blur, color or image.")),
    }
}

/// Renders source seconds start..end of `recording` with the new background
/// into `<folder>/clips/<name>`, returning that relative path.
pub fn render(folder: &Path, recording: &Path, start: f64, end: f64, background: &Value, progress: impl Fn(f64)) -> Result<String, String> {
    let helper = helper().ok_or("Background swap needs the newest Roughcut build: click Update.")?;
    let arg = background_arg(background)?;
    std::fs::create_dir_all(folder.join("clips")).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let rel = format!("clips/background-{stamp}.mp4");
    let mut child = tools::command(&helper)
        .arg(recording)
        .args([format!("{start:.3}"), format!("{end:.3}")])
        .arg(folder.join(&rel))
        .arg(arg)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't start the background swap: {e}"))?;
    let mut last = String::new();
    for line in BufReader::new(child.stderr.take().unwrap()).lines().map_while(Result::ok) {
        match line.strip_prefix("progress ").and_then(|p| p.trim().parse::<f64>().ok()) {
            Some(p) => progress(p),
            None => last = line,
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(if last.is_empty() { "The background swap stopped.".into() } else { last });
    }
    Ok(rel)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn background_args() {
        assert_eq!(background_arg(&json!({ "mode": "blur", "strength": 500 })).unwrap(), "blur:120");
        assert_eq!(background_arg(&json!({ "mode": "color", "color": "#00ff88" })).unwrap(), "color:#00ff88");
        assert!(background_arg(&json!({ "mode": "color", "color": "green" })).is_err());
        assert!(background_arg(&json!({ "mode": "image", "image": "/nope.png" })).is_err());
    }
}
