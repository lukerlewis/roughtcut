"""Write the cut as FCPXML 1.10, which Final Cut Pro (and DaVinci Resolve) import
as a project with each kept stretch as a clip on the primary storyline."""

from __future__ import annotations

from fractions import Fraction
from pathlib import Path
from xml.sax.saxutils import quoteattr

from .media import SourceInfo


def _t(frames: int, fd: Fraction) -> str:
    """A time as a whole number of frames, written unreduced (e.g. 3003/30000s) the way Final Cut does."""
    if frames == 0:
        return "0s"
    if fd.numerator == 1 and frames % fd.denominator == 0:
        return f"{frames // fd.denominator}s"
    return f"{frames * fd.numerator}/{fd.denominator}s"


def write(
    src: SourceInfo,
    clips: list[tuple[int, int]],
    dest: Path,
    project_name: str,
    markers: dict[int, str] | None = None,
) -> Path:
    """clips: [start_frame, end_frame) in source frames. markers: clip index -> note shown at the start of that clip."""
    fd = Fraction(1) / src.fps
    tc0 = round(src.tc_start * src.fps)
    total = round(src.duration * src.fps)
    seq_len = sum(b - a for a, b in clips)
    markers = markers or {}
    audio = (
        f' hasAudio="1" audioSources="1" audioChannels="{src.audio_channels}" audioRate="{src.audio_rate}"'
        if src.has_audio
        else ""
    )
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<!DOCTYPE fcpxml>",
        '<fcpxml version="1.10">',
        "  <resources>",
        f'    <format id="r1" frameDuration="{_t(1, fd)}" width="{src.width}" height="{src.height}" colorSpace="1-1-1 (Rec. 709)"/>',
        f'    <asset id="r2" name={quoteattr(src.path.stem)} start="{_t(tc0, fd)}" duration="{_t(total, fd)}" hasVideo="1" format="r1"{audio}>',
        f'      <media-rep kind="original-media" src={quoteattr(src.path.as_uri())}/>',
        "    </asset>",
        "  </resources>",
        "  <library>",
        '    <event name="Roughcut">',
        f"      <project name={quoteattr(project_name)}>",
        f'        <sequence format="r1" duration="{_t(seq_len, fd)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">',
        "          <spine>",
    ]
    offset = 0
    for i, (a, b) in enumerate(clips):
        start = tc0 + a
        attrs = (
            f'ref="r2" offset="{_t(offset, fd)}" name={quoteattr(src.path.stem)} '
            f'start="{_t(start, fd)}" duration="{_t(b - a, fd)}" format="r1" tcFormat="NDF"'
        )
        if i in markers:
            lines.append(f"            <asset-clip {attrs}>")
            lines.append(f'              <marker start="{_t(start, fd)}" duration="{_t(1, fd)}" value={quoteattr(markers[i][:200])}/>')
            lines.append("            </asset-clip>")
        else:
            lines.append(f"            <asset-clip {attrs}/>")
        offset += b - a
    lines += [
        "          </spine>",
        "        </sequence>",
        "      </project>",
        "    </event>",
        "  </library>",
        "</fcpxml>",
        "",
    ]
    dest.write_text("\n".join(lines))
    return dest
