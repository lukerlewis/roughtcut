//! Luke's editing skills: the steps Rough cut can run, each a small Markdown
//! file like a Claude skill (a name and settings up top, then what to do).
//! Some are steps the app runs itself (`does: cut`, `retakes`, `captions`,
//! `graphics`), whose text guides Claude where it takes part; the rest are
//! instructions the sidebar Claude follows with the roughcut tools. The ones
//! that ship are in app/skills; Luke's edits and his own skills are files in
//! Application Support/skills, beside his style.

use serde_json::{json, Map, Value};
use std::fs;
use std::path::PathBuf;

/// In the order they run.
const BUILT_IN: [(&str, &str); 8] = [
    ("cut", include_str!("../../skills/cut.md")),
    ("retakes", include_str!("../../skills/retakes.md")),
    ("captions", include_str!("../../skills/captions.md")),
    ("graphics", include_str!("../../skills/graphics.md")),
    ("layouts", include_str!("../../skills/layouts.md")),
    ("zooms", include_str!("../../skills/zooms.md")),
    ("chapters", include_str!("../../skills/chapters.md")),
    ("hooks", include_str!("../../skills/hooks.md")),
];

pub fn dir() -> PathBuf {
    if let Some(p) = std::env::var_os("ROUGHCUT_SKILLS") {
        return p.into();
    }
    crate::style::path().parent().map(|p| p.to_path_buf()).unwrap_or_default().join("skills")
}

/// The settings up top (`key: value` lines between `---`) and the text below.
fn parse(text: &str) -> (Map<String, Value>, String) {
    let mut meta = Map::new();
    let text = text.trim_start_matches('\u{feff}');
    let Some(rest) = text.strip_prefix("---") else { return (meta, text.trim().to_string()) };
    let Some(end) = rest.find("\n---") else { return (meta, text.trim().to_string()) };
    for line in rest[..end].lines() {
        if let Some((k, v)) = line.split_once(':') {
            let v = v.trim().trim_matches('"');
            let value = match v {
                "true" => Value::Bool(true),
                "false" => Value::Bool(false),
                _ => Value::String(v.to_string()),
            };
            meta.insert(k.trim().to_string(), value);
        }
    }
    (meta, rest[end + 4..].trim().to_string())
}

fn write(meta: &Map<String, Value>, body: &str) -> String {
    let mut s = String::from("---\n");
    for key in ["name", "does", "on", "needs", "look"] {
        match meta.get(key) {
            Some(Value::String(v)) if !v.is_empty() => s += &format!("{key}: {}\n", v.replace('\n', " ")),
            Some(Value::Bool(b)) => s += &format!("{key}: {b}\n"),
            _ => {}
        }
    }
    s + "---\n" + body.trim() + "\n"
}

fn skill(id: &str, text: &str, built_in: bool, edited: bool) -> Value {
    let (meta, body) = parse(text);
    let mut v = json!({
        "id": id,
        "name": meta.get("name").and_then(Value::as_str).unwrap_or(id),
        "on": meta.get("on").and_then(Value::as_bool).unwrap_or(false),
        "text": body,
        "builtIn": built_in,
        "edited": edited,
    });
    for key in ["does", "needs", "look"] {
        if let Some(Value::String(s)) = meta.get(key) {
            v[key] = json!(s);
        }
    }
    v
}

/// Every skill: the ones that ship (with Luke's edits), then his own.
pub fn list() -> Vec<Value> {
    let d = dir();
    let mut out: Vec<Value> = BUILT_IN
        .iter()
        .map(|(id, text)| match fs::read_to_string(d.join(format!("{id}.md"))) {
            Ok(mine) => skill(id, &mine, true, true),
            Err(_) => skill(id, text, true, false),
        })
        .collect();
    let mut own: Vec<Value> = fs::read_dir(&d)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let id = name.strip_suffix(".md")?.to_string();
            if BUILT_IN.iter().any(|(b, _)| *b == id) {
                return None;
            }
            Some(skill(&id, &fs::read_to_string(e.path()).ok()?, false, true))
        })
        .collect();
    own.sort_by_key(|s| s["name"].as_str().unwrap_or("").to_lowercase());
    out.extend(own);
    out
}

fn id_for(name: &str) -> String {
    let base: String = name.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    let base = base.split('-').filter(|s| !s.is_empty()).collect::<Vec<_>>().join("-");
    let base: String = if base.is_empty() { "skill".into() } else { base.chars().take(40).collect() };
    let mut id = base.clone();
    let mut n = 2;
    while BUILT_IN.iter().any(|(b, _)| *b == id) || dir().join(format!("{id}.md")).exists() {
        id = format!("{base}-{n}");
        n += 1;
    }
    id
}

fn valid(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Saves a skill: changes to one (by `id`), or a new one when there's no id.
/// For one that ships, only its name, text, look and whether it's ticked
/// can change; what it does stays. Returns the skill.
pub fn save(id: Option<&str>, name: Option<&str>, text: Option<&str>, on: Option<bool>, look: Option<&str>) -> Result<Value, String> {
    let current = id.and_then(|id| list().into_iter().find(|s| s["id"] == id));
    if id.is_some() && current.is_none() {
        return Err(format!("There's no skill called {}.", id.unwrap_or("")));
    }
    let id = match id {
        Some(id) if valid(id) => id.to_string(),
        Some(_) => return Err("That isn't a skill.".into()),
        None => id_for(name.filter(|n| !n.trim().is_empty()).ok_or("Give the skill a name.")?),
    };
    let current = current.unwrap_or(json!({}));
    let mut meta = Map::new();
    let pick = |new: Option<&str>, key: &str| new.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).or_else(|| current[key].as_str().map(String::from));
    let name = pick(name, "name").ok_or("Give the skill a name.")?;
    meta.insert("name".into(), json!(name));
    for key in ["does", "needs"] {
        if let Some(v) = current[key].as_str() {
            meta.insert(key.into(), json!(v));
        }
    }
    meta.insert("on".into(), json!(on.or(current["on"].as_bool()).unwrap_or(true)));
    if let Some(l) = pick(look, "look") {
        meta.insert("look".into(), json!(l));
    }
    let body = text.map(String::from).or_else(|| current["text"].as_str().map(String::from)).unwrap_or_default();
    if body.trim().is_empty() && !meta.contains_key("does") {
        return Err("Say what Claude should do.".into());
    }
    fs::create_dir_all(dir()).map_err(|e| e.to_string())?;
    fs::write(dir().join(format!("{id}.md")), write(&meta, &body)).map_err(|e| format!("Couldn't save the skill: {e}"))?;
    list().into_iter().find(|s| s["id"] == id.as_str()).ok_or("Couldn't save the skill.".into())
}

/// Deletes one of Luke's skills, or puts one that ships back as it came.
pub fn remove(id: &str) -> Result<(), String> {
    if !valid(id) {
        return Err("That isn't a skill.".into());
    }
    match fs::remove_file(dir().join(format!("{id}.md"))) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// The skills for Claude, in a few lines each.
pub fn describe() -> String {
    list()
        .iter()
        .map(|s| {
            let who = match s["does"].as_str() {
                Some(_) => "run by the app",
                None => "you follow it",
            };
            format!("- {} (id {}, {who}): {}", s["name"].as_str().unwrap_or(""), s["id"].as_str().unwrap_or(""), s["text"].as_str().unwrap_or("").replace('\n', " "))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skills_ship_and_can_be_changed_and_added() {
        let d = std::env::temp_dir().join(format!("roughcut-skills-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        std::env::set_var("ROUGHCUT_SKILLS", &d);
        let all = list();
        assert_eq!(all[0]["id"], "cut");
        assert_eq!(all[0]["does"], "cut");
        assert_eq!(all[0]["on"], true);
        assert_eq!(all.iter().find(|s| s["id"] == "layouts").unwrap()["needs"], "screen");
        assert!(all.iter().find(|s| s["id"] == "chapters").unwrap()["text"].as_str().unwrap().contains("add_graphic"));
        assert_eq!(all.iter().find(|s| s["id"] == "captions").unwrap()["look"], "bold");

        // Luke unticks the cut and changes its guidance; what it does stays.
        let cut = save(Some("cut"), None, Some("Keep my ums when they're funny."), Some(false), None).unwrap();
        assert_eq!((cut["on"].as_bool(), cut["does"].as_str(), cut["edited"].as_bool()), (Some(false), Some("cut"), Some(true)));
        assert_eq!(cut["name"], "Cut out filler words and empty space");
        let caps = save(Some("captions"), None, None, None, Some("clean")).unwrap();
        assert_eq!(caps["look"], "clean");
        assert!(caps["text"].as_str().unwrap().contains("captions"));

        // His own.
        let mine = save(None, Some("B-roll notes"), Some("Leave a note wherever b-roll would help."), None, None).unwrap();
        assert_eq!((mine["id"].as_str(), mine["on"].as_bool(), mine["builtIn"].as_bool()), (Some("b-roll-notes"), Some(true), Some(false)));
        assert!(save(None, Some("Empty"), Some(" "), None, None).is_err());
        assert_eq!(list().last().unwrap()["id"], "b-roll-notes");
        assert!(describe().contains("B-roll notes (id b-roll-notes, you follow it)"));
        assert!(save(Some("nope"), None, Some("x"), None, None).is_err());
        assert!(remove("../style").is_err());

        remove("b-roll-notes").unwrap();
        remove("cut").unwrap();
        assert_eq!(list()[0]["on"], true);
        assert_eq!(list().len(), BUILT_IN.len());
        std::env::remove_var("ROUGHCUT_SKILLS");
        let _ = fs::remove_dir_all(&d);
    }
}
