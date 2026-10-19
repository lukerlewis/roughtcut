"""Fix word timings with the audio itself.

Whisper often leaves "um" and "uh" out of the text and stretches the next word
back over them, along with any silence: in one test "actually" lasted 2.7s
because it swallowed a 1.6s pause. Pauses and fillers hidden inside a word
can't be cut, so for every word that runs far longer than it should, we look
at the audio under it:

- silence inside the word becomes a real gap, which the timeline closes up;
- the word itself is taken to be its last stretch of sound (Whisper stretches
  a word's start back, rarely its end);
- an earlier stretch that holds one steady vowel sound for a while is an "um"
  or "uh", and becomes its own "[um]" word so it can be cut;
- any other earlier sound is left to the previous word.

Needs numpy, which the speech engines already install. Without it, words are
left as they are.
"""

from __future__ import annotations

import re
import wave
from dataclasses import dataclass
from pathlib import Path

from .transcribe import Word

HOP = 0.01  # seconds per analysis frame
MIN_SILENCE = 0.2  # quieter stretches inside a word shorter than this are left alone
MIN_SOUND = 0.08  # stretches of sound shorter than this are noise
MIN_HESITATION = 0.25
STEADY = 0.95  # spectral change below this (per 40ms) sounds like one held vowel


@dataclass
class Frames:
    level: list[float]  # dB per frame
    change: list[float]  # how fast the spectrum moves, per frame
    silence: float  # dB below which a frame counts as silent


def expected_length(text: str) -> float:
    """Rough time to say a word at a normal pace, in seconds."""
    letters = len(re.sub(r"[^a-z0-9]", "", text.lower()))
    if text.strip("[]").isdigit() or any(ch.isdigit() for ch in text):
        letters *= 3  # "30" is spoken as "thirty"
    return max(0.25, 0.1 + 0.07 * letters)


def is_stretched(w: Word) -> bool:
    return w.end - w.start > max(0.5, 2.0 * expected_length(w.text))


def analyse(wav: Path) -> Frames:
    import numpy as np

    with wave.open(str(wav)) as f:
        sr = f.getframerate()
        x = np.frombuffer(f.readframes(f.getnframes()), dtype=np.int16).astype(np.float32) / 32768
        if f.getnchannels() > 1:
            x = x.reshape(-1, f.getnchannels()).mean(1)
    hop, n = int(sr * HOP), int(sr * 0.03)
    if len(x) < n:
        return Frames([], [], 0.0)
    idx = np.arange(0, len(x) - n, hop)
    frames = np.stack([x[i : i + n] for i in idx]) * np.hanning(n)
    level = 20 * np.log10(np.sqrt((frames**2).mean(1)) + 1e-9)
    spec = np.abs(np.fft.rfft(frames, axis=1))
    freqs = np.fft.rfftfreq(n, 1 / sr)
    band = np.log(spec[:, (freqs > 80) & (freqs < 4000)] + 1e-5)
    band -= band.mean(1, keepdims=True)
    lag = 4
    change = np.zeros(len(band))
    change[lag:] = np.sqrt(((band[lag:] - band[:-lag]) ** 2).mean(1))
    floor, loud = np.percentile(level, 10), np.percentile(level, 95)
    silence = max(floor + 12, loud - 35)
    return Frames(level.tolist(), change.tolist(), float(silence))


def islands(fr: Frames, a: float, b: float) -> list[tuple[float, float]]:
    """Stretches of sound between a and b, ignoring short dips and blips."""
    lo, hi = int(a / HOP), min(int(b / HOP), len(fr.level))
    out: list[list[float]] = []
    for k in range(lo, hi):
        if fr.level[k] < fr.silence:
            continue
        t = k * HOP
        if out and t - out[-1][1] < MIN_SILENCE:
            out[-1][1] = t + HOP
        else:
            out.append([t, t + HOP])
    return [(s, e) for s, e in out if e - s >= MIN_SOUND]


def steadiness(fr: Frames, a: float, b: float) -> float:
    vals = sorted(fr.change[int(a / HOP) : int(b / HOP)])
    return vals[len(vals) // 2] if vals else 99.0


def refine(words: list[Word], fr: Frames) -> tuple[list[Word], int, int]:
    """Words with corrected timings and "[um]" words inserted, plus counts of
    words fixed and hesitations found."""
    if not fr.level:
        return list(words), 0, 0
    out: list[Word] = []
    fixed = found = 0
    for w in words:
        if not is_stretched(w):
            out.append(w)
            continue
        parts = islands(fr, w.start, w.end)
        if not parts:
            out.append(w)
            continue
        # Join pieces of the word itself that are only split by a short dip.
        word_start, word_end = parts[-1]
        rest = parts[:-1]
        while rest and word_start - rest[-1][1] < MIN_SILENCE and steadiness(fr, *rest[-1]) >= STEADY:
            word_start = rest.pop()[0]
        for s, e in rest:
            if e - s >= MIN_HESITATION and steadiness(fr, s, e) < STEADY:
                out.append(Word("[um]", round(s, 2), round(e, 2), 0.5))
                found += 1
            elif out and not out[-1].text.startswith("["):
                prev = out[-1]
                out[-1] = Word(prev.text, prev.start, max(prev.end, round(e, 2)), prev.prob)
        out.append(Word(w.text, round(word_start, 2), round(max(word_end, word_start + 0.1), 2), w.prob))
        fixed += 1
    return out, fixed, found
