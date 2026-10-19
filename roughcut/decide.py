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


@dataclass
class Decision:
    keep: set[int]
    reasons: dict[int, str]  # why each dropped unit was cut
    summary: str = ""
    by: str = "rules"
    usage: dict = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)


def rules(units: list[Unit]) -> Decision:
    """Baseline: drop fillers and earlier attempts at a line. Pauses are
    tightened later when ranges are built."""
    keep, reasons = set(), {}
    for u in units:
        if u.kind == "filler":
            reasons[u.id] = "Filler word"
        elif u.retake_of is not None:
            reasons[u.id] = f"Earlier take of #{u.retake_of}"
        elif "trails off" in u.flags:
            reasons[u.id] = "Abandoned sentence"
        else:
            keep.add(u.id)
    return Decision(keep, reasons, by="rules")


def _fmt(t: float) -> str:
    m, s = divmod(t, 60)
    return f"{int(m):02d}:{s:04.1f}"


def build_prompt(units: list[Unit], style: str, duration: float) -> str:
    lines = []
    for u in units:
        flags = f" [{'; '.join(u.flags)}]" if u.flags else ""
        lines.append(f"#{u.id} {_fmt(u.start)}-{_fmt(u.end)} pause {u.pause_before:.1f}s{flags} | {u.text}")
    listing = "\n".join(lines)
    return f"""You are making the rough cut of a raw recording ({_fmt(duration)} long). The transcript below is split into numbered units with timings, the pause before each, and flags from an automatic pass. Flags are hints, not decisions.

Decide which units to keep so the video plays as a tight, natural first cut. Typical cuts: false starts and earlier takes of a line that is said again later (keep the best take, usually the last), filler words, abandoned sentences, off-topic chatter before the real start or after the real end, and "let me redo that" moments. Don't rewrite or reorder anything; you can only keep or drop whole units. When unsure, keep it. Pauses between kept units are tightened automatically, so don't cut a unit just for its pause.

Style guide:
{style.strip()}

Transcript:
{listing}

Reply with only a JSON object, no prose around it:
{{"cuts": [{{"id": <unit id>, "reason": "<short reason>"}}], "summary": "<two or three sentences to Luke on what you did and anything he should check, pointing to moments by timecode (mm:ss), never by unit number>"}}
Every unit not listed in "cuts" is kept."""


SCHEMA = {
    "type": "object",
    "properties": {
        "cuts": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"id": {"type": "integer"}, "reason": {"type": "string"}},
                "required": ["id", "reason"],
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


def claude(units: list[Unit], style: str, duration: float, model: str = "opus", timeout: int = 1200) -> Decision:
    prompt = build_prompt(units, style, duration)
    proc = subprocess.run(claude_command(model), input=prompt, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        raise RuntimeError(f"claude exited with {proc.returncode}: {(proc.stderr or proc.stdout).strip()[-800:]}")
    outer = json.loads(proc.stdout)
    if outer.get("is_error"):
        raise RuntimeError(f"Claude returned an error: {outer.get('result') or outer}")
    data = outer.get("structured_output") or _extract_json(outer.get("result", ""))
    usage = {k: outer[k] for k in ("duration_ms", "num_turns", "total_cost_usd", "usage", "modelUsage") if k in outer}

    ids = {u.id for u in units}
    reasons, warnings = {}, []
    for c in data.get("cuts", []):
        try:
            uid = int(c["id"])
        except (KeyError, TypeError, ValueError):
            warnings.append(f"Ignored a malformed cut: {c!r}")
            continue
        if uid not in ids:
            warnings.append(f"Ignored a cut for unknown unit #{uid}")
            continue
        reasons[uid] = str(c.get("reason", "")).strip() or "Cut by Claude"
    keep = ids - set(reasons)
    return Decision(keep, reasons, summary=str(data.get("summary", "")), by=f"claude ({model})", usage=usage, warnings=warnings)
