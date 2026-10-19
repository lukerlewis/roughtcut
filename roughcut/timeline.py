"""Turn kept units into source ranges: pad each word so cuts don't clip
consonants, close up long pauses, merge what's nearly touching, and snap to
frames."""

from __future__ import annotations

import math
from dataclasses import dataclass
from fractions import Fraction

from .analyze import Unit
from .transcribe import Word


@dataclass
class Params:
    pad_in: float = 0.08  # seconds before the first word of a kept stretch
    pad_out: float = 0.15  # after the last word (breath and decay)
    max_pause: float = 0.35  # longer pauses between kept units are cut down to pad_out + pad_in
    min_clip: float = 0.4  # kept stretches shorter than this are dropped


def kept_ranges(units: list[Unit], words: list[Word], keep: set[int], duration: float, p: Params) -> list[tuple[float, float]]:
    ranges: list[list[float]] = []
    prev_kept = False
    for i, u in enumerate(units):
        if u.id not in keep:
            prev_kept = False
            continue
        # Pad, but never into a neighbouring unit that was cut.
        lo = units[i - 1].end if i > 0 and units[i - 1].id not in keep else 0.0
        hi = units[i + 1].start if i + 1 < len(units) and units[i + 1].id not in keep else duration
        a = max(lo, u.start - p.pad_in, 0.0)
        b = min(hi, u.end + p.pad_out, duration)
        if prev_kept and ranges and a - ranges[-1][1] <= p.max_pause:
            # Follows straight on from the previous unit after a short pause: play through it.
            ranges[-1][1] = b
        else:
            ranges.append([a, b])
        prev_kept = True
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
