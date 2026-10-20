//! Luke's assets: title cards and other text he saved to reuse in any video,
//! kept next to his style (one file for every project).

use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

pub fn path() -> PathBuf {
    crate::style::path().with_file_name("assets.json")
}

pub fn load() -> Value {
    let v = fs::read_to_string(path()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).unwrap_or(json!([]));
    if v.is_array() {
        v
    } else {
        json!([])
    }
}

pub fn save(assets: &Value) -> Result<(), String> {
    if !assets.is_array() {
        return Err("Assets must be a list.".into());
    }
    let p = path();
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Couldn't save your assets: {e}"))?;
    }
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(assets).unwrap()).map_err(|e| format!("Couldn't save your assets: {e}"))?;
    fs::rename(&tmp, &p).map_err(|e| format!("Couldn't save your assets: {e}"))
}

/// Copies an image into the assets folder, so the asset keeps working if the
/// original moves. Returns the copy's path.
pub fn import_image(src: &std::path::Path) -> Result<PathBuf, String> {
    let dir = path().with_file_name("assets");
    fs::create_dir_all(&dir).map_err(|e| format!("Couldn't keep the image: {e}"))?;
    let name = src.file_name().ok_or("That isn't a file.")?.to_string_lossy().to_string();
    let mut dest = dir.join(&name);
    let mut n = 2;
    while dest.exists() {
        let stem = std::path::Path::new(&name).file_stem().unwrap_or_default().to_string_lossy().to_string();
        let ext = std::path::Path::new(&name).extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
        dest = dir.join(format!("{stem} {n}{ext}"));
        n += 1;
    }
    fs::copy(src, &dest).map_err(|e| format!("Couldn't keep the image: {e}"))?;
    Ok(dest)
}

/// The asset called `name` (case doesn't matter).
pub fn find(name: &str) -> Option<Value> {
    load().as_array()?.iter().find(|a| a["name"].as_str().map(|n| n.eq_ignore_ascii_case(name.trim())) == Some(true)).cloned()
}

/// "Name (lower-third: “Luke Lewis”)" for each asset, for Claude.
pub fn describe() -> String {
    load()
        .as_array()
        .into_iter()
        .flatten()
        .map(|a| format!("\"{}\" ({}: \"{}\")", a["name"].as_str().unwrap_or(""), a["style"].as_str().unwrap_or("title"), a["text"].as_str().unwrap_or("")))
        .collect::<Vec<_>>()
        .join(", ")
}
