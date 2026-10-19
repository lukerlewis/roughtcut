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
