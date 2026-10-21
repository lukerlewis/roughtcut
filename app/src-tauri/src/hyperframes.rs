//! HyperFrames' own renderer, for motion graphics in the export. It isn't
//! shipped with the app: the first export with a graphic sets it up in
//! Application Support (Node if the Mac has none recent enough, the
//! `hyperframes` package, and Chrome if the Mac has none), about 350 MB once.
//! Each graphic renders to a ProRes 4444 movie with transparency, kept beside
//! it in the project so it only renders again when it changes.

use crate::tools;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const VERSION: &str = "0.8.181";
const NODE: &str = "22.12.0";

fn home() -> PathBuf {
    if let Some(p) = std::env::var_os("ROUGHCUT_HYPERFRAMES") {
        return p.into();
    }
    crate::style::path().parent().map(Path::to_path_buf).unwrap_or_default().join("hyperframes")
}

/// Node 22 or later: the Mac's own, or the one set up here.
fn node() -> Option<PathBuf> {
    let ours = home().join("node/bin/node");
    if ours.is_file() {
        return Some(ours);
    }
    let found = tools::path_var().split(':').map(|d| Path::new(d).join("node")).find(|p| p.is_file())?;
    let out = Command::new(&found).arg("--version").output().ok()?;
    let major: u32 = String::from_utf8_lossy(&out.stdout).trim().trim_start_matches('v').split('.').next()?.parse().ok()?;
    (major >= 22).then_some(found)
}

fn cli() -> PathBuf {
    home().join(format!("cli-{VERSION}/node_modules/hyperframes/dist/cli.js"))
}

/// A command with Node's folder and Homebrew (for FFmpeg) on its PATH, and
/// HyperFrames' usage reporting off.
fn command(program: &Path, node: &Path) -> Command {
    let mut c = Command::new(program);
    let bin = node.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    c.env("PATH", format!("{bin}:{}", tools::path_var()))
        .env("HYPERFRAMES_NO_TELEMETRY", "1")
        .env("DO_NOT_TRACK", "1")
        .env("NPM_CONFIG_UPDATE_NOTIFIER", "false")
        .env("NPM_CONFIG_FUND", "false");
    c
}

fn run(mut c: Command, what: &str) -> Result<(), String> {
    let out = c.stdout(Stdio::piped()).stderr(Stdio::piped()).output().map_err(|e| format!("Couldn't {what}: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        Err(format!("Couldn't {what}: {}", err.trim().lines().last().unwrap_or("it stopped")))
    }
}

pub fn ready() -> bool {
    node().is_some() && cli().is_file()
}

/// Sets the renderer up once. `say` gets a line for Luke at each step.
pub fn install(say: &impl Fn(&str)) -> Result<(), String> {
    let dir = home();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let node = match node() {
        Some(n) => n,
        None => {
            say("Downloading Node (once)…");
            let os = if cfg!(target_os = "macos") { "darwin" } else { "linux" };
            let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
            let name = format!("node-v{NODE}-{os}-{arch}");
            let url = format!("https://nodejs.org/dist/v{NODE}/{name}.tar.gz");
            let tarball = dir.join(format!("{name}.tar.gz"));
            let mut c = tools::command("curl");
            c.args(["-fsSL", "-o"]).arg(&tarball).arg(&url);
            run(c, "download Node")?;
            // Checked against nodejs.org's published checksums.
            let sums = tools::command("curl").args(["-fsSL", &format!("https://nodejs.org/dist/v{NODE}/SHASUMS256.txt")]).output().map_err(|e| e.to_string())?;
            let want = String::from_utf8_lossy(&sums.stdout).lines().find(|l| l.ends_with(&format!("{name}.tar.gz"))).and_then(|l| l.split_whitespace().next()).map(String::from);
            let got = tools::command("shasum").args(["-a", "256"]).arg(&tarball).output().map_err(|e| e.to_string())?;
            let got = String::from_utf8_lossy(&got.stdout).split_whitespace().next().map(String::from);
            if want.is_none() || want != got {
                let _ = fs::remove_file(&tarball);
                return Err("The Node download didn't match its checksum, so it wasn't used.".into());
            }
            let mut c = tools::command("tar");
            c.arg("-xzf").arg(&tarball).arg("-C").arg(&dir);
            run(c, "unpack Node")?;
            let _ = fs::remove_file(&tarball);
            let _ = fs::remove_dir_all(dir.join("node"));
            fs::rename(dir.join(&name), dir.join("node")).map_err(|e| e.to_string())?;
            dir.join("node/bin/node")
        }
    };
    if !cli().is_file() {
        say("Downloading HyperFrames' renderer (once)…");
        let npm = node.parent().unwrap().join("npm");
        let mut c = command(if npm.is_file() { &npm } else { Path::new("npm") }, &node);
        c.args(["install", "--no-audit", "--no-fund", "--loglevel=error", "--prefix"]).arg(dir.join(format!("cli-{VERSION}"))).arg(format!("hyperframes@{VERSION}"));
        run(c, "install HyperFrames")?;
    }
    say("Getting Chrome ready for rendering (once)…");
    let mut c = command(&node, &node);
    c.arg(cli()).args(["browser", "ensure"]);
    run(c, "set up Chrome for rendering")
}

/// Renders graphics/<slug>/index.html to a movie with transparency, unless
/// it already has. Returns the movie. `progress` gets 0..1.
pub fn render(folder: &Path, slug: &str, fps: f64, progress: &impl Fn(f64)) -> Result<PathBuf, String> {
    let dir = crate::graphics::dir(folder, slug)?;
    let html = fs::read_to_string(dir.join("index.html")).map_err(|e| e.to_string())?;
    let mut h = DefaultHasher::new();
    (html.as_str(), VERSION, (fps * 1000.0).round() as u64).hash(&mut h);
    let movie = dir.join(format!("render-{:016x}.mov", h.finish()));
    if movie.is_file() {
        return Ok(movie);
    }
    // Older renders of this graphic are stale now.
    for f in fs::read_dir(&dir).into_iter().flatten().flatten() {
        let n = f.file_name().to_string_lossy().to_string();
        if n.starts_with("render-") && n.ends_with(".mov") {
            let _ = fs::remove_file(f.path());
        }
    }
    let node = node().ok_or("HyperFrames' renderer isn't set up.")?;
    let part = dir.join("render.part.mov");
    let fps = if (fps.round() - fps).abs() < 0.01 { format!("{}", fps.round() as u32) } else { format!("{}/1001", (fps * 1001.0).round() as u32) };
    let mut c = command(&node, &node);
    c.current_dir(folder)
        .arg(cli())
        .arg("render")
        .arg(&dir)
        .args(["--format", "mov", "--fps", &fps, "--output"])
        .arg(&part)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = c.spawn().map_err(|e| format!("Couldn't start HyperFrames: {e}"))?;
    let mut log = vec![];
    for line in BufReader::new(child.stdout.take().unwrap()).lines().map_while(Result::ok) {
        // "… 45% …" lines as it captures frames.
        if let Some(p) = line.split_whitespace().find_map(|w| w.strip_suffix('%').and_then(|n| n.parse::<f64>().ok())) {
            progress((p / 100.0).clamp(0.0, 1.0));
        }
        log.push(line);
        if log.len() > 40 {
            log.remove(0);
        }
    }
    let mut err = String::new();
    if let Some(mut e) = child.stderr.take() {
        let _ = e.read_to_string(&mut err);
    }
    let ok = child.wait().map_err(|e| e.to_string())?.success();
    if !ok || !part.is_file() {
        let _ = fs::remove_file(&part);
        let last = err.lines().chain(log.iter().map(String::as_str)).rfind(|l| !l.trim().is_empty()).unwrap_or("it stopped").to_string();
        return Err(format!("A graphic didn't render ({slug}): {last}"));
    }
    fs::rename(&part, &movie).map_err(|e| e.to_string())?;
    progress(1.0);
    Ok(movie)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Renders a catalogue graphic with the real renderer. Needs Node 22+
    /// and network for the first set-up: `cargo test -- --ignored renders`.
    #[test]
    #[ignore]
    fn renders_a_graphic() {
        let folder = std::env::temp_dir().join(format!("roughcut-hf-{}", std::process::id()));
        let _ = fs::remove_dir_all(&folder);
        fs::create_dir_all(&folder).unwrap();
        install(&|s| println!("{s}")).unwrap();
        assert!(ready());
        let slug = crate::graphics::add_from_catalog(&folder, "lt-clean-bar").unwrap();
        let movie = render(&folder, &slug, 30.0, &|p| println!("{p:.2}")).unwrap();
        let info = crate::media::probe(&movie).unwrap();
        assert_eq!((info.width, info.height), (1920, 1080));
        assert!((info.duration - 4.8).abs() < 0.1, "{}", info.duration);
        // Unchanged, it isn't rendered again.
        assert_eq!(render(&folder, &slug, 30.0, &|_| panic!("rendered again")).unwrap(), movie);
        let _ = fs::remove_dir_all(&folder);
    }
}
