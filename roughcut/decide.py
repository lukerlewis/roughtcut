"""Decide which units to keep: a simple rule-based pass, or Claude via the
official `claude` CLI on Luke's subscription. No API key, no SDK."""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import subprocess
from dataclasses import dataclass, field

from .analyze import Unit
from .transcribe import Word


@dataclass
class Cut:
    first: int  # index of the first word cut
    last: int  # index of the last word cut (inclusive)
    reason: str


@dataclass
class Decision:
    cuts: list[Cut]  # in word order, never overlapping
    summary: str = ""
    by: str = "rules"
    usage: dict = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)

    def kept(self, n_words: int) -> set[int]:
        gone = {i for c in self.cuts for i in range(c.first, c.last + 1)}
        return set(range(n_words)) - gone


def tidy(cuts: list[Cut]) -> list[Cut]:
    """Sort cuts and merge any that overlap, keeping the first reason."""
    out: list[Cut] = []
    for c in sorted(cuts, key=lambda c: (c.first, c.last)):
        if out and c.first <= out[-1].last:
            out[-1].last = max(out[-1].last, c.last)
        else:
            out.append(Cut(c.first, c.last, c.reason))
    return out


def rules(units: list[Unit]) -> Decision:
    """Baseline: drop fillers and earlier attempts at a line. Pauses are
    tightened later when ranges are built."""
    cuts = []
    for u in units:
        if u.kind == "filler":
            cuts.append(Cut(u.first, u.last, "Filler word"))
        elif u.retake_of is not None:
            cuts.append(Cut(u.first, u.last, "Earlier take of a line said again later"))
        elif "trails off" in u.flags:
            cuts.append(Cut(u.first, u.last, "Abandoned sentence"))
    return Decision(tidy(cuts), by="rules")


def _fmt(t: float) -> str:
    m, s = divmod(t, 60)
    return f"{int(m):02d}:{s:04.1f}"


def build_prompt(units: list[Unit], words: list[Word], style: str, duration: float) -> str:
    lines = []
    for u in units:
        flags = f" [{'; '.join(u.flags)}]" if u.flags else ""
        tagged = " ".join(f"{i}:{words[i].text}" for i in range(u.first, u.last + 1))
        lines.append(f"{_fmt(u.start)}-{_fmt(u.end)} pause {u.pause_before:.1f}s{flags}\n  {tagged}")
    listing = "\n".join(lines)
    return f"""You are making the rough cut of a raw recording ({_fmt(duration)} long). The transcript below is grouped into lines with timings, the pause before each line, and flags from an automatic pass. Flags are hints, not decisions. Every word carries its number, as number:word. [um] marks a held sound found in the audio that speech-to-text left out, almost always an um or uh; cut it unless the words around it read as if a word is missing there.

Decide which words to cut so the video plays as a tight, natural first cut. Typical cuts: false starts and earlier takes of a line that is said again later (keep the best take, usually the last), filler words and hesitations, stammered or repeated words ("this is a this, this is a"), abandoned sentences, off-topic chatter before the real start or after the real end, and "let me redo that" moments. Cut precisely: a line can hold a good sentence followed by a false start, so cut only the words that should go and keep the rest. A cut is a span of consecutive word numbers. Don't rewrite or reorder anything. When unsure, keep it. Pauses between kept words are tightened automatically, so don't cut words just for a pause.

Style guide:
{style.strip()}

Transcript:
{listing}

Reply with only a JSON object, no prose around it:
{{"cuts": [{{"from": <first word number>, "to": <last word number, inclusive>, "reason": "<short reason>"}}], "summary": "<two or three sentences to Luke on what you did and anything he should check, pointing to moments by timecode (mm:ss), never by word number>"}}
Every word not inside a cut is kept."""


SCHEMA = {
    "type": "object",
    "properties": {
        "cuts": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"from": {"type": "integer"}, "to": {"type": "integer"}, "reason": {"type": "string"}},
                "required": ["from", "to", "reason"],
            },
        },
        "summary": {"type": "string"},
    },
    "required": ["cuts", "summary"],
}


def _extract_json(text: str) -> dict:
    text = text.strip()
    fence = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.S)
    if fence:
        text = fence.group(1)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < 0:
        raise ValueError("Claude's reply had no JSON object in it.")
    return json.loads(text[start : end + 1])


def claude_command(model: str) -> list[str]:
    exe = os.environ.get("ROUGHCUT_CLAUDE", "claude")
    if shutil.which(exe) is None:
        raise RuntimeError(
            "The `claude` CLI isn't on your PATH. Install Claude Code and run `claude` once to log in with your plan."
        )
    cmd = [
        exe, "-p", "--model", model, "--output-format", "json", "--tools", "",
        "--no-session-persistence", "--json-schema", json.dumps(SCHEMA),
    ]
    cmd += shlex.split(os.environ.get("ROUGHCUT_CLAUDE_ARGS", ""))
    return cmd


def claude(units: list[Unit], words: list[Word], style: str, duration: float, model: str = "opus", timeout: int = 1200) -> Decision:
    prompt = build_prompt(units, words, style, duration)
    proc = subprocess.run(claude_command(model), input=prompt, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        raise RuntimeError(f"claude exited with {proc.returncode}: {(proc.stderr or proc.stdout).strip()[-800:]}")
    outer = json.loads(proc.stdout)
    if outer.get("is_error"):
        raise RuntimeError(f"Claude returned an error: {outer.get('result') or outer}")
    data = outer.get("structured_output") or _extract_json(outer.get("result", ""))
    usage = {k: outer[k] for k in ("duration_ms", "num_turns", "total_cost_usd", "usage", "modelUsage") if k in outer}

    cuts, warnings = [], []
    for c in data.get("cuts", []):
        try:
            a, b = int(c["from"]), int(c["to"])
        except (KeyError, TypeError, ValueError):
            warnings.append(f"Ignored a malformed cut: {c!r}")
            continue
        a, b = min(a, b), max(a, b)
        if a < 0 or b >= len(words):
            warnings.append(f"Ignored a cut for words {a}-{b}, outside the transcript")
            continue
        cuts.append(Cut(a, b, str(c.get("reason", "")).strip() or "Cut by Claude"))
    return Decision(tidy(cuts), summary=str(data.get("summary", "")), by=f"claude ({model})", usage=usage, warnings=warnings)
