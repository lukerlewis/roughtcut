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
    assert d.keep == {units[2].id, units[3].id}


def test_ranges_never_bleed_into_cut_units():
    units = analyze.analyze(SAMPLE)
    keep = {units[0].id, units[2].id, units[3].id}  # filler at 3.0-3.3 is cut
    r = timeline.kept_ranges(units, SAMPLE, keep, 10.0, timeline.Params())
    for a, b in r:
        assert not (a < 3.3 and b > 3.0), r
    # 4.0-5.0 and 5.2-5.7 are 0.2s apart, so they play through as one range.
    assert any(a <= 4.0 and b >= 5.7 for a, b in r)


def test_long_pause_is_closed_up():
    w = words_from([("Hello", 0.5, 1.0), ("there.", 1.0, 1.4), ("Next", 4.0, 4.4), ("bit.", 4.4, 4.8)])
    units = analyze.analyze(w)
    r = timeline.kept_ranges(units, w, {u.id for u in units}, 6.0, timeline.Params())
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
    reply = {"type": "result", "is_error": False, "result": json.dumps({"cuts": [{"id": 1, "reason": "Filler"}, {"id": 99, "reason": "?"}], "summary": "ok"}), "duration_ms": 1200}
    fake.write_text(f"#!{sys.executable}\nimport sys, json\nsys.stdin.read()\nprint(json.dumps({reply!r}))\n")
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("ROUGHCUT_CLAUDE", str(fake))
    units = analyze.analyze(SAMPLE)
    d = decide.claude(units, "style", 10.0)
    assert d.keep == {u.id for u in units} - {1}
    assert d.reasons == {1: "Filler"}
    assert any("99" in w for w in d.warnings)


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
