"""ffprobe / ffmpeg helpers: probe a source, pull its audio, render a preview."""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path


class MediaError(RuntimeError):
    pass


@dataclass
class SourceInfo:
    path: Path
    duration: float
    width: int
    height: int
    # Nominal frame rate, e.g. Fraction(30000, 1001). Screen recordings are often
    # variable frame rate; we snap edits to this nominal rate.
    fps: Fraction
    has_audio: bool
    audio_rate: int
    audio_channels: int
    # Source timecode start in seconds (0 for most camera-less recordings).
    tc_start: float


def _run(cmd: list[str]) -> str:
    try:
        out = subprocess.run(cmd, check=True, capture_output=True, text=True)
    except FileNotFoundError as e:
        raise MediaError(f"{cmd[0]} not found. Install it with `brew install ffmpeg`.") from e
    except subprocess.CalledProcessError as e:
        raise MediaError(f"{cmd[0]} failed: {e.stderr.strip()[-800:]}") from e
    return out.stdout


def _parse_tc(tc: str, fps: Fraction) -> float:
    parts = tc.replace(";", ":").split(":")
    if len(parts) != 4:
        return 0.0
    h, m, s, f = (int(p) for p in parts)
    return h * 3600 + m * 60 + s + f / round(float(fps))


def probe(path: Path) -> SourceInfo:
    data = json.loads(
        _run(["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(path)])
    )
    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if video is None:
        raise MediaError(f"{path.name} has no video stream.")
    rate = video.get("r_frame_rate") or video.get("avg_frame_rate") or "30/1"
    fps = Fraction(rate)
    if fps <= 0 or fps > 240:
        fps = Fraction(30)
    tags = {**data.get("format", {}).get("tags", {}), **video.get("tags", {})}
    tc = tags.get("timecode")
    return SourceInfo(
        path=path.resolve(),
        duration=float(data["format"]["duration"]),
        width=int(video["width"]),
        height=int(video["height"]),
        fps=fps,
        has_audio=audio is not None,
        audio_rate=int(audio.get("sample_rate", 48000)) if audio else 48000,
        audio_channels=int(audio.get("channels", 2)) if audio else 2,
        tc_start=_parse_tc(tc, fps) if tc else 0.0,
    )


def extract_audio(src: Path, dest: Path) -> Path:
    """16 kHz mono WAV, which is what the speech models want."""
    _run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(dest)])
    return dest


def render_preview(src: Path, ranges: list[tuple[float, float]], dest: Path, height: int = 540) -> Path:
    """A small H.264 preview of the cut, for watching it without Final Cut."""
    if not ranges:
        raise MediaError("Nothing kept, so there is nothing to render.")
    parts = []
    for i, (a, b) in enumerate(ranges):
        parts.append(f"[0:v]trim={a:.4f}:{b:.4f},setpts=PTS-STARTPTS,scale=-2:{height}[v{i}];")
        parts.append(f"[0:a]atrim={a:.4f}:{b:.4f},asetpts=PTS-STARTPTS[a{i}];")
    joined = "".join(f"[v{i}][a{i}]" for i in range(len(ranges)))
    graph = "".join(parts) + f"{joined}concat=n={len(ranges)}:v=1:a=1[v][a]"
    script = dest.with_suffix(".filter.txt")
    script.write_text(graph)
    try:
        _run([
            "ffmpeg", "-v", "error", "-y", "-i", str(src), "-filter_complex_script", str(script),
            "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
            "-c:a", "aac", "-b:a", "128k", str(dest),
        ])
    finally:
        script.unlink(missing_ok=True)
    return dest
