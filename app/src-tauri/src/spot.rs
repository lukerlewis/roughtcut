//! "Suggest graphics", in two passes so a video that needs none costs little.
//! Spotting: a quick model reads only the kept transcript (no tools, no
//! pictures) and names the few moments a visual would help, or none.
//! Building: the sidebar Claude makes just those, with the roughcut tools,
//! filling in catalogue graphics and writing new ones only when it must.

use crate::{edits, graphics, style};
use serde_json::{json, Value};
use std::path::Path;

const SCHEMA: &str = r#"{"type":"object","properties":{"moments":{"type":"array","items":{"type":"object","properties":{"from":{"type":"integer"},"to":{"type":"integer"},"catalog":{"type":"string"},"idea":{"type":"string"},"why":{"type":"string"}},"required":["from","to","catalog","idea","why"]}}},"required":["moments"]}"#;

/// The kept words as numbered lines of about a sentence.
fn transcript(words: &[edits::Word], kinds: &[edits::Kind]) -> String {
    let mut out = String::new();
    let mut line: Vec<&str> = vec![];
    let mut first = 0;
    for (i, w) in words.iter().enumerate() {
        if kinds[i] != edits::Kind::Kept {
            continue;
        }
        if line.is_empty() {
            first = i;
        }
        line.push(&w.text);
        let end = w.text.ends_with(['.', '?', '!']) || line.len() >= 30;
        let gap = words.get(i + 1).map(|n| n.start - w.end > 1.0).unwrap_or(true);
        if end || gap || i + 1 == words.len() {
            out += &format!("[{first}-{i}] {}\n", line.join(" "));
            line.clear();
        }
    }
    out
}

/// How many graphics at most, for this setting and length of cut.
pub fn budget(level: &str, seconds: f64) -> usize {
    match level {
        "off" => 0,
        "more" => ((seconds / 30.0).ceil() as usize).clamp(1, 10),
        _ => ((seconds / 90.0).ceil() as usize).clamp(1, 4),
    }
}

fn prompt(folder: &Path) -> Result<Option<(String, usize)>, String> {
    let words = edits::load_words(folder)?;
    let e = edits::load(folder)?;
    let kinds = edits::kinds(words.len(), &e);
    let st = style::load();
    let level = st["graphics"].as_str().unwrap_or("light");
    let length = edits::kept_length(&words, &kinds, words.last().map(|w| w.end).unwrap_or(0.0));
    let most = budget(level, length);
    if most == 0 || words.is_empty() {
        return Ok(None);
    }
    let catalogue: Vec<String> = graphics::catalog()
        .as_array()
        .into_iter()
        .flatten()
        .map(|g| {
            let d = g["description"].as_str().unwrap_or("");
            let d: String = d.chars().take(90).collect();
            format!("- {} ({}): {d}", g["name"].as_str().unwrap_or(""), g["group"].as_str().unwrap_or(""))
        })
        .collect();
    let placed: Vec<String> = e
        .other
        .get("graphics")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|g| g["status"] != "restored")
        .map(|g| format!("- \"{}\" at {:.1}-{:.1}s", g["name"].as_str().unwrap_or(""), g["start"].as_f64().unwrap_or(0.0), g["end"].as_f64().unwrap_or(0.0)))
        .collect();
    let history = style::corrections(folder).unwrap_or_default();
    let history: String = history.lines().filter(|l| l.contains("graphic")).map(|l| format!("{l}\n")).collect();
    let rules = style::rules_text(&st);
    let p = format!(
        "Luke makes talking-head and screen-share videos. Below is what's said in one, after his cut, as [first-last word] lines.\n\n{}\n\
         Pick the moments where an on-screen motion graphic would genuinely help the viewer: a number or result worth showing big, a name to introduce \
         (once, near the start), a short list or steps, a comparison, a quote, code being discussed, an app or post being talked about. Most sentences need nothing. \
         Pick at most {most}, fewer is better, and none at all if nothing would help; never two within 10 seconds or two that say the same thing.\n\n\
         For each, `from`/`to` are the word numbers it should sit over, `catalog` is the best fitting graphic from this list (Luke's own, group Yours, come first: prefer them when they fit; or \"\" if none fits and a new one \
         must be made, which is costly, so only for something clearly worth it), `idea` says in a few words what it shows using the actual words or numbers said \
         (\"30 days, big\"), and `why` is one short sentence for Luke.\n\nCatalogue:\n{}\n\n{}{}{}",
        transcript(&words, &kinds),
        catalogue.join("\n"),
        if placed.is_empty() { String::new() } else { format!("Already on screen (don't repeat):\n{}\n\n", placed.join("\n")) },
        if history.is_empty() { String::new() } else { format!("What Luke kept and removed before (follow his taste):\n{history}\n") },
        rules,
    );
    Ok(Some((p, most)))
}

/// Spotting: the moments worth a graphic, as [{from, to, catalog, idea, why}].
pub fn spot(folder: &Path) -> Result<Value, String> {
    let Some((p, most)) = prompt(folder)? else { return Ok(json!([])) };
    let words = edits::load_words(folder)?.len();
    let answer = style::ask_json(folder, "sonnet", SCHEMA, &p)?;
    Ok(clean(&answer["moments"], words, most))
}

/// Keeps moments with real word numbers and catalogue names, in order, no more than `most`.
fn clean(moments: &Value, words: usize, most: usize) -> Value {
    let mut out: Vec<Value> = moments
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let (a, b) = (m["from"].as_u64()? as usize, m["to"].as_u64()? as usize);
            if a > b || b >= words {
                return None;
            }
            let catalog = m["catalog"].as_str().filter(|c| graphics::find(c).is_some()).unwrap_or("");
            Some(json!({ "from": a, "to": b, "catalog": catalog, "idea": m["idea"].as_str().unwrap_or("").trim(), "why": m["why"].as_str().unwrap_or("").trim() }))
        })
        .collect();
    out.sort_by_key(|m| m["from"].as_u64());
    out.truncate(most);
    Value::Array(out)
}

/// Building: what the sidebar Claude is asked to do with the moments.
pub fn build_prompt(moments: &Value) -> String {
    let list: Vec<String> = moments
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(i, m)| {
            let what = match m["catalog"].as_str().filter(|c| !c.is_empty()) {
                Some(c) => format!("catalogue graphic {c}"),
                None => "a new graphic you write".into(),
            };
            format!("{}. words {}-{}: {what}, showing {}", i + 1, m["from"], m["to"], m["idea"].as_str().unwrap_or(""))
        })
        .collect();
    format!(
        "Add these motion graphics, each as its own add_graphic over its words, with the idea as its reason:\n{}\n\n\
         For a catalogue graphic, call list_graphics with its name, then fill its words (`texts`) and settings (`params`) with what's said; \
         leave out words it doesn't need by replacing them with the closest short fit. Only for \"a new graphic you write\", read graphics_guide once \
         and write a small one in Luke's brand. Don't call get_edit or add anything else. When done, tell me in one sentence what you added.",
        list.join("\n")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spotting_is_bounded_and_clean() {
        assert_eq!(budget("off", 600.0), 0);
        assert_eq!(budget("light", 60.0), 1);
        assert_eq!(budget("light", 600.0), 4);
        assert_eq!(budget("more", 100.0), 4);
        let got = clean(
            &json!([
                { "from": 9, "to": 12, "catalog": "lt-clean-bar", "idea": "Luke", "why": "x" },
                { "from": 2, "to": 3, "catalog": "made-up", "idea": "30 days", "why": "y" },
                { "from": 5, "to": 40, "catalog": "", "idea": "z", "why": "z" },
            ]),
            20,
            5,
        );
        assert_eq!(got.as_array().unwrap().len(), 2);
        assert_eq!(got[0]["from"], 2);
        assert_eq!(got[0]["catalog"], "");
        assert_eq!(got[1]["catalog"], "lt-clean-bar");
        let p = build_prompt(&got);
        assert!(p.contains("1. words 2-3: a new graphic you write, showing 30 days"), "{p}");
        assert!(p.contains("2. words 9-12: catalogue graphic lt-clean-bar"), "{p}");
        let words: Vec<edits::Word> = "So I tried it. Then".split(' ').enumerate().map(|(i, w)| edits::Word { text: w.into(), start: i as f64, end: i as f64 + 0.5 }).collect();
        let kinds = vec![edits::Kind::Kept, edits::Kind::You, edits::Kind::Kept, edits::Kind::Kept, edits::Kind::Kept];
        assert_eq!(transcript(&words, &kinds), "[0-3] So tried it.\n[4-4] Then\n");
    }
}
