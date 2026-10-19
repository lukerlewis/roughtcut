//! Finding the programs Roughcut runs. An app opened from Finder gets a bare
//! PATH without Homebrew, so we add the usual places ourselves.

use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

fn home() -> PathBuf {
    env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

/// PATH with Homebrew and Claude Code's install folder in front.
pub fn path_var() -> String {
    let mut parts: Vec<String> = vec![
        "/opt/homebrew/bin".into(),
        "/usr/local/bin".into(),
        home().join(".local/bin").to_string_lossy().into(),
    ];
    if let Ok(p) = env::var("PATH") {
        parts.push(p);
    }
    parts.push("/usr/bin:/bin:/usr/sbin:/sbin".into());
    parts.join(":")
}

pub fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut c = Command::new(program);
    c.env("PATH", path_var());
    c
}

fn on_path(name: &str) -> Option<PathBuf> {
    path_var().split(':').map(|d| Path::new(d).join(name)).find(|p| p.is_file())
}

/// The `roughcut` CLI: $ROUGHCUT_CLI, then the setup's virtualenv in the
/// Roughcut folder in the home folder, then anything on PATH.
pub fn roughcut_cli() -> Option<PathBuf> {
    if let Some(p) = env::var_os("ROUGHCUT_CLI").map(PathBuf::from) {
        if p.is_file() {
            return Some(p);
        }
    }
    let home = home();
    let mut candidates: Vec<PathBuf> = std::fs::read_dir(&home)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().to_lowercase().starts_with("rough")))
        .map(|p| p.join(".venv/bin/roughcut"))
        .filter(|p| p.is_file())
        .collect();
    candidates.sort();
    candidates.into_iter().next().or_else(|| on_path("roughcut"))
}

/// Claude Code's `claude` command: the native installer's ~/.local/bin, the
/// older ~/.claude/local, then anything on PATH.
pub fn claude() -> Option<PathBuf> {
    if let Some(p) = env::var_os("ROUGHCUT_CLAUDE").map(PathBuf::from) {
        if p.is_file() {
            return Some(p);
        }
    }
    let local = home().join(".claude/local/claude");
    on_path("claude").or_else(|| local.is_file().then_some(local))
}

pub fn ffmpeg() -> PathBuf {
    on_path("ffmpeg").unwrap_or_else(|| "ffmpeg".into())
}

pub fn ffprobe() -> PathBuf {
    on_path("ffprobe").unwrap_or_else(|| "ffprobe".into())
}

/// Shows the file in Finder.
pub fn reveal(path: &Path) -> Result<(), String> {
    let status = if cfg!(target_os = "macos") {
        command("open").arg("-R").arg(path).status()
    } else {
        command("xdg-open").arg(path.parent().unwrap_or(path)).status()
    };
    status.map(|_| ()).map_err(|e| e.to_string())
}
