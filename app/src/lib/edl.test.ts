import { describe, expect, it } from "vitest";
import {
  acceptAll,
  cutKinds,
  cutToSource,
  cutWords,
  fromDecisions,
  keptRanges,
  keptSet,
  restoreWords,
  setAgentStatus,
  sourceToCut,
  wordAt,
  addZoom,
  removeZooms,
  segments,
  captionCues,
  cueAt,
  liveZooms,
  pendingCount,
  setZoomStatus,
  applyTrims,
  removeZoom,
  setZoomLook,
  zoomBox,
  zoomPointFor,
  blocks,
  clearTrims,
  deleteClip,
  editRanges,
  setZoomTimes,
  shownKinds,
  trimClip,
  zoomSpan,
  addText,
  setText,
  removeText,
  type Edits,
  type Word,
} from "./edl";

const w = (spec: [string, number, number][]): Word[] => spec.map(([text, start, end]) => ({ text, start, end }));

// Same sample as tests/test_pipeline.py in the Python package.
const SAMPLE = w([
  ["The", 1.0, 1.2], ["rule", 1.2, 1.4], ["was", 1.4, 1.6], ["simple,", 1.6, 1.9], ["I", 1.9, 2.0], ["could", 2.0, 2.2],
  ["Um,", 3.0, 3.3],
  ["The", 4.0, 4.2], ["rule", 4.2, 4.4], ["was", 4.4, 4.6], ["simple.", 4.6, 5.0],
  ["It", 5.2, 5.3], ["goes.", 5.3, 5.7],
]);

const decisions = { cuts: [{ from: 0, to: 5, reason: "Earlier take" }, { from: 6, to: 6, reason: "Filler" }] };

describe("ranges", () => {
  it("never bleed into cut words", () => {
    const keep = new Set(SAMPLE.map((_, i) => i).filter((i) => i !== 6));
    const r = keptRanges(SAMPLE, keep, 10);
    for (const [a, b] of r) expect(a < 3.3 && b > 3.0).toBe(false);
    expect(r.some(([a, b]) => a <= 4.0 && b >= 5.7)).toBe(true);
  });

  it("close up long pauses", () => {
    const words = w([["Hello", 0.5, 1.0], ["there.", 1.0, 1.4], ["Next", 4.0, 4.4], ["bit.", 4.4, 4.8]]);
    const r = keptRanges(words, new Set([0, 1, 2, 3]), 6);
    expect(r).toHaveLength(2);
  });

  it("map between source and cut time", () => {
    const r: [number, number][] = [[1, 2], [5, 7]];
    expect(sourceToCut(r, 1.5)).toBeCloseTo(0.5);
    expect(sourceToCut(r, 3)).toBeCloseTo(1); // inside a removed bit: the next kept frame
    expect(sourceToCut(r, 6)).toBeCloseTo(2);
    expect(cutToSource(r, 0.5)).toEqual({ source: 1.5, index: 0 });
    expect(cutToSource(r, 1.5).source).toBeCloseTo(5.5);
    expect(cutToSource(r, 99)).toEqual({ source: 7, index: 1 });
  });
});

describe("edits", () => {
  it("start with Claude's cuts pending", () => {
    const e = fromDecisions(decisions);
    expect(cutKinds(SAMPLE.length, e).slice(0, 8)).toEqual([
      "agent-pending", "agent-pending", "agent-pending", "agent-pending", "agent-pending", "agent-pending", "agent-pending", null,
    ]);
    expect([...keptSet(SAMPLE.length, e)]).toEqual([7, 8, 9, 10, 11, 12]);
  });

  it("restore a whole Claude cut from any word in it", () => {
    const e = restoreWords(fromDecisions(decisions), 2, 2);
    expect(e.agent[0].status).toBe("restored");
    expect(e.agent[1].status).toBe("pending");
    expect(keptSet(SAMPLE.length, e).has(0)).toBe(true);
    expect(e.log.at(-1)?.op).toBe("restore");
  });

  it("let Luke cut and uncut his own words", () => {
    let e = fromDecisions({ cuts: [] });
    e = cutWords(e, 2, 4);
    e = cutWords(e, 5, 6);
    expect(e.user).toEqual([{ first: 2, last: 6 }]);
    e = restoreWords(e, 4, 4);
    expect(e.user).toEqual([{ first: 2, last: 3 }, { first: 5, last: 6 }]);
    expect(cutKinds(SAMPLE.length, e)[4]).toBeNull();
  });

  it("accept turns blue to grey and keeps the cut", () => {
    let e = setAgentStatus(fromDecisions(decisions), 1, "accepted");
    expect(cutKinds(SAMPLE.length, e)[6]).toBe("agent-accepted");
    e = acceptAll(e);
    expect(e.agent.every((c) => c.status === "accepted")).toBe(true);
    expect(keptSet(SAMPLE.length, e).has(6)).toBe(false);
  });
});

it("finds the word at a time", () => {
  expect(wordAt(SAMPLE, 0.5)).toBe(-1);
  expect(wordAt(SAMPLE, 1.25)).toBe(1);
  expect(wordAt(SAMPLE, 3.5)).toBe(6);
});

describe("zooms", () => {
  const base: Edits = { version: 1, agent: [], user: [], log: [] };
  it("split kept ranges where a zoom starts and ends", () => {
    const e = addZoom(base, 8, 10);
    const ranges = keptRanges(SAMPLE, keptSet(SAMPLE.length, e), 6);
    const segs = segments(ranges, SAMPLE, liveZooms(e));
    const zoomed = segs.filter((s) => s.zoom);
    expect(zoomed).toHaveLength(1);
    expect(zoomed[0].start).toBeCloseTo(4.2 - 0.08);
    expect(zoomed[0].end).toBeCloseTo(5.0 + 0.15);
    // Pieces still cover exactly the kept ranges.
    expect(segs.reduce((n, s) => n + s.end - s.start, 0)).toBeCloseTo(ranges.reduce((n, [a, b]) => n + b - a, 0));
  });
  it("adding replaces overlaps, removing keeps Claude's as removed", () => {
    let e: Edits = { ...base, zooms: [{ first: 2, last: 4, scale: 1.3, x: 0.5, y: 0.4, by: "agent", status: "pending", reason: "emphasis" }] };
    expect(pendingCount(e)).toBe(1);
    e = setZoomStatus(e, 0, "accepted");
    expect(pendingCount(e)).toBe(0);
    e = removeZooms(e, 3, 3);
    expect(e.zooms![0].status).toBe("restored");
    expect(liveZooms(e)).toHaveLength(0);
    e = addZoom(e, 0, 1);
    e = addZoom(e, 1, 2);
    expect(liveZooms(e).map((z) => [z.first, z.last])).toEqual([[1, 2]]);
  });
});

describe("captions", () => {
  it("cover the kept words in short lines that break at cuts and sentence ends", () => {
    const e = fromDecisions(decisions);
    const keep = keptSet(SAMPLE.length, e);
    const ranges = keptRanges(SAMPLE, keep, 6);
    const cues = captionCues(SAMPLE, keep, ranges);
    const lines = [...new Set(cues.map((c) => c.words.join(" ")))];
    expect(lines).toEqual(["The rule was simple.", "It goes."]);
    expect(cues).toHaveLength(6);
    expect(cueAt(cues, cues[1].start + 0.01)?.active).toBe(1);
    for (let i = 1; i < cues.length; i++) expect(cues[i].start).toBeGreaterThanOrEqual(cues[i - 1].end - 1e-9);
  });
});

describe("timeline trims", () => {
  const base: Edits = { version: 1, agent: [], user: [], log: [] };

  it("cut and keep exact stretches of source time", () => {
    expect(applyTrims([[0, 2], [3, 5]], [{ start: 1.5, end: 3.5, keep: false }], 6)).toEqual([[0, 1.5], [3.5, 5]]);
    expect(applyTrims([[0, 2], [3, 5]], [{ start: 2, end: 3, keep: true }], 6)).toEqual([[0, 5]]);
    // Later trims win.
    const trims = [{ start: 1, end: 4, keep: false }, { start: 1.5, end: 2, keep: true }];
    expect(applyTrims([[0, 5]], trims, 6)).toEqual([[0, 1], [1.5, 2], [4, 5]]);
  });

  it("trim a clip's ends in or out, delete a clip, and show it in the transcript", () => {
    const e = fromDecisions(decisions);
    const ranges = editRanges(SAMPLE, e, 6);
    expect(ranges).toHaveLength(1);
    const [a, b] = ranges[0];
    // Pull the end in past "goes." and push the start out into the pause before.
    const t = trimClip(e, ranges, 0, a - 0.5, 5.25);
    const r2 = editRanges(SAMPLE, t, 6);
    expect(r2[0][0]).toBeCloseTo(a - 0.5);
    expect(r2[r2.length - 1][1]).toBeCloseTo(5.25);
    expect(shownKinds(SAMPLE, t, r2)[12]).toBe("user"); // "goes." now reads as cut
    expect(b).toBeGreaterThan(5.25);
    // Delete the whole clip.
    const d = deleteClip(e, ranges, 0);
    expect(editRanges(SAMPLE, d, 6)).toEqual([]);
    // Restoring words in the transcript lifts trims over them.
    const back = clearTrims(d, SAMPLE[7].start - 0.08, SAMPLE[8].end + 0.15);
    expect(editRanges(SAMPLE, back, 6).length).toBeGreaterThan(0);
  });

  it("move zooms to exact times", () => {
    let e: Edits = { ...base, zooms: [{ first: 2, last: 4, scale: 1.3, x: 0.5, y: 0.4, by: "agent", status: "pending" }] };
    e = setZoomTimes(e, SAMPLE, 0, 1.33, 2.07);
    expect(zoomSpan(SAMPLE, e.zooms![0])).toEqual([1.33, 2.07]);
    expect([e.zooms![0].first, e.zooms![0].last]).toEqual([1, 5]);
    expect(e.zooms![0].status).toBe("accepted");
  });
});

describe("word blocks", () => {
  it("gives each word a block and long pauses their own", () => {
    const words = [
      { text: "good", start: 1.0, end: 1.3 },
      { text: "morning", start: 1.32, end: 1.8 },
      { text: "today", start: 2.6, end: 3.0 },
    ];
    const [lane] = blocks([[0.9, 3.15]], words);
    expect(lane.map((b) => b.word)).toEqual([0, 1, null, 2]);
    expect(lane[0].start).toBe(0.9);
    expect(lane[0].end).toBeCloseTo(1.31);
    expect(lane[2].start).toBeCloseTo(1.84);
    expect(lane[2].end).toBeCloseTo(2.56);
    expect(lane[3].end).toBe(3.15);
    for (let i = 1; i < lane.length; i++) expect(lane[i].start).toBeCloseTo(lane[i - 1].end);
  });
});

describe("effect settings", () => {
  it("changes a zoom's amount and spot, and keeps Claude's", () => {
    const e: Edits = { version: 1, agent: [], user: [], log: [], zooms: [{ first: 1, last: 2, scale: 1.3, x: 0.5, y: 0.4, by: "agent", status: "pending" }] };
    const next = setZoomLook(e, 0, { scale: 1.6, x: 0.2 });
    expect(next.zooms![0]).toMatchObject({ scale: 1.6, x: 0.2, y: 0.4, status: "accepted" });
    expect(setZoomLook(next, 0, { scale: 1.6 })).toBe(next);
    expect(removeZoom(next, 0).zooms![0].status).toBe("restored");
  });

  it("turns the framing box into a zoom point and back", () => {
    const box = zoomBox({ scale: 2, x: 0.25, y: 1 });
    expect(box).toEqual({ left: 0.125, top: 0.5, size: 0.5 });
    expect(zoomPointFor(2, box.left, box.top)).toEqual({ x: 0.25, y: 1 });
  });
});

describe("text on screen", () => {
  it("adds, edits and removes text; Claude's counts as kept once Luke edits it", () => {
    let e: Edits = { version: 1, agent: [], user: [], log: [] };
    e = addText(e, "lower-third", "Luke Lewis", 1, 4);
    expect(e.texts![0]).toMatchObject({ style: "lower-third", x: 0.06, look: "box", by: "you" });
    expect(removeText(e, 0).texts).toEqual([]);
    const c: Edits = { ...e, texts: [{ ...e.texts![0], by: "agent", status: "pending" }] };
    expect(pendingCount(c)).toBe(1);
    const edited = setText(c, 0, { text: "Luke" });
    expect(edited.texts![0]).toMatchObject({ text: "Luke", status: "accepted" });
    expect(setText(c, 0, { start: 2, end: 2 })).toBe(c);
    expect(removeText(c, 0).texts![0].status).toBe("restored");
  });
});
