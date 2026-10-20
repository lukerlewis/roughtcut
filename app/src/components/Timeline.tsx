import { Minus, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cutDuration, cutToSource, sourceToCut, timecode, wordAt, zoomSpan, type Word, type Zoom } from "../lib/edl";

interface Props {
  ranges: [number, number][];
  peaks: Uint8Array | null; // loudness per 10ms of source
  time: number; // playhead, seconds into the cut
  playing: boolean;
  claudeJoins: number[]; // indexes of joins where Claude's unreviewed cut sits
  fps: number;
  words: Word[];
  zooms: Zoom[]; // all of them; removed ones are skipped
  onZoomEdit: (index: number, first: number, last: number) => void;
  onScrub: (t: number) => void;
  onScrubEnd?: () => void;
}

const RULER = 22;
const ZOOM_TOP = 28; // the effects track, above the clips
const ZOOM_H = 18;
const LANE_TOP = 52;
const LANE_H = 100;
const EDGE = 6; // px from a block's end that grabs its edge

type Drag = { mode: "scrub" } | { mode: "left" | "right" | "move"; index: number; first: number; last: number; grabT: number };

function css(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Mix a hex colour over another at `amount` (0..1), like CSS color-mix. */
function mix(hex: string, over: string, amount: number) {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [a, b] = [p(hex), p(over)];
  return `rgb(${a.map((v, i) => Math.round(v * amount + b[i] * (1 - amount))).join(",")})`;
}

export function Timeline(p: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState(0); // 0 = fit the whole cut
  const [scroll, setScroll] = useState(0); // seconds at the left edge
  const drag = useRef<Drag | null>(null);
  const [moving, setMoving] = useState<{ index: number; first: number; last: number } | null>(null);
  const total = cutDuration(p.ranges);

  // Each live zoom as a block in cut time, with the edit in progress applied.
  const blocks = p.zooms.flatMap((z, index) => {
    if (z.status === "restored") return [];
    const m = moving?.index === index ? { ...z, first: moving.first, last: moving.last } : z;
    const [a, b] = zoomSpan(p.words, m);
    return [{ index, z: m, a: sourceToCut(p.ranges, a), b: sourceToCut(p.ranges, b) }];
  });

  const pxPerSec = useCallback(
    (width: number) => {
      const fit = (width - 24) / Math.max(total, 1);
      return fit * Math.pow(2, zoom);
    },
    [total, zoom],
  );

  // Keep the playhead on screen while playing.
  useEffect(() => {
    const c = canvas.current;
    if (!c || zoom === 0) return;
    const pps = pxPerSec(c.clientWidth);
    const visible = (c.clientWidth - 24) / pps;
    if (p.time < scroll || p.time > scroll + visible * 0.9) setScroll(Math.max(0, p.time - visible * 0.1));
  }, [p.time, zoom, pxPerSec, scroll]);

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
    const left = zoom === 0 ? 0 : scroll;
    const x = (t: number) => 12 + (t - left) * pps;
    const tint = parseFloat(css("--lane-tint")) / 100;
    const voiceHex = css("--lane-voice");
    const videoHex = css("--lane-video");
    const isHex = (s: string) => /^#[0-9a-f]{6}$/i.test(s);
    const clipFill = isHex(bg) && isHex(videoHex) ? mix(videoHex, bg, tint) : "#333";
    const waveFill = isHex(bg) && isHex(voiceHex) ? mix(voiceHex, bg, Math.min(1, tint * 1.8)) : "#3a5";

    // Ruler.
    g.fillStyle = css("--muted-foreground");
    g.font = `11px ${css("--mono") || "monospace"}`;
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const step = steps.find((s) => s * pps >= 70) ?? 1200;
    g.strokeStyle = css("--stroke");
    g.lineWidth = 1;
    for (let t = Math.floor(left / step) * step; x(t) < w; t += step) {
      if (t < 0) continue;
      g.beginPath();
      g.moveTo(Math.round(x(t)) + 0.5, RULER - 6);
      g.lineTo(Math.round(x(t)) + 0.5, RULER);
      g.stroke();
      g.fillText(timecode(t), x(t) + 3, 13);
    }
    g.beginPath();
    g.moveTo(0, RULER + 0.5);
    g.lineTo(w, RULER + 0.5);
    g.strokeStyle = css("--border");
    g.stroke();

    // Clips laid end to end, each with its slice of the waveform.
    let acc = 0;
    p.ranges.forEach(([a, b], i) => {
      const x0 = x(acc);
      const x1 = x(acc + (b - a));
      acc += b - a;
      if (x1 < 0 || x0 > w) return;
      const cw = Math.max(1, x1 - x0 - 1);
      g.fillStyle = clipFill;
      g.beginPath();
      g.roundRect(x0, LANE_TOP, cw, LANE_H, 4);
      g.fill();
      if (p.peaks) {
        g.fillStyle = waveFill;
        const mid = LANE_TOP + LANE_H * 0.62;
        const amp = LANE_H * 0.34;
        for (let px = Math.max(0, Math.floor(x0)); px < Math.min(w, x1 - 1); px++) {
          const s0 = a + (px - x0) / pps;
          const s1 = a + (px + 1 - x0) / pps;
          let peak = 0;
          for (let k = Math.floor(s0 * 100); k <= Math.floor(s1 * 100) && k < p.peaks.length; k++) peak = Math.max(peak, p.peaks[k]);
          const hgt = (peak / 255) * amp;
          g.fillRect(px, mid - hgt, 1, hgt * 2);
        }
      }
      g.fillStyle = css("--muted-foreground");
      if (cw > 60) g.fillText(timecode(a), x0 + 6, LANE_TOP + 14);
      // Claude's unreviewed cut sits at the start of this clip: mark the join blue.
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
    g.font = `500 10px ${css("--mono") || "monospace"}`;
    for (const { z, a, b } of blocks) {
      const x0 = x(a);
      const x1 = x(b);
      if (x1 < 0 || x0 > w) continue;
      const pending = z.status === "pending";
      g.fillStyle = pending ? css("--unread") : css("--stroke-strong");
      g.beginPath();
      g.roundRect(x0, ZOOM_TOP, Math.max(4, x1 - x0 - 1), ZOOM_H, 4);
      g.fill();
      g.fillStyle = pending ? "#fff" : css("--foreground");
      g.fillRect(x0 + 2, ZOOM_TOP + 5, 2, ZOOM_H - 10);
      g.fillRect(x1 - 5, ZOOM_TOP + 5, 2, ZOOM_H - 10);
      if (x1 - x0 > 60) g.fillText(`Zoom ${Math.round(z.scale * 100)}%`, x0 + 9, ZOOM_TOP + 12.5);
    }
    g.font = `11px ${css("--mono") || "monospace"}`;

    // Playhead.
    const ph = x(p.time);
    g.fillStyle = css("--ink");
    g.fillRect(Math.round(ph) - 0.5, 0, 1.5, h);
    g.beginPath();
    g.moveTo(ph - 5, 0);
    g.lineTo(ph + 5, 0);
    g.lineTo(ph, 7);
    g.fill();
  }, [p.ranges, p.peaks, p.time, p.claudeJoins, zoom, scroll, pxPerSec, blocks]);

  const timeAt = (clientX: number) => {
    const c = canvas.current!;
    const r = c.getBoundingClientRect();
    const t = (zoom === 0 ? 0 : scroll) + (clientX - r.left - 12) / pxPerSec(c.clientWidth);
    return Math.max(0, Math.min(total, t));
  };

  /** What's under the pointer on the effects track: a block's edge or body. */
  const hit = (clientX: number, clientY: number) => {
    const c = canvas.current!;
    const r = c.getBoundingClientRect();
    const y = clientY - r.top;
    if (y < ZOOM_TOP - 2 || y > ZOOM_TOP + ZOOM_H + 2) return null;
    const pps = pxPerSec(c.clientWidth);
    const px = (t: number) => r.left + 12 + (t - (zoom === 0 ? 0 : scroll)) * pps;
    for (const bl of blocks) {
      const [x0, x1] = [px(bl.a), px(bl.b)];
      if (clientX < x0 - EDGE || clientX > x1 + EDGE) continue;
      const mode = Math.abs(clientX - x0) <= EDGE ? "left" : Math.abs(clientX - x1) <= EDGE ? "right" : "move";
      return { mode, block: bl } as const;
    }
    return null;
  };

  // A word boundary near cut time t: the start of a word for a left edge, the end of one for a right edge.
  const snap = (t: number, edge: "start" | "end") => {
    const src = cutToSource(p.ranges, t).source;
    let i = Math.max(0, wordAt(p.words, src));
    if (edge === "start" && i + 1 < p.words.length && Math.abs(p.words[i + 1].start - src) < Math.abs(p.words[i].start - src)) i++;
    if (edge === "end" && i > 0 && Math.abs(p.words[i - 1].end - src) < Math.abs(p.words[i].end - src)) i--;
    return i;
  };

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      if (d.mode === "scrub") return p.onScrub(timeAt(e.clientX));
      const t = timeAt(e.clientX);
      if (d.mode === "left") setMoving({ index: d.index, first: Math.min(snap(t, "start"), d.last), last: d.last });
      else if (d.mode === "right") setMoving({ index: d.index, first: d.first, last: Math.max(snap(t, "end"), d.first) });
      else {
        const len = d.last - d.first;
        const startSrc = cutToSource(p.ranges, sourceToCut(p.ranges, p.words[d.first].start) + (t - d.grabT)).source;
        const first = Math.max(0, Math.min(p.words.length - 1 - len, wordAt(p.words, startSrc + 0.01)));
        setMoving({ index: d.index, first, last: first + len });
      }
    };
    const up = () => {
      const d = drag.current;
      drag.current = null;
      if (!d) return;
      if (d.mode === "scrub") p.onScrubEnd?.();
      else if (moving) p.onZoomEdit(moving.index, moving.first, moving.last);
      setMoving(null);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
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
        <button className="btn icon ghost" title="Zoom out" onClick={() => setZoom((z) => Math.max(0, z - 1))}>
          <Minus size={16} />
        </button>
        <button className="btn icon ghost" title="Zoom in" onClick={() => setZoom((z) => Math.min(8, z + 1))}>
          <Plus size={16} />
        </button>
      </div>
      <canvas
        ref={canvas}
        onMouseDown={(e) => {
          const h = hit(e.clientX, e.clientY);
          if (h) {
            const { index, z } = h.block;
            drag.current = { mode: h.mode, index, first: z.first, last: z.last, grabT: timeAt(e.clientX) };
            setMoving({ index, first: z.first, last: z.last });
            return;
          }
          drag.current = { mode: "scrub" };
          p.onScrub(timeAt(e.clientX));
        }}
        onMouseMove={(e) => {
          if (drag.current) return;
          const h = hit(e.clientX, e.clientY);
          e.currentTarget.style.cursor = !h ? "default" : h.mode === "move" ? "grab" : "ew-resize";
        }}
        onWheel={(e) => {
          if (e.ctrlKey || e.metaKey) setZoom((z) => Math.max(0, Math.min(8, z + (e.deltaY < 0 ? 1 : -1))));
          else if (zoom > 0) setScroll((s) => Math.max(0, s + (e.deltaX || e.deltaY) / pxPerSec(canvas.current!.clientWidth)));
        }}
      />
    </div>
  );
}
