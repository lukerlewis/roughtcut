import { Minus, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cutDuration, timecode } from "../lib/edl";

interface Props {
  ranges: [number, number][];
  peaks: Uint8Array | null; // loudness per 10ms of source
  time: number; // playhead, seconds into the cut
  playing: boolean;
  claudeJoins: number[]; // indexes of joins where Claude's unreviewed cut sits
  fps: number;
  onScrub: (t: number) => void;
  onScrubEnd?: () => void;
}

const RULER = 22;
const LANE_TOP = 30;
const LANE_H = 100;

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
  const drag = useRef(false);
  const total = cutDuration(p.ranges);

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

    // Playhead.
    const ph = x(p.time);
    g.fillStyle = css("--ink");
    g.fillRect(Math.round(ph) - 0.5, 0, 1.5, h);
    g.beginPath();
    g.moveTo(ph - 5, 0);
    g.lineTo(ph + 5, 0);
    g.lineTo(ph, 7);
    g.fill();
  }, [p.ranges, p.peaks, p.time, p.claudeJoins, zoom, scroll, pxPerSec]);

  const timeAt = (clientX: number) => {
    const c = canvas.current!;
    const r = c.getBoundingClientRect();
    const t = (zoom === 0 ? 0 : scroll) + (clientX - r.left - 12) / pxPerSec(c.clientWidth);
    return Math.max(0, Math.min(total, t));
  };

  useEffect(() => {
    const move = (e: MouseEvent) => drag.current && p.onScrub(timeAt(e.clientX));
    const up = () => {
      if (drag.current) p.onScrubEnd?.();
      drag.current = false;
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
          drag.current = true;
          p.onScrub(timeAt(e.clientX));
        }}
        onWheel={(e) => {
          if (e.ctrlKey || e.metaKey) setZoom((z) => Math.max(0, Math.min(8, z + (e.deltaY < 0 ? 1 : -1))));
          else if (zoom > 0) setScroll((s) => Math.max(0, s + (e.deltaX || e.deltaY) / pxPerSec(canvas.current!.clientWidth)));
        }}
      />
    </div>
  );
}
