"""A readable report of what was cut and why, plus a scorecard for testing."""

from __future__ import annotations

from pathlib import Path

from .decide import Cut, Decision
from .transcribe import Word


def _tc(t: float) -> str:
    m, s = divmod(t, 60)
    h, m = divmod(int(m), 60)
    return f"{h:d}:{m:02d}:{s:05.2f}" if h else f"{m:02d}:{s:05.2f}"


def span_text(words: list[Word], c: Cut) -> str:
    return " ".join(words[i].text for i in range(c.first, c.last + 1))


def write(dest: Path, name: str, words: list[Word], d: Decision, duration: float, cut_duration: float, n_clips: int) -> Path:
    cuts = d.cuts
    n_cut_words = sum(c.last - c.first + 1 for c in cuts)
    saved = duration - cut_duration
    out = [
        f"# Rough cut: {name}",
        "",
        f"Decided by **{d.by}**. {_tc(duration)} raw, {_tc(cut_duration)} cut ({saved / max(duration, 1e-9):.0%} shorter), {n_clips} clips, {len(cuts)} cuts removing {n_cut_words} of {len(words)} words.",
        "",
    ]
    if d.summary:
        out += ["## Claude's notes", "", d.summary, ""]
    if d.usage:
        u = d.usage
        bits = []
        if "duration_ms" in u:
            bits.append(f"{u['duration_ms'] / 1000:.0f}s")
        tokens = u.get("usage") or {}
        if tokens:
            bits.append(
                f"{tokens.get('input_tokens', 0) + tokens.get('cache_read_input_tokens', 0) + tokens.get('cache_creation_input_tokens', 0):,} input tokens"
            )
            bits.append(f"{tokens.get('output_tokens', 0):,} output tokens")
        if "total_cost_usd" in u:
            bits.append(f"API-equivalent cost ${u['total_cost_usd']:.2f} (not billed on a plan, but a fair gauge of how much of the limit it used)")
        out += ["## Usage", "", ", ".join(bits) + ".", ""]
    if d.warnings:
        out += ["## Warnings", ""] + [f"- {w}" for w in d.warnings] + [""]
    out += ["## What was cut", "", "| At | Cut | Why |", "| --- | --- | --- |"]
    for c in cuts:
        text = span_text(words, c).replace("|", "\\|")
        reason = c.reason.replace("|", "\\|")
        out.append(f"| {_tc(words[c.first].start)} | {text} | {reason} |")
    out += [
        "",
        "## Scorecard (fill in after watching preview.mp4)",
        "",
        "| Check | Target | Result |",
        "| --- | --- | --- |",
        f"| Cuts you kept, out of {len(cuts)} | 80% or more | |",
        "| Words clipped at a cut point | None | |",
        "| Takes Claude picked that you'd swap | Few | |",
        "",
    ]
    dest.write_text("\n".join(out))
    return dest
