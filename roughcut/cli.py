"""roughcut cut <recording>: transcript in, rough cut out.

Writes everything to a "<name> rough cut" folder next to the source:
  transcript.json   word timings from speech-to-text (cached; reused on the next run)
  words.json        the same words with timings corrected from the audio, and hidden ums added
  units.json        the lines and flags Claude saw
  decisions.json    what was kept and cut, and why
  cut.fcpxml        open this in Final Cut Pro (File > Import > XML)
  report.md         what was cut, Claude's notes, and a test scorecard
  preview.mp4       a small render of the cut, to watch without Final Cut
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import asdict
from importlib import resources
from pathlib import Path

from . import analyze, decide, fcpxml, hesitations, media, report, timeline, transcribe


def log(msg: str) -> None:
    print(f"› {msg}", file=sys.stderr, flush=True)


def cut(args: argparse.Namespace) -> int:
    src_path = Path(args.recording).expanduser()
    if not src_path.exists():
        log(f"Can't find {src_path}")
        return 1
    out = Path(args.out).expanduser() if args.out else src_path.with_name(f"{src_path.stem} rough cut")
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.time()

    src = media.probe(src_path)
    log(f"{src_path.name}: {src.duration / 60:.1f} min, {src.width}x{src.height} at {float(src.fps):.3f} fps")
    if not src.has_audio:
        log("This recording has no audio, so there's nothing to transcribe.")
        return 1

    tpath = out / "transcript.json"
    wav = out / "audio.wav"
    if args.transcript:
        words = transcribe.load(Path(args.transcript))
        log(f"Using transcript {args.transcript} ({len(words)} words)")
    elif tpath.exists() and not args.retranscribe:
        words = transcribe.load(tpath)
        log(f"Reusing transcript ({len(words)} words); pass --retranscribe to redo it")
    else:
        backend = args.backend or transcribe.default_backend()
        log(f"Transcribing on this machine with {backend}…")
        media.extract_audio(src.path, wav)
        words = transcribe.transcribe(wav, backend, args.whisper_model)
        transcribe.save(words, tpath)
        log(f"{len(words)} words")
    if not words:
        log("No speech found.")
        return 1

    try:
        if not wav.exists():
            media.extract_audio(src.path, wav)
        words, fixed, found = hesitations.refine(words, hesitations.analyse(wav))
        log(f"Checked the audio: fixed the timing of {fixed} stretched words, found {found} hidden ums")
    except ImportError:
        log("numpy isn't installed, so word timings weren't checked against the audio")
    finally:
        wav.unlink(missing_ok=True)
    transcribe.save(words, out / "words.json")

    units = analyze.analyze(words)
    (out / "units.json").write_text(json.dumps([asdict(u) for u in units], indent=1))
    flagged = sum(1 for u in units if u.flags)
    log(f"{len(units)} lines, {flagged} flagged (fillers, retakes, trailing off)")

    if args.rules_only:
        d = decide.rules(units)
    else:
        style = Path(args.style).read_text() if args.style else resources.files("roughcut").joinpath("styles/talking-head.md").read_text()
        log(f"Asking Claude ({args.model}) for the cut… this uses your Claude plan")
        d = decide.claude(units, words, style, src.duration, model=args.model)
    for w in d.warnings:
        log(f"warning: {w}")

    p = timeline.Params(pad_in=args.pad_in, pad_out=args.pad_out, max_pause=args.max_pause)
    keep = d.kept(len(words))
    ranges = timeline.kept_ranges(words, keep, src.duration, p)
    clips = timeline.snap(ranges, src.fps)
    cut_len = sum(b - a for a, b in clips) / float(src.fps)

    # A marker at the start of each clip that follows a cut, saying what was removed there.
    markers: dict[int, str] = {}
    for i, (a, _) in enumerate(clips):
        if i == 0 and a == 0:
            continue
        lo = clips[i - 1][1] / float(src.fps) if i else 0.0
        hi = a / float(src.fps)
        gone = [c for c in d.cuts if words[c.first].start >= lo - p.pad_out - 0.05 and words[c.last].end <= hi + p.pad_in + 0.05]
        if gone:
            markers[i] = "Cut: " + "; ".join(f"{c.reason} ({report.span_text(words, c)[:40]})" for c in gone[:3])

    (out / "decisions.json").write_text(
        json.dumps(
            {
                "by": d.by,
                "summary": d.summary,
                "cuts": [
                    {"from": c.first, "to": c.last, "start": words[c.first].start, "end": words[c.last].end,
                     "text": report.span_text(words, c), "reason": c.reason}
                    for c in d.cuts
                ],
                "clips_frames": clips,
                "fps": str(src.fps),
                "usage": d.usage,
            },
            indent=1,
        )
    )
    fcpxml.write(src, clips, out / "cut.fcpxml", f"{src_path.stem} rough cut", markers)
    report.write(out / "report.md", src_path.name, words, d, src.duration, cut_len, len(clips))
    if not args.no_preview:
        log("Rendering preview.mp4…")
        media.render_preview(src.path, [(a / float(src.fps), b / float(src.fps)) for a, b in clips], out / "preview.mp4")

    log(f"Done in {time.time() - t0:.0f}s: {src.duration / 60:.1f} min → {cut_len / 60:.1f} min, {len(clips)} clips")
    log(f"Open {out / 'cut.fcpxml'} in Final Cut (File > Import > XML), and read {out / 'report.md'}")
    print(out)
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="roughcut", description="Rough-cut a raw recording with Claude.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("cut", help="make a rough cut of a recording")
    c.add_argument("recording")
    c.add_argument("--out", help='output folder (default: "<name> rough cut" next to the recording)')
    c.add_argument("--rules-only", action="store_true", help="skip Claude; cut fillers and earlier takes by rule")
    c.add_argument("--model", default="opus", help="Claude model alias for the CLI (default: opus)")
    c.add_argument("--style", help="style guide markdown (default: the built-in talking-head guide)")
    c.add_argument("--backend", choices=["mlx", "cpu"], help="transcription backend (default: mlx on Apple Silicon)")
    c.add_argument("--whisper-model", help="override the speech model")
    c.add_argument("--transcript", help="use this transcript.json instead of transcribing")
    c.add_argument("--retranscribe", action="store_true", help="ignore the cached transcript")
    c.add_argument("--no-preview", action="store_true", help="skip rendering preview.mp4")
    c.add_argument("--pad-in", type=float, default=0.08, help="seconds kept before a word at a cut (default 0.08)")
    c.add_argument("--pad-out", type=float, default=0.15, help="seconds kept after a word at a cut (default 0.15)")
    c.add_argument("--max-pause", type=float, default=0.35, help="longest pause left between kept lines (default 0.35)")
    args = ap.parse_args(argv)
    try:
        return cut(args)
    except (media.MediaError, RuntimeError, ValueError) as e:
        log(str(e))
        return 1


if __name__ == "__main__":
    sys.exit(main())
