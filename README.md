# Roughcut

A personal, AI-native video editor for macOS. Drop in a talking-head or screen-share recording and Claude makes the first 80 to 90% of the cut; you finish it on a Final Cut-style timeline or by editing the transcript.

**Status:** planning. No app code yet.

## The idea

- **Claude does the rough cut.** Best takes, fillers and pauses, pacing, punch-ins, titles from your design kit, screen zooms.
- **One shared timeline.** Claude's edits arrive as change sets you accept or reject. Leave comments on the timeline as tasks for Claude.
- **Instructions, not a text box.** Rules (dos and don'ts), skills, settings and per-format profiles, stored as files Claude reads natively.
- **It learns your taste.** Corrections you make turn into suggested rules you approve.
- **Slim and local.** Tauri app, footage never leaves the Mac, and all AI runs through the official `claude` CLI and a local MCP server on a Claude subscription. No Anthropic API key.

## Planned stack

| Piece | Choice |
| --- | --- |
| App shell | Tauri (Rust core, system WebKit UI) |
| Claude | Local MCP server + `claude -p` in the sidebar, on a Claude plan |
| Media | FFmpeg proxies, all-intra for scrubbing |
| Transcription | On-device (Parakeet MLX / WhisperKit) |
| Motion graphics | HyperFrames (HTML + GSAP), Remotion as fallback |
| Recording | Separate slim native Swift recorder (ScreenCaptureKit) |
| Project format | Folder with JSON edit list, op log, transcript, `CLAUDE.md` style guide, design kit |

## Docs

- [Planning doc](docs/planning.md) (snapshot; the living version is [on Claude](https://claude.ai/code/artifact/00bf2ea2-aca2-4ab8-9ef9-e3fbf388011b))
- [UI mockups](https://claude.ai/artifact/Ju4AVzXTb8bi2Y8KBQUyg9)

## Roadmap

0. Headless first cut: a script that turns a recording into an FCPXML rough cut, plus the playback and scrubbing spikes.
1. Slim recorder.
2. Editor core: timeline, transcript editing, Claude sidebar, change-set review.
3. Screen-recording features and the design kit.
4. Preference loop and the Instructions area.
5. Extras.
