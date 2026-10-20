//! Updates from Luke's private GitHub repo. Every CI build is published as a
//! release named `build-<n>` with the app zipped. Roughcut asks GitHub for the
//! latest one with a read-only key Luke keeps in his Keychain, downloads it
//! itself and swaps the app in place. Files an app downloads for itself
//! aren't quarantined, so macOS opens the new build without a warning.
//! Everything goes through the Mac's own `curl`, `ditto` and `security`.

use crate::tools;
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;

const REPO: &str = "lukerlewis/roughtcut";
const KEYCHAIN: [&str; 4] = ["-s", "Roughcut updates", "-a", "github"];
const ASSET: &str = "Roughcut.zip";

#[derive(Serialize, Debug, PartialEq)]
pub struct Available {
    pub build: u64,
    pub notes: String,
    #[serde(skip)]
    pub asset: String,
}

/// The build number of a version like 0.1.42 or a tag like build-42.
pub fn build_number(s: &str) -> u64 {
    s.rsplit(['.', '-']).next().and_then(|n| n.parse().ok()).unwrap_or(0)
}

/// The newest release, if it is newer than `current` and has the app.
pub fn newer(release: &Value, current: u64) -> Option<Available> {
    let build = build_number(release["tag_name"].as_str()?);
    let asset = release["assets"].as_array()?.iter().find(|a| a["name"] == ASSET)?;
    (build > current).then(|| Available {
        build,
        notes: release["body"].as_str().unwrap_or("").lines().next().unwrap_or("").to_string(),
        asset: asset["url"].as_str().unwrap_or("").to_string(),
    })
}

pub fn key() -> Option<String> {
    let out = tools::command("security").arg("find-generic-password").args(KEYCHAIN).arg("-w").output().ok()?;
    let key = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !key.is_empty()).then_some(key)
}

pub fn set_key(key: &str) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        let _ = tools::command("security").arg("delete-generic-password").args(KEYCHAIN).output();
        return Ok(());
    }
    // Check it works before keeping it.
    api(key, &format!("https://api.github.com/repos/{REPO}"), None)?;
    let ok = tools::command("security")
        .arg("add-generic-password")
        .arg("-U")
        .args(KEYCHAIN)
        .args(["-w", key])
        .status()
        .map_err(|e| e.to_string())?;
    ok.success().then_some(()).ok_or_else(|| "Couldn't save the key in your Keychain.".into())
}

/// Calls GitHub with the key, which goes to curl on stdin rather than on its
/// command line. With `save_to`, downloads a release asset there instead.
fn api(key: &str, url: &str, save_to: Option<&Path>) -> Result<Vec<u8>, String> {
    let mut cmd = tools::command("curl");
    cmd.args(["-sSL", "--fail-with-body", "--max-time", "600", "-H", "@-", "-H", "X-GitHub-Api-Version: 2022-11-28"]);
    match save_to {
        Some(path) => cmd.args(["-H", "Accept: application/octet-stream", "-o"]).arg(path),
        None => cmd.args(["-H", "Accept: application/vnd.github+json"]),
    };
    let mut child = cmd
        .arg(url)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't run curl: {e}"))?;
    child.stdin.take().unwrap().write_all(format!("Authorization: Bearer {key}\n").as_bytes()).map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        return Ok(out.stdout);
    }
    let body = String::from_utf8_lossy(&out.stdout);
    let err = String::from_utf8_lossy(&out.stderr);
    if body.contains("Bad credentials") || err.contains("401") {
        return Err("GitHub didn't accept your key. Make a new one and paste it in again.".into());
    }
    if err.contains("404") || body.contains("Not Found") {
        return Err("GitHub couldn't find Roughcut's builds with this key. Check the key can read the roughtcut repository.".into());
    }
    Err(format!("Couldn't reach GitHub: {}", err.trim()))
}

pub fn check(current: u64) -> Result<Option<Available>, String> {
    let Some(key) = key() else { return Ok(None) };
    let json = api(&key, &format!("https://api.github.com/repos/{REPO}/releases/latest"), None)?;
    let release: Value = serde_json::from_slice(&json).map_err(|e| e.to_string())?;
    Ok(newer(&release, current))
}

/// The .app this is running from, e.g. /Applications/Roughcut.app.
pub fn bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let app = exe.parent()?.parent()?.parent()?; // Contents/MacOS/roughcut
    (app.extension()? == "app").then(|| app.to_path_buf())
}

/// Downloads the build and puts it where this app is. The caller restarts.
pub fn install(update: &Available) -> Result<PathBuf, String> {
    let key = key().ok_or("Paste your GitHub key first.")?;
    let target = bundle().ok_or("Roughcut can only update itself when it's opened from its .app.")?;
    let tmp = std::env::temp_dir().join(format!("roughcut-update-{}", update.build));
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let zip = tmp.join(ASSET);
    api(&key, &update.asset, Some(&zip))?;
    let ok = tools::command("ditto").args(["-x", "-k"]).arg(&zip).arg(&tmp).status().map_err(|e| e.to_string())?;
    if !ok.success() {
        return Err("The download wasn't a complete app. Try again.".into());
    }
    let new = tmp.join("Roughcut.app");
    if !new.join("Contents/MacOS").is_dir() {
        return Err("The download wasn't a complete app. Try again.".into());
    }
    replace(&new, &target)?;
    let _ = fs::remove_dir_all(&tmp);
    Ok(target)
}

/// Swaps `new` in for `target`, keeping the old one until the new one is in
/// place so a failure leaves a working app.
pub fn replace(new: &Path, target: &Path) -> Result<(), String> {
    let parent = target.parent().ok_or("No folder")?;
    let staged = parent.join(".Roughcut-update.app");
    let old = parent.join(".Roughcut-old.app");
    let _ = fs::remove_dir_all(&staged);
    let _ = fs::remove_dir_all(&old);
    let copied = tools::command("ditto").arg(new).arg(&staged).status();
    if !copied.is_ok_and(|s| s.success()) {
        let _ = fs::remove_dir_all(&staged);
        return Err(format!("Couldn't write to {}. Is it in a folder you can change?", parent.display()));
    }
    fs::rename(target, &old).map_err(|e| format!("Couldn't move the old app aside: {e}"))?;
    if let Err(e) = fs::rename(&staged, target) {
        let _ = fs::rename(&old, target);
        return Err(format!("Couldn't put the new app in place: {e}"));
    }
    let _ = fs::remove_dir_all(&old);
    Ok(())
}

/// Opens the app again once this one has quit.
pub fn relaunch(target: &Path) {
    let _ = tools::command("/bin/sh")
        .arg("-c")
        .arg("sleep 1; open \"$0\"")
        .arg(target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn finds_a_newer_build() {
        assert_eq!(build_number("0.1.42"), 42);
        assert_eq!(build_number("build-7"), 7);
        assert_eq!(build_number("0.1.0"), 0);
        let release = json!({
            "tag_name": "build-12",
            "body": "Editor: zooms\n\nmore",
            "assets": [{"name": "Roughcut.dmg", "url": "x"}, {"name": "Roughcut.zip", "url": "https://api.github.com/a/1"}]
        });
        assert_eq!(
            newer(&release, 11),
            Some(Available { build: 12, notes: "Editor: zooms".into(), asset: "https://api.github.com/a/1".into() })
        );
        assert_eq!(newer(&release, 12), None);
        assert_eq!(newer(&json!({"tag_name": "build-13", "assets": []}), 1), None);
    }

    #[test]
    fn replaces_the_app_in_place() {
        if tools::command("ditto").arg("--help").output().is_err() {
            eprintln!("skipping: no ditto");
            return;
        }
        let dir = std::env::temp_dir().join(format!("roughcut-replace-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("new/Roughcut.app/Contents/MacOS")).unwrap();
        fs::write(dir.join("new/Roughcut.app/Contents/MacOS/roughcut"), "new").unwrap();
        fs::create_dir_all(dir.join("Applications/Roughcut.app/Contents/MacOS")).unwrap();
        fs::write(dir.join("Applications/Roughcut.app/Contents/MacOS/roughcut"), "old").unwrap();
        let target = dir.join("Applications/Roughcut.app");
        replace(&dir.join("new/Roughcut.app"), &target).unwrap();
        assert_eq!(fs::read_to_string(target.join("Contents/MacOS/roughcut")).unwrap(), "new");
        assert_eq!(fs::read_dir(dir.join("Applications")).unwrap().count(), 1);
        fs::remove_dir_all(&dir).ok();
    }
}
