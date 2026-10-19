//! The edit state in edits.json, for when Claude changes it through the MCP
//! server. Mirrors the parts of app/src/lib/edl.ts the tools need, so a cut
//! Claude makes here reads exactly like one made in the app.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::Path;

#[derive(Clone, Deserialize)]
pub struct Word {
    pub text: String,
    pub start: f64,
    pub end: f64,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
pub struct AgentCut {
    pub first: usize,
    pub last: usize,
    pub reason: String,
    pub status: String, // pending | accepted | restored
}

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Debug)]
pub struct Span {
    pub first: usize,
    pub last: usize,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Edits {
    pub version: u32,
    pub agent: Vec<AgentCut>,
    pub user: Vec<Span>,
    pub log: Vec<Value>,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Kind {
    Kept,
    ClaudePending,
    ClaudeKept,
    You,
}

fn read(path: &Path) -> Result<Value, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("Can't read {}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{} isn't valid: {e}", path.display()))
}

pub fn load_words(folder: &Path) -> Result<Vec<Word>, String> {
    serde_json::from_value(read(&folder.join("words.json"))?).map_err(|e| e.to_string())
}

/// edits.json, or Claude's rough cut as unreviewed cuts if the app hasn't saved one yet.
pub fn load(folder: &Path) -> Result<Edits, String> {
    let path = folder.join("edits.json");
    if path.is_file() {
        return serde_json::from_value(read(&path)?).map_err(|e| e.to_string());
    }
    let d = read(&folder.join("decisions.json"))?;
    let agent = d["cuts"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| AgentCut {
            first: c["from"].as_u64().unwrap_or(0) as usize,
            last: c["to"].as_u64().unwrap_or(0) as usize,
            reason: c["reason"].as_str().unwrap_or("").into(),
            status: "pending".into(),
        })
        .collect();
    Ok(Edits { version: 1, agent, user: vec![], log: vec![] })
}

pub fn save(folder: &Path, e: &Edits) -> Result<(), String> {
    let tmp = folder.join(".edits.json.tmp");
    let text = serde_json::to_string_pretty(e).map_err(|e| e.to_string())?;
    fs::write(&tmp, text).map_err(|e| format!("Couldn't save: {e}"))?;
    fs::rename(&tmp, folder.join("edits.json")).map_err(|e| format!("Couldn't save: {e}"))
}

/// Seconds since 1970 as an ISO time, without pulling in a date library.
fn now() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let (days, rem) = (secs / 86400, secs % 86400);
    // Civil date from days since epoch (Howard Hinnant's algorithm).
    let z = days as i64 + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

fn log(e: &mut Edits, op: &str, first: usize, last: usize, note: Option<&str>) {
    let mut entry = serde_json::json!({ "at": now(), "by": "agent", "op": op, "first": first, "last": last });
    if let Some(n) = note {
        entry["note"] = n.into();
    }
    e.log.push(entry);
}

/// Claude cuts words first..last. It shows as an unreviewed (blue) cut.
pub fn cut(e: &mut Edits, first: usize, last: usize, reason: &str) {
    e.agent.push(AgentCut { first, last, reason: reason.into(), status: "pending".into() });
    log(e, "cut", first, last, Some(reason));
}

/// Brings words back, the same way the app's restore does: Luke's cuts in
/// the range are lifted and any of Claude's cuts touching it are restored whole.
pub fn restore(e: &mut Edits, first: usize, last: usize) {
    let mut user = vec![];
    for s in &e.user {
        if s.last < first || s.first > last {
            user.push(*s);
        } else {
            if s.first < first {
                user.push(Span { first: s.first, last: first - 1 });
            }
            if s.last > last {
                user.push(Span { first: last + 1, last: s.last });
            }
        }
    }
    e.user = user;
    for c in &mut e.agent {
        if c.status != "restored" && c.first <= last && c.last >= first {
            c.status = "restored".into();
        }
    }
    log(e, "restore", first, last, None);
}

/// Who cut each word. Luke's own cuts win.
pub fn kinds(n: usize, e: &Edits) -> Vec<Kind> {
    let mut k = vec![Kind::Kept; n];
    for c in e.agent.iter().filter(|c| c.status != "restored") {
        for i in c.first..=c.last.min(n.saturating_sub(1)) {
            k[i] = if c.status == "pending" { Kind::ClaudePending } else { Kind::ClaudeKept };
        }
    }
    for s in &e.user {
        for i in s.first..=s.last.min(n.saturating_sub(1)) {
            k[i] = Kind::You;
        }
    }
    k
}

/// Length of the cut in seconds. Mirrors keptRanges in edl.ts.
pub fn kept_length(words: &[Word], kinds: &[Kind], duration: f64) -> f64 {
    let (pad_in, pad_out, max_pause, min_clip) = (0.08, 0.15, 0.35, 0.25);
    let keep = |i: usize| kinds[i] == Kind::Kept;
    let mut ranges: Vec<(f64, f64)> = vec![];
    let mut prev: Option<usize> = None;
    for (i, w) in words.iter().enumerate() {
        if !keep(i) {
            continue;
        }
        let lo = if i > 0 && !keep(i - 1) { words[i - 1].end } else { 0.0 };
        let hi = if i + 1 < words.len() && !keep(i + 1) { words[i + 1].start } else { duration };
        let a = lo.max(w.start - pad_in).max(0.0);
        let b = hi.min(w.end + pad_out).min(duration);
        match ranges.last_mut() {
            Some(last) if prev == Some(i.wrapping_sub(1)) && w.start - words[i - 1].end <= max_pause => last.1 = last.1.max(b),
            Some(last) if a <= last.1 => last.1 = last.1.max(b),
            _ => ranges.push((a, b)),
        }
        prev = Some(i);
    }
    ranges.iter().map(|(a, b)| b - a).filter(|d| *d >= min_clip).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(n: usize) -> Vec<Word> {
        (0..n).map(|i| Word { text: format!("w{i}"), start: i as f64 * 0.5, end: i as f64 * 0.5 + 0.4 }).collect()
    }

    #[test]
    fn restore_splits_your_cuts_and_restores_claudes_whole() {
        let mut e = Edits { version: 1, agent: vec![], user: vec![Span { first: 2, last: 8 }], log: vec![] };
        cut(&mut e, 10, 12, "filler");
        restore(&mut e, 4, 5);
        restore(&mut e, 11, 11);
        assert_eq!(e.user, vec![Span { first: 2, last: 3 }, Span { first: 6, last: 8 }]);
        assert_eq!(e.agent[0].status, "restored");
        assert_eq!(e.log.len(), 3);
        assert_eq!(e.log[0]["by"], "agent");
    }

    #[test]
    fn kinds_and_length() {
        let w = words(10);
        let mut e = Edits { version: 1, agent: vec![], user: vec![], log: vec![] };
        let full = kept_length(&w, &kinds(10, &e), 5.0);
        cut(&mut e, 3, 5, "retake");
        let k = kinds(10, &e);
        assert_eq!(k[4], Kind::ClaudePending);
        assert!(kept_length(&w, &k, 5.0) < full - 1.0);
    }

    #[test]
    fn time_is_iso() {
        let t = now();
        assert_eq!(t.len(), 20);
        assert!(t.starts_with("20"));
    }
}
