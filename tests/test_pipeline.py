import json
import shutil
import stat
import subprocess
import sys
import xml.etree.ElementTree as ET
from fractions import Fraction
from pathlib import Path

import pytest

from roughcut import analyze, decide, fcpxml, timeline
from roughcut.media import SourceInfo
from roughcut.transcribe import Word


def words_from(spec):
    """spec: list of (text, start, end)."""
    return [Word(t, a, b, 0.9) for t, a, b in spec]


SAMPLE = words_from([
    ("The", 1.0, 1.2), ("rule", 1.2, 1.4), ("was", 1.4, 1.6), ("simple,", 1.6, 1.9), ("I", 1.9, 2.0), ("could", 2.0, 2.2),
    ("Um,", 3.0, 3.3),
    ("The", 4.0, 4.2), ("rule", 4.2, 4.4), ("was", 4.4, 4.6), ("simple.", 4.6, 5.0),
    ("It", 5.2, 5.3), ("goes.", 5.3, 5.7),
])


def test_units_split_fillers_and_flag_retakes():
    units = analyze.analyze(SAMPLE)
    texts = [u.text for u in units]
    assert texts == ["The rule was simple, I could", "Um,", "The rule was simple.", "It goes."]
    assert units[1].kind == "filler"
    assert units[0].retake_of == units[2].id
    assert units[2].retake_of is None


def test_rules_drop_filler_and_earlier_take():
    units = analyze.analyze(SAMPLE)
    d = decide.rules(units)
    assert d.kept(len(SAMPLE)) == set(range(7, 13))


def test_ranges_never_bleed_into_cut_words():
    keep = set(range(len(SAMPLE))) - {6}  # filler at 3.0-3.3 is cut
    r = timeline.kept_ranges(SAMPLE, keep, 10.0, timeline.Params())
    for a, b in r:
        assert not (a < 3.3 and b > 3.0), r
    # 4.0-5.0 and 5.2-5.7 are 0.2s apart, so they play through as one range.
    assert any(a <= 4.0 and b >= 5.7 for a, b in r)


def test_long_pause_is_closed_up():
    w = words_from([("Hello", 0.5, 1.0), ("there.", 1.0, 1.4), ("Next", 4.0, 4.4), ("bit.", 4.4, 4.8)])
    r = timeline.kept_ranges(w, set(range(len(w))), 6.0, timeline.Params())
    assert len(r) == 2
    kept = sum(b - a for a, b in r)
    assert kept < 2.5  # 1.7s of speech plus padding, out of 4.3s


def test_snap_is_frame_accurate_and_ordered():
    fps = Fraction(30000, 1001)
    clips = timeline.snap([(0.0, 1.0), (0.99, 2.0), (5.0, 5.01)], fps)
    assert all(b > a for a, b in clips)
    assert all(clips[i][1] <= clips[i + 1][0] for i in range(len(clips) - 1))


def _src(tmp_path, tc=0.0):
    f = tmp_path / "My Clip.mov"
    f.write_bytes(b"")
    return SourceInfo(f, 60.0, 1920, 1080, Fraction(30000, 1001), True, 48000, 2, tc)


def _secs(t):
    return float(Fraction(t[:-1])) if t != "0s" else 0.0


def test_fcpxml_structure(tmp_path):
    src = _src(tmp_path, tc=3600.0)
    clips = [(0, 30), (60, 120), (300, 310)]
    out = fcpxml.write(src, clips, tmp_path / "cut.fcpxml", "Test", {1: "Cut: filler"})
    root = ET.parse(out).getroot()
    assert root.tag == "fcpxml" and root.get("version") == "1.10"
    spine = root.find("./library/event/project/sequence/spine")
    ac = spine.findall("asset-clip")
    assert len(ac) == 3
    fd = 1001 / 30000
    offset = 0.0
    for el, (a, b) in zip(ac, clips):
        assert _secs(el.get("offset")) == pytest.approx(offset)
        assert _secs(el.get("start")) == pytest.approx(3600 * 30000 / 1001 // 1 * fd + a * fd, abs=fd)
        assert _secs(el.get("duration")) == pytest.approx((b - a) * fd)
        offset += (b - a) * fd
    assert ac[1].find("marker").get("value") == "Cut: filler"
    assert "My%20Clip.mov" in root.find(".//media-rep").get("src")


def test_extract_json_handles_fences():
    assert decide._extract_json('Here:\n```json\n{"cuts": [], "summary": "x"}\n```') == {"cuts": [], "summary": "x"}


def test_claude_pass_with_fake_cli(tmp_path, monkeypatch):
    fake = tmp_path / "claude"
    cuts = [{"from": 6, "to": 6, "reason": "Filler"}, {"from": 4, "to": 5, "reason": "Trails off"}, {"from": 99, "to": 99, "reason": "?"}]
    reply = {"type": "result", "is_error": False, "result": json.dumps({"cuts": cuts, "summary": "ok"}), "duration_ms": 1200}
    fake.write_text(f"#!{sys.executable}\nimport sys, json\nsys.stdin.read()\nprint(json.dumps({reply!r}))\n")
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("ROUGHCUT_CLAUDE", str(fake))
    units = analyze.analyze(SAMPLE)
    d = decide.claude(units, SAMPLE, "style", 10.0)
    assert d.kept(len(SAMPLE)) == set(range(len(SAMPLE))) - {4, 5, 6}
    assert [(c.first, c.last, c.reason) for c in d.cuts] == [(4, 5, "Trails off"), (6, 6, "Filler")]
    assert any("99" in w for w in d.warnings)


def test_cut_inside_a_line_keeps_the_rest():
    # "...in the morning, but the research says it's, sorry, let me start again." with no pause:
    # cutting only the false start keeps the opening sentence.
    w = words_from([("Most", 0.0, 0.3), ("people", 0.3, 0.6), ("think", 0.6, 0.9), ("mornings.", 0.9, 1.4),
                    ("but", 1.45, 1.6), ("it's,", 1.6, 2.0), ("sorry.", 2.2, 2.6), ("But", 3.2, 3.4), ("evenings.", 3.4, 4.0)])
    d = decide.Decision([decide.Cut(4, 6, "False start")])
    r = timeline.kept_ranges(w, d.kept(len(w)), 5.0, timeline.Params())
    assert r[0][0] == 0.0 and 1.4 <= r[0][1] <= 1.45
    assert all(not (a < 2.6 and b > 1.45) for a, b in r)
    assert r[-1][1] >= 4.0


def test_prompt_numbers_every_word():
    units = analyze.analyze(SAMPLE)
    prompt = decide.build_prompt(units, SAMPLE, "style", 10.0)
    assert "6:Um," in prompt and "12:goes." in prompt


@pytest.mark.skipif(not (shutil.which("espeak-ng") and shutil.which("ffmpeg")), reason="needs espeak-ng and ffmpeg")
def test_end_to_end_rules_only(tmp_path):
    sys.path.insert(0, str(Path(__file__).parent))
    import synth

    video = synth.build(tmp_path / "talk.mp4")
    from roughcut.cli import main

    rc = main(["cut", str(video), "--transcript", str(video.with_suffix(".transcript.json")), "--rules-only", "--out", str(tmp_path / "out")])
    assert rc == 0
    out = tmp_path / "out"
    for name in ("cut.fcpxml", "report.md", "decisions.json", "preview.mp4"):
        assert (out / name).exists(), name
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(out / "preview.mp4")], capture_output=True, text=True).stdout)
    assert 15 < dur < 35


def test_edit_rate_handles_variable_frame_rate():
    from roughcut.media import _edit_rate

    assert _edit_rate({"r_frame_rate": "30000/1001", "avg_frame_rate": "30000/1001"}) == Fraction(30000, 1001)
    assert _edit_rate({"r_frame_rate": "60/1", "avg_frame_rate": "60/1"}) == 60
    # A screen recording: nominal 60, averaging 41 because idle frames were skipped.
    assert _edit_rate({"r_frame_rate": "60/1", "avg_frame_rate": "41/1"}) == 60
    # ffprobe reporting an odd nominal rate for a variable stream.
    assert _edit_rate({"r_frame_rate": "10000/1001", "avg_frame_rate": "23490000/1184183"}) == Fraction(24000, 1001)
    assert _edit_rate({"r_frame_rate": "0/0", "avg_frame_rate": "0/0"}) == 30


def _wav(tmp_path, pieces, sr=16000):
    """pieces: list of (kind, seconds) with kind 'quiet', 'hum' (a held vowel) or 'speech' (a moving spectrum)."""
    import wave

    np = pytest.importorskip("numpy")
    rng = np.random.default_rng(0)
    out = []
    for kind, secs in pieces:
        t = np.arange(int(sr * secs)) / sr
        if kind == "quiet":
            out.append(rng.normal(0, 0.0005, len(t)))
        elif kind == "hum":
            out.append(sum(0.3 / k * np.sin(2 * np.pi * 120 * k * t) for k in range(1, 8)))
        else:
            # Syllables: a pitch glide with formants that jump every 80ms, plus some hiss.
            f0 = 110 + 60 * np.sin(2 * np.pi * 3 * t)
            phase = 2 * np.pi * np.cumsum(f0) / sr
            sig = np.zeros_like(t)
            for k in range(1, 12):
                gain = np.repeat(rng.uniform(0, 1, len(t) // 1280 + 1), 1280)[: len(t)]
                sig += gain * 0.25 / k * np.sin(k * phase)
            out.append(sig + rng.normal(0, 0.02, len(t)))
    x = np.concatenate(out)
    path = tmp_path / "a.wav"
    with wave.open(str(path), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(sr)
        f.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes())
    return path


def test_stretched_word_gives_up_its_pause_and_hidden_um(tmp_path):
    from roughcut import hesitations

    # "for" (0.5-0.9), then an "uh" (1.2-1.7), a pause, and "thirty" (2.6-3.0) that Whisper
    # timed as 0.9-3.0, as it did in Luke's first test.
    wav = _wav(tmp_path, [("quiet", 0.5), ("speech", 0.4), ("quiet", 0.3), ("hum", 0.5), ("quiet", 0.9), ("speech", 0.4), ("quiet", 0.5)])
    words = words_from([("for", 0.5, 0.9), ("30", 0.9, 3.0), ("days.", 3.0, 3.4)])
    out, fixed, found = hesitations.refine(words, hesitations.analyse(wav))
    texts = [w.text for w in out]
    assert texts == ["for", "[um]", "30", "days."], out
    um, thirty = out[1], out[2]
    assert 1.1 <= um.start <= 1.3 and 1.6 <= um.end <= 1.8
    assert 2.5 <= thirty.start <= 2.7
    assert found == 1 and fixed == 1
    assert analyze.is_filler(um)


def test_normal_words_are_left_alone(tmp_path):
    from roughcut import hesitations

    wav = _wav(tmp_path, [("quiet", 0.2), ("speech", 1.0), ("quiet", 0.3)])
    words = words_from([("Most", 0.2, 0.5), ("people", 0.5, 0.85), ("think", 0.85, 1.2)])
    out, fixed, found = hesitations.refine(words, hesitations.analyse(wav))
    assert out == words and fixed == found == 0


def test_transcribe_only_cuts_nothing(tmp_path):
    sys.path.insert(0, str(Path(__file__).parent))
    import synth

    video = synth.build(tmp_path / "talk.mp4")
    from roughcut.cli import main

    out = tmp_path / "out"
    rc = main(["cut", str(video), "--transcript", str(video.with_suffix(".transcript.json")), "--transcribe-only", "--out", str(out)])
    assert rc == 0
    assert (out / "words.json").exists()
    assert json.loads((out / "decisions.json").read_text())["cuts"] == []
    assert not (out / "cut.fcpxml").exists()
