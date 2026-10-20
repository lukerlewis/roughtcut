//! Motion graphics: HyperFrames compositions (animated HTML pages) placed on
//! the timeline. Each one lives in the project folder as
//! `graphics/<slug>/source.html` (the composition as made, from the
//! catalogue or by Claude) and `index.html` (the same with Luke's settings
//! applied, written by the editor), next to `graphics/lib` (GSAP and the
//! HyperFrames runtime). The editor plays index.html in the viewer; the
//! export renders it with HyperFrames' own renderer.

use serde_json::Value;
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

/// The catalogue: name, title, description, group, duration, size, params.
pub fn catalog() -> Value {
    fs::read_to_string(bundled().join("catalog.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .map(|v| v["graphics"].clone())
        .unwrap_or(Value::Array(vec![]))
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
        let dest = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &dest)?;
        } else {
            fs::copy(entry.path(), dest)?;
        }
    }
    Ok(())
}

/// A folder name under graphics/ not yet taken, from `name`.
fn slug(folder: &Path, name: &str) -> String {
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
    while folder.join("graphics").join(&s).exists() {
        s = format!("{base}-{n}");
        n += 1;
    }
    s
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

/// Copies a catalogue graphic into the project. Returns its folder name.
pub fn add_from_catalog(folder: &Path, name: &str) -> Result<String, String> {
    let item = find(name).ok_or_else(|| format!("There's no graphic called “{name}” in the catalogue."))?;
    let s = slug(folder, item["name"].as_str().unwrap_or(name));
    let dir = folder.join("graphics").join(&s);
    copy_dir(&bundled().join(name.trim()), &dir).map_err(|e| format!("Couldn't add the graphic: {e}"))?;
    fs::rename(dir.join("index.html"), dir.join("source.html")).map_err(|e| e.to_string())?;
    ensure_lib(folder)?;
    let html = fs::read_to_string(dir.join("source.html")).map_err(|e| e.to_string())?;
    fs::write(dir.join("index.html"), &html).map_err(|e| e.to_string())?;
    Ok(s)
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
fn check(html: &str) -> Result<(), String> {
    if !html.contains("data-composition-id") {
        return Err("A graphic needs a root element with data-composition-id, data-width, data-height and data-duration.".into());
    }
    if !html.contains("__timelines") {
        return Err("A graphic needs its GSAP timeline (paused) registered as window.__timelines[\"<composition id>\"].".into());
    }
    Ok(())
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
        let _ = fs::remove_dir_all(&folder);
    }
}
