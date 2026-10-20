//! Verbal markers: what Luke says while filming to mark a bad take ("cut
//! that", "again"). Mirrors findRetakes in src/lib/edl.ts.

use crate::edits::Word;

const CUES: [&str; 15] = [
    "cut that", "cut this", "scratch that", "let me redo that", "let me redo this", "let me do that again", "let me try that again",
    "let me say that again", "let me start again", "let me start over", "start again", "from the top", "take two", "one more time", "again",
];
const LOOSE: [&str; 5] = ["again", "start again", "from the top", "take two", "one more time"];

fn bare(t: &str) -> String {
    t.to_lowercase().chars().filter(|c| c.is_ascii_lowercase() || *c == '\'').collect()
}

fn ends(t: &str) -> bool {
    t.trim().ends_with(['.', '?', '!'])
}

/// (first, last, reason) for each take Luke marked: from the start of the
/// take before the cue through the cue.
pub fn find(words: &[Word]) -> Vec<(usize, usize, String)> {
    let mut found = vec![];
    let mut floor = 0;
    let mut c = 0;
    while c < words.len() {
        let cue = CUES.iter().find(|q| q.split(' ').enumerate().all(|(k, w)| words.get(c + k).map(|x| bare(&x.text) == w).unwrap_or(false)));
        let Some(cue) = cue else {
            c += 1;
            continue;
        };
        let loose = LOOSE.contains(cue);
        let end = c + cue.split(' ').count() - 1;
        let before = if c > 0 { words[c].start - words[c - 1].end } else { 9.0 };
        let after = if end + 1 < words.len() { words[end + 1].start - words[end].end } else { 9.0 };
        let (need_before, need_after) = if loose { (0.6, 0.6) } else { (0.3, 0.4) };
        let ok_before = before >= need_before || (!loose && c > 0 && words[c - 1].text.trim().ends_with(['.', ',', '?', '!']));
        let ok_after = after >= need_after || (!loose && ends(&words[end].text));
        if !ok_before || !ok_after {
            c += 1;
            continue;
        }
        let mut first = c;
        if c > floor {
            first = c - 1;
            while first > floor && c - first < 40 && !ends(&words[first - 1].text) && words[first].start - words[first - 1].end < 0.8 {
                first -= 1;
            }
        }
        found.push((first, end, format!("You said \"{cue}\"")));
        floor = end + 1;
        c = end + 1;
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_marked_takes() {
        let spec = [
            ("Hello", 0.0, 0.3), ("there.", 0.3, 0.6),
            ("This", 0.8, 1.0), ("is", 1.0, 1.1), ("the", 1.1, 1.2), ("wrong", 1.2, 1.5), ("bit,", 1.5, 1.8),
            ("cut", 2.6, 2.8), ("that.", 2.8, 3.0),
            ("This", 4.0, 4.2), ("is", 4.2, 4.3), ("the", 4.3, 4.4), ("right", 4.4, 4.7), ("bit.", 4.7, 5.0),
            ("Let's", 5.2, 5.4), ("do", 5.4, 5.5), ("it", 5.5, 5.6), ("again", 5.6, 5.9), ("tomorrow.", 5.9, 6.3),
            ("Again.", 7.5, 7.8),
        ];
        let words: Vec<Word> = spec.iter().map(|(t, s, e)| Word { text: t.to_string(), start: *s, end: *e }).collect();
        let found = find(&words);
        assert_eq!(found.len(), 2);
        assert_eq!((found[0].0, found[0].1), (2, 8));
        assert_eq!((found[1].0, found[1].1), (14, 19));
    }
}
