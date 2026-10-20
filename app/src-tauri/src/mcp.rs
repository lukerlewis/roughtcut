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
            "description": "Punch in on words from..to: the frame scales up, centred a little above the middle (on Luke's face), for exactly while those words play. Good for emphasis on a key line or to hide a jump cut. Shows to Luke as your unreviewed zoom until he keeps or removes it; he can drag it on the timeline.",
            "inputSchema": {
                "type": "object",
                "properties": range(json!({
                    "scale": { "type": "number", "description": "How far in: 1.15 subtle, 1.3 normal (default), 1.6 strong. 1.05 to 2." },
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
                format!("Zoomed in on {a}-{b}: \"{}\" at {:.0}%.", text(a, b), scale.clamp(1.05, 2.0) * 100.0)
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
        other => Err(format!("No tool called {other}")),
    }
}

fn clock(t: f64) -> String {
    format!("{:02}:{:02}", (t / 60.0) as u64, (t % 60.0) as u64)
}

/// The transcript as runs of kept and cut words, which reads well and keeps indexes exact.
fn describe(words: &[edits::Word], e: &edits::Edits, duration: f64) -> String {
    let kinds = edits::kinds(words.len(), e);
    let length = edits::kept_length(words, &kinds, duration);
    let mut s = format!(
        "The recording is {:.1}s; the cut is {length:.1}s. Each run below is [first-last] time, then its words.\n\
         KEPT plays in the video. CUT runs say who cut them; yours stay unreviewed until Luke keeps or restores them.\n\n",
        duration
    );
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
        s += &format!("[{i}-{j}] {} {head}: {text}\n", clock(words[i].start));
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
        assert_eq!(rpc(&dir, "tools/list", json!({}))["tools"].as_array().unwrap().len(), 6);
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

        let bad = rpc(&dir, "tools/call", json!({ "name": "cut_words", "arguments": { "from": 3, "to": 99, "reason": "x" } }));
        assert_eq!(bad["isError"], true);
        fs::remove_dir_all(&dir).ok();
    }
}
