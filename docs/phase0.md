# Phase 0: rough cut from the command line

The first step proves the core bet before any app exists: can Claude cut Luke's raw footage well enough that finishing it takes less than half the usual time? Final Cut stands in as the timeline.

## What it does

`roughcut cut recording.mov`:

1. Pulls the audio out with FFmpeg and transcribes it on the Mac with word timings (mlx-whisper on Apple Silicon). Nothing is uploaded.
2. Checks the audio under any word that runs far longer than it should. Whisper often drops an "um" and stretches the next word over it and any pause, so the silence becomes a real gap and a held "um" sound becomes its own `[um]` word.
3. Groups the words into short lines and flags fillers, long pauses, abandoned sentences and likely retakes.
4. Sends the numbered words, the flags and the style guide to Claude through the `claude` CLI on Luke's plan (`claude -p`, Opus by default, no tools). Claude returns which spans of words to cut and why, so it can drop a false start without losing the good sentence before it.
5. Builds frame-accurate clip ranges: pads each cut so words aren't clipped and closes up long pauses.
6. Writes `cut.fcpxml` for Final Cut, a `report.md` of every cut with its reason, and a small `preview.mp4`.

Everything lands in a `recording rough cut` folder next to the source. The transcript is cached there, so rerunning (say with a tweaked style guide) skips straight to Claude.

## Setup on the Mac

From the repo folder in Terminal:

```sh
bash scripts/setup-mac.sh
```

It installs Homebrew if needed, then FFmpeg and uv, makes a private Python environment in `.venv`, installs Roughcut with the Apple Silicon speech engine, installs Claude Code if it's missing and checks it's logged in to Luke's plan, and downloads the speech model (roughly 1.5 GB, once). It's safe to run again.

## Running it

```sh
bash cut.sh ~/Movies/raw/take-01.mov
```

`cut.sh` runs `roughcut cut` from the private environment and opens the results folder and report when it's done. Options below go after the file name.

Then in Final Cut: **File > Import > XML…** and pick `take-01 rough cut/cut.fcpxml`. It opens as a project in a "Roughcut" event, with a marker at each cut saying what was removed.

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

- The audio check finds an "um" Whisper left out only when it sits inside a stretched word and sounds like one held vowel. A quick "um" squeezed between two words can still slip through, and Whisper's word edges can be off by a tenth of a second or so.
- Variable-frame-rate screen recordings are cut at their nominal frame rate. Final Cut handles this fine; other tools may drift slightly.
- Only one source file per run. Multi-cam and separate audio come later.

## Developing

```sh
pip install -e '.[cpu,dev]'
pytest
```

`tests/synth.py` builds a fake recording with espeak-ng (fillers, a retake, a mic check, long pauses) plus a matching transcript, so the pipeline can be tested without a speech model.
