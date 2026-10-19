"""Turn kept words into source ranges: pad each stretch so cuts don't clip
consonants, close up long pauses, and snap to frames."""

from __future__ import annotations

import math
from dataclasses import dataclass
from fractions import Fraction

from .transcribe import Word


@dataclass
class Params:
    pad_in: float = 0.08  # seconds before the first word of a kept stretch
    pad_out: float = 0.15  # after the last word (breath and decay)
    max_pause: float = 0.35  # longer pauses between kept words are cut down to pad_out + pad_in
    min_clip: float = 0.25  # kept stretches shorter than this are dropped


def kept_ranges(words: list[Word], keep: set[int], duration: float, p: Params) -> list[tuple[float, float]]:
    ranges: list[list[float]] = []
    prev = None  # index of the last kept word
    for i, w in enumerate(words):
        if i not in keep:
            continue
        # Pad, but never into a neighbouring word that was cut.
        lo = words[i - 1].end if i > 0 and i - 1 not in keep else 0.0
        hi = words[i + 1].start if i + 1 < len(words) and i + 1 not in keep else duration
        a = max(lo, w.start - p.pad_in, 0.0)
        b = min(hi, w.end + p.pad_out, duration)
        if prev == i - 1 and ranges and w.start - words[prev].end <= p.max_pause:
            # Follows straight on from the previous word: play through.
            ranges[-1][1] = max(ranges[-1][1], b)
        elif ranges and a <= ranges[-1][1]:
            ranges[-1][1] = max(ranges[-1][1], b)
        else:
            ranges.append([a, b])
        prev = i
    return [(a, b) for a, b in ranges if b - a >= p.min_clip]


def snap(ranges: list[tuple[float, float]], fps: Fraction) -> list[tuple[int, int]]:
    """Frame-accurate [start, end) in frames, never overlapping."""
    out: list[tuple[int, int]] = []
    for a, b in ranges:
        fa, fb = math.floor(a * fps), math.ceil(b * fps)
        if out and fa < out[-1][1]:
            fa = out[-1][1]
        if fb > fa:
            out.append((fa, fb))
    return out
