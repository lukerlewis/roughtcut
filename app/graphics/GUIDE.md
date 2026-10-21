# Writing a motion graphic for Roughcut

A graphic is one HyperFrames composition: an HTML page whose animation is a
paused GSAP timeline the app seeks frame by frame, in the viewer and in the
export (HyperFrames' own renderer, to video with transparency). Adapted from
HyperFrames' rules for agents (hyperframes-core, Apache-2.0, HeyGen).

## Before writing one

- Prefer a catalogue graphic (list_graphics) filled in with `texts` and
  `params`, or one of Luke's saved graphics. Write a new one only when nothing
  there fits; it costs far more.
- It plays over Luke's video, so leave the page background transparent unless
  the graphic is meant to fill the frame (a full-screen title card).
- Keep it to what's being said: a number, a name, a short list, a step. Few
  words, big type, generous margins (at least 80px from the frame's edges).

## Luke's look

The app gives every graphic Luke's brand as CSS custom properties. Use them,
each with a fallback, so the graphic is in his style and follows his changes:

- `var(--brand-font, -apple-system)` for words; headlines at
  `var(--brand-bold, 700)`, the rest at `var(--brand-regular, 400)`
- `var(--brand-ink, #111)` text, `var(--brand-paper, #fff)` cards and panels
- `var(--brand-accent, #2f80ed)` the one colour that stands out,
  `var(--brand-accent-2, …)` a second when needed
- `var(--brand-radius, 12px)` corners

Don't load web fonts or anything from the network: the export runs offline.

## The skeleton

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <script src="../lib/gsap.min.js"></script>
    <style>
      html, body { margin: 0; background: transparent; }
      #root { position: relative; width: 100%; height: 100%; overflow: hidden; font-family: var(--brand-font, -apple-system), sans-serif; }
      .card { position: absolute; left: 120px; bottom: 140px; padding: 28px 40px; border-radius: var(--brand-radius, 12px);
              background: var(--brand-paper, #fff); color: var(--brand-ink, #111); }
      .big { font-size: 96px; font-weight: var(--brand-bold, 800); color: var(--brand-accent, #2f80ed); line-height: 1; }
      .label { font-size: 34px; font-weight: var(--brand-regular, 400); margin-top: 10px; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="stat" data-width="1920" data-height="1080" data-start="0" data-duration="5"
         data-composition-variables='[{"id":"value","type":"number","label":"Number","default":30}]'>
      <div class="card" id="card">
        <div class="big" id="big">30</div>
        <div class="label">days of testing</div>
      </div>
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      const vars = window.__hyperframes && window.__hyperframes.getVariables ? window.__hyperframes.getVariables() : {};
      const value = Number(vars.value ?? 30);
      const counter = { n: 0 };
      tl.fromTo("#card", { y: 40, opacity: 0 }, { y: 0, opacity: 1, duration: 0.5, ease: "power3.out" }, 0.1);
      tl.to(counter, { n: value, duration: 1.2, ease: "power2.out", onUpdate: () => {
        document.getElementById("big").textContent = Math.round(counter.n);
      } }, 0.2);
      tl.to("#card", { y: 20, opacity: 0, duration: 0.3, ease: "power2.in" }, 4.6);
      window.__timelines["stat"] = tl;
    </script>
  </body>
</html>
```

## The rules

- The root is `<div data-composition-id="…" data-width="1920" data-height="1080" data-duration="…">`
  directly in `<body>`, sized `width/height: 100%` in CSS (never hardcoded pixels).
- Exactly one `gsap.timeline({ paused: true })`, registered last as
  `window.__timelines["<the composition id>"]`. Never call `tl.play()`.
- GSAP comes from `../lib/gsap.min.js`. Nothing else is loaded.
- The app sets `data-duration` to the block's length on the timeline, so the
  graphic can't know its length in advance: bring things in during the first
  second and take them out in the last 0.3-0.5s of the length you wrote. If
  Luke lengthens the block it holds the last frame.
- Every frame must come from the time alone: no `Date.now()`, no unseeded
  `Math.random()`, no hover or scroll, no `repeat: -1`.
- Never give an element a CSS `transform` that GSAP also tweens: set the start
  inside the tween with `fromTo`. Centre with flex or `inset`, not
  `translate(-50%, -50%)`, on anything you move.
- Transformed elements must be block-level with a real size (a `<span>` needs
  `display: inline-block`).
- No `<br>` in sentences: let text wrap with `max-width`.
- Anything Luke might tune (a number, a colour, a label the script writes) is
  a declared variable on the root's `data-composition-variables`
  (`id`, `type` string|number|color, `label`, `default`), read once with
  `window.__hyperframes.getVariables()`. Words written in the page Luke can
  change himself, so write the real words there.

## Motion that looks good

- Come in with a strong ease out (`power3.out`, `expo.out`), 0.4-0.7s; leave
  quicker than you came (`power2.in`, 0.25-0.4s).
- Stagger related parts by 0.04-0.1s; move short distances (20-60px).
- Masked reveals (text rising from behind a line with `overflow: hidden` on
  the parent) and `clipPath: inset(…)` wipes read as polished.
- One idea per graphic. Hold still long enough to read: about a second per
  four words.
