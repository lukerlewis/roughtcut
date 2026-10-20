import { Minus, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { blocks as wordBlocks, cutDuration, cutToSource, sourceToCut, timecode, type Block, type Range, type Word } from "../lib/edl";

/** An effect on the timeline, by kind and its index in that kind's list. */
export type Effect = { kind: string; index: number };

/** One block on an effect track, in source seconds. */
export interface FxItem {
  effect: Effect;
  start: number;
  end: number;
  label: string;
  pending: boolean; // Claude's and unreviewed: drawn blue
  icon?: "film" | "text" | "zoom" | "blur" | "speed" | "layout" | "audio";
  /** How far its ends can go (e.g. a clip can't run past its file). */
  bounds?: [number, number];
}

export interface FxTrack {
  name: string;
  items: FxItem[];
}

/** A note pinned to a moment, shown as a flag on the ruler. */
export interface Pin {
  index: number;
  at: number; // source seconds
  done: boolean;
  forClaude: boolean;
}

export type FxMode = "left" | "right" | "move";

interface Props {
  ranges: Range[];
  duration: number; // of the source
  peaks: Uint8Array | null; // loudness per 10ms of source
  time: number; // playhead, seconds into the cut
  playing: boolean;
  claudeJoins: number[]; // indexes of joins where Claude's unreviewed cut sits
  fps: number;
  words: Word[];
  tracks: FxTrack[]; // effect tracks, top to bottom, above the recording
  onFxEdit: (effect: Effect, start: number, end: number, mode: FxMode) => void; // source seconds
  pins: Pin[];
  onPin: (index: number) => void;
  onTrim: (clip: number, start: number, end: number) => void; // source seconds
  effect: Effect | null; // the effect whose settings are showing
  onSelectEffect: (effect: Effect | null) => void;
  selection: { first: number; last: number } | null; // words selected (shared with the transcript)
  onSelectWords: (first: number, last: number) => void; // ⌫ then cuts them, Z zooms
  onCutPause: (start: number, end: number) => void; // source seconds
  onScrub: (t: number) => void;
  onScrubEnd?: () => void;
}

const RULER = 22;
const TRACK_TOP = 28;
const TRACK_H = 18; // each effect track
const TRACK_GAP = 26; // from one track's top to the next
const LANE_H = 100;
const EDGE = 6; // px from an end that grabs it
const MIN = 0.1; // shortest effect, in seconds

type Drag =
  | { mode: "scrub" }
  | { mode: "fx"; edge: FxMode; item: FxItem; a: number; b: number; x: number }
  | { mode: "trim-left" | "trim-right"; clip: number; a: number; b: number; x: number };

type Preview = { kind: "fx"; key: string; a: number; b: number } | { kind: "trim"; clip: number; a: number; b: number };

const keyOf = (e: Effect) => `${e.kind}:${e.index}`;

function css(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Mix a hex colour over another at `amount` (0..1), like CSS color-mix. */
function mix(hex: string, over: string, amount: number) {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [a, b] = [p(hex), p(over)];
  return `rgb(${a.map((v, i) => Math.round(v * amount + b[i] * (1 - amount))).join(",")})`;
}

/** Ruler labels: whole seconds, or tenths and hundredths when zoomed right in. */
function label(t: number, step: number) {
  if (step >= 1) return timecode(t);
  const digits = step < 0.5 && step !== 0.1 ? 2 : 1;
  return `${timecode(t)}.${String(Math.round((t % 1) * 10 ** digits) % 10 ** digits).padStart(digits, "0")}`;
}

/** Small glyphs that say what kind of effect a block is. */
function glyph(g: CanvasRenderingContext2D, icon: FxItem["icon"], x: number, y: number) {
  switch (icon) {
    case "film":
      g.fillRect(x, y, 10, 1.5);
      g.fillRect(x, y + 8.5, 10, 1.5);
      g.fillRect(x, y, 1.5, 10);
      g.fillRect(x + 8.5, y, 1.5, 10);
      g.fillRect(x + 3, y + 3, 4, 4);
      break;
    case "text":
      g.fillRect(x, y, 10, 2);
      g.fillRect(x + 4, y, 2, 10);
      break;
    case "blur":
      for (const [dx, dy] of [[1, 1], [6, 1], [1, 6], [6, 6]]) g.fillRect(x + dx, y + dy, 3, 3);
      break;
    case "speed":
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + 5, y + 5);
      g.lineTo(x, y + 10);
      g.moveTo(x + 5, y);
      g.lineTo(x + 10, y + 5);
      g.lineTo(x + 5, y + 10);
      g.fill();
      break;
    case "layout":
      g.fillRect(x, y, 10, 1.5);
      g.fillRect(x, y + 8.5, 10, 1.5);
      g.fillRect(x, y, 1.5, 10);
      g.fillRect(x + 8.5, y, 1.5, 10);
      g.fillRect(x + 5, y + 4, 4, 4);
      break;
    case "audio":
      for (const [dx, hh] of [[0, 4], [3, 10], [6, 6], [9, 8]]) g.fillRect(x + dx, y + (10 - hh) / 2, 1.5, hh);
      break;
    default:
      // zoom: a magnifier ring
      g.beginPath();
      g.arc(x + 4, y + 4, 3.5, 0, Math.PI * 2);
      g.lineWidth = 1.5;
      g.strokeStyle = g.fillStyle as string;
      g.stroke();
      g.fillRect(x + 6.5, y + 6.5, 3, 3);
  }
}

export function Timeline(p: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState(0); // 0 = fit the whole cut
  const [scroll, setScroll] = useState(0); // seconds at the left edge
  const drag = useRef<Drag | null>(null);
  const [preview, setPreviewState] = useState<Preview | null>(null);
  // Also kept in a ref, so a quick release still commits the last position.
  const previewRef = useRef<Preview | null>(null);
  const setPreview = (v: Preview | null) => {
    previewRef.current = v;
    setPreviewState(v);
  };
  const [pause, setPause] = useState<Block | null>(null); // a pause block picked to delete
  const LANE_TOP = TRACK_TOP + p.tracks.length * TRACK_GAP;

  // The pieces as they'd be with the trim in progress.
  const ranges =
    preview?.kind === "trim" ? p.ranges.map((r, i) => (i === preview.clip ? ([preview.a, preview.b] as [number, number]) : r)) : p.ranges;
  const total = cutDuration(ranges);
  const lanes = useMemo(() => wordBlocks(ranges, p.words), [ranges, p.words]);

  // Every effect as a block in cut time, with the drag in progress applied.
  const fx = p.tracks.flatMap((track, t) =>
    track.items.map((item) => {
      const key = keyOf(item.effect);
      const moving = preview?.kind === "fx" && preview.key === key;
      return {
        item,
        key,
        top: TRACK_TOP + t * TRACK_GAP,
        a: moving ? preview.a : sourceToCut(ranges, item.start),
        b: moving ? preview.b : sourceToCut(ranges, item.end),
      };
    }),
  );

  const pxPerSec = useCallback(
    (width: number) => {
      const fit = (width - 24) / Math.max(total, 1);
      return fit * Math.pow(2, zoom);
    },
    [total, zoom],
  );
  const visible = (width: number) => (width - 24) / pxPerSec(width);
  const maxScroll = (width: number) => Math.max(0, total - visible(width));
  const left = zoom === 0 ? 0 : Math.min(scroll, maxScroll(canvas.current?.clientWidth ?? 1000));

  // Keep the playhead on screen while playing (but let Luke scroll freely when paused).
  useEffect(() => {
    const c = canvas.current;
    if (!c || zoom === 0 || !p.playing) return;
    const v = visible(c.clientWidth);
    if (p.time < left || p.time > left + v * 0.9) setScroll(Math.max(0, p.time - v * 0.1));
  }, [p.time, p.playing, zoom, left]);

  const zoomTo = (z: number) => {
    const next = Math.max(0, Math.min(8, z));
    setZoom(next);
    // Keep the playhead in the middle of the new view, which shows total / 2^zoom seconds.
    setScroll(Math.max(0, p.time - Math.max(total, 1) / Math.pow(2, next) / 2));
  };

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (c.width !== w * dpr || c.height !== h * dpr) {
      c.width = w * dpr;
      c.height = h * dpr;
    }
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const bg = css("--sidebar");
    const pps = pxPerSec(w);
    const x = (t: number) => 12 + (t - left) * pps;
    const tint = parseFloat(css("--lane-tint")) / 100;
    const voiceHex = css("--lane-voice");
    const videoHex = css("--lane-video");
    const isHex = (s: string) => /^#[0-9a-f]{6}$/i.test(s);
    const clipFill = isHex(bg) && isHex(videoHex) ? mix(videoHex, bg, tint) : "#333";
    const waveFill = isHex(bg) && isHex(voiceHex) ? mix(voiceHex, bg, Math.min(1, tint * 1.8)) : "#3a5";
    const mono = css("--mono") || "monospace";
    const sans = `"Geist", system-ui, sans-serif`;

    // Ruler.
    g.fillStyle = css("--muted-foreground");
    g.font = `11px ${mono}`;
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const step = steps.find((s) => s * pps >= 80) ?? 1200;
    g.strokeStyle = css("--stroke");
    g.lineWidth = 1;
    for (let k = Math.max(0, Math.floor(left / step)); x(k * step) < w; k++) {
      const t = k * step;
      g.beginPath();
      g.moveTo(Math.round(x(t)) + 0.5, RULER - 6);
      g.lineTo(Math.round(x(t)) + 0.5, RULER);
      g.stroke();
      g.fillText(label(t, step), x(t) + 3, 13);
    }
    g.beginPath();
    g.moveTo(0, RULER + 0.5);
    g.lineTo(w, RULER + 0.5);
    g.strokeStyle = css("--border");
    g.stroke();

    // The recording's pieces laid end to end, split into a block per word
    // (and per long pause), each word above its slice of the waveform.
    let acc = 0;
    ranges.forEach(([a, b], i) => {
      const x0 = x(acc);
      const x1 = x(acc + (b - a));
      const start = acc;
      acc += b - a;
      if (x1 < 0 || x0 > w) return;
      const at = (t: number) => x(start + (t - a));
      const span = (bl: Block) => {
        const bx0 = at(bl.start);
        const bx1 = bl.end >= b - 1e-6 ? x1 - 2 : at(bl.end) - 1;
        return [bx0, bx1, Math.max(1, bx1 - bx0)] as const;
      };
      for (const bl of lanes[i] ?? []) {
        const [bx0, bx1, bw] = span(bl);
        if (bx1 < 0 || bx0 > w) continue;
        g.globalAlpha = bl.word === null ? 0.55 : 1;
        g.fillStyle = clipFill;
        g.beginPath();
        g.roundRect(bx0, LANE_TOP, bw, LANE_H, 3);
        g.fill();
        g.globalAlpha = 1;
      }
      if (p.peaks) {
        g.fillStyle = waveFill;
        const mid = LANE_TOP + LANE_H * 0.64;
        const amp = LANE_H * 0.3;
        for (let px = Math.max(0, Math.floor(x0)); px < Math.min(w, x1 - 2); px++) {
          const s0 = a + (px - x0) / pps;
          const s1 = a + (px + 1 - x0) / pps;
          let peak = 0;
          for (let k = Math.floor(s0 * 100); k <= Math.floor(s1 * 100) && k < p.peaks.length; k++) peak = Math.max(peak, p.peaks[k]);
          const hgt = (peak / 255) * amp;
          g.fillRect(px, mid - hgt, 1, hgt * 2);
        }
      }
      for (const bl of lanes[i] ?? []) {
        const [bx0, bx1, bw] = span(bl);
        if (bx1 < 0 || bx0 > w) continue;
        // The word, where there's room for it.
        if (bl.word !== null && bw > 14) {
          g.save();
          g.beginPath();
          g.rect(bx0 + 4, LANE_TOP, bw - 6, LANE_H);
          g.clip();
          g.font = `12px ${sans}`;
          g.fillStyle = css("--subtle-foreground");
          g.fillText(p.words[bl.word].text, bx0 + 5, LANE_TOP + 18);
          g.restore();
        }
        const chosen =
          bl.word === null
            ? pause !== null && Math.abs(pause.start - bl.start) < 1e-6
            : p.selection !== null && bl.word >= p.selection.first && bl.word <= p.selection.last;
        if (chosen) {
          g.strokeStyle = css("--ink");
          g.lineWidth = 2;
          g.beginPath();
          g.roundRect(bx0 + 1, LANE_TOP + 1, bw - 2, LANE_H - 2, 3);
          g.stroke();
        }
      }
      if (preview?.kind === "trim" && preview.clip === i) {
        g.fillStyle = css("--ink");
        g.fillRect(x0, LANE_TOP, 2, LANE_H);
        g.fillRect(x1 - 4, LANE_TOP, 2, LANE_H);
      }
      // Claude's unreviewed cut sits at the start of this piece: mark the join blue.
      if (i > 0 && p.claudeJoins.includes(i)) {
        g.fillStyle = css("--unread");
        g.fillRect(x0 - 1.5, LANE_TOP - 4, 2, LANE_H + 8);
        g.beginPath();
        g.moveTo(x0 - 5, LANE_TOP - 6);
        g.lineTo(x0 + 3, LANE_TOP - 6);
        g.lineTo(x0 - 1, LANE_TOP);
        g.fill();
      }
    });

    // Effect tracks: one block per effect, blue while Claude's and unreviewed.
    g.font = `500 11px ${sans}`;
    for (const { item, key, top, a, b } of fx) {
      const x0 = x(a);
      const x1 = x(b);
      if (x1 < 0 || x0 > w) continue;
      const bw = Math.max(4, x1 - x0 - 1);
      g.fillStyle = item.pending ? css("--unread") : css("--stroke-strong");
      g.beginPath();
      g.roundRect(x0, top, bw, TRACK_H, 4);
      g.fill();
      if (p.effect && keyOf(p.effect) === key) {
        g.strokeStyle = css("--ink");
        g.lineWidth = 2;
        g.beginPath();
        g.roundRect(x0 + 1, top + 1, bw - 2, TRACK_H - 2, 4);
        g.stroke();
      }
      g.save();
      g.beginPath();
      g.rect(x0, top, bw - 6, TRACK_H);
      g.clip();
      g.fillStyle = item.pending ? "#fff" : css("--foreground");
      if (bw > 20) glyph(g, item.icon, x0 + 6, top + 4);
      if (bw > 40) g.fillText(item.label, x0 + 21, top + 13);
      g.restore();
    }

    // Notes: flags hanging from the ruler.
    for (const pin of p.pins) {
      const px = x(sourceToCut(ranges, pin.at));
      if (px < -6 || px > w + 6) continue;
      g.fillStyle = pin.done ? css("--stroke-strong") : css("--foreground");
      g.fillRect(Math.round(px) - 0.5, RULER - 12, 1.5, 12);
      g.beginPath();
      g.moveTo(px + 1, RULER - 12);
      g.lineTo(px + 8, RULER - 9);
      g.lineTo(px + 1, RULER - 6);
      g.fill();
    }

    // Playhead.
    const ph = x(p.time);
    g.fillStyle = css("--ink");
    g.fillRect(Math.round(ph) - 0.5, 0, 1.5, h);
    g.beginPath();
    g.moveTo(ph - 5, 0);
    g.lineTo(ph + 5, 0);
    g.lineTo(ph, 7);
    g.fill();
  });

  const timeAt = (clientX: number) => {
    const c = canvas.current!;
    const r = c.getBoundingClientRect();
    const t = left + (clientX - r.left - 12) / pxPerSec(c.clientWidth);
    return Math.max(0, Math.min(total, t));
  };

  /** What's under the pointer: a note, an effect's edge or body, a piece's edge, or a word. */
  const hit = (clientX: number, clientY: number) => {
    const c = canvas.current!;
    const r = c.getBoundingClientRect();
    const y = clientY - r.top;
    const pps = pxPerSec(c.clientWidth);
    const px = (t: number) => r.left + 12 + (t - left) * pps;
    if (y < RULER) {
      const pin = p.pins.find((n) => Math.abs(px(sourceToCut(ranges, n.at)) + 3 - clientX) <= 6);
      return pin ? ({ mode: "pin", pin } as const) : null;
    }
    for (const f of fx) {
      if (y < f.top - 2 || y > f.top + TRACK_H + 2) continue;
      const [x0, x1] = [px(f.a), px(f.b)];
      if (clientX < x0 - EDGE || clientX > x1 + EDGE) continue;
      const edge: FxMode = Math.abs(clientX - x0) <= EDGE ? "left" : Math.abs(clientX - x1) <= EDGE ? "right" : "move";
      return { mode: "fx", edge, f } as const;
    }
    if (y >= LANE_TOP && y <= LANE_TOP + LANE_H) {
      let acc = 0;
      for (let i = 0; i < ranges.length; i++) {
        const [a, b] = ranges[i];
        const [x0, x1] = [px(acc), px(acc + b - a)];
        const start = acc;
        acc += b - a;
        // At a join, the side the pointer is on picks the piece.
        if (clientX >= x0 && clientX < x0 + EDGE) return { mode: "trim-left", clip: i } as const;
        if (clientX > x1 - EDGE && clientX <= x1) return { mode: "trim-right", clip: i } as const;
        if (clientX >= x0 && clientX <= x1) {
          const t = a + (clientX - r.left - 12) / pps + left - start;
          const block = lanes[i]?.find((bl) => t >= bl.start && t <= bl.end) ?? null;
          return { mode: "clip", clip: i, block } as const;
        }
      }
    }
    return null;
  };

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      if (d.mode === "scrub") return p.onScrub(timeAt(e.clientX));
      const dt = (e.clientX - d.x) / pxPerSec(canvas.current!.clientWidth);
      if (d.mode !== "fx") {
        // Moving an end in or out of the source, rippling what follows.
        const prev = p.ranges[d.clip - 1]?.[1] ?? 0;
        const next = p.ranges[d.clip + 1]?.[0] ?? p.duration;
        const a = d.mode === "trim-left" ? Math.max(prev, Math.min(d.b - MIN, d.a + dt)) : d.a;
        const b = d.mode === "trim-right" ? Math.min(next, Math.max(d.a + MIN, d.b + dt)) : d.b;
        return setPreview({ kind: "trim", clip: d.clip, a, b });
      }
      let { a, b } = d;
      if (d.edge === "left") a = Math.max(0, Math.min(b - MIN, a + dt));
      else if (d.edge === "right") b = Math.min(total, Math.max(a + MIN, b + dt));
      else {
        const shift = Math.max(-a, Math.min(total - b, dt));
        [a, b] = [a + shift, b + shift];
      }
      setPreview({ kind: "fx", key: keyOf(d.item.effect), a, b });
    };
    const up = () => {
      const d = drag.current;
      drag.current = null;
      if (!d) return;
      let preview = previewRef.current;
      // A click without a drag changes nothing.
      if (preview && d.mode !== "scrub" && Math.abs(preview.a - d.a) < 1e-6 && Math.abs(preview.b - d.b) < 1e-6) preview = null;
      if (d.mode === "scrub") p.onScrubEnd?.();
      else if (preview?.kind === "trim") p.onTrim(preview.clip, preview.a, preview.b);
      else if (preview?.kind === "fx" && d.mode === "fx") {
        // Back to source time. The end that wasn't dragged stays exactly where it was;
        // a move keeps the length in the recording. An end exactly at a join belongs to the piece before it.
        const it = d.item;
        let start = d.edge === "right" ? it.start : cutToSource(p.ranges, preview.a).source;
        let end = d.edge === "left" ? it.end : cutToSource(p.ranges, Math.max(0, preview.b - 1e-4)).source + 1e-4;
        if (d.edge === "move") end = start + (it.end - it.start);
        if (it.bounds && d.edge !== "move") [start, end] = [Math.max(start, it.bounds[0]), Math.min(end, it.bounds[1])];
        if (end - start >= 0.05) p.onFxEdit(it.effect, start, end, d.edge);
      }
      setPreview(null);
    };
    // Select a pause, then ⌫ deletes it. Runs before the app's own keys.
    const key = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (pause === null || typing || (e.key !== "Backspace" && e.key !== "Delete")) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      p.onCutPause(pause.start, pause.end);
      setPause(null);
    };
    const down = (e: MouseEvent) => {
      if (e.target !== canvas.current) setPause(null);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    window.addEventListener("keydown", key, true);
    window.addEventListener("mousedown", down);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("mousedown", down);
    };
  });

  return (
    <div className="timeline">
      <div className="timeline-head">
        <span className="meta mono">
          {timecode(p.time, p.fps, true)} / {timecode(total, p.fps, true)}
        </span>
        <span className="meta">{p.ranges.length} clips</span>
        <span className="meta tracks">{p.tracks.map((t) => t.name).join(" · ")}</span>
        <span className="spacer" />
        <button className="btn icon ghost" title="Zoom out" onClick={() => zoomTo(zoom - 1)}>
          <Minus size={16} />
        </button>
        <button className="btn icon ghost" title="Zoom in" onClick={() => zoomTo(zoom + 1)}>
          <Plus size={16} />
        </button>
      </div>
      <canvas
        ref={canvas}
        style={{ height: LANE_TOP + LANE_H + 20 }}
        onMouseDown={(e) => {
          const h = hit(e.clientX, e.clientY);
          setPause(null);
          if (h?.mode === "pin") return p.onPin(h.pin.index);
          if (h?.mode === "fx") {
            const { item, a, b } = h.f;
            drag.current = { mode: "fx", edge: h.edge, item, a, b, x: e.clientX };
            p.onSelectEffect(item.effect);
            setPreview({ kind: "fx", key: h.f.key, a, b });
            return;
          }
          if (h && (h.mode === "trim-left" || h.mode === "trim-right")) {
            const [a, b] = p.ranges[h.clip];
            drag.current = { mode: h.mode, clip: h.clip, a, b, x: e.clientX };
            setPreview({ kind: "trim", clip: h.clip, a, b });
            return;
          }
          p.onSelectEffect(null);
          // Click a word to select it (shift-click to select up to another), or a pause.
          if (h?.mode === "clip" && h.block) {
            const bl = h.block;
            if (bl.word === null) setPause(bl);
            else if (e.shiftKey && p.selection) p.onSelectWords(Math.min(p.selection.first, bl.word), Math.max(p.selection.last, bl.word));
            else p.onSelectWords(bl.word, bl.word);
          }
          drag.current = { mode: "scrub" };
          p.onScrub(timeAt(e.clientX));
        }}
        onMouseMove={(e) => {
          if (drag.current) return;
          const h = hit(e.clientX, e.clientY);
          e.currentTarget.style.cursor =
            !h || h.mode === "clip" ? "default" : h.mode === "pin" ? "pointer" : h.mode === "fx" && h.edge === "move" ? "grab" : "ew-resize";
        }}
        onWheel={(e) => {
          const c = canvas.current!;
          if (e.ctrlKey || e.metaKey) return zoomTo(zoom + (e.deltaY < 0 ? 1 : -1));
          if (zoom === 0) return;
          // Magic Mouse and trackpad swipes come as deltaX; a plain wheel as deltaY.
          const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
          setScroll(Math.max(0, Math.min(maxScroll(c.clientWidth), left + delta / pxPerSec(c.clientWidth))));
        }}
      />
    </div>
  );
}
