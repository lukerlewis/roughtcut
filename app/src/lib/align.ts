// Lines the transcript's word times up with the sound. Speech-to-text word
// timings drift by a few hundred milliseconds, so the words on the timeline
// sat beside their waveform and a word deleted there could clip its
// neighbour. This moves each word onto the speech it belongs to, using the
// loudness the timeline already draws (one value per 10ms).

import type { Word } from "./edl";

const STEP = 0.01; // seconds per loudness value
const MAX_SHIFT = 0.5; // a word never moves further than this

/** Runs of speech: loud stretches, with gaps under 80ms bridged and blips under 50ms dropped. */
export function speechRuns(peaks: Uint8Array): [number, number][] {
  const sorted = [...peaks].sort((a, b) => a - b);
  const loud = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  const threshold = Math.max(10, loud * 0.12);
  const runs: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= peaks.length; i++) {
    const on = i < peaks.length && peaks[i] > threshold;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      const last = runs[runs.length - 1];
      if (last && (start - last[1] / STEP) * STEP < 0.08) last[1] = i * STEP;
      else runs.push([start * STEP, i * STEP]);
      start = -1;
    }
  }
  return runs.filter(([a, b]) => b - a >= 0.05);
}

/** The quietest moment within ±window of t, for a boundary between two words. */
function quietest(peaks: Uint8Array, t: number, window: number, lo: number, hi: number): number {
  let best = t;
  let bestValue = Infinity;
  const from = Math.max(Math.ceil(Math.max(lo, t - window) / STEP), 0);
  const to = Math.min(Math.floor(Math.min(hi, t + window) / STEP), peaks.length - 1);
  for (let k = from; k <= to; k++) {
    // Prefer the dip closest to where the transcript put it.
    const v = peaks[k] + Math.abs(k * STEP - t) * 40;
    if (v < bestValue) [best, bestValue] = [k * STEP, v];
  }
  return best;
}

/** The words with their times moved onto the speech in `peaks`. Each word is
 *  matched to the run of speech it overlaps most (in order), each run's words
 *  are stretched to fill it, and the joins inside a run go to its quietest
 *  points. Words with no speech near them keep their times. */
export function alignWords(words: Word[], peaks: Uint8Array | null): Word[] {
  if (!peaks || peaks.length < 10 || !words.length) return words;
  const runs = speechRuns(peaks);
  if (!runs.length) return words;

  // One run per word, never going backwards.
  const runOf: number[] = new Array(words.length).fill(-1);
  let r = 0;
  words.forEach((w, i) => {
    let best = -1;
    let bestScore = -Infinity;
    for (let k = r; k < runs.length && runs[k][0] < w.end + MAX_SHIFT; k++) {
      const [a, b] = runs[k];
      if (b < w.start - MAX_SHIFT) continue;
      const overlap = Math.min(b, w.end) - Math.max(a, w.start);
      const distance = overlap > 0 ? 0 : Math.max(a - w.end, w.start - b);
      const score = overlap > 0 ? overlap : -distance;
      if (score > bestScore) [best, bestScore] = [k, score];
    }
    if (best >= 0) {
      runOf[i] = best;
      r = best;
    }
  });

  const out = words.map((w) => ({ ...w }));
  for (let i = 0; i < words.length; ) {
    const k = runOf[i];
    let j = i;
    while (j + 1 < words.length && runOf[j + 1] === k) j++;
    if (k >= 0) {
      const [a, b] = runs[k];
      const [s, e] = [words[i].start, words[j].end];
      const scale = e > s ? (b - a) / (e - s) : 1;
      const map = (t: number) => a + (t - s) * scale;
      for (let n = i; n <= j; n++) {
        out[n].start = map(words[n].start);
        out[n].end = map(words[n].end);
      }
      // Joins between words go to the nearest dip in loudness.
      for (let n = i; n < j; n++) {
        const join = (out[n].end + out[n + 1].start) / 2;
        const lo = out[n].start + 0.04;
        const hi = out[n + 1].end - 0.04;
        const t = hi > lo ? quietest(peaks, join, 0.12, lo, hi) : join;
        out[n].end = t;
        out[n + 1].start = t;
      }
      out[i].start = a;
      out[j].end = b;
      // A run that would drag a word far from where it was said was matched wrongly: leave those words be.
      for (let n = i; n <= j; n++)
        if (Math.abs(out[n].start - words[n].start) > MAX_SHIFT + 0.2 || Math.abs(out[n].end - words[n].end) > MAX_SHIFT + 0.2) {
          for (let m = i; m <= j; m++) out[m] = { ...words[m] };
          break;
        }
    }
    i = j + 1;
  }
  // Keep order and a minimum length even where the sound gave no help.
  for (let n = 0; n < out.length; n++) {
    if (n > 0 && out[n].start < out[n - 1].end) out[n].start = out[n - 1].end;
    if (out[n].end < out[n].start + 0.02) out[n].end = out[n].start + 0.02;
  }
  return out;
}
