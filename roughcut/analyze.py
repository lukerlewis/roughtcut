"""Split the transcript into small units Claude can keep or drop, and flag the
obvious candidates: filler words, long pauses and retakes."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from difflib import SequenceMatcher

from .transcribe import Word

FILLERS = {"um", "umm", "uh", "uhh", "uhm", "erm", "er", "ah", "ahh", "hmm", "mm", "mmm"}
SPLIT_GAP = 0.35  # seconds of silence that starts a new unit
MAX_UNIT_WORDS = 30
RETAKE_WINDOW = 8  # how many following units to compare against
RETAKE_SECONDS = 45.0
RETAKE_SIMILARITY = 0.7


def norm(text: str) -> str:
    return re.sub(r"[^a-z0-9' ]", "", text.lower()).strip()


def is_filler(word: Word) -> bool:
    return norm(word.text) in FILLERS


def ends_sentence(word: Word) -> bool:
    return word.text.rstrip().endswith((".", "?", "!"))


def trails_off(word: Word) -> bool:
    return word.text.rstrip().endswith(("-", "—", "–", "..."))


@dataclass
class Unit:
    id: int
    first: int  # index of first word
    last: int  # index of last word (inclusive)
    start: float
    end: float
    text: str
    kind: str  # "speech" or "filler"
    pause_before: float
    flags: list[str] = field(default_factory=list)
    # id of the later unit this one seems to be an earlier attempt at
    retake_of: int | None = None

    @property
    def n_words(self) -> int:
        return self.last - self.first + 1


def split_units(words: list[Word]) -> list[Unit]:
    groups: list[list[int]] = []
    for i, w in enumerate(words):
        if not groups:
            groups.append([i])
            continue
        prev = words[groups[-1][-1]]
        gap = w.start - prev.end
        new = (
            gap >= SPLIT_GAP
            or ends_sentence(prev)
            or trails_off(prev)
            or is_filler(w)
            or is_filler(prev)
            or len(groups[-1]) >= MAX_UNIT_WORDS
        )
        if new:
            groups.append([i])
        else:
            groups[-1].append(i)

    units = []
    for n, g in enumerate(groups):
        first, last = g[0], g[-1]
        prev_end = words[first - 1].end if first > 0 else 0.0
        all_filler = all(is_filler(words[i]) for i in g)
        units.append(
            Unit(
                id=n,
                first=first,
                last=last,
                start=words[first].start,
                end=words[last].end,
                text=" ".join(words[i].text for i in g),
                kind="filler" if all_filler else "speech",
                pause_before=round(words[first].start - prev_end, 2),
            )
        )
    return units


def _similar(a: str, b: str) -> float:
    aw, bw = norm(a).split(), norm(b).split()
    if len(aw) < 3 or not bw:
        return 0.0
    k = min(len(aw), len(bw), 8)
    return SequenceMatcher(None, aw[:k], bw[:k]).ratio()


def flag(units: list[Unit], words: list[Word]) -> list[Unit]:
    speech = [u for u in units if u.kind == "speech"]
    for u in units:
        if u.kind == "filler":
            u.flags.append("filler")
        if u.pause_before >= 1.0:
            u.flags.append(f"long pause before ({u.pause_before:.1f}s)")
        if trails_off(words[u.last]):
            u.flags.append("trails off")
        if sum(words[i].prob for i in range(u.first, u.last + 1)) / u.n_words < 0.5:
            u.flags.append("low-confidence transcript")
    for i, u in enumerate(speech):
        for v in speech[i + 1 : i + 1 + RETAKE_WINDOW]:
            if v.start - u.end > RETAKE_SECONDS:
                break
            if _similar(u.text, v.text) >= RETAKE_SIMILARITY:
                u.retake_of = v.id
                u.flags.append(f"possible retake: said again in #{v.id}")
                break
    return units


def analyze(words: list[Word]) -> list[Unit]:
    return flag(split_units(words), words)
