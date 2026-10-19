"""Speech to text with word timings, on the Mac. No cloud.

Backends:
  mlx     mlx-whisper on Apple Silicon (default on a Mac)
  cpu     faster-whisper on the CPU (Intel Macs, Linux, tests)

Whisper tends to tidy away "um" and "uh". A disfluent initial prompt nudges it to
keep them, which matters because fillers are half of what we cut.
"""

from __future__ import annotations

import json
import platform
from dataclasses import asdict, dataclass
from pathlib import Path

FILLER_PROMPT = "Umm, so, uh, I was like, you know, hmm. Okay, um, let me, uh, start again."


@dataclass
class Word:
    text: str
    start: float
    end: float
    prob: float = 1.0


def default_backend() -> str:
    if platform.system() == "Darwin" and platform.machine() == "arm64":
        return "mlx"
    return "cpu"


def transcribe(audio: Path, backend: str | None = None, model: str | None = None) -> list[Word]:
    backend = backend or default_backend()
    if backend == "mlx":
        return _mlx(audio, model or "mlx-community/whisper-large-v3-turbo")
    if backend == "cpu":
        return _faster(audio, model or "small.en")
    raise ValueError(f"Unknown transcription backend: {backend}")


def _mlx(audio: Path, model: str) -> list[Word]:
    try:
        import mlx_whisper
    except ImportError as e:
        raise RuntimeError("mlx-whisper isn't installed. Run `pip install 'roughcut[mlx]'`.") from e
    result = mlx_whisper.transcribe(
        str(audio), path_or_hf_repo=model, word_timestamps=True, initial_prompt=FILLER_PROMPT,
        condition_on_previous_text=False, language="en",
    )
    words = []
    for seg in result.get("segments", []):
        for w in seg.get("words", []):
            words.append(Word(w["word"].strip(), float(w["start"]), float(w["end"]), float(w.get("probability", 1.0))))
    return [w for w in words if w.text]


def _faster(audio: Path, model: str) -> list[Word]:
    try:
        from faster_whisper import WhisperModel
    except ImportError as e:
        raise RuntimeError("faster-whisper isn't installed. Run `pip install 'roughcut[cpu]'`.") from e
    m = WhisperModel(model, device="cpu", compute_type="int8")
    segments, _ = m.transcribe(
        str(audio), word_timestamps=True, initial_prompt=FILLER_PROMPT, language="en",
        condition_on_previous_text=False, vad_filter=False,
    )
    words = []
    for seg in segments:
        for w in seg.words or []:
            words.append(Word(w.word.strip(), float(w.start), float(w.end), float(w.probability)))
    return [w for w in words if w.text]


def save(words: list[Word], path: Path) -> None:
    path.write_text(json.dumps([asdict(w) for w in words], indent=1))


def load(path: Path) -> list[Word]:
    return [Word(**w) for w in json.loads(path.read_text())]
