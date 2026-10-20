//! The sidebar's conversation with Claude: runs the official `claude` CLI on
//! Luke's plan (`claude -p`), with this app as its MCP server for the edit,
//! and streams what Claude does back to the window as "claude-event"s.

use crate::tools;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, Stdio};
use std::sync::Mutex;

/// The run in progress, so Stop can end it.
#[derive(Default)]
pub struct Running(pub Mutex<Option<Child>>);

pub const TOOLS: [&str; 32] = [
    "mcp__roughcut__get_edit",
    "mcp__roughcut__cut_words",
    "mcp__roughcut__restore_words",
    "mcp__roughcut__zoom_in",
    "mcp__roughcut__remove_zoom",
    "mcp__roughcut__set_captions",
    "mcp__roughcut__add_clip",
    "mcp__roughcut__remove_clip",
    "mcp__roughcut__add_text",
    "mcp__roughcut__remove_text",
    "mcp__roughcut__resolve_note",
    "mcp__roughcut__add_note",
    "mcp__roughcut__add_rule",
    "mcp__roughcut__speed_up",
    "mcp__roughcut__blur",
    "mcp__roughcut__remove_effect",
    "mcp__roughcut__set_voice",
    "mcp__roughcut__swap_background",
    "mcp__roughcut__set_layout",
    "mcp__roughcut__zoom_to_clicks",
    "mcp__roughcut__cut_retakes",
    "mcp__roughcut__save_version",
    "mcp__roughcut__add_asset",
    "mcp__roughcut__open_version",
    "mcp__roughcut__list_graphics",
    "mcp__roughcut__graphics_guide",
    "mcp__roughcut__add_graphic",
    "mcp__roughcut__get_graphic",
    "mcp__roughcut__update_graphic",
    "mcp__roughcut__remove_graphic",
    "mcp__roughcut__list_skills",
    "mcp__roughcut__save_skill",
];

/// Built-in tools for making clips: FFmpeg and Python to render them, and
/// Read to look at a frame. Anything else Claude tries is refused.
const MAKING: [&str; 6] = ["Bash(ffmpeg:*)", "Bash(ffprobe:*)", "Bash(python3:*)", "Bash(mkdir:*)", "Bash(ls:*)", "Read"];

fn brief(recording: &str) -> String {
    let name = Path::new(recording).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    format!(
        "You are Claude inside Roughcut, Luke's video editor, talking with him in the app's sidebar while he watches \
         his video \"{name}\". You can read and change the edit with the roughcut tools: call get_edit first, \
         then cut or restore words, zoom in on words, put titles, lower thirds or callouts on screen (or his saved assets, with add_asset), add motion graphics (add_graphic: a catalogue one from list_graphics filled in, or one you write after reading graphics_guide), speed up or blur stretches, swap the background behind him, change the screen layout or zoom to his clicks (for videos recorded in Roughcut), cut the takes he marked by saying \"cut that\" (cut_retakes), polish the voice, or turn captions on, all by word index. Your cuts and zooms show to Luke in blue as unreviewed until he keeps or restores \
         them, so make the change he asks for rather than describing it, and give each one a reason of a few words. \
         Those edits stay fully adjustable by Luke, so always prefer them.\n\n\
         For anything they can't do (a look or colour change, a background, an effect), you can make a new clip: \
         render it with ffmpeg or python3 from the recording at \"{recording}\" into the clips/ folder here (mkdir -p clips), \
         then put it on the timeline with add_clip. A clip replaces the recording over source seconds start..end: make it exactly that long, \
         the same size and frame rate as the recording, with its audio for that span (unless asked otherwise), as H.264 MP4. \
         Before making one, tell Luke in one sentence that this will be a new clip he can keep, move, trim or delete but not fine-tune afterwards, \
         and end your turn; make it only after he says yes. Use the get_edit times to pick start and end. \
         Never change or delete the recording or any file outside clips/. You can't add music yet: say so plainly if asked.\n\n\
         Luke can pin notes to moments; get_edit lists them. When he sends you notes, deal with each one, then mark it done \
         with resolve_note and a short reply. To point something out for him to decide, leave a note with add_note.\n\n\
         When Luke says to always or never do something in his videos, save it as a rule with add_rule (in his voice, one line), \
         then apply it here too. When he asks to make a way of editing reusable (\"make that a skill\"), save it with save_skill: it becomes \
         a checkbox when he presses Rough cut.\n\n\
         Luke can keep named versions of the edit: save_version saves the current one, open_version switches to one. \
         When he asks for alternatives (other openings, a tighter cut), save each as its own version and finish on the edit he started from.\n\n\
         Don't re-cut anything he restored unless he asks. Luke isn't technical: reply in a sentence or two of plain \
         English, and give times like 00:12 so he can find things."
    )
}

pub fn ask(
    folder: &Path,
    recording: &str,
    duration: f64,
    prompt: &str,
    resume: Option<&str>,
    running: &Running,
    emit: impl Fn(Value),
) -> Result<(), String> {
    let claude = tools::claude().ok_or("Can't find Claude Code. Install it and run `claude` once in Terminal to log in.")?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mcp = json!({ "mcpServers": { "roughcut": {
        "command": exe,
        "args": ["--mcp", folder, duration.to_string()],
        "env": { "ROUGHCUT_RECORDING": recording },
    } } });
    let mut cmd = tools::command(&claude);
    cmd.current_dir(folder)
        .args(["-p", "--model", "opus", "--output-format", "stream-json", "--verbose", "--tools", "Bash,Read"])
        .args(["--strict-mcp-config", "--mcp-config", &mcp.to_string()])
        .args(["--allowedTools", &[&TOOLS[..], &MAKING[..]].concat().join(",")])
        .args(["--append-system-prompt", &format!("{}\n\n{}", brief(recording), crate::style::rules_text(&crate::style::load()))]);
    if let Some(id) = resume {
        cmd.args(["--resume", id]);
    }
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't start Claude: {e}"))?;
    child.stdin.take().unwrap().write_all(prompt.as_bytes()).map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    *running.0.lock().unwrap() = Some(child);

    let mut last_error = None;
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if let Ok(event) = serde_json::from_str::<Value>(&line) {
            if event["type"] == "result" && event["is_error"] == true {
                last_error = event["result"].as_str().map(String::from);
            }
            emit(event);
        }
    }
    let mut err = String::new();
    let _ = stderr.read_to_string(&mut err);
    let child = running.0.lock().unwrap().take();
    let Some(mut child) = child else {
        return Ok(()); // stopped
    };
    let status = child.wait().map_err(|e| e.to_string())?;
    if status.success() && last_error.is_none() {
        return Ok(());
    }
    let detail = last_error.unwrap_or_else(|| err.trim().lines().last().unwrap_or("it stopped unexpectedly").to_string());
    if detail.to_lowercase().contains("login") || detail.to_lowercase().contains("auth") {
        return Err(format!("Claude needs you to log in again: open Terminal, run `claude`, then type /login. ({detail})"));
    }
    Err(format!("Claude stopped: {detail}"))
}

pub fn stop(running: &Running) {
    if let Some(mut child) = running.0.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A stand-in `claude` that checks its arguments and prints a short stream.
    #[test]
    fn streams_events_from_the_cli() {
        let dir = std::env::temp_dir().join(format!("roughcut-claude-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("claude");
        std::fs::write(
            &fake,
            "#!/bin/sh\nprompt=$(cat)\ncase \"$*\" in *--resume\\ abc*) ;; *) echo 'missing resume' >&2; exit 3;; esac\n\
             echo '{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"abc\"}'\n\
             echo \"{\\\"type\\\":\\\"result\\\",\\\"is_error\\\":false,\\\"result\\\":\\\"$prompt\\\"}\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::env::set_var("ROUGHCUT_CLAUDE", &fake);
        let events = std::cell::RefCell::new(vec![]);
        let running = Running::default();
        ask(&dir, "talk.mov", 10.0, "hello", Some("abc"), &running, |e| events.borrow_mut().push(e)).unwrap();
        let events = events.into_inner();
        assert_eq!(events.len(), 2);
        assert_eq!(events[1]["result"], "hello");
        assert!(ask(&dir, "talk.mov", 10.0, "hello", None, &running, |_| {}).unwrap_err().contains("missing resume"));
        std::env::remove_var("ROUGHCUT_CLAUDE");
        std::fs::remove_dir_all(&dir).ok();
    }
}
