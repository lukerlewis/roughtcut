// Titles, lower thirds, callouts and images, drawn the same way for the
// viewer and for the export, so what Luke sees is what he gets. The export
// receives them as transparent full-frame PNGs over the times they show.
//
// Each graphic comes in and goes out with its motion (fade, slide or pop,
// with an easing), and its parts (a title, then its subtitle) can stagger.

import type { CaptionStrips } from "./captions";
import { MOTION_DEFAULTS, type Easing, type Motion, type MotionStep, type TextFx } from "./edl";

const FONT = '"Geist", "Helvetica Neue", Helvetica, Arial, sans-serif';

// Ease-out curves (GSAP's power2.out, power4.out, sine.out and back.out(1.7)).
// Coming in they run forwards; going out they run on the time left, so an
// exit starts gently and speeds away, as an ease-in should.
export const EASINGS: Record<Easing, (t: number) => number> = {
  linear: (t) => t,
  smooth: (t) => 1 - Math.pow(1 - t, 3),
  snappy: (t) => 1 - Math.pow(1 - t, 5),
  gentle: (t) => Math.sin((t * Math.PI) / 2),
  overshoot: (t) => 1 + 2.7 * Math.pow(t - 1, 3) + 1.7 * Math.pow(t - 1, 2),
  spring: (t) => springAt(t * SPRING_SETTLE),
};

// Remotion's spring() (mass 1, stiffness 100; damping 12 rather than its
// default 10, for one soft bounce of about 9%), solved in closed form and
// stretched, as Remotion does with durationInFrames, so it settles exactly
// when the step ends.
const [MASS, STIFFNESS, DAMPING] = [1, 100, 12];
function springAt(t: number): number {
  const w0 = Math.sqrt(STIFFNESS / MASS);
  const zeta = DAMPING / (2 * Math.sqrt(STIFFNESS * MASS));
  const wd = w0 * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
}
// When it stays within 0.5% of rest for good (Remotion's measureSpring threshold).
const SPRING_SETTLE = (() => {
  let settled = 0;
  for (let t = 0; t < 5; t += 0.001) if (Math.abs(1 - springAt(t)) > 0.005) settled = t;
  return settled;
})();

export const motionOf = (t: TextFx): Motion => t.motion ?? MOTION_DEFAULTS[t.style];

const wordsOf = (text: string) => text.split(/\s+/).filter(Boolean);
const byWord = (t: TextFx) => (t.style === "title" || t.style === "lower-third") && motionOf(t).by === "word";

/** How many parts move separately (for staggering): the main text (or each
 *  of its words), then the second line. */
export const partsOf = (t: TextFx) => {
  if (t.style === "image" || t.style === "callout") return 1;
  return (byWord(t) ? Math.max(1, wordsOf(t.text).length) : 1) + (t.sub?.trim() ? 1 : 0);
};

/** Where a part is in its motion: how visible, how far moved (fractions of
 *  the frame) and how big. */
interface State {
  alpha: number;
  dx: number;
  dy: number;
  scale: number;
  blur?: number; // pixels at 1080p
  reveal?: number; // a masked reveal: how far it still sits behind its line (1 is fully hidden; negative is above)
}

const SHOWN: State = { alpha: 1, dx: 0, dy: 0, scale: 1 };

function stepState(step: MotionStep, v: number): State {
  // v: 0 hidden, 1 fully in (may pass 1 with an overshoot).
  const c = Math.min(1, Math.max(0, v));
  const s = moveState(step, v, c);
  return step.blur ? { ...s, blur: step.blur * (1 - c) } : s;
}

function moveState(step: MotionStep, v: number, c: number): State {
  if (step.type === "none") return v > 0 ? SHOWN : { ...SHOWN, alpha: 0 };
  if (step.type === "fade") return { ...SHOWN, alpha: c };
  if (step.type === "pop") return { alpha: c, dx: 0, dy: 0, scale: 0.85 + 0.15 * v };
  if (step.type === "reveal") {
    const side = step.from === "up" ? -1 : 1;
    return { ...SHOWN, alpha: v > 0 ? 1 : 0, reveal: side * (1 - v) };
  }
  const d = (step.distance ?? 0.3) * (1 - v);
  const [dx, dy] = { left: [-d, 0], right: [d, 0], up: [0, -d], down: [0, d] }[step.from ?? "left"];
  // A long slide comes in solid; a short nudge fades in as it moves.
  return { alpha: (step.distance ?? 0.3) >= 0.4 ? (v > 0 ? 1 : 0) : c, dx, dy, scale: 1 };
}

/** Part k's state at `time` seconds into a graphic lasting `length`. */
export function motionAt(m: Motion, parts: number, k: number, time: number, length: number): State {
  if (time < 0 || time > length) return { ...SHOWN, alpha: 0 };
  const into = time - k * m.stagger; // later parts start later
  const left = length - time - (parts - 1 - k) * m.stagger; // and the first leaves first
  if (into < 0) return { ...SHOWN, alpha: 0 };
  if (m.in.duration > 0 && into < m.in.duration) return stepState(m.in, EASINGS[m.in.easing](into / m.in.duration));
  if (left <= 0) return m.out.type === "none" && left > -1e-6 ? SHOWN : { ...SHOWN, alpha: 0 };
  if (m.out.duration > 0 && left < m.out.duration) return stepState(m.out, EASINGS[m.out.easing](left / m.out.duration));
  return SHOWN;
}

/** Seconds at the start and end of a graphic where it's moving. */
export function moving(t: TextFx): [number, number] {
  const m = motionOf(t);
  const extra = (partsOf(t) - 1) * m.stagger;
  if (m.drift) return [t.end - t.start, 0]; // it drifts the whole time
  return [m.in.duration + extra, m.out.duration + extra];
}

// Images, loaded once each. The app fills this before drawing or exporting.
const images = new Map<string, HTMLImageElement>();

/** Loads an image graphic's file (by the URL the app serves it at). */
export function loadImage(src: string, url: string): Promise<void> {
  if (images.get(src)?.complete) return Promise.resolve();
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous"; // so the export can read the canvas back
    img.onload = () => resolve();
    img.onerror = () => resolve();
    img.src = url;
    images.set(src, img);
  });
}

/** Draws one graphic onto a width x height frame, each part in its state
 *  (`part(k)`). */
export function drawText(g: CanvasRenderingContext2D, t: TextFx, width: number, height: number, part: (k: number) => State, drift = 1) {
  // The whole graphic grows slowly about its anchor while it holds.
  const [ax, ay] = [t.x * width, t.y * height];
  // Each part moves and fades on its own: set up the canvas for part k.
  const use = (k: number, cx: number, cy: number) => {
    const s = part(k);
    g.setTransform(drift, 0, 0, drift, ax * (1 - drift), ay * (1 - drift));
    g.globalAlpha = Math.max(0, Math.min(1, s.alpha));
    g.translate(s.dx * width + cx, s.dy * height + cy);
    g.scale(s.scale, s.scale);
    g.translate(-cx, -cy);
    g.filter = s.blur && s.blur > 0.2 ? `blur(${((s.blur * height) / 1080).toFixed(2)}px)` : "none";
    return s.alpha > 0;
  };
  const size = t.size * height;
  const box = (t.look ?? "plain") === "box";
  g.save();
  if (t.style === "image") {
    const img = t.src ? images.get(t.src) : undefined;
    if (img?.complete && img.naturalWidth && use(0, t.x * width, t.y * height)) {
      const w = (t.w ?? 0.3) * width;
      const h = (w * img.naturalHeight) / img.naturalWidth;
      g.drawImage(img, t.x * width - w / 2, t.y * height - h / 2, w, h);
    }
    g.restore();
    return;
  }
  if (Array.from({ length: partsOf(t) }, (_, k) => part(k)).every((s) => s.alpha <= 0)) {
    g.restore();
    return;
  }
  use(0, t.x * width, t.y * height);
  // Draws one part's text at x, y (its baseline): moved by its state, and for
  // a reveal, clipped to its own line so it rises out from behind it.
  const say = (k: number, text: string, x: number, y: number, fontSize: number, fade = 1) => {
    g.save();
    if (!use(k, x, y - fontSize * 0.35)) return void g.restore();
    g.globalAlpha *= fade;
    const r = part(k).reveal;
    if (r) {
      const w = g.measureText(text).width;
      const left = g.textAlign === "center" ? x - w / 2 : x;
      g.beginPath();
      g.rect(left - fontSize, y - fontSize * 1.05, w + fontSize * 2, fontSize * 1.4);
      g.clip();
      g.translate(0, r * fontSize * 1.4);
    }
    g.fillText(text, x, y);
    g.restore();
  };
  // The main text, whole or word by word (parts 0..n-1), centred on cx or from x.
  const sayLine = (line: string, first: number, x: number, y: number, fontSize: number, centre: boolean) => {
    if (!byWord(t)) return say(0, line, x, y, fontSize);
    const words = wordsOf(line);
    const space = g.measureText(" ").width;
    let at = centre ? x - g.measureText(words.join(" ")).width / 2 : x;
    const align = g.textAlign;
    g.textAlign = "left";
    words.forEach((word, i) => {
      say(first + i, word, at, y, fontSize);
      at += g.measureText(word).width + space;
    });
    g.textAlign = align;
  };
  const mainParts = partsOf(t) - (t.sub?.trim() ? 1 : 0);
  g.textBaseline = "alphabetic";
  const fill = box ? "#121212" : "#fff";
  const shadow = () => {
    if (box) return;
    g.shadowColor = "rgba(0,0,0,0.55)";
    g.shadowBlur = size * 0.25;
    g.shadowOffsetY = size * 0.04;
  };
  const noShadow = () => {
    g.shadowColor = "transparent";
    g.shadowBlur = 0;
    g.shadowOffsetY = 0;
  };
  const sub = t.sub?.trim();
  const subSize = size * 0.55;

  if (t.style === "title") {
    g.textAlign = "center";
    g.font = `700 ${size}px ${FONT}`;
    const cx = t.x * width;
    const cy = t.y * height;
    const lines = wrap(g, t.text, width * 0.8);
    const lineH = size * 1.1;
    const top = cy - (lines.length * lineH) / 2 + size * 0.8;
    if (box) {
      const w = Math.max(...lines.map((l) => g.measureText(l).width)) + size * 0.9;
      const h = lines.length * lineH + size * 0.5 + (sub ? subSize * 1.5 : 0);
      g.fillStyle = "rgba(255,255,255,0.94)";
      g.beginPath();
      g.roundRect(cx - w / 2, cy - (lines.length * lineH) / 2 - size * 0.25, w, h, size * 0.2);
      g.fill();
    }
    shadow();
    g.fillStyle = fill;
    let first = 0;
    lines.forEach((l, i) => {
      sayLine(l, first, cx, top + i * lineH, size, true);
      first += wordsOf(l).length;
    });
    if (sub) {
      g.font = `500 ${subSize}px ${FONT}`;
      say(mainParts, sub, cx, top + (lines.length - 1) * lineH + subSize * 1.6, subSize, 0.85);
    }
  } else if (t.style === "lower-third") {
    g.textAlign = "left";
    const x = t.x * width;
    const y = t.y * height;
    g.font = `700 ${size}px ${FONT}`;
    const w1 = g.measureText(t.text).width;
    g.font = `500 ${subSize}px ${FONT}`;
    const w2 = sub ? g.measureText(sub).width : 0;
    const padX = size * 0.45;
    const h = size * 1.35 + (sub ? subSize * 1.35 : 0);
    if (box) {
      g.fillStyle = "rgba(255,255,255,0.94)";
      g.beginPath();
      g.roundRect(x, y - size * 1.1, Math.max(w1, w2) + padX * 2, h, size * 0.18);
      g.fill();
    }
    shadow();
    g.fillStyle = fill;
    g.font = `700 ${size}px ${FONT}`;
    sayLine(t.text, 0, x + (box ? padX : 0), y, size, false);
    if (sub) {
      g.font = `500 ${subSize}px ${FONT}`;
      say(mainParts, sub, x + (box ? padX : 0), y + subSize * 1.35, subSize, box ? 0.7 : 0.85);
    }
  } else {
    // Callout: a ring on the spot, a short line, and a label.
    const px = t.x * width;
    const py = t.y * height;
    const r = size * 0.7;
    noShadow();
    g.lineWidth = Math.max(2, size * 0.12);
    g.strokeStyle = "#fff";
    g.shadowColor = "rgba(0,0,0,0.5)";
    g.shadowBlur = size * 0.2;
    g.beginPath();
    g.arc(px, py, r, 0, Math.PI * 2);
    g.stroke();
    const right = px < width * 0.7;
    const lx = px + (right ? 1 : -1) * size * 2.2;
    const ly = py - size * 1.6;
    g.beginPath();
    g.moveTo(px + (right ? r : -r) * 0.7, py - r * 0.7);
    g.lineTo(lx, ly);
    g.stroke();
    noShadow();
    g.font = `600 ${size}px ${FONT}`;
    const w = g.measureText(t.text).width;
    const padX = size * 0.5;
    const bx = right ? lx : lx - w - padX * 2;
    g.fillStyle = box ? "rgba(255,255,255,0.96)" : "rgba(0,0,0,0.6)";
    g.beginPath();
    g.roundRect(bx, ly - size * 0.95, w + padX * 2, size * 1.5, size * 0.3);
    g.fill();
    g.fillStyle = box ? "#121212" : "#fff";
    g.textAlign = "left";
    g.fillText(t.text, bx + padX, ly + size * 0.2);
  }
  g.restore();
}

function wrap(g: CanvasRenderingContext2D, text: string, max: number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && g.measureText(next).width > max) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

/** A text placed in the cut: when it starts and ends there (cut seconds). */
export interface Placed {
  t: TextFx;
  start: number;
  end: number;
  full?: boolean; // being edited: shown fully in, not mid-animation
}

/** Everything showing at cut time `time`, drawn onto g. */
export function drawAt(g: CanvasRenderingContext2D, placed: Placed[], time: number, width: number, height: number) {
  for (const p of placed) {
    if (time < p.start || time > p.end) continue;
    const m = motionOf(p.t);
    const parts = partsOf(p.t);
    const drift = p.full || !m.drift ? 1 : 1 + m.drift * ((time - p.start) / Math.max(0.1, p.end - p.start));
    drawText(g, p.t, width, height, (k) => (p.full ? SHOWN : motionAt(m, parts, Math.min(k, parts - 1), time - p.start, p.end - p.start)), drift);
  }
}

/** The export's graphics layer: a full-frame PNG for each stretch where the
 *  picture changes (every frame while something moves, one image while it
 *  holds still). */
export async function graphicsLayer(placed: Placed[], width: number, height: number, fps: number): Promise<CaptionStrips | null> {
  if (!placed.length) return null;
  await document.fonts.load(`700 40px Geist`).catch(() => undefined);
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const g = c.getContext("2d")!;
  const png = () => c.toDataURL("image/png").split(",")[1];
  g.clearRect(0, 0, width, height);
  const blank = png();
  const step = 1 / Math.max(1, Math.min(fps || 30, 60));
  const times = new Set<number>();
  for (const p of placed) {
    const [a, b] = moving(p.t);
    times.add(p.start);
    times.add(p.end);
    for (let t = p.start; t < Math.min(p.end, p.start + a); t += step) times.add(t);
    for (let t = Math.max(p.start, p.end - b); t < p.end; t += step) times.add(t);
    times.add(Math.min(p.end, p.start + a));
  }
  const points = [...times].sort((a, b) => a - b);
  const frames: CaptionStrips["frames"] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const [a, b] = [points[i], points[i + 1]];
    if (b - a < 1e-4) continue;
    const showing = placed.filter((p) => p.start < b && p.end > a);
    if (!showing.length) continue;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, width, height);
    drawAt(g, showing, a + 1e-4, width, height);
    frames.push({ start: a, end: b, png: png() });
  }
  return { top: 0, blank, frames };
}
