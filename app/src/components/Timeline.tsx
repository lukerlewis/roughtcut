import { Minus, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { blocks as wordBlocks, cutDuration, cutToSource, sourceToCut, timecode, zoomSpan, type Block, type Clip, type Word, type Zoom } from "../lib/edl";

export type Effect = { kind: "zoom" | "clip"; index: number };

interface Props {
  ranges: [number, number][];
  duration: number; // of the source
  peaks: Uint8Array | null; // loudness per 10ms of source
  time: number; // playhead, seconds into the cut
  playing: boolean;
  claudeJoins: number[]; // indexes of joins where Claude's unreviewed cut sits
  fps: number;
  words: Word[];
  zooms: Zoom[]; // all of them; removed ones are skipped
  onZoomEdit: (index: number, start: number, end: number) => void; // source seconds
  clips: Clip[]; // Claude's clips, all of them; removed ones are skipped
  onClipEdit: (index: number, start: number, end: number, offset: number) => void; // source seconds
  onClipRemove: (index: number) => void;
  onTrim: (clip: number, start: number, end: number) => void; // source seconds
  onDeleteClip: (clip: number) => void;
  effect: Effect | null; // the zoom or clip whose settings are showing
  onSelectEffect: (effect: Effect | null) => void;
  selection: { first: number; last: number } | null; // words selected (shared with the transcript)
  onSelectWords: (first: number, last: number) => void; // ⌫ then cuts them, Z zooms
  onCutPause: (start: number, end: number) => void; // source seconds
  onScrub: (t: number) => void;
  onScrubEnd?: () => void;
}

const RULER = 22;
const TRACK_H = 18; // Claude's clips and the zooms each get a track this tall above the recording
const CLIP_GAP = 26; // the Claude clips track, shown only when there are clips
const LANE_H = 100;
const EDGE = 6; // px from an end that grabs it
const MIN = 0.1; // shortest clip or zoom, in seconds

type Drag =
  | { mode: "scrub" }
  | { mode: "zoom-left" | "zoom-right" | "zoom-move"; index: number; a: number; b: number; x: number; span: [number, number] }
  | { mode: "made-left" | "made-right" | "made-move"; index: number; a: number; b: number; x: number }
  | { mode: "trim-left" | "trim-right"; clip: number; a: number; b: number; x: number };

type Preview =
  | { kind: "zoom" | "made"; index: number; a: number; b: number }
  | { kind: "trim"; clip: number; a: number; b: number };


/** A small strip of film, marking a clip Claude made. */
function film(g: CanvasRenderingContext2D, x: number, y: number) {
  g.fillRect(x, y, 10, 1.5);
  g.fillRect(x, y + 8.5, 10, 1.5);
  g.fillRect(x, y, 1.5, 10);
  g.fillRect(x + 8.5, y, 1.5, 10);
  g.fillRect(x + 3, y + 3, 4, 4);
}

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
  const selected = p.effect;
  const [pause, setPause] = useState<Block | null>(null); // a pause block picked to delete
  const hasClips = p.clips.some((c) => c.status !== "restored");
  const CLIP_TOP = 28;
  const ZOOM_TOP = 28 + (hasClips ? CLIP_GAP : 0);
  const LANE_TOP = ZOOM_TOP + 24;

  // The clips as they'd be with the trim in progress.
  const ranges =
    preview?.kind === "trim" ? p.ranges.map((r, i) => (i === preview.clip ? ([preview.a, preview.b] as [number, number]) : r)) : p.ranges;
  const total = cutDuration(ranges);
  const lanes = useMemo(() => wordBlocks(ranges, p.words), [ranges, p.words]);

  // Each live zoom as a block in cut time, with the drag in progress applied.
  const blocks = p.zooms.flatMap((z, index) => {
    if (z.status === "restored") return [];
    if (preview?.kind === "zoom" && preview.index === index) return [{ index, z, a: preview.a, b: preview.b }];
    const [a, b] = zoomSpan(p.words, z);
    return [{ index, z, a: sourceToCut(ranges, a), b: sourceToCut(ranges, b) }];
  });

  // Each of Claude's live clips as a block in cut time.
  const made = p.clips.flatMap((c, index) => {
    if (c.status === "restored") return [];
    if (preview?.kind === "made" && preview.index === index) return [{ index, c, a: preview.a, b: preview.b }];
    return [{ index, c, a: sourceToCut(ranges, c.start), b: sourceToCut(ranges, c.end) }];
  });

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
      for (const bl of lanes[i] ?? []) {
        const bx0 = at(bl.start);
        const bx1 = bl.end >= b - 1e-6 ? x1 - 2 : at(bl.end) - 1;
        if (bx1 < 0 || bx0 > w) continue;
        const bw = Math.max(1, bx1 - bx0);
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
        const bx0 = at(bl.start);
        const bx1 = bl.end >= b - 1e-6 ? x1 - 2 : at(bl.end) - 1;
        if (bx1 < 0 || bx0 > w) continue;
        const bw = Math.max(1, bx1 - bx0);
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

    // Effects track: zooms as blocks, blue while Claude's and unreviewed.
    g.font = `500 10px ${mono}`;
    for (const { index, z, a, b } of blocks) {
      const x0 = x(a);
      const x1 = x(b);
      if (x1 < 0 || x0 > w) continue;
      const pending = z.status === "pending";
      g.fillStyle = pending ? css("--unread") : css("--stroke-strong");
      g.beginPath();
      g.roundRect(x0, ZOOM_TOP, Math.max(4, x1 - x0 - 1), TRACK_H, 4);
      g.fill();
      g.fillStyle = pending ? "#fff" : css("--foreground");
      g.fillRect(x0 + 2, ZOOM_TOP + 5, 2, TRACK_H - 10);
      g.fillRect(x1 - 5, ZOOM_TOP + 5, 2, TRACK_H - 10);
      if (x1 - x0 > 70) g.fillText(`Zoom ${Math.round(z.scale * 100)}%`, x0 + 10, ZOOM_TOP + 12.5);
      if (selected?.kind === "zoom" && selected.index === index) {
        g.strokeStyle = css("--ink");
        g.lineWidth = 2;
        g.beginPath();
        g.roundRect(x0 + 1, ZOOM_TOP + 1, Math.max(4, x1 - x0 - 1) - 2, TRACK_H - 2, 4);
        g.stroke();
      }
    }

    // Claude clips track: clips it made, blue until Luke keeps them.
    g.font = `500 11px ${sans}`;
    for (const { index, c, a, b } of made) {
      const x0 = x(a);
      const x1 = x(b);
      if (x1 < 0 || x0 > w) continue;
      const pending = c.status === "pending";
      const bw = Math.max(4, x1 - x0 - 1);
      g.fillStyle = pending ? css("--unread") : css("--stroke-strong");
      g.beginPath();
      g.roundRect(x0, CLIP_TOP, bw, TRACK_H, 4);
      g.fill();
      if (selected?.kind === "clip" && selected.index === index) {
        g.strokeStyle = css("--ink");
        g.lineWidth = 2;
        g.beginPath();
        g.roundRect(x0 + 1, CLIP_TOP + 1, bw - 2, TRACK_H - 2, 4);
        g.stroke();
      }
      g.save();
      g.beginPath();
      g.rect(x0, CLIP_TOP, bw - 6, TRACK_H);
      g.clip();
      g.fillStyle = pending ? "#fff" : css("--foreground");
      if (bw > 20) film(g, x0 + 6, CLIP_TOP + 4);
      if (bw > 40) g.fillText(c.reason || c.file.split("/").pop() || "Clip", x0 + 21, CLIP_TOP + 13);
      g.restore();
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

  /** What's under the pointer: a zoom's edge or body, a clip's edge or body. */
  const hit = (clientX: number, clientY: number) => {
    const c = canvas.current!;
    const r = c.getBoundingClientRect();
    const y = clientY - r.top;
    const pps = pxPerSec(c.clientWidth);
    const px = (t: number) => r.left + 12 + (t - left) * pps;
    if (hasClips && y >= CLIP_TOP - 2 && y <= CLIP_TOP + TRACK_H + 2) {
      for (const bl of made) {
        const [x0, x1] = [px(bl.a), px(bl.b)];
        if (clientX < x0 - EDGE || clientX > x1 + EDGE) continue;
        const mode = Math.abs(clientX - x0) <= EDGE ? "made-left" : Math.abs(clientX - x1) <= EDGE ? "made-right" : "made-move";
        return { mode, made: bl } as const;
      }
      return null;
    }
    if (y >= ZOOM_TOP - 2 && y <= ZOOM_TOP + TRACK_H + 2) {
      for (const bl of blocks) {
        const [x0, x1] = [px(bl.a), px(bl.b)];
        if (clientX < x0 - EDGE || clientX > x1 + EDGE) continue;
        const mode = Math.abs(clientX - x0) <= EDGE ? "zoom-left" : Math.abs(clientX - x1) <= EDGE ? "zoom-right" : "zoom-move";
        return { mode, block: bl } as const;
      }
      return null;
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
      if ("clip" in d) {
        // Moving an end in or out of the source, rippling what follows.
        const prev = p.ranges[d.clip - 1]?.[1] ?? 0;
        const next = p.ranges[d.clip + 1]?.[0] ?? p.duration;
        const a = d.mode === "trim-left" ? Math.max(prev, Math.min(d.b - MIN, d.a + dt)) : d.a;
        const b = d.mode === "trim-right" ? Math.min(next, Math.max(d.a + MIN, d.b + dt)) : d.b;
        return setPreview({ kind: "trim", clip: d.clip, a, b });
      }
      let { a, b } = d;
      const { index, mode } = d;
      if (d.mode === "zoom-left" || d.mode === "made-left") a = Math.max(0, Math.min(b - MIN, a + dt));
      else if (d.mode === "zoom-right" || d.mode === "made-right") b = Math.min(total, Math.max(a + MIN, b + dt));
      else {
        const shift = Math.max(-a, Math.min(total - b, dt));
        [a, b] = [a + shift, b + shift];
      }
      setPreview({ kind: mode.startsWith("made") ? "made" : "zoom", index, a, b });
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
      else if (preview?.kind === "made" && d.mode.startsWith("made")) {
        // Back to source time. Moving keeps where in its file the clip plays
        // from; trimming the left end moves that point with it. Neither end
        // can go past the file's own start or end.
        const c = p.clips[preview.index];
        const fileStart = c.start - c.offset; // where the file's first frame would sit
        const fileEnd = fileStart + c.length;
        let start = cutToSource(p.ranges, preview.a).source;
        let end = cutToSource(p.ranges, Math.max(0, preview.b - 1e-4)).source + 1e-4;
        if (d.mode === "made-move") end = start + (c.end - c.start);
        if (d.mode === "made-right") start = c.start;
        if (d.mode === "made-left") end = c.end;
        if (d.mode !== "made-move") [start, end] = [Math.max(start, fileStart), Math.min(end, fileEnd)];
        const offset = d.mode === "made-move" ? c.offset : c.offset + (start - c.start);
        p.onClipEdit(preview.index, start, end, offset);
      }
      else if (preview?.kind === "zoom" && d.mode.startsWith("zoom")) {
        // Back to source time, leaving an end that wasn't dragged where it was.
        // An end exactly at a join belongs to the clip before it.
        const start = d.mode === "zoom-right" ? d.span[0] : cutToSource(p.ranges, preview.a).source;
        const end = d.mode === "zoom-left" ? d.span[1] : cutToSource(p.ranges, Math.max(0, preview.b - 1e-4)).source + 1e-4;
        p.onZoomEdit(preview.index, start, end);
      }
      setPreview(null);
    };
    // Select a clip, then ⌫ deletes it. Runs before the app's own keys.
    const key = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (pause === null || typing || (e.key !== "Backspace" && e.key !== "Delete")) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      p.onCutPause(pause.start, pause.end);
      setPause(null);
    };
    const down = (e: MouseEvent) => {
      if (e.target === canvas.current) return;
      setPause(null);
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
          if (h && (h.mode === "made-left" || h.mode === "made-right" || h.mode === "made-move")) {
            const { index, a, b } = h.made;
            drag.current = { mode: h.mode, index, a, b, x: e.clientX };
            p.onSelectEffect({ kind: "clip", index });
            setPreview({ kind: "made", index, a, b });
            return;
          }
          if (h && (h.mode === "zoom-left" || h.mode === "zoom-right" || h.mode === "zoom-move")) {
            const { index, a, b, z } = h.block;
            drag.current = { mode: h.mode, index, a, b, x: e.clientX, span: zoomSpan(p.words, z) };
            p.onSelectEffect({ kind: "zoom", index });
            setPreview({ kind: "zoom", index, a, b });
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
          e.currentTarget.style.cursor = !h || h.mode === "clip" ? "default" : h.mode.endsWith("move") ? "grab" : "ew-resize";
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
