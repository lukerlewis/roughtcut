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
    pub audio: bool,
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
        audio: v["streams"].as_array().is_some_and(|s| s.iter().any(|s| s["codec_type"] == "audio")),
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

/// A kept piece of the recording, in source seconds, maybe zoomed in. With
/// `file`, the piece comes from one of Claude's clips instead, and start..end
/// are seconds into that file.
#[derive(Deserialize)]
pub struct Segment {
    pub start: f64,
    pub end: f64,
    pub zoom: Option<Zoom>,
    #[serde(default)]
    pub file: Option<String>,
    /// Played faster (2.0 is double speed). Audio keeps its pitch.
    #[serde(default)]
    pub speed: Option<f64>,
    /// Parts of the frame to blur, as fractions of it.
    #[serde(default)]
    pub blur: Vec<Rect>,
}

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Segment {
    /// How long the piece lasts in the export.
    pub fn length(&self) -> f64 {
        (self.end - self.start) / self.speed.filter(|s| *s > 0.0).unwrap_or(1.0)
    }
}

/// atempo only takes 0.5 to 2 per step, so bigger changes chain steps.
fn atempo(speed: f64) -> String {
    let mut s = String::new();
    let mut left = speed;
    while left > 2.0 {
        s += ",atempo=2.0";
        left /= 2.0;
    }
    while left < 0.5 {
        s += ",atempo=0.5";
        left /= 0.5;
    }
    if (left - 1.0).abs() > 1e-6 {
        s += &format!(",atempo={left:.4}");
    }
    s
}

/// The files the export reads: the recording first, then each clip once.
pub fn inputs(source: &Path, segments: &[Segment]) -> Vec<std::path::PathBuf> {
    let mut files = vec![source.to_path_buf()];
    for s in segments {
        if let Some(f) = &s.file {
            if !files.iter().any(|x| x == Path::new(f)) {
                files.push(f.into());
            }
        }
    }
    files
}

/// One overlay image and when it shows, in cut seconds. The editor draws
/// each one (captions as a strip across the bottom, titles over the whole
/// frame, as base64 PNGs) so the export matches its preview and needs no
/// subtitle or text support in FFmpeg.
#[derive(Deserialize)]
pub struct CaptionFrame {
    pub start: f64,
    pub end: f64,
    pub png: String,
}

/// A layer of images laid over the video: captions, or titles and graphics.
#[derive(Deserialize)]
pub struct Captions {
    /// Where the images' top edge sits, as a fraction of the frame height.
    pub top: f64,
    /// A clear strip, shown between captions.
    pub blank: String,
    pub frames: Vec<CaptionFrame>,
}

/// The filter graph that trims each piece, zooms it if asked, joins them and
/// lays each overlay layer (the inputs after the recording and clips) over
/// the result, in order. `overlays` holds each layer's top edge.
pub fn concat_graph(segments: &[Segment], inputs: &[std::path::PathBuf], width: u32, height: u32, overlays: &[f64]) -> String {
    let mut g = String::new();
    for (i, s) in segments.iter().enumerate() {
        let (a, b) = (s.start, s.end);
        // Claude's clips come in at whatever size they were made; match the recording.
        let (k, fit) = match &s.file {
            Some(f) => (
                inputs.iter().position(|x| x == Path::new(f)).unwrap_or(0),
                format!(",scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2"),
            ),
            None => (0, String::new()),
        };
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
        let speed = s.speed.filter(|v| *v > 0.0 && (*v - 1.0).abs() > 1e-6);
        let pts = match speed {
            Some(v) => format!("(PTS-STARTPTS)/{v:.4}"),
            None => "PTS-STARTPTS".into(),
        };
        if s.blur.is_empty() {
            g += &format!("[{k}:v]trim={a:.4}:{b:.4},setpts={pts}{fit}{zoom},setsar=1[v{i}];");
        } else {
            // Blur each box: cut it out, blur it, lay it back over the frame.
            g += &format!("[{k}:v]trim={a:.4}:{b:.4},setpts={pts}{fit}[p{i}b0];");
            for (r, rect) in s.blur.iter().enumerate() {
                let (x, y) = (rect.x.clamp(0.0, 1.0), rect.y.clamp(0.0, 1.0));
                let (w, h) = (rect.w.clamp(0.01, 1.0 - x), rect.h.clamp(0.01, 1.0 - y));
                g += &format!(
                    "[p{i}b{r}]split[p{i}s{r}][p{i}c{r}];[p{i}c{r}]crop=w=iw*{w:.4}:h=ih*{h:.4}:x=iw*{x:.4}:y=ih*{y:.4},boxblur=luma_radius=min(w\\,h)/6:luma_power=3[p{i}r{r}];\
                     [p{i}s{r}][p{i}r{r}]overlay=x=main_w*{x:.4}:y=main_h*{y:.4}[p{i}b{n}];",
                    n = r + 1
                );
            }
            g += &format!("[p{i}b{}]null{zoom},setsar=1[v{i}];", s.blur.len());
        }
        let tempo = speed.map(atempo).unwrap_or_default();
        g += &format!("[{k}:a]atrim={a:.4}:{b:.4},asetpts=PTS-STARTPTS{tempo},aresample=48000[a{i}];");
    }
    for i in 0..segments.len() {
        g += &format!("[v{i}][a{i}]");
    }
    let n = segments.len();
    if overlays.is_empty() {
        return g + &format!("concat=n={n}:v=1:a=1[v][a]");
    }
    g += &format!("concat=n={n}:v=1:a=1[o0][a]");
    for (k, top) in overlays.iter().enumerate() {
        let c = inputs.len() + k; // overlay layers come in after the recording and clips
        let out = if k + 1 == overlays.len() { "v".to_string() } else { format!("o{}", k + 1) };
        g += &format!(";[{c}:v]format=rgba[l{k}];[o{k}][l{k}]overlay=x=0:y=main_h*{top:.4}:eof_action=pass:format=auto[{out}]");
    }
    g
}

/// The FFmpeg concat list that shows each caption image for its time, with
/// the blank strip filling the gaps. Files are named by `name(i)`, the blank
/// one by `name(usize::MAX)`.
pub fn caption_list(frames: &[CaptionFrame], total: f64, name: impl Fn(usize) -> String) -> String {
    let mut s = String::from("ffconcat version 1.0\n");
    let mut at = 0.0;
    let mut add = |file: String, dur: f64| {
        if dur > 0.0005 {
            s += &format!("file '{file}'\nduration {dur:.4}\n");
        }
    };
    for (i, f) in frames.iter().enumerate() {
        let start = f.start.max(at);
        add(name(usize::MAX), start - at);
        let end = f.end.min(total).max(start);
        add(name(i), end - start);
        at = end;
    }
    add(name(usize::MAX), total - at + 1.0);
    // The last entry is listed twice so its duration is honoured.
    s += &format!("file '{}'\n", name(usize::MAX));
    s
}

/// Decodes standard base64, ignoring anything that isn't part of it.
fn base64(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0);
    for c in text.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => continue,
        };
        acc = acc << 6 | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    out
}

/// Renders the cut at full quality. Calls `progress` with 0..1 as it goes.
/// Tries the Mac's hardware encoder first and falls back to x264, so a
/// machine (or FFmpeg build) without it still exports.
pub fn export(source: &Path, segments: &[Segment], overlays: &[Captions], dest: &Path, progress: impl Fn(f64)) -> Result<(), String> {
    if segments.is_empty() {
        return Err("Nothing is kept, so there's nothing to export.".into());
    }
    // A generous bitrate for the size: about 12 Mbit/s for 1080p30 and 50 for 4K30.
    let info = probe(source)?;
    let bitrate = ((info.width as f64 * info.height as f64 * info.fps * 0.2) as u64).max(4_000_000).to_string();
    let total: f64 = segments.iter().map(Segment::length).sum();
    let layers: Vec<&Captions> = overlays.iter().filter(|c| !c.frames.is_empty()).collect();
    let mut caps = Vec::new();
    for (k, c) in layers.iter().enumerate() {
        caps.push(write_captions(c, total, k).map_err(|e| format!("Couldn't write the captions and titles: {e}"))?);
    }
    let files = inputs(source, segments);
    let tops: Vec<f64> = layers.iter().map(|c| c.top).collect();
    let graph = concat_graph(segments, &files, info.width, info.height, &tops);
    let lists: Vec<std::path::PathBuf> = caps.iter().map(|d| d.join("list.ffconcat")).collect();
    let mut encoders: Vec<Vec<&str>> = Vec::new();
    if cfg!(target_os = "macos") {
        encoders.push(vec!["-c:v", "h264_videotoolbox", "-b:v", &bitrate]);
    }
    encoders.push(vec!["-c:v", "libx264", "-preset", "medium", "-crf", "18"]);
    let mut result = Err(String::new());
    for video in &encoders {
        result = encode(&files, &lists, &graph, total, dest, video, &progress);
        if result.is_ok() {
            break;
        }
    }
    for d in caps {
        let _ = fs::remove_dir_all(d);
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

/// Writes the caption images and their concat list to a temporary folder.
fn write_captions(c: &Captions, total: f64, layer: usize) -> std::io::Result<std::path::PathBuf> {
    let dir = std::env::temp_dir().join(format!("roughcut-overlay-{}-{layer}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir)?;
    let name = |i: usize| if i == usize::MAX { "blank.png".to_string() } else { format!("c{i}.png") };
    fs::write(dir.join(name(usize::MAX)), base64(&c.blank))?;
    for (i, f) in c.frames.iter().enumerate() {
        fs::write(dir.join(name(i)), base64(&f.png))?;
    }
    fs::write(dir.join("list.ffconcat"), caption_list(&c.frames, total, name))?;
    Ok(dir)
}

fn encode(files: &[std::path::PathBuf], overlays: &[std::path::PathBuf], graph: &str, total: f64, dest: &Path, video: &[&str], progress: &impl Fn(f64)) -> Result<(), String> {
    let mut cmd = tools::command(tools::ffmpeg());
    cmd.args(["-v", "error", "-y"]);
    for f in files {
        cmd.arg("-i").arg(f);
    }
    for list in overlays {
        cmd.args(["-f", "concat", "-safe", "0", "-i"]).arg(list);
    }
    let mut child = cmd
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
            Segment { start: 1.0, end: 2.5, zoom: None, file: None, speed: None, blur: vec![] },
            Segment { start: 4.0, end: 6.0, zoom: Some(Zoom { scale: 1.5, x: 0.5, y: 0.4 }), file: None, speed: None, blur: vec![] },
        ];
        let files = inputs(Path::new("/r.mov"), &segs);
        let g = concat_graph(&segs, &files, 1920, 1080, &[]);
        assert!(g.contains("[0:v]trim=1.0000:2.5000,setpts=PTS-STARTPTS,setsar=1[v0]"));
        assert!(g.contains("crop=w=iw/1.5:h=ih/1.5:x=(iw-iw/1.5)*0.5:y=(ih-ih/1.5)*0.4,scale=1920:1080"));
        assert!(g.contains("[0:a]atrim=4.0000:6.0000"));
        assert!(g.ends_with("[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]"));
        let g = concat_graph(&segs, &files, 1920, 1080, &[0.6, 0.0]);
        assert!(g.ends_with(
            "concat=n=2:v=1:a=1[o0][a];[1:v]format=rgba[l0];[o0][l0]overlay=x=0:y=main_h*0.6000:eof_action=pass:format=auto[o1];\
             [2:v]format=rgba[l1];[o1][l1]overlay=x=0:y=main_h*0.0000:eof_action=pass:format=auto[v]"
        ));
        assert_eq!(atempo(3.0), ",atempo=2.0,atempo=1.5000");
        assert_eq!(atempo(1.0), "");
    }

    #[test]
    fn captions_list_and_base64() {
        let f = |start, end| CaptionFrame { start, end, png: String::new() };
        let name = |i: usize| if i == usize::MAX { "b".to_string() } else { format!("c{i}") };
        let l = caption_list(&[f(0.0, 1.0), f(1.0, 1.5), f(2.0, 2.5)], 3.0, name);
        assert_eq!(
            l,
            "ffconcat version 1.0\nfile 'c0'\nduration 1.0000\nfile 'c1'\nduration 0.5000\nfile 'b'\nduration 0.5000\n\
             file 'c2'\nduration 0.5000\nfile 'b'\nduration 1.5000\nfile 'b'\n"
        );
        assert_eq!(base64("aGVsbG8h\n"), b"hello!");
        assert_eq!(base64("aGk="), b"hi");
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
        let clip = tools::command(tools::ffmpeg())
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "color=red:size=160x90:rate=25", "-f", "lavfi", "-i", "sine=f=500"])
            .args(["-t", "2", "-c:v", "libx264", "-c:a", "aac", "-shortest"])
            .arg(dir.join("clip.mp4"))
            .status();
        assert!(clip.is_ok_and(|s| s.success()));
        let dest = dir.join("out.mp4");
        let seen = std::cell::Cell::new(0.0);
        let segs = [
            Segment { start: 0.5, end: 2.0, zoom: None, file: None, speed: None, blur: vec![Rect { x: 0.1, y: 0.1, w: 0.3, h: 0.2 }] },
            // Double speed: 2s of source plays in 1s.
            Segment { start: 2.5, end: 4.5, zoom: Some(Zoom { scale: 1.4, x: 0.5, y: 0.4 }), file: None, speed: Some(2.0), blur: vec![] },
            // A clip of Claude's, made at another size.
            Segment { start: 0.2, end: 1.2, zoom: None, file: Some(dir.join("clip.mp4").to_string_lossy().into()), speed: None, blur: vec![] },
        ];
        // A one-pixel PNG stands in for the editor's caption strips.
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
        let captions = Captions {
            top: 0.6,
            blank: png.into(),
            frames: vec![CaptionFrame { start: 0.2, end: 1.0, png: png.into() }, CaptionFrame { start: 1.5, end: 2.0, png: png.into() }],
        };
        let titles = Captions { top: 0.0, blank: png.into(), frames: vec![CaptionFrame { start: 0.0, end: 1.0, png: png.into() }] };
        export(&src, &segs, &[captions, titles], &dest, |p| seen.set(p)).unwrap();
        let got = probe(&dest).unwrap();
        assert!((got.duration - 3.5).abs() < 0.15, "{}", got.duration);
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
