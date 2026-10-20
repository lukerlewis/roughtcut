// Titles, lower thirds and callouts, drawn the same way for the viewer and
// for the export, so what Luke sees is what he gets. The export receives
// them as transparent full-frame PNGs over the times they show.

import type { CaptionStrips } from "./captions";
import type { TextFx } from "./edl";

const FONT = '"Geist", "Helvetica Neue", Helvetica, Arial, sans-serif';
export const ANIM_IN = 0.35; // seconds to come in
export const ANIM_OUT = 0.25; // seconds to go out

const ease = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

/** How far in (0..1) a text is at `t` seconds after it starts, lasting `length`. */
export function presence(t: number, length: number): number {
  if (t < 0 || t > length) return 0;
  return Math.min(ease(t / ANIM_IN), ease((length - t) / ANIM_OUT));
}

/** Draws one text onto a width x height frame, `amount` of the way in. */
export function drawText(g: CanvasRenderingContext2D, t: TextFx, width: number, height: number, amount: number) {
  if (amount <= 0) return;
  const size = t.size * height;
  const box = (t.look ?? "plain") === "box";
  const rise = (1 - amount) * height * 0.02;
  g.save();
  g.globalAlpha = amount;
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
    const cy = t.y * height + rise;
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
    lines.forEach((l, i) => g.fillText(l, cx, top + i * lineH));
    if (sub) {
      g.font = `500 ${subSize}px ${FONT}`;
      g.globalAlpha = amount * 0.85;
      g.fillText(sub, cx, top + (lines.length - 1) * lineH + subSize * 1.6);
    }
  } else if (t.style === "lower-third") {
    g.textAlign = "left";
    const x = t.x * width + (1 - amount) * -width * 0.02;
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
    g.fillText(t.text, x + (box ? padX : 0), y);
    if (sub) {
      g.font = `500 ${subSize}px ${FONT}`;
      g.globalAlpha = amount * (box ? 0.7 : 0.85);
      g.fillText(sub, x + (box ? padX : 0), y + subSize * 1.35);
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
    g.arc(px, py, r * (0.6 + 0.4 * amount), 0, Math.PI * 2);
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
    drawText(g, p.t, width, height, p.full ? 1 : presence(time - p.start, p.end - p.start));
  }
}

/** The export's graphics layer: a full-frame PNG for each stretch where the
 *  picture changes (every frame while something animates, one image while
 *  it holds still). */
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
    times.add(p.start);
    times.add(p.end);
    for (let t = p.start; t < Math.min(p.end, p.start + ANIM_IN); t += step) times.add(t);
    for (let t = Math.max(p.start, p.end - ANIM_OUT); t < p.end; t += step) times.add(t);
    times.add(Math.min(p.end, p.start + ANIM_IN));
  }
  const points = [...times].sort((a, b) => a - b);
  const frames: CaptionStrips["frames"] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const [a, b] = [points[i], points[i + 1]];
    if (b - a < 1e-4) continue;
    const showing = placed.filter((p) => p.start < b && p.end > a);
    if (!showing.length) continue;
    g.clearRect(0, 0, width, height);
    drawAt(g, showing, a + 1e-4, width, height);
    frames.push({ start: a, end: b, png: png() });
  }
  return { top: 0, blank, frames };
}
