"""Build a fake talking-head recording with espeak-ng: fillers, a retake, a long
pause and an off-topic opener, over a test pattern that burns in source time.
Also writes <out>.transcript.json with approximate word timings, so the rest of
the pipeline can be tested where no speech model can be downloaded.

    python tests/synth.py out.mp4
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT = [
    ("say", "Okay, is this recording? Let me check the mic."),
    ("gap", 1.5),
    ("say", "Three months ago I deleted every app on my phone except one."),
    ("gap", 0.4),
    ("say", "Um,"),
    ("gap", 0.3),
    ("say", "here is what happened to my focus."),
    ("gap", 1.2),
    ("say", "The rule was simple, I could only keep the apps that"),
    ("gap", 0.8),
    ("say", "The rule was simple. If I would not reinstall it tomorrow, it goes."),
    ("gap", 2.5),
    ("say", "Uh,"),
    ("gap", 0.4),
    ("say", "The first week was genuinely awful."),
    ("gap", 0.3),
    ("say", "I checked my pocket forty times a day."),
    ("gap", 0.6),
    ("say", "Then something shifted in week two. I started finishing things."),
    ("gap", 1.0),
]


def _dur(f: Path) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(f)], capture_output=True, text=True, check=True)
    return float(out.stdout)


def build(dest: Path) -> Path:
    with tempfile.TemporaryDirectory() as tmp:
        tmpd = Path(tmp)
        parts, words, t = [], [], 0.0
        for i, (kind, val) in enumerate(SCRIPT):
            f = tmpd / f"{i:02d}.wav"
            if kind == "say":
                subprocess.run(["espeak-ng", "-v", "en-us", "-s", "150", "-w", str(f), val], check=True)
                subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(f), "-ar", "48000", "-ac", "2", str(f.with_suffix(".r.wav"))], check=True)
                f = f.with_suffix(".r.wav")
                d = _dur(f)
                # espeak pads ~0.1s of silence at each end; spread the words over the rest by length.
                toks = val.split()
                a, b = t + 0.1, t + d - 0.1
                total = sum(len(w) + 2 for w in toks)
                x = a
                for w in toks:
                    span = (b - a) * (len(w) + 2) / total
                    words.append({"text": w, "start": round(x, 3), "end": round(x + span * 0.9, 3), "prob": 0.95})
                    x += span
                t += d
            else:
                t += float(val)
                subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", str(val), str(f)], check=True)
            parts.append(f)
        dest.with_suffix(".transcript.json").write_text(json.dumps(words, indent=1))
        lst = tmpd / "list.txt"
        lst.write_text("".join(f"file '{p}'\n" for p in parts))
        audio = tmpd / "audio.wav"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), str(audio)], check=True)
        dur = _dur(audio)
        subprocess.run([
            "ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc2=size=1280x720:rate=30000/1001:duration={dur}",
            "-i", str(audio), "-vf", "drawtext=text='%{pts\\:hms}':fontsize=64:fontcolor=white:box=1:boxcolor=black@0.6:x=40:y=40",
            "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(dest),
        ], check=True)
    return dest


if __name__ == "__main__":
    build(Path(sys.argv[1] if len(sys.argv) > 1 else "synthetic.mp4"))
