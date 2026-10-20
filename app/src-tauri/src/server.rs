//! Serves the open recording to the video player over plain HTTP on
//! 127.0.0.1, with byte ranges for seeking. WebKit loads media through its
//! own network stack this way, which copes with the constant cancelled and
//! restarted range requests of scrubbing. (Tauri's asset protocol crashed the
//! app when WebKit cancelled a request while it was in the background.)
//! Only recordings the app opened are served, under a random token.

use std::collections::HashSet;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub struct Server {
    port: u16,
    token: String,
    allowed: Arc<Mutex<HashSet<PathBuf>>>,
}

fn token() -> String {
    let mut bytes = [0u8; 16];
    if File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut bytes)).is_err() {
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
        bytes[..16].copy_from_slice(&t.as_nanos().to_le_bytes());
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl Server {
    pub fn start() -> io::Result<Server> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let port = listener.local_addr()?.port();
        let server = Server { port, token: token(), allowed: Arc::default() };
        let (token, allowed) = (server.token.clone(), server.allowed.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let (token, allowed) = (token.clone(), allowed.clone());
                std::thread::spawn(move || {
                    let _ = serve(stream, &token, &allowed);
                });
            }
        });
        Ok(server)
    }

    /// The URL the player uses for `path`, which from now on may be served.
    pub fn url(&self, path: &Path) -> String {
        self.allowed.lock().unwrap().insert(path.to_path_buf());
        format!("http://127.0.0.1:{}/{}/{}", self.port, self.token, encode(&path.to_string_lossy()))
    }
}

fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok());
            if let Some(v) = hex {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().map(|e| e.to_string_lossy().to_lowercase()).as_deref() {
        Some("mov") => "video/quicktime",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("mp4") | Some("m4v") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mkv") => "video/x-matroska",
        _ => "application/octet-stream",
    }
}

/// "bytes=a-b", "bytes=a-" or "bytes=-n" as an inclusive range within len.
fn range(header: &str, len: u64) -> Option<(u64, u64)> {
    let spec = header.trim().strip_prefix("bytes=")?.split(',').next()?.trim();
    let (a, b) = spec.split_once('-')?;
    let (start, end) = match (a.trim(), b.trim()) {
        ("", n) => {
            let n: u64 = n.parse().ok()?;
            (len.saturating_sub(n), len.checked_sub(1)?)
        }
        (a, "") => (a.parse().ok()?, len.checked_sub(1)?),
        (a, b) => (a.parse().ok()?, b.parse::<u64>().ok()?.min(len.checked_sub(1)?)),
    };
    (start <= end && start < len).then_some((start, end))
}

/// Answers requests on one connection until the player closes it.
fn serve(stream: TcpStream, token: &str, allowed: &Mutex<HashSet<PathBuf>>) -> io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut out = stream;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(());
        }
        let mut parts = line.split_whitespace();
        let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
        let mut range_header = None;
        let mut close = line.contains("HTTP/1.0");
        loop {
            let mut h = String::new();
            if reader.read_line(&mut h)? == 0 || h.trim().is_empty() {
                break;
            }
            if let Some((k, v)) = h.split_once(':') {
                if k.trim().eq_ignore_ascii_case("range") {
                    range_header = Some(v.trim().to_string());
                } else if k.trim().eq_ignore_ascii_case("connection") && v.trim().eq_ignore_ascii_case("close") {
                    close = true;
                }
            }
        }
        let path = target
            .strip_prefix('/')
            .and_then(|t| t.strip_prefix(token))
            .map(|p| PathBuf::from(decode(p.split('?').next().unwrap_or(p))));
        let path = path.filter(|p| allowed.lock().unwrap().contains(p));
        let (Some(path), true) = (path, method == "GET" || method == "HEAD") else {
            write!(out, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")?;
            if close {
                return Ok(());
            }
            continue;
        };
        let mut file = match File::open(&path) {
            Ok(f) => f,
            Err(_) => {
                write!(out, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")?;
                continue;
            }
        };
        let len = file.metadata()?.len();
        let common = format!(
            "Content-Type: {}\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-cache\r\n",
            content_type(&path)
        );
        let (start, end) = match range_header.as_deref() {
            None => {
                write!(out, "HTTP/1.1 200 OK\r\n{common}Content-Length: {len}\r\n\r\n")?;
                (0, len.saturating_sub(1))
            }
            Some(h) => match range(h, len) {
                Some((a, b)) => {
                    write!(out, "HTTP/1.1 206 Partial Content\r\n{common}Content-Range: bytes {a}-{b}/{len}\r\nContent-Length: {}\r\n\r\n", b - a + 1)?;
                    (a, b)
                }
                None => {
                    write!(out, "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{len}\r\nContent-Length: 0\r\n\r\n")?;
                    continue;
                }
            },
        };
        if method == "GET" && len > 0 {
            file.seek(SeekFrom::Start(start))?;
            io::copy(&mut file.take(end - start + 1), &mut out)?;
        }
        out.flush()?;
        if close {
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(range("bytes=0-1", 100), Some((0, 1)));
        assert_eq!(range("bytes=10-", 100), Some((10, 99)));
        assert_eq!(range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(range("bytes=50-500", 100), Some((50, 99)));
        assert_eq!(range("bytes=100-", 100), None);
        assert_eq!(range("bytes=5-1", 100), None);
        assert_eq!(decode(&encode("/Users/a/test talking head%.mov")), "/Users/a/test talking head%.mov");
    }

    fn get(port: u16, path: &str, range: &str) -> (String, Vec<u8>) {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(s, "GET {path} HTTP/1.1\r\nHost: x\r\n{range}Connection: close\r\n\r\n").unwrap();
        let mut buf = vec![];
        s.read_to_end(&mut buf).unwrap();
        let split = buf.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        (String::from_utf8_lossy(&buf[..split]).into(), buf[split + 4..].to_vec())
    }

    #[test]
    fn serves_only_opened_files_with_ranges() {
        let dir = std::env::temp_dir().join(format!("roughcut-serve-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("my take.mov");
        std::fs::write(&file, (0..=255u8).collect::<Vec<_>>()).unwrap();
        let server = Server::start().unwrap();
        let path = format!("/{}/{}", server.token, encode(&file.to_string_lossy()));
        assert!(get(server.port, &path, "").0.starts_with("HTTP/1.1 404"));
        let url = server.url(&file);
        assert!(url.ends_with("my%20take.mov"));
        let (head, body) = get(server.port, &path, "Range: bytes=10-19\r\n");
        assert!(head.starts_with("HTTP/1.1 206"), "{head}");
        assert!(head.contains("Content-Range: bytes 10-19/256"));
        assert!(head.contains("video/quicktime"));
        assert_eq!(body, (10..20u8).collect::<Vec<_>>());
        let (head, body) = get(server.port, &path, "");
        assert!(head.starts_with("HTTP/1.1 200"));
        assert_eq!(body.len(), 256);
        assert!(get(server.port, "/wrong/x", "").0.starts_with("HTTP/1.1 404"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
