import { describe, expect, it } from "vitest";
import { alignWords, speechRuns } from "./align";

/** Loudness at 100 per second: loud over each [start, end), quiet elsewhere. */
function loudness(spans: [number, number][], seconds: number, dips: number[] = []) {
  const p = new Uint8Array(seconds * 100).fill(2);
  for (const [a, b] of spans) for (let k = Math.round(a * 100); k < Math.round(b * 100); k++) p[k] = 160;
  for (const t of dips) for (let k = Math.round(t * 100) - 1; k <= Math.round(t * 100) + 1; k++) p[k] = 40;
  return p;
}

describe("aligning words to the sound", () => {
  it("finds runs of speech", () => {
    expect(speechRuns(loudness([[1, 2], [2.05, 2.5], [4, 4.02], [5, 6]], 8))).toEqual([
      [1, 2.5],
      [5, 6],
    ]);
  });

  it("moves late words onto their speech and splits at the dips", () => {
    // "every" 1.0-1.5 and "time" 2.0-2.4, with a pause between, but the transcript is 0.25s late.
    // "good morning" 4.0-4.8 runs together with a dip at 4.35.
    const peaks = loudness([[1, 1.5], [2, 2.4], [4, 4.8]], 6, [4.35]);
    const words = [
      { text: "every", start: 1.25, end: 1.8 },
      { text: "time.", start: 2.25, end: 2.6 },
      { text: "good", start: 4.2, end: 4.5 },
      { text: "morning", start: 4.5, end: 5.0 },
    ];
    const out = alignWords(words, peaks);
    const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(0.03);
    near(out[0].start, 1);
    near(out[0].end, 1.5);
    near(out[1].start, 2);
    near(out[1].end, 2.4);
    near(out[2].start, 4);
    near(out[2].end, 4.35);
    near(out[3].start, 4.35);
    near(out[3].end, 4.8);
  });

  it("leaves the words alone without sound to go on", () => {
    const words = [{ text: "hi", start: 1, end: 1.2 }];
    expect(alignWords(words, null)).toBe(words);
    expect(alignWords(words, new Uint8Array(600))).toBe(words);
  });
});
