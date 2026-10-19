# Roughcut design system

Roughcut should look and feel like LukeOS: the same grey scale, type, icons, corners and motion. It's derived from LukeOS's `src/app/globals.css` and `src/components/ui`, so when LukeOS changes, update this file to match.

The one deliberate difference is density. LukeOS is built for phone and desktop, with 44px tap targets. Roughcut is a desktop pro tool in the spirit of Final Cut, so controls and text step down a size. Everything else carries over unchanged.

## Principles

1. **Grey does the work.** A pure grey scale with no tint. Hierarchy comes from steps of grey, not colour.
2. **Colour only when it means something.** Every colour in the UI has exactly one job (see Colour).
3. **The footage is the colourful thing.** Chrome stays quiet so the picture and the timeline read first.
4. **Shape before colour for state.** As in LukeOS, state is shown by shape where possible (filled, outlined, dashed), with colour as a second signal.
5. **Calm motion.** Short, eased, and switched off for anyone who asks their Mac to reduce motion.

## Colour

### Grey scale

Same step names in light and dark. Roughcut opens in **dark** by default (it's easier to judge footage against a dark surround) and follows the system setting if Luke switches it.

| Step | Light | Dark |
| --- | --- | --- |
| grey-0 | #ffffff | #121212 |
| grey-50 | #f8f8f8 | #191919 |
| grey-100 | #f2f2f2 | #222222 |
| grey-200 | #e8e8e8 | #2b2b2b |
| grey-300 | #d9d9d9 | #353535 |
| grey-400 | #c1c1c1 | #454545 |
| grey-500 | #a4a4a4 | #5d5d5d |
| grey-600 | #808080 | #7d7d7d |
| grey-700 | #636363 | #a4a4a4 |
| grey-800 | #424242 | #cecece |
| grey-900 | #262626 | #e8e8e8 |
| grey-950 | #121212 | #f5f5f5 |

### Roles

Use role names in code, never raw steps.

| Role | Step | Used for |
| --- | --- | --- |
| background | 0 | Viewer surround, main panels |
| sidebar | 50 | Side panels, inspector, browser |
| card | 0 light / 50 dark (lifts a step inside a filled area) | Raised items: inputs, popovers, cards |
| muted | 100 | Hover fills, segmented track, code |
| selected | 200 | Selected rows and clips' selection fill |
| border | 200 | Hairlines between panels |
| stroke | 300 | Card and button outlines |
| stroke-strong | 400 | Text fields |
| disabled | 500 | Disabled text |
| icon | 600 | Idle icons |
| muted-foreground | 700 | Secondary text, timecodes, meta |
| subtle-foreground | 800 | Body text |
| foreground | 900 | Emphasised text |
| ink | 950 | Headings |
| primary | 950 on on-solid | The one primary button per view |

A card is always at least a step lighter than what it sits on. In dark, inside a step-50 panel, cards lift to 100; inside a step-100 area, to 200.

### Colours with a job

LukeOS has two: red for count badges and blue for unread. Roughcut keeps both meanings and adds only what an editor needs.

| Colour | Light / dark | Job |
| --- | --- | --- |
| Blue `unread` | #2563eb / #4c8df6 | **Claude's unreviewed changes.** Same meaning as LukeOS's unread dot: something new you haven't looked at. Outlines Claude's clips and edits, dots in the change list, the sidebar's new-reply dot. Turns grey once you accept. |
| Red `notification` | #d92d20 | Count badges and errors only. Also the record button. Deleting stays grey until you point at it. |
| Clip lanes | Desaturated hues (below) | Telling track types apart on the timeline |
| Rule strength | LukeOS flame colours | Always / prefer in the Instructions area (green, yellow, red tints from `.flames-*`) |

**Timeline lanes.** Lanes need colour to be scannable, but they stay muted so the footage is still the brightest thing on screen. Each is a 24% tint over the background in dark (14% in light), with text mixed toward white, using the same `color-mix` recipe as LukeOS's project chips.

| Lane | Base hue |
| --- | --- |
| Video | #6b7280 (neutral, filmstrip thumbnails carry it) |
| Audio, voice | #16a34a |
| Audio, music | #0d9488 |
| Titles and graphics | #7c3aed |
| Screen recording | #64748b |

Never use blue for a lane: blue is reserved for Claude's unreviewed work.

## Type

**Geist** (regular 400 and medium 500 only; bold text is medium). **Geist Mono** for timecodes, durations, frame counts and file paths, always with tabular numbers.

Roughcut's scale is LukeOS's, one step denser for a desktop editor:

| Token | Roughcut | LukeOS equivalent | Used for |
| --- | --- | --- | --- |
| tag | 11px | 12px | Tags, lane labels, badges |
| meta | 12px | 13px | Timecodes, secondary info |
| control | 13px | 15px | Buttons, inputs, menus, list rows (the default) |
| body | 14px / 1.55 | 16px / 1.65 | Transcript text, chat, rule descriptions |
| heading | 15px, -0.04em | 17px | Panel and section titles |
| section | 20px, -0.04em | 22px | Screen titles (Instructions, Export) |
| title | 26px, -0.04em | 26px | Empty states, onboarding |

Anything over 14px is drawn 4% tighter, as in LukeOS. Headings use `ink`, body uses `subtle-foreground`.

## Spacing and size

4px grid. Desktop control sizes:

| Thing | Height |
| --- | --- |
| Toolbar buttons, icon buttons | 28px |
| Standard buttons, inputs, segmented options | 28px (sm) / 32px (md) |
| List rows (transcript, rules, media) | 32px |
| Panel headers | 36px |
| Window toolbar | 44px |
| Timeline lanes | 48px video, 32px audio, 24px titles |

Panels sit edge to edge, separated by `border` hairlines, like LukeOS's sidebar against its main area. Inside a panel, padding is 12px; between grouped controls, 8px.

## Corners

Straight from LukeOS: **6px** tags and chips, **8px** icon tiles and segmented options, **10px** buttons and inputs, **14px** cards, popovers and dialogs. Timeline clips use **4px** so they still read as precise blocks at small sizes.

## Icons

**Lucide**, default 2px stroke, round caps. 16px in buttons and rows, 18px in the toolbar and sidebar nav. Icons are `icon` grey when idle and `foreground` when active or hovered. No filled icons except play/pause and record.

## Components

These match LukeOS's components, resized per the density rules above.

- **Button.** Variants: primary (ink fill, on-solid text, one per view), outline (stroke border, card fill), ghost (text only, muted fill on hover), danger (grey until hovered, then red text).
- **Segmented control.** Grey track (`muted` with a `border` outline); the picked option is raised (`grey-0` light, `grey-300` dark) with an inset stroke. Used for Inspector / Claude / Comments, Always / Prefer, view modes.
- **Tag.** 22px (20px in dense rows), stroke border, muted fill, medium weight.
- **Card.** 14px corners, stroke border, card fill.
- **Claude tag.** LukeOS's `.claude-tag`: a grey pill with a stroke, crossed out once Claude has dealt with it. Used for comments addressed to Claude.
- **Change set.** A card listing Claude's edits, each with a blue dot while unreviewed, a one-line reason, and accept or reject. Accepting fades the blue to grey.
- **Focus ring.** 2px `ring` outline, 2px offset, keyboard focus only.

## Motion

From LukeOS, unchanged:

- Colour, fill and stroke transitions: 160ms, `cubic-bezier(0.2, 0.8, 0.2, 1)`.
- Buttons press in to 0.96 on click (60ms); wide rows shade instead (`press-tint`).
- Popovers and menus grow out of their button (`pop-in`, 160ms from 0.96 scale).
- Dialogs settle in (200ms, 0.97 scale, 8px rise). Toasts rise in (240ms).
- New screens fade in, opacity only.
- With reduced motion on, movement stops and only colour fades remain.

Roughcut-specific: Claude's edits arriving on the timeline fade in over 160ms rather than popping, so a large change set doesn't flash. Playback, scrubbing and the playhead never animate.

## Source of truth

LukeOS: `src/app/globals.css` (tokens, type scale, corners, motion) and `src/components/ui` (button, card, segmented, dialog). Fonts: Geist via `next/font`, Lucide icons via `lucide-react`. When building Roughcut, copy the token block from `globals.css` and apply the density changes above, rather than inventing new values.
