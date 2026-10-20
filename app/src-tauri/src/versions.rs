//! Versions: named snapshots of the edit ("Claude cut", "tighter", "Hook 2")
//! kept in the project's versions/ folder, to switch between or branch from.

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

fn dir(folder: &Path) -> PathBuf {
    folder.join("versions")
}

/// Each version's id, name, when, who saved it and how long the cut is, oldest first.
pub fn list(folder: &Path) -> Vec<Value> {
    let mut out: Vec<Value> = fs::read_dir(dir(folder))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|f| f.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|f| {
            let v: Value = serde_json::from_str(&fs::read_to_string(f.path()).ok()?).ok()?;
            let id = f.path().file_stem()?.to_string_lossy().to_string();
            Some(json!({ "id": id, "name": v["name"], "at": v["at"], "by": v["by"], "length": v["length"], "note": v["note"] }))
        })
        .collect();
    out.sort_by(|a, b| a["at"].as_str().cmp(&b["at"].as_str()));
    out
}

fn slug(name: &str) -> String {
    let s: String = name.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    let s = s.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-");
    if s.is_empty() { "version".into() } else { s.chars().take(40).collect() }
}

/// Saves the edit under a name. A version with the same name is replaced.
pub fn save(folder: &Path, name: &str, edits: &Value, length: f64, by: &str, note: Option<&str>) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Give the version a name.".into());
    }
    fs::create_dir_all(dir(folder)).map_err(|e| format!("Couldn't save the version: {e}"))?;
    let id = list(folder)
        .into_iter()
        .find(|v| v["name"].as_str().map(|n| n.eq_ignore_ascii_case(name)) == Some(true))
        .and_then(|v| v["id"].as_str().map(String::from))
        .unwrap_or_else(|| {
            let base = slug(name);
            let mut id = base.clone();
            let mut n = 2;
            while dir(folder).join(format!("{id}.json")).exists() {
                id = format!("{base}-{n}");
                n += 1;
            }
            id
        });
    let v = json!({ "name": name, "at": crate::edits::now(), "by": by, "length": (length * 100.0).round() / 100.0, "note": note, "edits": edits });
    fs::write(dir(folder).join(format!("{id}.json")), serde_json::to_string_pretty(&v).unwrap()).map_err(|e| format!("Couldn't save the version: {e}"))?;
    Ok(id)
}

/// The edit saved as `key` (an id or a name).
pub fn load(folder: &Path, key: &str) -> Result<Value, String> {
    let id = list(folder)
        .into_iter()
        .find(|v| v["id"] == key || v["name"].as_str().map(|n| n.eq_ignore_ascii_case(key.trim())) == Some(true))
        .and_then(|v| v["id"].as_str().map(String::from))
        .ok_or_else(|| format!("There's no version called {key}."))?;
    let v: Value = serde_json::from_str(&fs::read_to_string(dir(folder).join(format!("{id}.json"))).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(v["edits"].clone())
}

pub fn remove(folder: &Path, id: &str) -> Result<(), String> {
    if id.contains('/') || id.contains("..") {
        return Err("Not a version.".into());
    }
    fs::remove_file(dir(folder).join(format!("{id}.json"))).map_err(|e| format!("Couldn't delete the version: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_list_load_replace() {
        let folder = std::env::temp_dir().join(format!("roughcut-versions-{}", std::process::id()));
        fs::create_dir_all(&folder).unwrap();
        let a = save(&folder, "Claude cut", &json!({ "agent": [1] }), 61.234, "agent", None).unwrap();
        save(&folder, "Tighter", &json!({ "agent": [2] }), 50.0, "you", Some("shorter intro")).unwrap();
        assert_eq!(a, "claude-cut");
        assert_eq!(list(&folder).len(), 2);
        assert_eq!(list(&folder)[0]["length"], 61.23);
        assert_eq!(load(&folder, "tighter").unwrap()["agent"][0], 2);
        // Same name replaces it.
        save(&folder, "claude cut", &json!({ "agent": [3] }), 60.0, "you", None).unwrap();
        assert_eq!(list(&folder).len(), 2);
        assert_eq!(load(&folder, "claude-cut").unwrap()["agent"][0], 3);
        remove(&folder, "claude-cut").unwrap();
        assert_eq!(list(&folder).len(), 1);
        assert!(remove(&folder, "../edits").is_err());
        fs::remove_dir_all(&folder).ok();
    }
}
