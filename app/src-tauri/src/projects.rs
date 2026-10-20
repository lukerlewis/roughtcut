//! Luke's projects: the recordings he's edited, newest first, so the start
//! screen can list them and the app can reopen the last one. A project is a
//! recording plus its "<name> rough cut" folder, where every change is saved;
//! this list only remembers where they are, in Application Support beside
//! his style.

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const MOST: usize = 30;

fn path() -> PathBuf {
    if let Some(p) = std::env::var_os("ROUGHCUT_PROJECTS") {
        return p.into();
    }
    crate::style::path().with_file_name("projects.json")
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn read() -> Vec<Value> {
    fs::read_to_string(path()).ok().and_then(|t| serde_json::from_str::<Vec<Value>>(&t).ok()).unwrap_or_default()
}

fn write(list: &[Value]) -> Result<(), String> {
    let p = path();
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(list).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

/// When the project's edits were last saved, if they have been.
fn saved_at(folder: &Path) -> Option<u64> {
    let m = fs::metadata(folder.join("edits.json")).ok()?.modified().ok()?;
    m.duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs())
}

/// The projects whose recordings are still there, newest first, each with
/// its name, rough-cut folder, when it was opened and last saved.
pub fn list() -> Vec<Value> {
    read()
        .into_iter()
        .filter_map(|p| {
            let source = PathBuf::from(p["source"].as_str()?);
            if !source.is_file() {
                return None;
            }
            let folder = crate::cut_folder(&source);
            let name = source.file_stem()?.to_string_lossy().to_string();
            Some(json!({
                "source": source,
                "name": name,
                "folder": folder,
                "opened": p["opened"].as_u64().unwrap_or(0),
                "saved": saved_at(&folder),
            }))
        })
        .collect()
}

/// Puts a recording at the top of the list.
pub fn remember(source: &str) -> Result<(), String> {
    let mut list = read();
    list.retain(|p| p["source"].as_str() != Some(source));
    list.insert(0, json!({ "source": source, "opened": now() }));
    list.truncate(MOST);
    write(&list)
}

/// Takes a recording off the list (its files stay where they are).
pub fn forget(source: &str) -> Result<(), String> {
    let mut list = read();
    list.retain(|p| p["source"].as_str() != Some(source));
    write(&list)
}

/// What deleting a project puts in the Trash: a recording made in Roughcut
/// goes with its whole folder (its parts and edits); for a video from
/// elsewhere only the edits go, and the video stays where Luke keeps it.
pub fn deletable(source: &Path) -> PathBuf {
    match crate::recorder::parts(source) {
        Some((dir, _)) => dir,
        None => crate::cut_folder(source),
    }
}

/// Moves a project to the Trash, where Luke can still get it back, and takes
/// it off the list.
pub fn delete(source: &str) -> Result<(), String> {
    let target = deletable(Path::new(source));
    if target.exists() {
        trash(&target)?;
    }
    forget(source)
}

#[cfg(target_os = "macos")]
fn trash(path: &Path) -> Result<(), String> {
    // Foundation's own "move to Trash" (as Finder does it, with Put Back),
    // run through osascript so the app needs nothing extra.
    const SCRIPT: &str = "function run(argv) { ObjC.import('Foundation');         const ok = $.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(argv[0]), null, null);         if (!ok) throw new Error('not moved'); }";
    let out = std::process::Command::new("/usr/bin/osascript").args(["-l", "JavaScript", "-e", SCRIPT]).arg(path).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("Couldn't move {} to the Trash.", path.display()))
    }
}

#[cfg(not(target_os = "macos"))]
fn trash(path: &Path) -> Result<(), String> {
    let bin = std::env::var_os("ROUGHCUT_TRASH").map(PathBuf::from).ok_or("No Trash here.")?;
    fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
    fs::rename(path, bin.join(path.file_name().unwrap_or_default())).map_err(|e| e.to_string())
}

/// A still from near the start of the recording, for the project's card.
pub fn thumbnail(source: &Path) -> Result<PathBuf, String> {
    let folder = crate::cut_folder(source);
    let out = folder.join("thumbnail.jpg");
    if out.is_file() {
        return Ok(out);
    }
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let status = std::process::Command::new(crate::tools::ffmpeg())
        .args(["-v", "error", "-ss", "1", "-i"])
        .arg(source)
        .args(["-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", "-y"])
        .arg(&out)
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() && out.is_file() {
        Ok(out)
    } else {
        Err("No picture for this one.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remembers_projects_newest_first() {
        let d = std::env::temp_dir().join(format!("roughcut-projects-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        std::env::set_var("ROUGHCUT_PROJECTS", d.join("projects.json"));
        let (a, b) = (d.join("a.mov"), d.join("b.mov"));
        fs::write(&a, "").unwrap();
        fs::write(&b, "").unwrap();
        assert!(list().is_empty());

        remember(a.to_str().unwrap()).unwrap();
        remember(b.to_str().unwrap()).unwrap();
        remember(a.to_str().unwrap()).unwrap();
        let all = list();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0]["name"], "a");
        assert_eq!(all[0]["folder"], d.join("a rough cut").to_str().unwrap());
        assert_eq!(all[0]["saved"], Value::Null);

        // Saved edits show when they were saved.
        fs::create_dir_all(d.join("a rough cut")).unwrap();
        fs::write(d.join("a rough cut/edits.json"), "{}").unwrap();
        assert!(list()[0]["saved"].as_u64().unwrap() > 0);

        // Deleting a video from elsewhere bins its edits and keeps the video.
        std::env::set_var("ROUGHCUT_TRASH", d.join("trash"));
        delete(a.to_str().unwrap()).unwrap();
        assert!(a.is_file());
        assert!(!d.join("a rough cut").exists());
        assert!(d.join("trash/a rough cut/edits.json").is_file());
        assert_eq!(list().len(), 1);

        // A moved recording drops off.
        fs::remove_file(&b).unwrap();
        assert!(list().is_empty());
        std::env::remove_var("ROUGHCUT_PROJECTS");
        std::env::remove_var("ROUGHCUT_TRASH");
        let _ = fs::remove_dir_all(&d);
    }
}
