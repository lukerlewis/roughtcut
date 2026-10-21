import type { CaptionStyle, Cue } from "./edl";

/** Caption images for the export, drawn to match the preview's styles. */
export interface CaptionStrips {
  top: number; // where each strip starts, as a fraction of the frame height
  blank: string; // base64 PNGs
  frames: { start: number; end: number; png: string }[];
}

const TOP = 0.55;
const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';

/** Draws each cue as a transparent strip across the bottom of a width x
 *  height frame: the same sizes, positions and colours as `.caption` in
 *  styles.css, in pixels of the frame. */
export function captionStrips(cues: Cue[], style: CaptionStyle, width: number, height: number): CaptionStrips {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = Math.round(height * (1 - TOP));
  const g = c.getContext("2d")!;
  const png = () => c.toDataURL("image/png").split(",")[1];
  const top = height * TOP;
  const bold = style === "bold";
  const size = height * (bold ? 0.065 : 0.045);
  const lineH = size * 1.2;
  const bottom = height * (1 - (bold ? 0.12 : 0.07)) - top;
  const pad = [height * 0.004, height * 0.012];

  g.clearRect(0, 0, c.width, c.height);
  const blank = png();
  const frames = cues.map((cue) => {
    g.clearRect(0, 0, c.width, c.height);
    g.font = `${bold ? 700 : 500} ${size}px ${FONT}`;
    g.textBaseline = "middle";
    const words = cue.words.map((w) => (bold ? w.toUpperCase() : w));
    const space = g.measureText(" ").width;
    // Wrap to the caption box: 88% of the width.
    const lines: number[][] = [[]];
    let w = 0;
    words.forEach((word, i) => {
      const ww = g.measureText(word).width;
      const line = lines[lines.length - 1];
      if (line.length && w + space + ww > width * 0.88) {
        lines.push([i]);
        w = ww;
      } else {
        line.push(i);
        w += (line.length > 1 ? space : 0) + ww;
      }
    });
    lines.forEach((line, li) => {
      const widths = line.map((i) => g.measureText(words[i]).width);
      const total = widths.reduce((a, b) => a + b, 0) + space * (line.length - 1);
      const y = bottom - (lines.length - li - 0.5) * lineH;
      let x = (width - total) / 2;
      if (!bold) {
        g.fillStyle = "rgba(0, 0, 0, 0.5)";
        g.beginPath();
        g.roundRect(x - pad[1], y - lineH / 2 - pad[0], total + pad[1] * 2, lineH + pad[0] * 2, height * 0.008);
        g.fill();
      }
      line.forEach((i, k) => {
        if (bold) {
          g.lineJoin = "round";
          g.lineWidth = height * 0.006;
          g.strokeStyle = "#000";
          g.strokeText(words[i], x, y);
        }
        g.fillStyle = bold && i === cue.active ? "#ffd60a" : "#fff";
        g.fillText(words[i], x, y);
        x += widths[k] + space;
      });
    });
    return { start: cue.start, end: cue.end, png: png() };
  });
  return { top: TOP, blank, frames };
}
