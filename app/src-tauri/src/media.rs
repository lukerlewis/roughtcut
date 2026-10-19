//! FFmpeg work: reading a recording's details, drawing its waveform and
//! rendering the finished cut.

use crate::tools;
use serde::Serialize;
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

/// The filter graph that trims each kept range and joins them.
pub fn concat_graph(ranges: &[(f64, f64)], height: Option<u32>) -> String {
    let scale = height.map(|h| format!(",scale=-2:'min({h},ih)'")).unwrap_or_default();
    let mut g = String::new();
    for (i, (a, b)) in ranges.iter().enumerate() {
        g += &format!("[0:v]trim={a:.4}:{b:.4},setpts=PTS-STARTPTS{scale}[v{i}];");
        g += &format!("[0:a]atrim={a:.4}:{b:.4},asetpts=PTS-STARTPTS[a{i}];");
    }
    for i in 0..ranges.len() {
        g += &format!("[v{i}][a{i}]");
    }
    g + &format!("concat=n={}:v=1:a=1[v][a]", ranges.len())
}

/// Renders the cut at full quality. Calls `progress` with 0..1 as it goes.
pub fn export(source: &Path, ranges: &[(f64, f64)], dest: &Path, progress: impl Fn(f64)) -> Result<(), String> {
    if ranges.is_empty() {
        return Err("Nothing is kept, so there's nothing to export.".into());
    }
    let total: f64 = ranges.iter().map(|(a, b)| b - a).sum();
    let script = dest.with_extension("filter.txt");
    fs::write(&script, concat_graph(ranges, None)).map_err(|e| format!("Couldn't write to {}: {e}", dest.display()))?;
    // The Mac's hardware encoder, at a generous bitrate for the size: about
    // 12 Mbit/s for 1080p30 and 50 for 4K30.
    let info = probe(source)?;
    let bitrate = ((info.width as f64 * info.height as f64 * info.fps * 0.2) as u64).max(4_000_000).to_string();
    let video: Vec<&str> = if cfg!(target_os = "macos") {
        vec!["-c:v", "h264_videotoolbox", "-b:v", &bitrate, "-allow_sw", "1"]
    } else {
        vec!["-c:v", "libx264", "-preset", "medium", "-crf", "18"]
    };
    let mut child = tools::command(tools::ffmpeg())
        .args(["-v", "error", "-y", "-i"])
        .arg(source)
        .arg("-filter_complex_script")
        .arg(&script)
        .args(["-map", "[v]", "-map", "[a]"])
        .args(&video)
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
    let _ = fs::remove_file(&script);
    if !status.success() {
        return Err(format!("The export failed: {}", err.trim().lines().last().unwrap_or("ffmpeg stopped")));
    }
    progress(1.0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn graph_joins_every_range() {
        let g = concat_graph(&[(1.0, 2.5), (4.0, 6.0)], None);
        assert!(g.contains("[0:v]trim=1.0000:2.5000"));
        assert!(g.contains("[0:a]atrim=4.0000:6.0000"));
        assert!(g.ends_with("[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]"));
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
        export(&src, &[(0.5, 2.0), (3.0, 4.5)], &dest, |p| seen.set(p)).unwrap();
        let got = probe(&dest).unwrap();
        assert!((got.duration - 3.0).abs() < 0.15, "{}", got.duration);
        assert_eq!(seen.get(), 1.0);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rates() {
        assert!((rate("30000/1001") - 29.97).abs() < 0.01);
        assert_eq!(rate("0/0"), 0.0);
    }
}
