//! FFmpeg work: reading a recording's details, drawing its waveform and
//! rendering the finished cut.

use crate::tools;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::Stdio;

#[derive(Serialize)]
pub struct Info {
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
}

fn rate(s: &str) -> f64 {
    match s.split_once('/') {
        Some((n, d)) => {
            let (n, d) = (n.parse::<f64>().unwrap_or(0.0), d.parse::<f64>().unwrap_or(0.0));
            if d > 0.0 { n / d } else { 0.0 }
        }
        None => s.parse().unwrap_or(0.0),
    }
}

pub fn probe(path: &Path) -> Result<Info, String> {
    let out = tools::command(tools::ffprobe())
        .args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams"])
        .arg(path)
        .output()
        .map_err(|e| format!("Couldn't run ffprobe: {e}"))?;
    if !out.status.success() {
        return Err(format!("ffprobe couldn't read {}", path.display()));
    }
    let v: Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    let video = v["streams"].as_array().and_then(|s| s.iter().find(|s| s["codec_type"] == "video")).cloned().unwrap_or(Value::Null);
    let duration = v["format"]["duration"].as_str().and_then(|d| d.parse().ok()).unwrap_or(0.0);
    let fps = [video["r_frame_rate"].as_str(), video["avg_frame_rate"].as_str()]
        .into_iter()
        .flatten()
        .map(rate)
        .find(|r| *r > 1.0 && *r <= 240.0)
        .unwrap_or(30.0);
    Ok(Info {
        duration,
        width: video["width"].as_u64().unwrap_or(0) as u32,
        height: video["height"].as_u64().unwrap_or(0) as u32,
        fps,
    })
}

/// Loudness every 10ms as 0 to 255, cached next to the cut.
pub fn waveform(path: &Path, cache: &Path) -> Result<Vec<u8>, String> {
    if let Ok(bytes) = fs::read(cache) {
        if !bytes.is_empty() {
            return Ok(bytes);
        }
    }
    const SR: usize = 8000;
    const BIN: usize = SR / 100;
    let mut child = tools::command(tools::ffmpeg())
        .args(["-v", "error", "-i"])
        .arg(path)
        .args(["-vn", "-ac", "1", "-ar", &SR.to_string(), "-f", "s16le", "-"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Couldn't run ffmpeg: {e}"))?;
    let mut raw = Vec::new();
    child.stdout.take().unwrap().read_to_end(&mut raw).map_err(|e| e.to_string())?;
    child.wait().map_err(|e| e.to_string())?;
    let samples: Vec<i16> = raw.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect();
    let peaks: Vec<u8> = samples
        .chunks(BIN)
        .map(|c| {
            let peak = c.iter().map(|s| (*s as i32).unsigned_abs()).max().unwrap_or(0) as f64 / 32768.0;
            // -60 dB to 0 dB onto 0..255, so quiet speech still shows.
            let db = 20.0 * (peak + 1e-9).log10();
            (((db + 60.0) / 60.0).clamp(0.0, 1.0) * 255.0) as u8
        })
        .collect();
    let _ = fs::write(cache, &peaks);
    Ok(peaks)
}

#[derive(Deserialize, Clone, Copy)]
pub struct Zoom {
    pub scale: f64,
    pub x: f64,
    pub y: f64,
}

/// A kept piece of the recording, in source seconds, maybe zoomed in.
#[derive(Deserialize)]
pub struct Segment {
    pub start: f64,
    pub end: f64,
    pub zoom: Option<Zoom>,
}

/// One caption line while one of its words is being said, in cut seconds.
#[derive(Deserialize)]
pub struct Cue {
    pub start: f64,
    pub end: f64,
    pub words: Vec<String>,
    pub active: usize,
}

#[derive(Deserialize)]
pub struct Captions {
    pub style: String, // "bold" or "clean"
    pub cues: Vec<Cue>,
}

/// The filter graph that trims each piece, zooms it if asked, joins them and
/// burns in the captions file if there is one.
pub fn concat_graph(segments: &[Segment], width: u32, height: u32, captions: Option<&Path>) -> String {
    let mut g = String::new();
    for (i, s) in segments.iter().enumerate() {
        let (a, b) = (s.start, s.end);
        let zoom = match s.zoom {
            // Crop the part of the frame the zoom shows, then scale it back to full size.
            Some(z) if z.scale > 1.001 => format!(
                ",crop=w=iw/{k}:h=ih/{k}:x=(iw-iw/{k})*{x}:y=(ih-ih/{k})*{y},scale={width}:{height}",
                k = z.scale,
                x = z.x.clamp(0.0, 1.0),
                y = z.y.clamp(0.0, 1.0)
            ),
            _ => String::new(),
        };
        g += &format!("[0:v]trim={a:.4}:{b:.4},setpts=PTS-STARTPTS{zoom},setsar=1[v{i}];");
        g += &format!("[0:a]atrim={a:.4}:{b:.4},asetpts=PTS-STARTPTS[a{i}];");
    }
    for i in 0..segments.len() {
        g += &format!("[v{i}][a{i}]");
    }
    let n = segments.len();
    match captions {
        Some(file) => {
            let f = file.to_string_lossy().replace('\\', "/").replace('\'', "");
            g + &format!("concat=n={n}:v=1:a=1[vc][a];[vc]subtitles=filename='{f}'[v]")
        }
        None => g + &format!("concat=n={n}:v=1:a=1[v][a]"),
    }
}

fn ass_time(t: f64) -> String {
    let cs = (t.max(0.0) * 100.0).round() as u64;
    format!("{}:{:02}:{:02}.{:02}", cs / 360000, cs / 6000 % 60, cs / 100 % 60, cs % 100)
}

/// Captions as an ASS subtitle file sized to the video. Bold: big capitals
/// with an outline and the spoken word in yellow. Clean: smaller sentence
/// case on a soft dark box. The editor's preview draws the same two styles.
pub fn ass(captions: &Captions, width: u32, height: u32) -> String {
    let h = height as f64;
    let margin = (width as f64 * 0.08).round();
    let mut s = format!(
        "[Script Info]\nScriptType: v4.00+\nPlayResX: {width}\nPlayResY: {height}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n\
         [V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, \
         Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n\
         Style: bold,Helvetica Neue,{},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,{},0,2,{margin},{margin},{},1\n\
         Style: clean,Helvetica Neue,{},&H00FFFFFF,&H00FFFFFF,&H80000000,&H80000000,0,0,0,0,100,100,0,0,3,{},0,2,{margin},{margin},{},1\n\n\
         [Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n",
        (h * 0.065).round(),
        (h * 0.0055).max(1.0).round(),
        (h * 0.12).round(),
        (h * 0.045).round(),
        (h * 0.012).max(1.0).round(),
        (h * 0.07).round(),
    );
    let bold = captions.style != "clean";
    for c in &captions.cues {
        let words: Vec<String> = c
            .words
            .iter()
            .enumerate()
            .map(|(i, w)| {
                let w = w.replace(['{', '}'], "").replace('\\', "/");
                let w = if bold { w.to_uppercase() } else { w };
                if bold && i == c.active {
                    format!("{{\\c&H0AD6FF&}}{w}{{\\c&HFFFFFF&}}")
                } else {
                    w
                }
            })
            .collect();
        let style = if bold { "bold" } else { "clean" };
        s += &format!("Dialogue: 0,{},{},{style},,0,0,0,,{}\n", ass_time(c.start), ass_time(c.end), words.join(" "));
    }
    s
}

/// Renders the cut at full quality. Calls `progress` with 0..1 as it goes.
/// Tries the Mac's hardware encoder first and falls back to x264, so a
/// machine (or FFmpeg build) without it still exports.
pub fn export(source: &Path, segments: &[Segment], captions: Option<&Captions>, dest: &Path, progress: impl Fn(f64)) -> Result<(), String> {
    if segments.is_empty() {
        return Err("Nothing is kept, so there's nothing to export.".into());
    }
    // A generous bitrate for the size: about 12 Mbit/s for 1080p30 and 50 for 4K30.
    let info = probe(source)?;
    let bitrate = ((info.width as f64 * info.height as f64 * info.fps * 0.2) as u64).max(4_000_000).to_string();
    let subs = match captions {
        Some(c) if !c.cues.is_empty() => {
            let file = std::env::temp_dir().join(format!("roughcut-captions-{}.ass", std::process::id()));
            fs::write(&file, ass(c, info.width, info.height)).map_err(|e| format!("Couldn't write the captions: {e}"))?;
            Some(file)
        }
        _ => None,
    };
    let graph = concat_graph(segments, info.width, info.height, subs.as_deref());
    let total: f64 = segments.iter().map(|s| s.end - s.start).sum();
    let mut encoders: Vec<Vec<&str>> = Vec::new();
    if cfg!(target_os = "macos") {
        encoders.push(vec!["-c:v", "h264_videotoolbox", "-b:v", &bitrate]);
    }
    encoders.push(vec!["-c:v", "libx264", "-preset", "medium", "-crf", "18"]);
    let mut result = Err(String::new());
    for video in &encoders {
        result = encode(source, &graph, total, dest, video, &progress);
        if result.is_ok() {
            break;
        }
    }
    if let Some(f) = subs {
        let _ = fs::remove_file(f);
    }
    match result {
        Ok(()) => {
            progress(1.0);
            Ok(())
        }
        Err(last) => {
            let _ = fs::remove_file(dest);
            Err(format!("The export failed: {last}"))
        }
    }
}

fn encode(source: &Path, graph: &str, total: f64, dest: &Path, video: &[&str], progress: &impl Fn(f64)) -> Result<(), String> {
    let mut child = tools::command(tools::ffmpeg())
        .args(["-v", "error", "-y", "-i"])
        .arg(source)
        .arg("-filter_complex")
        .arg(graph)
        .args(["-map", "[v]", "-map", "[a]"])
        .args(video)
        .args(["-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-progress", "pipe:1"])
        .arg(dest)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't run ffmpeg: {e}"))?;
    for line in BufReader::new(child.stdout.take().unwrap()).lines().map_while(Result::ok) {
        if let Some(us) = line.strip_prefix("out_time_us=").and_then(|v| v.parse::<f64>().ok()) {
            progress((us / 1e6 / total).clamp(0.0, 1.0));
        }
    }
    let mut err = String::new();
    if let Some(mut e) = child.stderr.take() {
        let _ = e.read_to_string(&mut err);
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(err.trim().lines().last().unwrap_or("ffmpeg stopped").to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn graph_joins_every_range() {
        let segs = [
            Segment { start: 1.0, end: 2.5, zoom: None },
            Segment { start: 4.0, end: 6.0, zoom: Some(Zoom { scale: 1.5, x: 0.5, y: 0.4 }) },
        ];
        let g = concat_graph(&segs, 1920, 1080, None);
        assert!(g.contains("[0:v]trim=1.0000:2.5000,setpts=PTS-STARTPTS,setsar=1[v0]"));
        assert!(g.contains("crop=w=iw/1.5:h=ih/1.5:x=(iw-iw/1.5)*0.5:y=(ih-ih/1.5)*0.4,scale=1920:1080"));
        assert!(g.contains("[0:a]atrim=4.0000:6.0000"));
        assert!(g.ends_with("[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]"));
        let g = concat_graph(&segs, 1920, 1080, Some(Path::new("/tmp/c.ass")));
        assert!(g.ends_with("concat=n=2:v=1:a=1[vc][a];[vc]subtitles=filename='/tmp/c.ass'[v]"));
    }

    #[test]
    fn captions_file() {
        let c = Captions {
            style: "bold".into(),
            cues: vec![Cue { start: 61.5, end: 62.25, words: vec!["Most".into(), "{people}".into()], active: 1 }],
        };
        let a = ass(&c, 1920, 1080);
        assert!(a.contains("PlayResY: 1080"));
        assert!(a.contains("Dialogue: 0,0:01:01.50,0:01:02.25,bold,,0,0,0,,MOST {\\c&H0AD6FF&}PEOPLE{\\c&HFFFFFF&}"), "{a}");
    }

    #[test]
    fn exports_the_kept_ranges() {
        let dir = std::env::temp_dir().join(format!("roughcut-export-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.mp4");
        let made = tools::command(tools::ffmpeg())
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30", "-f", "lavfi", "-i", "sine=f=300"])
            .args(["-t", "6", "-c:v", "libx264", "-c:a", "aac", "-shortest"])
            .arg(&src)
            .status();
        if !made.is_ok_and(|s| s.success()) {
            eprintln!("skipping: no ffmpeg");
            return;
        }
        let dest = dir.join("out.mp4");
        let seen = std::cell::Cell::new(0.0);
        let segs = [
            Segment { start: 0.5, end: 2.0, zoom: None },
            Segment { start: 3.0, end: 4.5, zoom: Some(Zoom { scale: 1.4, x: 0.5, y: 0.4 }) },
        ];
        let captions = Captions {
            style: "bold".into(),
            cues: vec![Cue { start: 0.2, end: 1.0, words: vec!["Hello".into(), "there".into()], active: 0 }],
        };
        export(&src, &segs, Some(&captions), &dest, |p| seen.set(p)).unwrap();
        let got = probe(&dest).unwrap();
        assert!((got.duration - 3.0).abs() < 0.15, "{}", got.duration);
        assert_eq!((got.width, got.height), (320, 240));
        assert_eq!(seen.get(), 1.0);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rates() {
        assert!((rate("30000/1001") - 29.97).abs() < 0.01);
        assert_eq!(rate("0/0"), 0.0);
    }
}
