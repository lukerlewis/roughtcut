# AI-Native Video Editor: Planning Doc

Oct 19, 2026 · @Luke

## TL;DR

Luke is planning a personal, AI-native Mac editor for talking-head and screen-share videos, where Claude makes the first 80 to 90% of the cut. Everything runs on his Claude subscription with no API key, and Claude lives in the app's sidebar through the official claude CLI, with no AI SDK or bundled model. This is the plan as of Oct 19, after the first planning conversation; see the [mockups](https://claude.ai/artifact/Ju4AVzXTb8bi2Y8KBQUyg9).

- **App:** a Tauri app (decided) with a dense, Final Cut-style pro UI. Roughly 10 to 20 MB installed and a few hundred MB of RAM while editing. Footage never leaves the Mac.
- **Claude:** the app runs a local MCP server. Luke works with Claude in the desktop app or Claude Code, and comments left for Claude inside the app run the official `claude` CLI in the background on his plan.
- **Shared timeline:** one project file with an edit log. Transcript editing, the timeline and Claude all change the same file, and Claude's changes are reviewed like tracked changes.
- **Recording:** done in the app, by a separate slim recorder (estimated 50 to 150 MB RAM) that logs cursor, clicks and keystrokes. That data drives auto zoom, auto layouts, auto blur and speed ramps.
- **Understanding footage:** on-device transcription and on-screen text recognition; Claude looks at frames when it needs to see something.
- **Motion graphics:** HyperFrames compositions written by Opus from Luke's design kit, with Remotion as the fallback.
- **Learning:** a style guide Claude reads every time, with new rules proposed from Luke's corrections.
- **Running cost:** about $0 beyond the Claude plan.
- **Hardest parts:** taste, smooth playback in WebKit (tested before any UI work), and making Claude's edits easy to review.

## Decisions so far

| Topic | Decision | Why |
| --- | --- | --- |
| Users | Luke only, never public | No accounts, hosting or sync needed |
| Platform | Tauri | Slim; its pro UI looked fine next to a native Swift mockup |
| UI style | Final Cut-like pro editor, not a designed showpiece | Luke's call after the first mockups |
| AI access | Claude subscription only, through MCP and the `claude` CLI; no Anthropic API | Luke's requirement |
| Content | Mostly talking head, plus a lot of screen sharing | Luke's answer |
| Recording | In the app, as a separate slim recording mode | Keeps RAM free for whatever is being demoed |
| Motion graphics | HyperFrames, Remotion as fallback | Built for agents, light, previews in WebKit |
| Transcription | On-device by default | Free, private, no outside service |
| Infinite canvas | Dropped | Luke's call |

## Landscape

"Agentic video editing" became a crowded category in 2026, but nobody does all of what you described: a fully shared timeline, comments as tasks for the agent, learned taste, and a design system the agent composes with. Most tools are either polish agents (Descript) or clip extractors (OpusClip).

| Product | What it does well | What it lacks for you |
| --- | --- | --- |
| [Descript (Underlord)](https://www.tella.com/blog/best-agentic-video-editors) | Transcript editing, filler removal, Studio Sound, an agent that suggests edits; has an MCP server | Agent mostly polishes, not a full first cut; weak design system; cloud-locked |
| [Tella Agent](https://www.tella.com/blog/best-agentic-video-editors) | Screen recordings: cuts, zooms on clicks, layouts; saves multi-step edits as reusable "skills" | Narrow to screen/demo content |
| [Cardboard](https://www.tella.com/blog/best-agentic-video-editors) | "Director" agent builds first cuts from footage, refined via chat or timeline; web b-roll, music, voice | Closest to your idea; generative-leaning, unclear on taste learning |
| [Palmier Pro](https://www.tella.com/blog/best-agentic-video-editors) | Native macOS editor built for AI, local MCP so Claude Code can drive it | Early; no preference learning |
| [Eddie AI](https://a16z.com/its-time-for-agentic-video-editing/) | Logs hours of footage, separates A-roll from B-roll, compares takes, multicam | Assistant-editor focus, hands off to an NLE |
| [OpusClip](https://www.tella.com/blog/best-agentic-video-editors), Reap | Long video to captioned vertical clips, ranked by predicted virality | Shorts only, template look |
| [Riverside Co-Creator](https://www.tella.com/blog/best-agentic-video-editors) | Podcast and interview clipping inside Riverside | Tied to its recorder |
| CapCut, Runway | Templates, effects, generative video (Runway) | Not agent-driven editing of your footage |
| Gling | Removes bad takes and silences for YouTubers, exports to Premiere/Resolve | One job, no timeline of its own |

Two patterns worth stealing: Tella's reusable "skills" (a saved multi-step edit) map directly to your preference idea, and nearly every serious tool now exposes an MCP server so outside agents can drive it. The [a16z thesis](https://a16z.com/its-time-for-agentic-video-editing/) (Jan 2026) names the same open problems you will hit: understanding long footage, taste, and reliable tool use.

## Platform

Decision (Oct 19): Tauri, after comparing mockups with a native Swift build. Build a local-first Mac app with Tauri: a small Rust core that runs FFmpeg and the MCP server, and a web UI drawn by macOS's own WebKit, so nothing like Chromium ships inside it. This replaces the earlier Electron pick, which fails your "as slim as possible" requirement. HyperFrames (below) also removes the main reason Electron was attractive, since its animations preview fine in WebKit.

**Storage cost is not the real problem.** A web app would not keep video in a database; it would use object storage. Cloudflare R2 is about $0.015 per GB per month with free egress (approximate, from memory), so 500 GB of footage is roughly $7.50 a month. The real problems with a cloud-hosted editor are upload time (an hour of 4K can be 50 to 100+ GB), scrubbing latency over a network, and needing your own render servers. For one person with the footage already on a Mac, local wins on every axis except "open it from any device".

| Approach | App size / RAM (approx.) | Strengths | Weaknesses | Fit for you |
| --- | --- | --- | --- | --- |
| **Tauri (recommended)** | \~10 to 20 MB; \~150 to 300 MB RAM while editing | Slim; web UI gives full design control and Claude writes it fluently; WebKit plays HyperFrames animations natively for live preview; Rust core runs FFmpeg and the MCP server | Frame-accurate scrubbing in WebKit needs proxies and care; WebKit's newer video APIs lag Chrome's | Best balance of slim, design control and build speed |
| Native Swift (SwiftUI + AVFoundation) | \~10 to 30 MB; lowest RAM | Best playback, hardware ProRes/HEVC decode, the most "Mac" feel | Custom timeline UI is slow to build; motion graphics still need an embedded WebKit view; Claude is less fluent in SwiftUI than web UI | Strong second choice; could replace Tauri's player later if playback disappoints |
| Electron | \~150 to 250 MB; often 400 MB+ RAM | Chromium everywhere, Remotion-native | Heaviest option | Ruled out by your slimness requirement |
| Local web app (localhost + browser tab) | Tiny app, but uses a browser tab's RAM | Fastest to prototype | Not a real app | Good for phase 0/1 only |
| Cloud web app | n/a | Use anywhere | Uploads, servers, hosting | Not worth it for one user |
| Claude edits Final Cut / Resolve projects | No new app | Zero UI to build | No live shared timeline, comments or transcript editing | Escape hatch for finishing only |

Disk beyond the app: FFmpeg (\~80 MB), a local speech model (\~0.6 to 1.5 GB, optional), and a headless Chrome used only at render time by HyperFrames (\~200 MB). Proxies add roughly 5 to 10% on top of your footage and can be deleted after export. All sizes are estimates.

**Tauri's limitations, and the workaround for each:**

| Limitation | Why it matters | Workaround |
| --- | --- | --- |
| Scrubbing precision in WebKit | Seeking a normal H.264/HEVC file lands near keyframes, so frame-by-frame scrubbing and trimming can feel sloppy | Generate all-intra proxies (every frame a keyframe) at ingest; worst case, a native AVFoundation player behind the web UI |
| WebKit lags Chrome on newer APIs | Some video and graphics APIs arrive later in Safari, and the version is tied to your macOS version | Stick to well-supported APIs; HyperFrames only needs HTML, CSS and GSAP |
| Preview vs export engine | Preview runs in WebKit, HyperFrames exports through headless Chrome, so fonts or blurs can differ slightly | Check the side by side in phase 0; bundle your fonts |
| Node isn't bundled | The HyperFrames CLI needs Node, which adds \~50 to 100 MB if shipped with the app | Use the Node already on your Mac (Claude Code installs it) |
| Rust backend | The core is Rust, not JavaScript | Claude writes Rust well, and most heavy work is FFmpeg called as a separate program |
| Smaller ecosystem | Few video editors are built on Tauri, so fewer examples to copy | Keep the core small; the risky parts are FFmpeg and playback, which are not Tauri-specific |

Solo use also means no accounts, auth or sync. A project is just a folder next to your footage (project file, transcript, style guide, design kit), which turns out to be exactly what Claude Code works best with.

## How Claude connects (your subscription, no API)

Yes, this works without the Anthropic API. The app exposes its editing tools as a local MCP server, and you use Claude through apps you already pay for. Two routes, both on your subscription:

| Route | How you use it | Good for |
| --- | --- | --- |
| **Claude desktop app or Claude Code, connected to the app's MCP server** | You chat with Claude ("do a first cut, tighten the intro, add a lower-third"); it calls the editor's tools and you watch the timeline change live | Big passes: first cut, restructuring, designing motion graphics |
| **The `claude` CLI, launched by the app** | You leave a comment on the timeline addressed to Claude, or press a button like "First cut"; the app runs `claude -p` in the background with the MCP server and your project folder attached | Day-to-day comments as tasks, without switching apps |

The "CLI thing" you asked about is this second route. Claude Code's headless mode (`claude -p "..."`) runs the official CLI, logged in with your own plan, so the app never holds an API key. Per a [summary of Anthropic's terms](https://autonomee.ai/blog/claude-code-terms-of-service-explained/) (updated Oct 7 2026), this is allowed for personal use on your own machine; what's banned is pulling the login token out to use in other clients. It draws from your plan's usage limits, so a Max plan matters if you want Opus doing long edits often.

**Claude in the sidebar.** The Claude tab in the inspector is a full chat panel driven by the same CLI. The app runs `claude -p --output-format stream-json` with the app's MCP server and the project folder attached, pins Opus, and resumes the same session so the conversation carries over. Replies stream into the panel, and any edits land on the timeline as a change set you accept or reject. It uses your plan's limits, needs Claude Code installed and logged in on the Mac, and the app never touches your login token.

Why the project-folder design matters here: Claude Code can read the transcript, style guide and design kit as files, write motion graphics as code, and call the app's tools only for things that need the app (seek, show frames, render a preview). Your preferences live as Claude-readable files (a `CLAUDE.md` style guide and skills), so the "learning" travels with every route.

**What the app's MCP server exposes (sketch):** `get_transcript`, `view_frames(times)`, `contact_sheet(range)`, `cut_range`, `trim`, `move_clip`, `punch_in`, `add_graphic(composition, props, range)`, `set_audio`, `list_comments` / `reply_to_comment`, `render_preview(range)`, `propose_changes` (a batch shown to you as tracked changes).

## Ingest pipeline

When you drop in a video, the app (not Claude) builds a "footage index" on your Mac: words with timestamps, pauses, retakes, shot changes and thumbnails. Claude edits from that index and asks the app for frames when it needs to see something. For talking-head footage this runs in a few minutes, free, with no cloud service at all.

| Stage | What it produces | Default (local, free) | Optional upgrade |
| --- | --- | --- | --- |
| 1. Proxy + audio | Low-res proxy for smooth preview, WAV, thumbnails, waveform | FFmpeg |  |
| 2. Transcription | Word-level timestamps, fillers (um, uh), punctuation | On-device model on Apple Silicon: NVIDIA Parakeet via MLX, or Whisper via WhisperKit | [ElevenLabs Scribe v2](https://openrouter.ai/elevenlabs/scribe-v2), called by the app with your ElevenLabs key (\~$0.22 per hour), if local accuracy disappoints |
| 3. Retake detection | Groups repeated attempts at the same line so the best take can be picked | Text similarity over the transcript, done by the app | Claude judges which take is best |
| 4. Silence + quality | Pauses, breaths, clipped audio, loudness, blur or exposure drops | FFmpeg filters |  |
| 5. Shot changes | Camera switches, if you film multi-cam | PySceneDetect |  |
| 6. Visuals for Claude | Frames and contact sheets on request | App extracts images; Claude (Opus) looks at them directly |  |

Screen recordings add three more inputs: the recorder's cursor, click and keystroke log; on-screen text read by Apple's on-device text recognition (free, local); and an activity measure from frame differences that finds idle stretches of typing or loading.

Things dropped for talking heads: speaker diarization (one speaker), Gemini or TwelveLabs video models, and embeddings search. If you later film b-roll-heavy videos, Gemini as a cheap "watcher" can return as an add-on.

Why transcription doesn't go through Claude or an MCP connector: an hour of word-level timestamps is a huge amount of text to push through a chat, and Claude can't listen to audio. The ElevenLabs MCP server exists, but its local version is deprecated in favor of a hosted one ([glama listing](https://glama.ai/mcp/servers/elevenlabs/elevenlabs-mcp)), and either way the app should own the transcript file. On-device transcription keeps your "no integrated AI services" rule except for a speech model that runs on your own chip.

The index lives as files in the project folder (JSON, plus a small SQLite for fast lookups), so nothing is re-processed and Claude Code can read it directly.

The model files take roughly 0.6 to 1.5 GB of disk depending on which one we pick (estimate). That is the single largest thing the app installs, so it is worth testing both on a sample of your footage in phase 0.

## Core architecture

The whole product hangs on one decision: the timeline is a plain data file, and every edit, from you or the agent, is a small operation applied to it. That is what makes the timeline truly shared.

&#91;embedded content: system overview · ingest, shared project file, preview and render\]

- **Project file.** A JSON edit decision list: tracks, clips (source file + in/out points), captions, graphics (a component name + its settings), audio levels, transitions. Close to [OpenTimelineIO](https://opentimeline.io) so it can export to Final Cut, Resolve or Premiere.
- **Edit log.** Every change is an operation like `trim clip 14 out to 03:12.4` or `insert lower-third "Luke Lewis" at 00:05`, tagged with who made it and why. This gives you undo, a history, and the most important agent feature: reviewing the agent's changes like tracked changes in a doc (accept, reject, or comment on each).
- **Transcript view.** Not a separate document but another view of the same timeline, like Descript. Deleting a sentence emits "remove range" operations; reordering paragraphs moves clips. Words the agent cut stay visible as struck-through text you can restore.
- **Timeline view.** tracks, clips, waveforms, thumbnails, with Claude's edits tinted so you can see what it touched.
- **Preview.** Plays the project file directly: proxies played by WebKit, with HyperFrames graphics layered on top. No render needed to watch.
- **Render.** FFmpeg renders the cut from your original footage, HyperFrames renders the graphics, and FFmpeg composites them. All local.

The recorder sits outside this picture on purpose: it is a separate native process that only writes video files and an event log to the project folder, so the editor can stay closed while recording.

## Agent design

The agent is Claude (Opus, through your subscription) working through the app's MCP tools and the project folder. It never touches pixels directly: it reads the footage index, proposes operations, and checks its own work by looking at frames the app renders for it.

**The first cut, in passes.** One giant "edit this video" prompt gives mushy results. A pipeline of focused passes, each reviewable on its own, works far better:

1. **Understand:** read the transcript and shot list, write a one-paragraph brief (what this video is, who it's for, the story beats). You can correct the brief before anything is cut.
2. **Select:** pick best takes, drop false starts, repeated lines and dead air. This is where transcript-based editing does 60% of the work for talking content.
3. **Structure:** reorder into the story beats, tighten the hook (first 5 to 15 seconds), cut to a target length.
4. **Pace:** trim breaths and pauses to your preferred rhythm, add jump-cut punch-ins to hide cuts.
5. **Dress:** captions, lower-thirds, titles, b-roll inserts, zooms, music and ducking, all from your design kit.
6. **Self-review:** render key frames or a low-res pass, look at them, fix collisions (captions over a face, text off-brand), then hand off with a summary of what it did and anything it was unsure about.

**Screen pass for screen-share videos.** Claude chooses layouts (full screen, camera bubble, split, camera-only) from what Luke is saying, places zooms from the click log, speeds up idle stretches, blurs sensitive text, and adds callouts on the UI elements being discussed. Each of these is its own reviewable change set.

**Comments as tasks.** A comment is pinned to a time range, a clip, or transcript words, and can be addressed to the agent ("tighten this", "b-roll of the product here", "this joke doesn't land, cut it"). The agent picks up open comments, makes the change as a reviewable set of operations, and replies in the thread with what it did. You resolve or push back. This is the same loop as code review, and it is the main way you will steer it day to day.

**Shared timeline rules.** You and the agent can work at the same time. The agent's in-flight changes show as a pending layer; your manual edits always win, and an edit you make by hand to something the agent touched is recorded as a preference signal (see next section). Locked regions ("don't touch the intro") are just a flag on a time range.

**Tools:** the MCP tool list is under "How Claude connects". Because the same server works from the Claude desktop app, Claude Code and the background CLI, every route can do everything.

**Usage budget:** a first cut of a 20-minute talking-head video means Claude reading a transcript of roughly 3,000 words plus some frames, then issuing a few hundred operations, so it should fit comfortably in an Opus session (inferred, not measured). Motion graphics with several render-and-look iterations are the heaviest use.

## Preference learning

For one user, the right approach is not training a model; it is a living, readable "editing style guide" the agent writes and you can edit, plus a log of examples it retrieves from. This is cheap, transparent, and works from the first video.

**Signals it learns from (strongest first):**

1. **Your corrections.** Every time you undo, re-trim, or replace something the agent did, the diff is logged with context ("agent cut pause to 0.2s, Luke extended to 0.5s before a punchline").
2. **Comments and rejections.** "Too fast", "never use this font for captions", a rejected b-roll pick.
3. **Explicit rules** you write: "never cut mid-laugh", "hook under 8 seconds", "music at -22 LUFS under voice".
4. **Reference videos** you like: the pipeline analyzes their cut frequency, caption style, pacing and structure into measurable targets.
5. **Final exports** vs the agent's first cut: the overall delta per video is the cleanest summary of taste.

**How it becomes behavior:**

- After each video, the agent drafts proposed rule updates ("You lengthened 9 of 12 pauses before jokes. Proposed rule: keep 0.4 to 0.6s before a punchline."). You approve, edit or reject. Approved rules go into the style guide, which is loaded into every edit.
- Numeric preferences (cut rhythm, caption length, zoom frequency, loudness) are stored as parameters the tools use directly, not just prose.
- A small library of before/after examples is retrieved when a similar situation comes up, so the agent sees what you actually did last time.
- Profiles per format ("YouTube long-form", "Shorts", "client work") so lessons from one don't leak into another.

This mirrors Tella's saved "skills": a repeatable multi-step edit ("my podcast intro treatment") is just a named recipe of operations the agent can replay.

## Instructions area

Luke wants something more structured than one big text box (Oct 19). The Instructions area is a dedicated screen in the editor that splits what Claude should know into parts it can weigh separately. Everything in it is stored as plain files in the project folder, so the `claude` CLI in the sidebar reads them natively and the history is versionable.

| Part | What it holds | Stored as |
| --- | --- | --- |
| Rules | One-line dos and don'ts ("Don't cut mid-breath"). Each has a scope (all videos, talking head, screen share, shorts), a strength (always or prefer), an on/off switch and optional "like this / not this" clips. | Compiled into `CLAUDE.md`, grouped by scope and strength |
| Skills | Named recipes such as "Tighten pacing", "Chapter titles", "Screen zoom pass": steps, settings and the design-kit components each may use. Run by name from the sidebar, and as passes in the first cut. | `.claude/skills/<name>/SKILL.md` per skill |
| Settings | Numbers instead of prose: max pause length, zoom strength, caption style, music level. Sliders and pickers. | `settings.json`, read by skills and the MCP tools |
| Formats | A bundle of rules, skills and settings per video type. A screen recording loads the screen-share format automatically. | `formats/<name>.json` |
| References | Videos and clips tagged as good or bad examples, with a note on why. | `references/` plus an index file |
| Suggested rules | Claude proposes a rule when Luke keeps undoing the same kind of edit. Approve, tweak or reject; each rule keeps where it came from and how often it fired. | Pending items in `suggestions.json` until approved |

**Why each edit happened.** Every edit in a change set names the rule or skill that caused it, and clicking it opens that rule. This is also how Luke spots a bad rule: if the same rule keeps producing edits he rejects, the app flags it.

**Conflicts.** When two active rules disagree within a format ("keep pauses for emphasis" vs "max pause 0.4s"), the screen shows a warning and asks which wins, rather than leaving Claude to guess.

## Motion graphics: Remotion and HyperFrames

Both tools do the same core trick: animation is written as web code, a headless browser plays it frame by frame, and FFmpeg stitches the frames into video. That is why they matter to you. Claude can't drive After Effects, but Opus writes excellent HTML, CSS and animation code, so "motion graphics as code" is how you get its full power: bespoke animations designed for each video, not a menu of presets.

**How it fits the editor.** Your footage is cut by the app with FFmpeg; motion graphics are a separate layer. Each graphic (a lower-third, a kinetic-type quote, an animated stat, a chapter card) is a small composition with settings, placed on the timeline over a time range. In the app, WebKit plays it live on top of your footage, so you see it instantly. On export, it's rendered and composited over the cut.

**What Opus actually does with it:** reads the transcript, spots moments worth a visual ("we grew 3x" becomes an animated counter, a key line becomes kinetic type), writes the composition using only your design kit's fonts, colors and easing, renders a few frames, looks at them, and fixes problems before handing it to you. You comment "make it snappier" and it edits the code.

|  | HyperFrames | Remotion |
| --- | --- | --- |
| What you write | Plain HTML + CSS, animated with GSAP; Three.js for 3D | React components driven by the current frame number |
| Made by / since | HeyGen, open-sourced Apr 2026 | Remotion, since 2021 |
| License | Apache 2.0, free for anyone | Free for individuals; company license above 3 people |
| Built for agents | Yes: ships Claude Code skills (`npx skills add heygen-com/hyperframes`) and a preview studio | Not specifically, but Claude writes React well |
| Preview in our app | Any browser engine, including the WebKit Tauri uses | Player is a React component; best tested in Chrome |
| Footprint | No build step; HTML files plus a render CLI | Needs a Node/React/bundler toolchain |
| Maturity | \~6 months old, smaller ecosystem | Mature, large ecosystem, many examples |

**Recommendation: HyperFrames for the motion layer.** It suits a Tauri app, it is the lighter toolchain, and GSAP is the industry standard for web motion, so Opus has deep fluency in it. Remotion stays the fallback if HyperFrames proves too young. Two things to verify in phase 0: that HyperFrames can render graphics with a transparent background for overlaying on footage, and how closely the WebKit preview matches the Chrome render (fonts and blurs can differ slightly). Sources: [HyperFrames overview](https://noqta.tn/en/blog/heygen-hyperframes-html-to-mp4-ai-agent-video-2026), [Remotion license](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md).

## Design system for the agent

The strongest version of this is a code-based design kit: tokens plus a library of motion components written as HyperFrames compositions (HTML + GSAP), each with a typed set of props and a short usage note. The agent can only compose from the kit, so everything it makes is on-brand by construction.

**Three layers:**

1. **Tokens:** colors, type (font files, sizes, weights), spacing, corner radii, safe margins per aspect ratio, and motion tokens (easing curves, durations, stagger). One file, used by every component.
2. **Components:** lower-third, title card, caption styles, callout/arrow, zoom-punch, number counter, quote card, chapter marker, end screen, transitions, logo sting. Each has a props schema (`title`, `subtitle`, `accent`, `align`) and a rule sheet: when to use it, max duration, what it must not overlap.
3. **Composition rules:** how often graphics may appear, never two at once, captions avoid faces (the vision index knows where faces are), keep text inside title-safe margins.

**Ways to get your designs in:**

| Source | How it enters the kit | Effort |
| --- | --- | --- |
| Figma | Tokens via Figma variables; components designed in Figma, then rebuilt as HyperFrames compositions (Claude can do this from a Figma frame using the Figma connector already on your account) | Medium, best fidelity |
| After Effects / Lottie | Export Lottie JSON with editable text layers; Lottie plays inside an HTML composition and the agent fills the text | Low per component, limited logic |
| Written description | "Swiss, monochrome, one accent, snappy ease-out" becomes tokens + generated components you then refine | Lowest, least precise |
| Reference videos | The agent proposes components that match a style you point at | Exploratory |

Because components are code, the agent can also author new ones on request ("make a lower-third variant with a progress bar") which you approve into the kit. A gallery screen in the app shows every component rendered with sample props so you can review the kit visually.

## Cost and hard problems

Running costs are close to zero: transcription and rendering run on your Mac, HyperFrames is free, and Claude runs on the plan you already pay for. The real budgets are your plan's Opus usage limits, build effort, and the problems below.

| Problem | Why it's hard | Mitigation |
| --- | --- | --- |
| Taste | Pacing, hooks and b-roll choice are thousands of micro-decisions; generic agents produce generic edits | Passes with checkpoints, your style guide, reference-video targets, and you correcting early videos heavily |
| Visual understanding | Vision models summarize well but are fuzzy on exact frames and subtle quality (focus, eyeline) | Frame-exact cuts come from transcript and shot detection; vision only labels; agent views real frames before committing |
| Smooth preview | Scrubbing multi-track 4K in a web UI is the classic hard part of building any editor | Proxies, cached thumbnails, keep v1 to 1080p proxies; native Swift player as a fallback |
| Trust in agent edits | 200 small changes are unreviewable | Grouped change sets with reasons, tracked-changes view, locks, one-click revert per pass |
| Visual-led footage | B-roll montages, music videos, cinematic edits have no transcript to lean on | Start with talking content; add beat detection and shot-similarity later |
| Scope | A full NLE is years of work | Lean on export to Resolve/Final Cut for finishing; build only what the agent loop needs |

## Feature ideas

These are candidates beyond the core editor, ranked by how much they'd help a solo talking-head creator. Starred ones are my top picks.

| Feature | What it does | Effort |
| --- | --- | --- |
| **Overnight first cut** ★ | Drop footage in a watch folder; the app ingests it and runs Claude in the background, so a first cut is waiting in the morning | Low, once the core works |
| **Verbal markers** ★ | Say "again" or "cut that" while filming; the transcript catches it and marks the bad take automatically | Low |
| **Script matching** ★ | Paste your script or outline; every line is matched to its takes, and missing or ad-libbed lines are flagged | Medium |
| **Watch-down notes** ★ | A review player where one key drops a comment at the playhead and you keep watching; Claude works through the notes afterward | Low |
| **Shorts from the long video** ★ | Claude picks 3 to 5 clip candidates, reframes to 9:16 by tracking your face, adds styled captions | Medium |
| **Packaging** ★ | Thumbnail candidates from your best expressions, composed from the design kit; title options, description and YouTube chapters from the story beats | Medium |
| Versions | Snapshots like "Claude cut", "tighter" and "final" you can compare side by side or branch from | Medium |
| Hook variants | Claude cuts 2 or 3 alternate openings for you to pick from | Low |
| Pacing check | Flags stretches with no visual change or long talking-head runs where viewers may drop off | Low |
| Voice polish | Local noise removal and loudness to YouTube's target, with a before/after toggle | Medium |
| Look consistency | Matches color and exposure across clips shot on different days | Medium |
| B-roll library | A local folder of your clips, tagged by Claude from frames, suggested at relevant transcript moments | Medium |
| Music and sound | A local music and sound-effects library; cuts can snap to beats, whooshes on transitions from the kit | Medium |
| Retention feedback | Import YouTube retention data per video so Claude learns which edits hold attention | High; needs a YouTube connector |
| Keyboard-first editing | Final Cut-style shortcuts (J/K/L, blade, ripple) so manual edits stay fast | Low |
| Round trip | Export to Final Cut or Resolve and back, for anything the app can't do | Medium |

## Screen recording features

Luke will screen-share a lot (Oct 19), so screen + camera videos are a core format, not an add-on. The biggest lever is recording inside the app: macOS's ScreenCaptureKit (reached from Tauri's Rust core through a small native helper) captures screen, camera and mic as separate tracks and logs every cursor move, click and keystroke as data. That metadata powers most of the features below.

**Recording mode is a separate, slim native process.** A small recorder helper (Swift, bundled with the Tauri app) uses ScreenCaptureKit plus the Mac's hardware video encoder and writes straight to disk. When you start recording, the editor window and its web view close, leaving only a menu-bar control, a floating stop/pause pill and an optional camera bubble. Nothing else runs during a take: no transcription, no Claude, no previews. Cursor, click and keystroke data goes to a small log file. Processing starts when you press stop. Estimated footprint is roughly 50 to 150 MB of RAM (to verify in phase 0), so the apps you're demoing keep the memory. Default codec is hardware HEVC at a high bitrate for small files, with ProRes as an option. Keystroke capture needs the macOS Input Monitoring permission, asked once.

| Feature | What it does | Needs the in-app recorder? |
| --- | --- | --- |
| **Separate tracks** ★ | Screen, camera and mic recorded separately, so layouts can change after the fact | Yes |
| **Auto zoom** ★ | Smooth zooms toward where you click or type, eased like Screen Studio | Best with it; Claude can approximate from frames otherwise |
| **Auto layouts** ★ | Claude switches between full screen, screen + camera bubble, split and camera-only based on what you're saying ("as you can see here" means screen) | No |
| **Auto blur** ★ | On-device text recognition (Apple Vision) finds emails, API keys, notifications and personal info; blurred automatically, listed for your review | No |
| **Speed ramps** ★ | Silent stretches of typing, loading or scrolling sped up 2 to 4x, with a small speed badge | No |
| Cursor polish | Smoothed movement, bigger cursor, click ripples, cursor hidden when idle | Yes |
| Keystroke badges | Shortcuts you press shown as on-screen keys from the design kit | Yes |
| Searchable screen text | Everything on screen indexed by time, so you or Claude can find "the part where I open Settings" | No |
| Callouts | Arrows, highlight boxes and labels Claude places on UI elements it can read in the frame | No |
| Vertical reframe | Shorts crop that follows the cursor region instead of your face | Best with it |
| External recordings | Footage from OBS or QuickTime auto-synced to camera audio by waveform | No |

Claude is well suited to this: reading UI text in screenshots is one of its strengths, so it can tell what you're showing at each moment and pick zooms, callouts and layouts from that.

## Phased roadmap

Prove the Claude loop and the risky tech before building the editor UI; the recorder comes early because it shapes the footage everything else works on.

1. **Phase 0: headless first cut and spikes.** Scripts plus the MCP server, no UI: local transcription, a Claude Code first cut, FCPXML export to Final Cut or Resolve. Spikes: HyperFrames transparent overlays and preview-vs-export match, and a scrubbing test on a 30-minute 4K clip in a bare Tauri window. That test is the gate: if it fails, the player goes native before any UI work.
2. **Phase 1: slim recorder.** Native recorder with separate screen, camera and mic tracks, the cursor, click and keystroke log, menu-bar control and floating stop pill.
3. **Phase 2: editor core.** The Final Cut-style Tauri app: transcript editing, viewer, magnetic timeline, Claude's change sets, comments that launch `claude -p`.
4. **Phase 3: screen features and design kit.** Auto zoom, layouts, blur, speed ramps and cursor polish; HyperFrames components from Luke's design tokens; captions; local export.
5. **Phase 4: preference loop.** Correction logging, rules proposed after each video, style-guide editor.
6. **Phase 5: extras.** Whatever Luke picks from Feature ideas (overnight first cut, shorts, packaging and so on).

Each phase is usable on its own. Phase 0 alone may already save most of the editing time on talking-head videos.

## Open questions

Answered items stay ticked for the record. Of the open ones, the Claude plan and the Mac specs matter most.

- [x] **What do you film?** Mostly talking head, plus a lot of screen sharing.
- [x] **Platform?** Tauri.
- [x] **Record in the app?** Yes, as a separate slim recording mode.
- [ ] **Which Claude plan are you on?** Pro or Max? Regular Opus first cuts and motion graphics will likely want Max.
- [ ] **Your Mac:** which chip and how much RAM? This decides the local speech model.
- [ ] **Raw footage:** typical length per video, 1080p or 4K, one camera or two?
- [ ] **Outputs:** long-form only, or also vertical shorts?
- [ ] **Design source:** an existing design language in Figma, or define it from scratch?
- [ ] **Finishing:** finish color and audio in Resolve/Final Cut, or everything in this app?
- [ ] **Who builds it:** you with Claude Code, or Claude building it end to end in a repo?
- [ ] **One paid exception?** If local transcription disappoints, is ElevenLabs at \~$0.22 per footage hour acceptable?
- [ ] **v1 features:** which Feature ideas make the first version?
- [ ] **Name:** "Cutroom" in the mockups is a placeholder.

## Sources

- [The Best Agentic Video Editors in 2026, Tella](https://www.tella.com/blog/best-agentic-video-editors) (Oct 16 2026)
- [It's time for agentic video editing, a16z](https://a16z.com/its-time-for-agentic-video-editing/) (Jan 2026)
- [ElevenLabs Scribe v2 on OpenRouter](https://openrouter.ai/elevenlabs/scribe-v2)
- [Speech-to-text API pricing 2026, diyai.io](https://diyai.io/ai-tools/speech-to-text/speech-to-text-api-pricing/) (Aug 2026)
- [Video understanding costs, Vorp Labs](https://vorplabs.com/models/video-understanding-costs) (checked Jul 2026)
- [Remotion license](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md)
- Cloudflare R2 pricing, Gling, CapCut and Runway descriptions: from memory, approximate
- [HyperFrames overview, Noqta](https://noqta.tn/en/blog/heygen-hyperframes-html-to-mp4-ai-agent-video-2026)
- [Claude Code terms explained, Autonomee](https://autonomee.ai/blog/claude-code-terms-of-service-explained/) (Oct 7 2026)
- [ElevenLabs MCP server, Glama](https://glama.ai/mcp/servers/elevenlabs/elevenlabs-mcp)
- App sizes, RAM figures and model sizes: estimates from memory, to verify in phase 0
