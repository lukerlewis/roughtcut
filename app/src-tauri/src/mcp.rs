//! A tiny MCP server over stdio that lets Claude read and change the edit.
//! The app runs itself as this server (`Roughcut --mcp <folder> <duration>`)
//! when it starts `claude -p`, so no separate program ships with it.
//! Each call reads edits.json fresh and writes it back; the app reloads it
//! when Claude's turn reports a tool result.

use crate::edits::{self, Kind};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

pub fn serve(folder: PathBuf, duration: f64) {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    for line in stdin.lock().lines().map_while(Result::ok) {
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        let Some(id) = msg.get("id").cloned() else { continue }; // notifications need no answer
        let reply = match handle(&folder, duration, &msg) {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err((code, message)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
        };
        let _ = writeln!(out, "{reply}");
        let _ = out.flush();
    }
}

fn handle(folder: &Path, duration: f64, msg: &Value) -> Result<Value, (i64, String)> {
    match msg["method"].as_str().unwrap_or("") {
        "initialize" => Ok(json!({
            "protocolVersion": msg["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "roughcut", "version": env!("CARGO_PKG_VERSION") },
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools() })),
        "tools/call" => {
            let name = msg["params"]["name"].as_str().unwrap_or("");
            let args = &msg["params"]["arguments"];
            Ok(match call(folder, duration, name, args) {
                Ok(text) => json!({ "content": [{ "type": "text", "text": text }] }),
                Err(text) => json!({ "content": [{ "type": "text", "text": text }], "isError": true }),
            })
        }
        other => Err((-32601, format!("Unknown method {other}"))),
    }
}

fn tools() -> Value {
    let range = |extra: Value| {
        let mut props = json!({
            "from": { "type": "integer", "description": "Index of the first word." },
            "to": { "type": "integer", "description": "Index of the last word (inclusive)." },
        });
        if let Value::Object(m) = extra {
            props.as_object_mut().unwrap().extend(m);
        }
        props
    };
    json!([
        {
            "name": "get_edit",
            "description": "Read the current edit: every word of the transcript with its index and time, grouped into runs that are kept or cut (and who cut them), plus the length of the cut. Call this before changing anything, and again after Luke has been editing.",
            "inputSchema": { "type": "object", "properties": {} },
        },
        {
            "name": "cut_words",
            "description": "Cut words from..to out of the video. It shows to Luke as your unreviewed cut, with your reason, until he keeps or restores it.",
            "inputSchema": {
                "type": "object",
                "properties": range(json!({ "reason": { "type": "string", "description": "A few words on why, shown to Luke, e.g. \"repeats the line before\"." } })),
                "required": ["from", "to", "reason"],
            },
        },
        {
            "name": "zoom_in",
            "description": "Punch in on words from..to: the frame scales up about a point (by default a little above the middle, on Luke's face) for exactly while those words play. Good for emphasis on a key line or to hide a jump cut. Shows to Luke as your unreviewed zoom until he keeps or removes it; he can drag it on the timeline.",
            "inputSchema": {
                "type": "object",
                "properties": range(json!({
                    "scale": { "type": "number", "description": "How far in: 1.15 subtle, 1.3 normal (default), 1.6 strong. 1.05 to 2.5." },
                    "x": { "type": "number", "description": "Where to zoom, across: 0 left edge, 0.5 middle (default), 1 right edge." },
                    "y": { "type": "number", "description": "Where to zoom, down: 0 top, 0.4 face height (default), 1 bottom." },
                    "reason": { "type": "string", "description": "A few words on why, shown to Luke." },
                })),
                "required": ["from", "to", "reason"],
            },
        },
        {
            "name": "remove_zoom",
            "description": "Take out any zooms overlapping words from..to.",
            "inputSchema": { "type": "object", "properties": range(json!({})), "required": ["from", "to"] },
        },
        {
            "name": "set_captions",
            "description": "Turn burned-in captions on or off. They follow the kept words automatically. Styles: \"bold\" (big capitals, the spoken word highlighted, for social clips) or \"clean\" (smaller sentence case on a soft box).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "on": { "type": "boolean" },
                    "style": { "type": "string", "enum": ["bold", "clean"] },
                },
                "required": ["on"],
            },
        },
        {
            "name": "add_clip",
            "description": "Put a clip you made onto the timeline. Use this only for things the other tools can't do, and only after Luke has said yes. Render the clip with ffmpeg (or python3) into the clips/ folder here: a replacement for source seconds start..end of the recording, the same length, with an audio track (copy the recording's audio for that span unless asked otherwise). It plays instead of the recording there and shows to Luke as your unreviewed clip on the Claude clips track; he can keep, move, trim or delete it. A clip overlapping one of yours replaces it.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "file": { "type": "string", "description": "Path of the clip, relative to this folder, e.g. clips/paris.mp4." },
                    "start": { "type": "number", "description": "Source second it starts replacing." },
                    "end": { "type": "number", "description": "Source second it stops replacing." },
                    "reason": { "type": "string", "description": "What it is, in a few words, shown to Luke, e.g. \"Paris behind you\"." },
                },
                "required": ["file", "start", "end", "reason"],
            },
        },
        {
            "name": "add_text",
            "description": "Put words on screen over words from..to: a title (big, centred), a lower-third (name and role, bottom left) or a callout (a ring on a spot with a label, for pointing at something on screen). Shows to Luke as your unreviewed text; he can edit the words, look, size and place, and drag it on the timeline.",
            "inputSchema": {
                "type": "object",
                "properties": range(json!({
                    "style": { "type": "string", "enum": ["title", "lower-third", "callout"] },
                    "text": { "type": "string", "description": "What it says. Keep it short." },
                    "sub": { "type": "string", "description": "Optional second line: a subtitle, or a lower third's role." },
                    "x": { "type": "number", "description": "Optional place across, 0..1 (a callout's spot; a title's centre; a lower third's left edge)." },
                    "y": { "type": "number", "description": "Optional place down, 0..1." },
                    "reason": { "type": "string", "description": "A few words on why, shown to Luke." },
                })),
                "required": ["style", "text", "from", "to", "reason"],
            },
        },
        {
            "name": "resolve_note",
            "description": "Mark one of Luke's notes done once you've dealt with it, with a one-sentence reply he'll see on the note.",
            "inputSchema": {
                "type": "object",
                "properties": { "note": { "type": "integer", "description": "The note's number from get_edit." }, "reply": { "type": "string" } },
                "required": ["note", "reply"],
            },
        },
        {
            "name": "add_note",
            "description": "Pin a note for Luke at word `at`: something for him to look at or decide, not a change you could just make.",
            "inputSchema": {
                "type": "object",
                "properties": { "at": { "type": "integer", "description": "Word index." }, "text": { "type": "string" } },
                "required": ["at", "text"],
            },
        },
        {
            "name": "add_rule",
            "description": "Save one of Luke's editing rules for all his videos, when he says to always or never do something. One line, in his voice (\"Keep 'so' at the start of sentences\"). He can switch it off or edit it in Style.",
            "inputSchema": { "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] },
        },
        {
            "name": "speed_up",
            "description": "Play words from..to faster (1.1 to 4; 1.5 is a gentle speed-up, 2 or more for a montage or a slow bit of screen work). The voice keeps its pitch. Shows to Luke as your unreviewed speed-up, adjustable on the timeline.",
            "inputSchema": {
                "type": "object",
                "properties": range(json!({ "rate": { "type": "number" }, "reason": { "type": "string" } })),
                "required": ["from", "to", "rate", "reason"],
            },
        },
        {
            "name": "blur",
            "description": "Blur out a box of the frame while words from..to play (a face, a screen with private details). x, y are its top-left corner and w, h its size, as fractions of the frame. Luke can move and resize it.",
            "inputSchema": {
                "type": "object",
                "properties": range(json!({
                    "x": { "type": "number" }, "y": { "type": "number" }, "w": { "type": "number" }, "h": { "type": "number" },
                    "reason": { "type": "string" },
                })),
                "required": ["from", "to", "x", "y", "w", "h", "reason"],
            },
        },
        {
            "name": "remove_effect",
            "description": "Take your speed-ups or blurs overlapping words from..to off the timeline.",
            "inputSchema": {
                "type": "object",
                "properties": range(json!({ "kind": { "type": "string", "enum": ["speed", "blur"] } })),
                "required": ["kind", "from", "to"],
            },
        },
        {
            "name": "set_voice",
            "description": "Polish the voice in the export (even loudness and less hiss), or turn that off.",
            "inputSchema": { "type": "object", "properties": { "polish": { "type": "boolean" } }, "required": ["polish"] },
        },
        {
            "name": "remove_text",
            "description": "Take your text overlapping words from..to off the screen.",
            "inputSchema": { "type": "object", "properties": range(json!({})), "required": ["from", "to"] },
        },
        {
            "name": "remove_clip",
            "description": "Take your clips overlapping source seconds start..end off the timeline. The recording plays there again.",
            "inputSchema": {
                "type": "object",
                "properties": { "start": { "type": "number" }, "end": { "type": "number" } },
                "required": ["start", "end"],
            },
        },
        {
            "name": "restore_words",
            "description": "Put words from..to back into the video, whoever cut them. Any of your cuts touching the range is restored whole.",
            "inputSchema": { "type": "object", "properties": range(json!({})), "required": ["from", "to"] },
        },
    ])
}

fn index(args: &Value, key: &str, n: usize) -> Result<usize, String> {
    let i = args[key].as_u64().ok_or(format!("`{key}` must be a word index"))? as usize;
    if i >= n {
        return Err(format!("`{key}` is {i}, but the last word is {}", n - 1));
    }
    Ok(i)
}

fn call(folder: &Path, duration: f64, name: &str, args: &Value) -> Result<String, String> {
    let words = edits::load_words(folder)?;
    let mut e = edits::load(folder)?;
    let n = words.len();
    let text = |a: usize, b: usize| words[a..=b].iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ");
    match name {
        "get_edit" => Ok(describe(&words, &e, duration)),
        "cut_words" | "restore_words" => {
            let (a, b) = (index(args, "from", n)?, index(args, "to", n)?);
            if a > b {
                return Err("`from` must not be after `to`".into());
            }
            let before = edits::kept_length(&words, &edits::kinds(n, &e), duration);
            if name == "cut_words" {
                let reason = args["reason"].as_str().filter(|r| !r.trim().is_empty()).ok_or("Give a short `reason`.")?;
                edits::cut(&mut e, a, b, reason.trim());
            } else {
                edits::restore(&mut e, a, b);
            }
            edits::save(folder, &e)?;
            let after = edits::kept_length(&words, &edits::kinds(n, &e), duration);
            let verb = if name == "cut_words" { "Cut" } else { "Restored" };
            Ok(format!("{verb} {a}-{b}: \"{}\". The cut is now {after:.1}s (was {before:.1}s).", text(a, b)))
        }
        "zoom_in" | "remove_zoom" => {
            let (a, b) = (index(args, "from", n)?, index(args, "to", n)?);
            if a > b {
                return Err("`from` must not be after `to`".into());
            }
            let msg = if name == "zoom_in" {
                let reason = args["reason"].as_str().filter(|r| !r.trim().is_empty()).ok_or("Give a short `reason`.")?;
                let scale = args["scale"].as_f64().unwrap_or(1.3);
                edits::zoom(&mut e, a, b, scale, reason.trim())?;
                if let Some(z) = e.zooms.iter_mut().find(|z| z.first == a && z.by == "agent") {
                    z.x = args["x"].as_f64().unwrap_or(0.5).clamp(0.0, 1.0);
                    z.y = args["y"].as_f64().unwrap_or(0.4).clamp(0.0, 1.0);
                }
                format!("Zoomed in on {a}-{b}: \"{}\" at {:.0}%.", text(a, b), scale.clamp(1.05, 2.5) * 100.0)
            } else {
                let n = edits::unzoom(&mut e, a, b);
                format!("Removed {n} zoom(s) around {a}-{b}.")
            };
            edits::save(folder, &e)?;
            Ok(msg)
        }
        "set_captions" => {
            let on = args["on"].as_bool().ok_or("`on` must be true or false")?;
            let style = args["style"].as_str().or(e.captions.as_ref().map(|c| c.style.as_str())).unwrap_or("bold").to_string();
            if style != "bold" && style != "clean" {
                return Err("`style` is \"bold\" or \"clean\"".into());
            }
            edits::set_captions(&mut e, on, &style);
            edits::save(folder, &e)?;
            Ok(if on { format!("Captions are on, {style} style.") } else { "Captions are off.".into() })
        }
        "add_clip" => {
            let rel = args["file"].as_str().ok_or("Give the clip's `file`.")?;
            let reason = args["reason"].as_str().filter(|r| !r.trim().is_empty()).ok_or("Give a short `reason`.")?;
            let (start, end) = (args["start"].as_f64().ok_or("`start` must be seconds")?, args["end"].as_f64().ok_or("`end` must be seconds")?);
            if !(0.0 <= start && start < end && end <= duration + 0.01) {
                return Err(format!("`start` and `end` must be within the recording (0 to {duration:.2}s), start first."));
            }
            let base = folder.canonicalize().map_err(|e| e.to_string())?;
            let path = base.join(rel).canonicalize().map_err(|_| format!("There's no file at {rel} in this folder."))?;
            if !path.starts_with(&base) {
                return Err("The clip has to be inside this folder (e.g. clips/name.mp4).".into());
            }
            let info = crate::media::probe(&path)?;
            if info.width == 0 {
                return Err(format!("{rel} has no video."));
            }
            if !info.audio {
                return Err(format!("{rel} has no audio track. Add one (the recording's audio for {start:.2}-{end:.2}s, or silence)."));
            }
            if info.duration < end - start - 0.1 {
                return Err(format!("{rel} is {:.2}s but needs to be {:.2}s to cover {start:.2}-{end:.2}s.", info.duration, end - start));
            }
            let rel = path.strip_prefix(&base).unwrap().to_string_lossy().to_string();
            edits::add_clip(&mut e, &rel, start, end, info.duration, reason.trim());
            edits::save(folder, &e)?;
            Ok(format!("Added {rel} on the Claude clips track for {start:.2}-{end:.2}s. Luke will see it in blue until he reviews it."))
        }
        "add_text" => {
            let (a, b) = (index(args, "from", n)?, index(args, "to", n)?);
            if a > b {
                return Err("`from` must not be after `to`".into());
            }
            let style = args["style"].as_str().unwrap_or("title");
            if !["title", "lower-third", "callout"].contains(&style) {
                return Err("`style` is title, lower-third or callout".into());
            }
            let text = args["text"].as_str().filter(|t| !t.trim().is_empty()).ok_or("Give the `text`.")?;
            let reason = args["reason"].as_str().filter(|r| !r.trim().is_empty()).ok_or("Give a short `reason`.")?;
            let place = match (args["x"].as_f64(), args["y"].as_f64()) {
                (Some(x), Some(y)) => Some((x.clamp(0.0, 1.0), y.clamp(0.0, 1.0))),
                _ => None,
            };
            // Hold it a little either side of the words.
            let (start, end) = ((words[a].start - 0.1).max(0.0), (words[b].end + 0.4).min(duration));
            edits::add_text(&mut e, style, text.trim(), args["sub"].as_str(), start, end, place, reason.trim());
            edits::save(folder, &e)?;
            Ok(format!("Added a {style} \"{}\" over {a}-{b} ({start:.2}-{end:.2}s). Luke will see it in blue until he reviews it.", text.trim()))
        }
        "speed_up" | "blur" => {
            let (a, b) = (index(args, "from", n)?, index(args, "to", n)?);
            if a > b {
                return Err("`from` must not be after `to`".into());
            }
            let reason = args["reason"].as_str().filter(|r| !r.trim().is_empty()).ok_or("Give a short `reason`.")?.trim();
            let (start, end) = (words[a].start, words[b].end);
            let item = if name == "speed_up" {
                let rate = args["rate"].as_f64().ok_or("`rate` must be a number")?.clamp(1.1, 4.0);
                // One speed per moment: Claude's new one replaces its own overlapping ones.
                for s in edits::list(&mut e, "speeds").iter_mut() {
                    let (s0, s1) = (s["start"].as_f64().unwrap_or(0.0), s["end"].as_f64().unwrap_or(0.0));
                    if s["by"] == "agent" && s["status"] != "restored" && s0 < end && s1 > start {
                        s["status"] = json!("restored");
                    }
                }
                json!({ "start": start, "end": end, "rate": (rate * 100.0).round() / 100.0, "by": "agent", "status": "pending", "reason": reason })
            } else {
                let f = |k: &str| args[k].as_f64().ok_or(format!("`{k}` must be a fraction of the frame"));
                let (x, y) = (f("x")?.clamp(0.0, 0.97), f("y")?.clamp(0.0, 0.97));
                let (w, h) = (f("w")?.clamp(0.03, 1.0 - x), f("h")?.clamp(0.03, 1.0 - y));
                json!({ "start": start, "end": end, "x": x, "y": y, "w": w, "h": h, "by": "agent", "status": "pending", "reason": reason })
            };
            edits::list(&mut e, if name == "speed_up" { "speeds" } else { "blurs" }).push(item);
            e.log.push(json!({ "at": edits::now(), "by": "agent", "op": name, "note": reason }));
            edits::save(folder, &e)?;
            Ok(format!("Added a {} over {a}-{b}. Luke will see it in blue until he reviews it.", if name == "speed_up" { "speed-up" } else { "blur" }))
        }
        "remove_effect" => {
            let (a, b) = (index(args, "from", n)?, index(args, "to", n)?);
            let key = if args["kind"] == "blur" { "blurs" } else { "speeds" };
            let (start, end) = (words[a].start, words[b.max(a)].end);
            let mut count = 0;
            for t in edits::list(&mut e, key).iter_mut() {
                let (s, f) = (t["start"].as_f64().unwrap_or(0.0), t["end"].as_f64().unwrap_or(0.0));
                if t["by"] == "agent" && t["status"] != "restored" && s < end && f > start {
                    t["status"] = json!("restored");
                    count += 1;
                }
            }
            edits::save(folder, &e)?;
            Ok(format!("Removed {count}."))
        }
        "set_voice" => {
            let on = args["polish"].as_bool().ok_or("`polish` must be true or false")?;
            e.other.insert("voice".into(), if on { json!({ "level": true, "clean": true }) } else { json!({}) });
            edits::save(folder, &e)?;
            Ok(if on { "The export will polish the voice.".into() } else { "The export will use the voice as recorded.".into() })
        }
        "add_rule" => {
            let text = args["text"].as_str().filter(|t| !t.trim().is_empty()).ok_or("Give the rule's `text`.")?;
            Ok(if crate::style::add_rule(text, "agent")? { format!("Saved the rule: {}", text.trim()) } else { "Luke already has that rule.".into() })
        }
        "resolve_note" => {
            let i = args["note"].as_u64().ok_or("`note` must be a note number")? as usize;
            let reply = args["reply"].as_str().filter(|r| !r.trim().is_empty()).ok_or("Give a short `reply`.")?;
            let note = edits::notes(&mut e).get_mut(i).ok_or_else(|| format!("There's no note {i}. Call get_edit for the list."))?;
            note["done"] = Value::Bool(true);
            note["reply"] = Value::String(reply.trim().into());
            edits::save(folder, &e)?;
            Ok(format!("Marked note {i} done."))
        }
        "add_note" => {
            let at = index(args, "at", n)?;
            let text = args["text"].as_str().filter(|t| !t.trim().is_empty()).ok_or("Give the note's `text`.")?;
            edits::notes(&mut e).push(json!({ "at": words[at].start, "text": text.trim(), "by": "agent" }));
            edits::save(folder, &e)?;
            Ok(format!("Left Luke a note at word {at}."))
        }
        "remove_text" => {
            let (a, b) = (index(args, "from", n)?, index(args, "to", n)?);
            let (start, end) = (words[a].start, words[b.max(a)].end);
            let mut count = 0;
            for t in edits::texts(&mut e).iter_mut() {
                let (s, f) = (t["start"].as_f64().unwrap_or(0.0), t["end"].as_f64().unwrap_or(0.0));
                if t["by"] == "agent" && t["status"] != "restored" && s < end && f > start {
                    t["status"] = Value::String("restored".into());
                    count += 1;
                }
            }
            edits::save(folder, &e)?;
            Ok(format!("Took {count} text(s) off the screen."))
        }
        "remove_clip" => {
            let (start, end) = (args["start"].as_f64().ok_or("`start` must be seconds")?, args["end"].as_f64().ok_or("`end` must be seconds")?);
            let mut n = 0;
            for c in e.clips.iter_mut() {
                if c.by == "agent" && c.status.as_deref() != Some("restored") && c.start < end && c.end > start {
                    c.status = Some("restored".into());
                    n += 1;
                }
            }
            edits::save(folder, &e)?;
            Ok(format!("Took {n} clip(s) off the timeline."))
        }
        other => Err(format!("No tool called {other}")),
    }
}

fn clock(t: f64) -> String {
    format!("{:02}:{:02}", (t / 60.0) as u64, (t % 60.0) as u64)
}

/// The transcript as runs of kept and cut words, which reads well and keeps indexes exact.
fn describe(words: &[edits::Word], e: &edits::Edits, duration: f64) -> String {
    let kinds = edits::kinds(words.len(), e);
    let ranges = edits::kept_ranges(words, &kinds, duration);
    let length: f64 = ranges.iter().map(|(a, b)| b - a).sum();
    let mut s = format!(
        "The recording is {:.1}s; the cut is {length:.1}s. Each run below is [first-last] source time, then its words.\n\
         Times Luke gives (like 00:12) are usually from the player, which shows the edit: match them to \"plays at\".\n\
         KEPT plays in the video. CUT runs say who cut them; yours stay unreviewed until Luke keeps or restores them.\n\n",
        duration
    );
    if e.other.get("keepPauses").and_then(Value::as_bool) == Some(true) {
        s += "No rough cut yet: every pause plays as recorded, and the cut is longer than the figure above. If Luke asks for a rough cut, \
              tell him to click Rough cut at the top (it cuts fillers, retakes and long pauses), or make the cuts he describes.\n\n";
    }
    let label = |k: Kind, i: usize| -> String {
        match k {
            Kind::Kept => "KEPT".into(),
            Kind::You => "CUT by Luke".into(),
            Kind::ClaudePending | Kind::ClaudeKept => {
                let c = e.agent.iter().find(|c| c.status != "restored" && c.first <= i && i <= c.last);
                let state = if k == Kind::ClaudePending { "unreviewed" } else { "kept by Luke" };
                format!("CUT by you ({state}: {})", c.map(|c| c.reason.as_str()).unwrap_or(""))
            }
        }
    };
    let mut i = 0;
    while i < words.len() {
        let k = kinds[i];
        let head = label(k, i);
        let mut j = i;
        while j + 1 < words.len() && kinds[j + 1] == k && label(k, j + 1) == head {
            j += 1;
        }
        let text = words[i..=j].iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ");
        let plays = if k == Kind::Kept { format!(", plays at {} in the edit", clock(edits::cut_time(&ranges, words[i].start))) } else { String::new() };
        s += &format!("[{i}-{j}] {} {head}: {text} (source {:.2}-{:.2}s{plays})\n", clock(words[i].start), words[i].start, words[j].end);
        i = j + 1;
    }
    let live: Vec<_> = e.zooms.iter().filter(|z| z.status.as_deref() != Some("restored")).collect();
    s += "\nZooms: ";
    if live.is_empty() {
        s += "none\n";
    } else {
        s += "\n";
        for z in live {
            let who = if z.by == "you" { "Luke's".to_string() } else { format!("yours, {}", z.status.as_deref().unwrap_or("pending")) };
            s += &format!("[{}-{}] {:.0}% ({who}) {}\n", z.first, z.last, z.scale * 100.0, z.reason.as_deref().unwrap_or(""));
        }
    }
    s += &match &e.captions {
        Some(c) if c.on => format!("Captions: on, {} style\n", c.style),
        _ => "Captions: off\n".into(),
    };
    let texts: Vec<&Value> = e.other.get("texts").and_then(Value::as_array).map(|a| a.iter().filter(|t| t["status"] != "restored").collect()).unwrap_or_default();
    if !texts.is_empty() {
        s += "Text on screen:\n";
        for t in texts {
            let who = if t["by"] == "agent" { format!("yours, {}", t["status"].as_str().unwrap_or("pending")) } else { "Luke's".into() };
            s += &format!(
                "{} \"{}\" {:.2}-{:.2}s ({who})\n",
                t["style"].as_str().unwrap_or("title"),
                t["text"].as_str().unwrap_or(""),
                t["start"].as_f64().unwrap_or(0.0),
                t["end"].as_f64().unwrap_or(0.0)
            );
        }
    }
    let notes = e.other.get("notes").and_then(Value::as_array).cloned().unwrap_or_default();
    if !notes.is_empty() {
        s += "Notes pinned to moments (source seconds):\n";
        for (i, note) in notes.iter().enumerate() {
            let at = note["at"].as_f64().unwrap_or(0.0);
            let near = words.iter().position(|w| w.end >= at).unwrap_or(0);
            let who = if note["by"] == "agent" { "yours, for Luke" } else if note["done"] == true { "Luke's, done" } else { "Luke's, open" };
            s += &format!("note {i} at {at:.2}s, near word {near} ({who}): {}\n", note["text"].as_str().unwrap_or(""));
        }
    }
    for (key, title) in [("speeds", "Speed-ups"), ("blurs", "Blurs")] {
        let items: Vec<&Value> = e.other.get(key).and_then(Value::as_array).map(|a| a.iter().filter(|t| t["status"] != "restored").collect()).unwrap_or_default();
        if !items.is_empty() {
            s += &format!("{title} (source seconds):\n");
            for t in items {
                let who = if t["by"] == "agent" { format!("yours, {}", t["status"].as_str().unwrap_or("pending")) } else { "Luke's".into() };
                let what = if key == "speeds" { format!("{}x", t["rate"]) } else { {
                    let f = |k: &str| t[k].as_f64().unwrap_or(0.0);
                    format!("box x {:.2} y {:.2} w {:.2} h {:.2}", f("x"), f("y"), f("w"), f("h"))
                } };
                s += &format!("{:.2}-{:.2}s {what} ({who})\n", t["start"].as_f64().unwrap_or(0.0), t["end"].as_f64().unwrap_or(0.0));
            }
        }
    }
    if e.other.get("voice").map(|v| v["level"] == true || v["clean"] == true) == Some(true) {
        s += "Voice: polished on export.\n";
    }
    let clips: Vec<_> = e.clips.iter().filter(|c| c.status.as_deref() != Some("restored")).collect();
    if !clips.is_empty() {
        s += "Clips on the timeline (playing instead of the recording):\n";
        for c in clips {
            let who = if c.by == "agent" { format!("yours, {}", c.status.as_deref().unwrap_or("pending")) } else { "Luke's".into() };
            s += &format!("{} {:.2}-{:.2}s ({who}) {}\n", c.file, c.start, c.end, c.reason.as_deref().unwrap_or(""));
        }
    }
    let restored: Vec<_> = e.agent.iter().filter(|c| c.status == "restored").collect();
    if !restored.is_empty() {
        s += "\nCuts of yours that Luke put back (don't cut these again unless he asks):\n";
        for c in restored {
            s += &format!("[{}-{}] {}\n", c.first, c.last, c.reason);
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn folder() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("roughcut-mcp-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let words: Vec<Value> = "So um I tested this for thirty days"
            .split(' ')
            .enumerate()
            .map(|(i, w)| json!({ "text": w, "start": i as f64 * 0.5, "end": i as f64 * 0.5 + 0.4 }))
            .collect();
        fs::write(dir.join("words.json"), Value::Array(words).to_string()).unwrap();
        fs::write(dir.join("decisions.json"), json!({ "cuts": [{ "from": 1, "to": 1, "reason": "filler" }] }).to_string()).unwrap();
        let _ = fs::remove_file(dir.join("edits.json"));
        dir
    }

    fn rpc(dir: &Path, method: &str, params: Value) -> Value {
        handle(dir, 4.0, &json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params })).unwrap()
    }

    #[test]
    fn reads_and_changes_the_edit() {
        let dir = folder();
        assert_eq!(rpc(&dir, "tools/list", json!({}))["tools"].as_array().unwrap().len(), 17);
        let edit = rpc(&dir, "tools/call", json!({ "name": "get_edit", "arguments": {} }));
        let text = edit["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("[1-1] 00:00 CUT by you (unreviewed: filler): um"), "{text}");
        assert!(text.contains("[2-7] 00:01 KEPT: I tested this for thirty days"), "{text}");

        let cut = rpc(&dir, "tools/call", json!({ "name": "cut_words", "arguments": { "from": 5, "to": 5, "reason": "not needed" } }));
        assert!(cut["content"][0]["text"].as_str().unwrap().starts_with("Cut 5-5: \"for\""));
        let saved: Value = serde_json::from_str(&fs::read_to_string(dir.join("edits.json")).unwrap()).unwrap();
        assert_eq!(saved["agent"].as_array().unwrap().len(), 2);
        assert_eq!(saved["agent"][1]["status"], "pending");

        rpc(&dir, "tools/call", json!({ "name": "restore_words", "arguments": { "from": 1, "to": 1 } }));
        let saved: Value = serde_json::from_str(&fs::read_to_string(dir.join("edits.json")).unwrap()).unwrap();
        assert_eq!(saved["agent"][0]["status"], "restored");

        let z = rpc(&dir, "tools/call", json!({ "name": "zoom_in", "arguments": { "from": 2, "to": 4, "reason": "key line" } }));
        assert!(z["content"][0]["text"].as_str().unwrap().contains("at 130%"), "{z}");
        rpc(&dir, "tools/call", json!({ "name": "set_captions", "arguments": { "on": true } }));
        let edit = rpc(&dir, "tools/call", json!({ "name": "get_edit", "arguments": {} }));
        let text = edit["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("[2-4] 130% (yours, pending) key line"), "{text}");
        assert!(text.contains("Captions: on, bold style"), "{text}");

        let t = rpc(&dir, "tools/call", json!({ "name": "add_text", "arguments": { "style": "title", "text": "30 days", "from": 6, "to": 7, "reason": "the hook" } }));
        assert!(t["content"][0]["text"].as_str().unwrap().starts_with("Added a title"), "{t}");
        let edit = rpc(&dir, "tools/call", json!({ "name": "get_edit", "arguments": {} }));
        assert!(edit["content"][0]["text"].as_str().unwrap().contains("30 days"));
        rpc(&dir, "tools/call", json!({ "name": "remove_text", "arguments": { "from": 7, "to": 7 } }));
        let saved: Value = serde_json::from_str(&fs::read_to_string(dir.join("edits.json")).unwrap()).unwrap();
        assert_eq!(saved["texts"][0]["status"], "restored");

        rpc(&dir, "tools/call", json!({ "name": "add_note", "arguments": { "at": 3, "text": "Retake?" } }));
        let r = rpc(&dir, "tools/call", json!({ "name": "resolve_note", "arguments": { "note": 0, "reply": "Done" } }));
        assert_eq!(r["content"][0]["text"], "Marked note 0 done.");
        let edit = rpc(&dir, "tools/call", json!({ "name": "get_edit", "arguments": {} }));
        assert!(edit["content"][0]["text"].as_str().unwrap().contains("note 0 at 1.50s, near word 3 (yours, for Luke): Retake?"), "{edit}");

        std::env::set_var("ROUGHCUT_STYLE", dir.join("style.json"));
        let r = rpc(&dir, "tools/call", json!({ "name": "add_rule", "arguments": { "text": "Keep 'so' at the start" } }));
        assert!(r["content"][0]["text"].as_str().unwrap().starts_with("Saved the rule"), "{r}");
        let again = rpc(&dir, "tools/call", json!({ "name": "add_rule", "arguments": { "text": "keep 'so' at the start" } }));
        assert_eq!(again["content"][0]["text"], "Luke already has that rule.");
        assert!(crate::style::corrections(&dir).unwrap().contains("Luke put it back"));

        rpc(&dir, "tools/call", json!({ "name": "speed_up", "arguments": { "from": 2, "to": 4, "rate": 9, "reason": "slow bit" } }));
        rpc(&dir, "tools/call", json!({ "name": "blur", "arguments": { "from": 5, "to": 6, "x": 0.9, "y": 0.1, "w": 0.5, "h": 0.2, "reason": "address" } }));
        rpc(&dir, "tools/call", json!({ "name": "set_voice", "arguments": { "polish": true } }));
        let edit = rpc(&dir, "tools/call", json!({ "name": "get_edit", "arguments": {} }));
        let text = edit["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("1.00-2.40s 4.0x (yours, pending)"), "{text}");
        assert!(text.contains("box x 0.90 y 0.10 w 0.10 h 0.20"), "{text}");
        assert!(text.contains("Voice: polished on export."), "{text}");
        rpc(&dir, "tools/call", json!({ "name": "remove_effect", "arguments": { "kind": "speed", "from": 3, "to": 3 } }));
        let saved: Value = serde_json::from_str(&fs::read_to_string(dir.join("edits.json")).unwrap()).unwrap();
        assert_eq!(saved["speeds"][0]["status"], "restored");

        let bad = rpc(&dir, "tools/call", json!({ "name": "cut_words", "arguments": { "from": 3, "to": 99, "reason": "x" } }));
        assert_eq!(bad["isError"], true);
        fs::remove_dir_all(&dir).ok();
    }
}
