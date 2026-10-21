//! Motion graphics: HyperFrames compositions (animated HTML pages) placed on
//! the timeline. Each one lives in the project folder as
//! `graphics/<slug>/source.html` (the composition as made, from the
//! catalogue or by Claude) and `index.html` (the same with Luke's settings
//! applied, written by the editor), next to `graphics/lib` (GSAP and the
//! HyperFrames runtime). The editor plays index.html in the viewer; the
//! export renders it with HyperFrames' own renderer.

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

/// The graphics that ship with the app (app/graphics, from HyperFrames' catalogue).
pub fn bundled() -> PathBuf {
    if let Some(p) = std::env::var_os("ROUGHCUT_GRAPHICS") {
        return p.into();
    }
    // In the app: Roughcut.app/Contents/MacOS/roughcut -> Contents/Resources/graphics.
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join("../Resources/graphics"))) {
        if dir.join("catalog.json").exists() {
            return dir;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../graphics")
}

/// Graphics Luke saved from his projects to use again ("Yours"), beside his style.
pub fn saved() -> PathBuf {
    if let Some(p) = std::env::var_os("ROUGHCUT_SAVED_GRAPHICS") {
        return p.into();
    }
    crate::style::path().parent().map(Path::to_path_buf).unwrap_or_default().join("graphics")
}

/// Where a catalogue name's files are: "mine/<folder>" is one of Luke's.
fn origin(name: &str) -> Option<PathBuf> {
    let name = name.trim();
    match name.strip_prefix("mine/") {
        Some(rest) if !rest.is_empty() && !rest.contains('/') && !rest.contains("..") => Some(saved().join(rest)),
        Some(_) => None,
        None if !name.is_empty() && !name.contains('/') && !name.contains("..") => Some(bundled().join(name)),
        None => None,
    }
}

fn mine() -> Vec<Value> {
    let mut out: Vec<(String, Value)> = fs::read_dir(saved())
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|d| {
            let t: Value = serde_json::from_str(&fs::read_to_string(d.path().join("template.json")).ok()?).ok()?;
            let name = format!("mine/{}", d.file_name().to_string_lossy());
            let mut g = t.clone();
            g["name"] = Value::String(name.clone());
            g["group"] = Value::String("Yours".into());
            if g["description"].is_null() {
                g["description"] = Value::String("One of yours.".into());
            }
            Some((t["saved"].as_str().unwrap_or("").to_string(), g))
        })
        .collect();
    out.sort_by(|a, b| b.0.cmp(&a.0)); // newest first
    out.into_iter().map(|(_, g)| g).collect()
}

/// The catalogue: Luke's own first, then HyperFrames'. Each has name, title,
/// description, group, duration, size and params (and, for his, the
/// `values` and `texts` he saved it with).
pub fn catalog() -> Value {
    let shipped = fs::read_to_string(bundled().join("catalog.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v["graphics"].as_array().cloned())
        .unwrap_or_default();
    Value::Array(mine().into_iter().chain(shipped).collect())
}

pub fn find(name: &str) -> Option<Value> {
    catalog().as_array()?.iter().find(|g| g["name"].as_str() == Some(name.trim())).cloned()
}

/// "name: title. description" per line, for Claude.
pub fn describe() -> String {
    catalog()
        .as_array()
        .into_iter()
        .flatten()
        .map(|g| {
            format!(
                "- {} ({}, {}s{}): {}",
                g["name"].as_str().unwrap_or(""),
                g["group"].as_str().unwrap_or(""),
                g["duration"].as_f64().unwrap_or(5.0),
                if g["height"].as_u64() > g["width"].as_u64() { ", portrait" } else { "" },
                g["description"].as_str().unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let n = entry.file_name().to_string_lossy().to_string();
        // Renders and the renderer's own state stay with the project they were made in.
        if n == ".hyperframes" || (n.starts_with("render") && n.ends_with(".mov")) {
            continue;
        }
        let dest = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &dest)?;
        } else {
            fs::copy(entry.path(), dest)?;
        }
    }
    Ok(())
}

/// A folder name in `parent` not yet taken, from `name`.
fn slug_in(parent: &Path, name: &str) -> String {
    let base: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let base = if base.is_empty() || base == "lib" { "graphic".to_string() } else { base.chars().take(40).collect() };
    let mut s = base.clone();
    let mut n = 2;
    while parent.join(&s).exists() {
        s = format!("{base}-{n}");
        n += 1;
    }
    s
}

/// A folder name under the project's graphics/ not yet taken.
fn slug(folder: &Path, name: &str) -> String {
    slug_in(&folder.join("graphics"), name)
}

/// GSAP and the runtime, beside the project's graphics.
fn ensure_lib(folder: &Path) -> Result<(), String> {
    let lib = folder.join("graphics/lib");
    if !lib.join("hyperframes-runtime.js").exists() {
        copy_dir(&bundled().join("lib"), &lib).map_err(|e| format!("Couldn't set up the graphics: {e}"))?;
    }
    Ok(())
}

/// Points GSAP from a CDN at the project's copy, so graphics work offline and
/// render without the network.
pub fn localise(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(i) = rest.find("<script") {
        let Some(end) = rest[i..].find("</script>").map(|e| i + e + "</script>".len()) else { break };
        let tag = &rest[i..end];
        out += &rest[..i];
        let open = &tag[..tag.find('>').unwrap_or(tag.len())];
        let is_gsap = open.contains("src=") && (open.contains("/gsap@") || open.contains("/gsap/")) && open.contains("gsap.min.js");
        out += if is_gsap { r#"<script src="../lib/gsap.min.js"></script>"# } else { tag };
        rest = &rest[end..];
    }
    out + rest
}

/// Copies a catalogue graphic (or one of Luke's) into the project. Returns its folder name.
pub fn add_from_catalog(folder: &Path, name: &str) -> Result<String, String> {
    find(name).ok_or_else(|| format!("There's no graphic called “{name}” in the catalogue."))?;
    let from = origin(name).ok_or("That isn't a graphic.")?;
    let base = name.trim().strip_prefix("mine/").unwrap_or(name.trim());
    let s = slug(folder, base);
    let dir = folder.join("graphics").join(&s);
    copy_dir(&from, &dir).map_err(|e| format!("Couldn't add the graphic: {e}"))?;
    let _ = fs::remove_file(dir.join("template.json"));
    if !dir.join("source.html").exists() {
        fs::rename(dir.join("index.html"), dir.join("source.html")).map_err(|e| e.to_string())?;
    }
    ensure_lib(folder)?;
    let html = fs::read_to_string(dir.join("source.html")).map_err(|e| e.to_string())?;
    fs::write(dir.join("index.html"), &html).map_err(|e| e.to_string())?;
    Ok(s)
}

/// Saves a project's graphic as one of Luke's, with the settings and words
/// he gave it (`info`: title, duration, width, height, params, values, texts).
/// Returns its catalogue name.
pub fn save_template(folder: &Path, slug: &str, info: &Value) -> Result<String, String> {
    let from = dir(folder, slug)?;
    let title = info["title"].as_str().map(str::trim).filter(|t| !t.is_empty()).ok_or("Give it a name.")?;
    fs::create_dir_all(saved()).map_err(|e| e.to_string())?;
    let s = slug_in(&saved(), title);
    let to = saved().join(&s);
    copy_dir(&from, &to).map_err(|e| format!("Couldn't save the graphic: {e}"))?;
    let _ = fs::remove_file(to.join("index.html"));
    let mut t = json!({
        "title": title,
        "duration": info["duration"].as_f64().unwrap_or(5.0),
        "width": info["width"].as_u64().unwrap_or(1920),
        "height": info["height"].as_u64().unwrap_or(1080),
        "params": info["params"].as_array().cloned().unwrap_or_default(),
        "saved": crate::edits::now(),
    });
    for key in ["values", "texts", "description"] {
        if !info[key].is_null() {
            t[key] = info[key].clone();
        }
    }
    fs::write(to.join("template.json"), serde_json::to_string_pretty(&t).unwrap()).map_err(|e| e.to_string())?;
    Ok(format!("mine/{s}"))
}

/// Forgets one of Luke's saved graphics.
pub fn forget_template(name: &str) -> Result<(), String> {
    match name.trim().strip_prefix("mine/").and(origin(name)) {
        Some(d) if d.join("template.json").exists() => fs::remove_dir_all(d).map_err(|e| e.to_string()),
        _ => Err("That isn't one of your graphics.".into()),
    }
}

/// A new graphic from a whole composition (Claude's). Returns its folder name.
pub fn create(folder: &Path, name: &str, html: &str) -> Result<String, String> {
    check(html)?;
    let s = slug(folder, name);
    let dir = folder.join("graphics").join(&s);
    fs::create_dir_all(&dir).map_err(|e| format!("Couldn't add the graphic: {e}"))?;
    ensure_lib(folder)?;
    let html = localise(html);
    fs::write(dir.join("source.html"), &html).map_err(|e| e.to_string())?;
    fs::write(dir.join("index.html"), &html).map_err(|e| e.to_string())?;
    Ok(s)
}

/// Replaces a graphic's composition (Claude changing it).
pub fn replace(folder: &Path, slug: &str, html: &str) -> Result<(), String> {
    check(html)?;
    let dir = dir(folder, slug)?;
    let html = localise(html);
    fs::write(dir.join("source.html"), &html).map_err(|e| e.to_string())?;
    fs::write(dir.join("index.html"), &html).map_err(|e| e.to_string())
}

/// The bones HyperFrames needs: a root with data-composition-id and a
/// timeline registered on window.__timelines.
pub fn check(html: &str) -> Result<(), String> {
    if !html.contains("data-composition-id") {
        return Err("A graphic needs a root element with data-composition-id, data-width, data-height and data-duration.".into());
    }
    if !html.contains("__timelines") {
        return Err("A graphic needs its GSAP timeline (paused) registered as window.__timelines[\"<composition id>\"].".into());
    }
    Ok(())
}

/// Where each piece of text written in a composition's body sits (byte
/// ranges, trimmed), skipping scripts, styles and drawings.
fn text_runs(html: &str) -> Vec<(usize, usize)> {
    let lower = html.to_ascii_lowercase();
    let b = html.as_bytes();
    let mut i = lower.find("<body").unwrap_or(0);
    let mut out = vec![];
    while i < html.len() {
        if b[i] == b'<' {
            if lower[i..].starts_with("<!--") {
                i = lower[i..].find("-->").map(|e| i + e + 3).unwrap_or(html.len());
                continue;
            }
            for tag in ["script", "style", "svg", "title", "template", "noscript"] {
                let after = lower.as_bytes().get(i + 1 + tag.len()).copied().unwrap_or(b'>');
                if lower[i + 1..].starts_with(tag) && !after.is_ascii_alphanumeric() && after != b'-' {
                    if let Some(e) = lower[i..].find(&format!("</{tag}")) {
                        i += e;
                    }
                    break;
                }
            }
            i = match html[i..].find('>') {
                Some(e) => i + e + 1,
                None => break,
            };
        } else {
            let end = html[i..].find('<').map(|e| i + e).unwrap_or(html.len());
            let seg = &html[i..end];
            let t = seg.trim();
            if !t.is_empty() {
                let s = i + (seg.len() - seg.trim_start().len());
                out.push((s, s + t.len()));
            }
            i = end;
        }
    }
    out
}

fn plain(raw: &str) -> String {
    let t = raw
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&amp;", "&");
    t.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The words written in a composition, in order: what `texts` can replace.
pub fn texts(html: &str) -> Vec<String> {
    text_runs(html).into_iter().map(|(a, b)| plain(&html[a..b])).collect()
}

/// Replaces written words (old -> new). Errors name any it couldn't find.
pub fn apply_texts(html: &str, changes: &serde_json::Map<String, Value>) -> Result<String, String> {
    let runs = text_runs(html);
    let mut taken = vec![false; runs.len()];
    let mut edits: Vec<(usize, usize, String)> = vec![];
    let mut missing = vec![];
    for (old, new) in changes {
        let (old, new) = (plain(old), new.as_str().unwrap_or("").trim().to_string());
        let hit = (0..runs.len()).find(|&k| !taken[k] && plain(&html[runs[k].0..runs[k].1]) == old);
        match hit {
            Some(k) => {
                taken[k] = true;
                let escaped = new.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
                edits.push((runs[k].0, runs[k].1, escaped));
            }
            None => missing.push(format!("\"{old}\"")),
        }
    }
    if !missing.is_empty() {
        return Err(format!(
            "Couldn't find {} in the graphic. Its words are: {}. Words a graphic makes in its script are settings (params) instead.",
            missing.join(", "),
            texts(html).iter().map(|t| format!("\"{t}\"")).collect::<Vec<_>>().join(", ")
        ));
    }
    edits.sort_by_key(|e| std::cmp::Reverse(e.0));
    let mut out = html.to_string();
    for (a, b, new) in edits {
        out.replace_range(a..b, &new);
    }
    Ok(out)
}

/// A catalogue graphic for Claude: what it's for, its words and its settings.
pub fn details(name: &str) -> Result<String, String> {
    let item = find(name).ok_or_else(|| format!("There's no graphic called “{name}” in the catalogue."))?;
    let from = origin(name).ok_or("That isn't a graphic.")?;
    let html = fs::read_to_string(from.join("source.html")).or_else(|_| fs::read_to_string(from.join("index.html"))).map_err(|e| e.to_string())?;
    let words = texts(&html);
    let mut s = format!(
        "{} ({}, made {}s long, {}x{}): {}\n",
        item["name"].as_str().unwrap_or(name),
        item["group"].as_str().unwrap_or(""),
        item["duration"].as_f64().unwrap_or(5.0),
        item["width"].as_u64().unwrap_or(1920),
        item["height"].as_u64().unwrap_or(1080),
        item["description"].as_str().unwrap_or("")
    );
    s += &if words.is_empty() { "Words: none written in the page.\n".to_string() } else { format!("Words (replace with `texts`, old -> new): {}\n", words.iter().map(|t| format!("\"{t}\"")).collect::<Vec<_>>().join(", ")) };
    let mut settings: Vec<String> = item["params"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| Some(format!("{} ({}, {}, default {})", p["key"].as_str().filter(|k| k.starts_with("--"))?, p["label"].as_str().unwrap_or(""), p["type"].as_str().unwrap_or(""), p["default"])))
        .collect();
    if let Some(at) = html.find("data-composition-variables='") {
        let rest = &html[at + "data-composition-variables='".len()..];
        if let Some(list) = rest.find('\'').and_then(|e| serde_json::from_str::<Value>(&rest[..e]).ok()) {
            for d in list.as_array().into_iter().flatten() {
                settings.push(format!("{} ({}, {}, default {})", d["id"].as_str().unwrap_or(""), d["label"].as_str().unwrap_or(""), d["type"].as_str().unwrap_or(""), d["default"]));
            }
        }
    }
    s += &if settings.is_empty() { "Settings: none.\n".to_string() } else { format!("Settings (set with `params`, key -> value): {}\n", settings.join("; ")) };
    if item["values"].as_object().is_some_and(|v| !v.is_empty()) {
        s += &format!("Luke saved it with these settings (used unless you change them): {}\n", item["values"]);
    }
    Ok(s)
}

/// How to write a graphic: HyperFrames' rules for agents, cut to what
/// matters here, plus Roughcut's own.
pub fn guide() -> String {
    fs::read_to_string(bundled().join("GUIDE.md")).unwrap_or_else(|_| "The guide is missing from the app.".into())
}

pub fn dir(folder: &Path, slug: &str) -> Result<PathBuf, String> {
    if slug.is_empty() || slug == "lib" || slug.contains('/') || slug.contains("..") {
        return Err("That isn't a graphic.".into());
    }
    let d = folder.join("graphics").join(slug);
    if d.join("source.html").exists() {
        Ok(d)
    } else {
        Err(format!("The graphic “{slug}” is missing from the project folder."))
    }
}

pub fn source(folder: &Path, slug: &str) -> Result<String, String> {
    fs::read_to_string(dir(folder, slug)?.join("source.html")).map_err(|e| e.to_string())
}

/// The editor's version with Luke's settings applied, which plays and renders.
pub fn write_view(folder: &Path, slug: &str, html: &str) -> Result<(), String> {
    fs::write(dir(folder, slug)?.join("index.html"), html).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gsap_comes_from_the_project() {
        let html = r#"<head><script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script><script>var a = "<b>";</script></head>"#;
        assert_eq!(localise(html), r#"<head><script src="../lib/gsap.min.js"></script><script>var a = "<b>";</script></head>"#);
    }

    #[test]
    fn adds_catalogue_graphics_to_the_project() {
        let folder = std::env::temp_dir().join(format!("roughcut-graphics-{}", std::process::id()));
        let _ = fs::remove_dir_all(&folder);
        fs::create_dir_all(&folder).unwrap();
        assert!(catalog().as_array().unwrap().len() > 20);
        assert!(describe().contains("lt-clean-bar"));
        let a = add_from_catalog(&folder, "lt-clean-bar").unwrap();
        let b = add_from_catalog(&folder, "lt-clean-bar").unwrap();
        assert_eq!((a.as_str(), b.as_str()), ("lt-clean-bar", "lt-clean-bar-2"));
        assert!(source(&folder, &a).unwrap().contains("../lib/gsap.min.js"));
        assert!(folder.join("graphics/lib/hyperframes-runtime.js").exists());
        // Its fonts come along.
        let c = add_from_catalog(&folder, "lower-third-bild").unwrap();
        assert!(folder.join("graphics").join(c).join("assets/fonts/BarlowCondensed-Bold.woff2").exists());
        assert!(create(&folder, "x", "<div>no</div>").is_err());
        let d = create(&folder, "My Stat!", r#"<div data-composition-id="s"></div><script>window.__timelines={}</script>"#).unwrap();
        assert_eq!(d, "my-stat");
        assert!(dir(&folder, "../x").is_err());
        // Words Claude can replace.
        let html = source(&folder, &a).unwrap();
        let words = texts(&html);
        assert!(!words.is_empty() && !words.iter().any(|w| w.contains("gsap")), "{words:?}");
        let mut change = serde_json::Map::new();
        change.insert(words[0].clone(), Value::String("Luke & co".into()));
        let changed = apply_texts(&html, &change).unwrap();
        assert_eq!(texts(&changed)[0], "Luke & co");
        assert!(changed.contains("Luke &amp; co"));
        change.insert("Not in it".into(), Value::String("x".into()));
        assert!(apply_texts(&html, &change).unwrap_err().contains("Not in it"));
        assert!(details("lower-third-bild").unwrap().contains("TXT_SUB"));
        assert!(guide().contains("__timelines"));
        // Luke saves one of his to use again; it comes first in the catalogue.
        std::env::set_var("ROUGHCUT_SAVED_GRAPHICS", folder.join("saved"));
        let mine = save_template(&folder, &a, &json!({ "title": "My name card", "duration": 3.0, "values": { "--accent": "#00ff00" }, "texts": { "0": "Luke" } })).unwrap();
        assert_eq!(mine, "mine/my-name-card");
        assert_eq!(catalog()[0]["name"], "mine/my-name-card");
        assert_eq!(catalog()[0]["group"], "Yours");
        assert!(details(&mine).unwrap().contains("#00ff00"));
        let again = add_from_catalog(&folder, &mine).unwrap();
        assert_eq!(again, "my-name-card");
        assert!(!folder.join("graphics/my-name-card/template.json").exists());
        assert!(origin("mine/../x").is_none());
        forget_template(&mine).unwrap();
        assert!(find(&mine).is_none());
        std::env::remove_var("ROUGHCUT_SAVED_GRAPHICS");
        let _ = fs::remove_dir_all(&folder);
    }
}
