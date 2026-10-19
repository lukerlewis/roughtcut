# Roughcut

Personal AI-native video editor for macOS, built for one user (Luke). Never public, so no auth, multi-user or telemetry.

## Design

The UI follows `DESIGN.md`: LukeOS's look (grey scale, Geist, Lucide, two meaningful colours), one size denser for a desktop editor. Blue means Claude's unreviewed changes; never use it for anything else.

## Current phase

Phase 0: the command-line rough cut in `roughcut/` (see `docs/phase0.md`). Don't scaffold the Tauri app or add dependencies unless asked. `docs/planning.md` is a snapshot of the living planning doc; the decisions table there is the source of truth.

The Python package has no required dependencies; speech models are optional extras. Run `pytest` before pushing.

## Hard constraints

- **No Anthropic API.** No API keys, no AI SDKs, no bundled models. Claude is reached only through a local MCP server the app exposes and the official `claude` CLI (`claude -p`) on Luke's subscription. Never read or extract the CLI's OAuth token.
- **Slim.** Minimise RAM and disk. Prefer system frameworks and small native helpers over bundled runtimes. Electron is ruled out.
- **Local.** Footage stays on the Mac. Third-party processing only where explicitly approved.
- **Tauri** is the shell (decided). Recording is a separate native Swift helper so the editor UI can close while recording.
- **UI** should feel like Final Cut in layout and density, and like LukeOS in look (see `DESIGN.md`). Not a graphic-design showpiece. No infinite canvas (rejected).

## Project file format (planned)

A project is a folder: JSON edit decision list, op log tagged `you`/`agent`, transcript with word timings, `CLAUDE.md` style guide compiled from rules, `.claude/skills/` for editing skills, `settings.json`, `formats/`, `references/`, design kit. The folder is the source of truth; the app and Claude both edit it.
