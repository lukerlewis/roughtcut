# Phase 0: rough cut from the command line

The first step proves the core bet before any app exists: can Claude cut Luke's raw footage well enough that finishing it takes less than half the usual time? Final Cut stands in as the timeline.

## What it does

`roughcut cut recording.mov`:

1. Pulls the audio out with FFmpeg and transcribes it on the Mac with word timings (mlx-whisper on Apple Silicon). Nothing is uploaded.
2. Splits the transcript into short units and flags fillers, long pauses, abandoned sentences and likely retakes.
3. Sends the units and the style guide to Claude through the `claude` CLI on Luke's plan (`claude -p`, Opus by default, no tools). Claude returns which units to cut and why.
4. Builds frame-accurate clip ranges: pads each cut so words aren't clipped and closes up long pauses.
5. Writes `cut.fcpxml` for Final Cut, a `report.md` of every cut with its reason, and a small `preview.mp4`.

Everything lands in `recording.mov.roughcut/` next to the source. The transcript is cached there, so rerunning (say with a tweaked style guide) skips straight to Claude.

## Setup on the Mac

Needs Homebrew, Python 3.10+ and Claude Code logged in with Luke's plan.

```sh
brew install ffmpeg
git clone https://github.com/lukerlewis/roughtcut && cd roughtcut
python3 -m venv .venv && source .venv/bin/activate
pip install -e '.[mlx]'
claude --version   # must be installed and logged in; run `claude` once if not
```

The first transcription downloads the speech model (roughly 1.5 GB, once).

## Running it

```sh
roughcut cut ~/Movies/raw/take-01.mov
```

Then in Final Cut: **File > Import > XML…** and pick `take-01.mov.roughcut/cut.fcpxml`. It opens as a project in a "Roughcut" event, with a marker at each cut saying what was removed.

Useful options:

| Option | What it does |
| --- | --- |
| `--rules-only` | Skip Claude and cut fillers and earlier takes by rule. A baseline to compare Claude against. |
| `--style my-style.md` | Use your own style guide instead of `roughcut/styles/talking-head.md`. |
| `--model sonnet` | Use a lighter model to save plan usage. |
| `--max-pause 0.5` | Leave longer pauses between lines (default 0.35s). |
| `--pad-out 0.2` | Keep more after the last word at each cut if endings sound clipped. |
| `--retranscribe` | Ignore the cached transcript. |
| `--no-preview` | Skip rendering `preview.mp4`. |

## How to test it

Use three real recordings:

1. A talking head with retakes.
2. A screen share.
3. One you've already edited yourself, as a benchmark.

For each, run `roughcut cut`, import the FCPXML, finish the edit, and fill in the scorecard at the bottom of `report.md`:

| Check | Target |
| --- | --- |
| Claude's cuts you kept | 80% or more |
| Time to finish vs. your usual | Under half |
| Words clipped at a cut point | None |
| Plan usage per video | Note it from the report's Usage line |
| How close it gets to your own edit (benchmark video) | Judgement call |

If it hits the targets, the app is worth building. If not, the fix is in the style guide, the prompt in `roughcut/decide.py`, or the padding, all cheap to change now.

## Known limits

- Cuts are whole units (a phrase between pauses). It can't yet cut a single word out of the middle of a phrase.
- Whisper sometimes tidies fillers out of the transcript even though the audio has them. Those stay in until the next phase adds an audio check.
- Variable-frame-rate screen recordings are cut at their nominal frame rate. Final Cut handles this fine; other tools may drift slightly.
- Only one source file per run. Multi-cam and separate audio come later.

## Developing

```sh
pip install -e '.[cpu,dev]'
pytest
```

`tests/synth.py` builds a fake recording with espeak-ng (fillers, a retake, a mic check, long pauses) plus a matching transcript, so the pipeline can be tested without a speech model.
