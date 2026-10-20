//! Luke's style: rules Claude always follows and settings for the rough cut,
//! kept once for every video (not per project). The sidebar's Claude and the
//! rough cut both read them, and Claude can suggest new rules from the
//! corrections Luke made to its edits.

use crate::{edits, tools};
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;

pub fn path() -> PathBuf {
    if let Some(p) = std::env::var_os("ROUGHCUT_STYLE") {
        return p.into();
    }
    let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    if cfg!(target_os = "macos") {
        home.join("Library/Application Support/com.lukelewis.roughcut/style.json")
    } else {
        home.join(".config/roughcut/style.json")
    }
}

/// The saved style, or an empty one.
pub fn load() -> Value {
    let v = fs::read_to_string(path()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).unwrap_or(json!({}));
    if v.is_object() {
        v
    } else {
        json!({})
    }
}

pub fn save(style: &Value) -> Result<(), String> {
    let p = path();
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Couldn't save your style: {e}"))?;
    }
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(style).unwrap()).map_err(|e| format!("Couldn't save your style: {e}"))?;
    fs::rename(&tmp, &p).map_err(|e| format!("Couldn't save your style: {e}"))
}

/// The rules that are switched on.
pub fn rules(style: &Value) -> Vec<String> {
    style["rules"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| r["on"] != false)
        .filter_map(|r| r["text"].as_str().map(str::trim).filter(|t| !t.is_empty()).map(String::from))
        .collect()
}

/// The rules as instructions for Claude, or "" if there are none.
pub fn rules_text(style: &Value) -> String {
    let rules = rules(style);
    if rules.is_empty() {
        return String::new();
    }
    format!("Luke's editing rules. Follow them unless he asks otherwise in the moment:\n{}", rules.iter().map(|r| format!("- {r}\n")).collect::<String>())
}

/// Adds a rule (Claude's, when Luke says "always..."), unless it's already there.
pub fn add_rule(text: &str, by: &str) -> Result<bool, String> {
    let mut style = load();
    let list = style.as_object_mut().unwrap().entry("rules").or_insert_with(|| json!([]));
    if !list.is_array() {
        *list = json!([]);
    }
    let list = list.as_array_mut().unwrap();
    if list.iter().any(|r| r["text"].as_str().map(|t| t.trim().eq_ignore_ascii_case(text.trim())) == Some(true)) {
        return Ok(false);
    }
    list.push(json!({ "text": text.trim(), "on": true, "by": by }));
    save(&style)?;
    Ok(true)
}

/// Rough-cut command-line options from the settings.
pub fn cut_args(style: &Value) -> Vec<String> {
    let s = &style["settings"];
    let mut args = vec![];
    for (key, flag, lo, hi) in [("maxPause", "--max-pause", 0.1, 2.0), ("padIn", "--pad-in", 0.0, 0.5), ("padOut", "--pad-out", 0.0, 0.8)] {
        if let Some(v) = s[key].as_f64() {
            args.push(flag.to_string());
            args.push(format!("{:.2}", v.clamp(lo, hi)));
        }
    }
    args
}

/// Quotes one argument for the rough cut's ROUGHCUT_CLAUDE_ARGS (read with shlex).
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\"'\"'"))
}

/// What Luke changed about Claude's edit in this project, in words.
pub fn corrections(folder: &Path) -> Result<String, String> {
    let words = edits::load_words(folder)?;
    let e = edits::load(folder)?;
    let say = |a: usize, b: usize| words.get(a..=b.min(words.len().saturating_sub(1))).map(|w| w.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ")).unwrap_or_default();
    let mut out = String::new();
    for c in &e.agent {
        match c.status.as_str() {
            "restored" => out += &format!("- Claude cut \"{}\" ({}); Luke put it back.\n", say(c.first, c.last), c.reason),
            "accepted" => out += &format!("- Claude cut \"{}\" ({}); Luke kept the cut.\n", say(c.first, c.last), c.reason),
            _ => {}
        }
    }
    for s in &e.user {
        out += &format!("- Luke cut \"{}\" himself.\n", say(s.first, s.last));
    }
    for z in &e.zooms {
        let who = if z.by == "agent" { "Claude" } else { "Luke" };
        match z.status.as_deref() {
            Some("restored") => out += &format!("- {who} zoomed in on \"{}\"; Luke removed it.\n", say(z.first, z.last)),
            _ if z.by == "you" => out += &format!("- Luke zoomed in on \"{}\" to {:.0}%.\n", say(z.first, z.last), z.scale * 100.0),
            _ => {}
        }
    }
    for t in e.other.get("texts").and_then(Value::as_array).into_iter().flatten() {
        let what = format!("{} \"{}\"", t["style"].as_str().unwrap_or("title"), t["text"].as_str().unwrap_or(""));
        match (t["by"].as_str(), t["status"].as_str()) {
            (Some("agent"), Some("restored")) => out += &format!("- Claude added a {what}; Luke removed it.\n"),
            (Some("you"), _) => out += &format!("- Luke added a {what}.\n"),
            _ => {}
        }
        if t["status"] != "restored" && t["motion"].is_object() {
            out += &format!("- Luke's {what} moves like this: {}.\n", motion_words(&t["motion"]));
        }
    }
    for n in e.other.get("notes").and_then(Value::as_array).into_iter().flatten() {
        if n["by"] == "you" {
            out += &format!("- Luke's note: {}\n", n["text"].as_str().unwrap_or(""));
        }
    }
    Ok(out)
}

/// "comes in: slide from left over 0.4s (snappy); goes out: fade over 0.25s (snappy); parts 0.08s apart"
pub fn motion_words(m: &Value) -> String {
    let step = |s: &Value| {
        let kind = s["type"].as_str().unwrap_or("fade");
        let from = match kind {
            "slide" => format!(" from {} ({:.0}% of the frame)", s["from"].as_str().unwrap_or("left"), s["distance"].as_f64().unwrap_or(0.3) * 100.0),
            "reveal" => format!(" from {}", s["from"].as_str().unwrap_or("down")),
            _ => String::new(),
        };
        let blur = s["blur"].as_f64().filter(|b| *b > 0.0).map(|b| format!(", {b:.0}px blur")).unwrap_or_default();
        format!("{kind}{from} over {:.2}s ({}{blur})", s["duration"].as_f64().unwrap_or(0.3), s["easing"].as_str().unwrap_or("smooth"))
    };
    let by = if m["by"].as_str() == Some("word") { "words" } else { "parts" };
    let drift = m["drift"].as_f64().filter(|d| *d > 0.0).map(|d| format!("; grows {:.0}% while it holds", d * 100.0)).unwrap_or_default();
    format!("comes in: {}; goes out: {}; {by} {:.2}s apart{drift}", step(&m["in"]), step(&m["out"]), m["stagger"].as_f64().unwrap_or(0.0))
}

const SCHEMA: &str = r#"{"type":"object","properties":{"rules":{"type":"array","items":{"type":"object","properties":{"text":{"type":"string"},"why":{"type":"string"}},"required":["text","why"]}}},"required":["rules"]}"#;

/// Asks Claude (on Luke's plan, no tools) for rules that would have saved
/// Luke these corrections. Returns [{text, why}].
pub fn suggest(folder: &Path) -> Result<Value, String> {
    let corrections = corrections(folder)?;
    if corrections.trim().is_empty() {
        return Ok(json!([]));
    }
    let style = load();
    let have = rules(&style);
    let prompt = format!(
        "Luke edits talking-head videos with Claude's help. Here is what he changed about Claude's edit of one video:\n\n{corrections}\n\
         His rules so far:\n{}\n\n\
         Suggest up to 4 new rules, in Luke's voice, that would have got these right the first time and will hold for his \
         other videos (\"Keep 'so' at the start of a sentence\", \"Never zoom in more than once in 10 seconds\"). Only suggest a \
         rule a pattern in the corrections supports, never one he already has. Rules can be about how graphics move \
         (\"Lower thirds slide in from the left, snappy, about 0.4s\") when his choices show a pattern. Each `why` is one short sentence pointing at \
         the correction. If nothing is a pattern yet, return no rules.",
        if have.is_empty() { "(none)".to_string() } else { have.iter().map(|r| format!("- {r}")).collect::<Vec<_>>().join("\n") }
    );
    let claude = tools::claude().ok_or("Can't find Claude Code. Install it and run `claude` once in Terminal to log in.")?;
    let mut child = tools::command(&claude)
        .current_dir(folder)
        .args(["-p", "--model", "opus", "--output-format", "json", "--tools", "", "--no-session-persistence", "--json-schema", SCHEMA])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't start Claude: {e}"))?;
    child.stdin.take().unwrap().write_all(prompt.as_bytes()).map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let outer: Value = serde_json::from_slice(&out.stdout).map_err(|_| format!("Claude didn't answer: {}", String::from_utf8_lossy(&out.stderr).trim()))?;
    if outer["is_error"] == true {
        return Err(format!("Claude returned an error: {}", outer["result"]));
    }
    let data = if outer["structured_output"].is_object() {
        outer["structured_output"].clone()
    } else {
        let text = outer["result"].as_str().unwrap_or("");
        let (a, b) = (text.find('{'), text.rfind('}'));
        match (a, b) {
            (Some(a), Some(b)) if b > a => serde_json::from_str(&text[a..=b]).map_err(|e| e.to_string())?,
            _ => return Err("Claude's answer had no rules in it.".into()),
        }
    };
    Ok(data["rules"].clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rules_and_settings() {
        let style = json!({
            "rules": [{ "text": "Keep 'so' at the start", "on": true }, { "text": "Off one", "on": false }, { "text": " " }],
            "settings": { "maxPause": 0.6, "padOut": 9.0 },
        });
        assert_eq!(rules(&style), vec!["Keep 'so' at the start"]);
        assert!(rules_text(&style).contains("- Keep 'so' at the start\n"));
        assert_eq!(rules_text(&json!({})), "");
        assert_eq!(cut_args(&style), vec!["--max-pause", "0.60", "--pad-out", "0.80"]);
        assert_eq!(shell_quote("it's"), "'it'\"'\"'s'");
    }

    /// Asks the real Claude; run with `cargo test -- --ignored` where `claude` is logged in.
    #[test]
    #[ignore]
    fn suggests_rules_from_corrections() {
        let dir = std::env::temp_dir().join("roughcut-style-test");
        fs::create_dir_all(&dir).unwrap();
        let text = "So I tried it . So it worked . So here's why";
        let words: Vec<Value> = text.split(' ').enumerate().map(|(i, w)| json!({ "text": w, "start": i as f64 * 0.5, "end": i as f64 * 0.5 + 0.4 })).collect();
        fs::write(dir.join("words.json"), Value::Array(words).to_string()).unwrap();
        let cut = |a: usize, status: &str| json!({ "first": a, "last": a, "reason": "filler", "status": status });
        fs::write(dir.join("edits.json"), json!({ "version": 1, "agent": [cut(0, "restored"), cut(5, "restored"), cut(10, "restored")], "user": [], "log": [] }).to_string()).unwrap();
        std::env::set_var("ROUGHCUT_STYLE", dir.join("style.json"));
        let got = suggest(&dir).unwrap();
        println!("{got:#}");
        assert!(got.as_array().map(|a| !a.is_empty()).unwrap_or(false));
    }
}
