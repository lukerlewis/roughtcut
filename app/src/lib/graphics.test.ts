import { describe, expect, it } from "vitest";
import { EASINGS, motionAt, moving } from "./graphics";
import { MOTION_DEFAULTS, type Motion, type TextFx } from "./edl";

describe("easings", () => {
  it("start at 0 and end at 1", () => {
    for (const [name, f] of Object.entries(EASINGS)) {
      expect(f(0), name).toBeCloseTo(0, 5);
      expect(Math.abs(f(1) - 1), name).toBeLessThan(0.006);
    }
  });
  it("overshoot and spring go a little past 1", () => {
    const peak = (f: (t: number) => number) => Math.max(...Array.from({ length: 101 }, (_, i) => f(i / 100)));
    expect(peak(EASINGS.overshoot)).toBeGreaterThan(1.05);
    expect(peak(EASINGS.spring)).toBeGreaterThan(1.05);
    expect(peak(EASINGS.smooth)).toBeLessThanOrEqual(1);
  });
});

describe("motionAt", () => {
  const m: Motion = {
    in: { type: "slide", from: "left", distance: 0.5, duration: 1, easing: "linear" },
    out: { type: "fade", duration: 1, easing: "linear" },
    stagger: 0.5,
  };
  it("slides in from the side, holds, then fades out", () => {
    expect(motionAt(m, 1, 0, 0.5, 10).dx).toBeCloseTo(-0.25);
    expect(motionAt(m, 1, 0, 5, 10)).toEqual({ alpha: 1, dx: 0, dy: 0, scale: 1 });
    expect(motionAt(m, 1, 0, 9.5, 10).alpha).toBeCloseTo(0.5);
    expect(motionAt(m, 1, 0, 10.5, 10).alpha).toBe(0);
  });
  it("staggers the second part in after the first, and out before it", () => {
    expect(motionAt(m, 2, 1, 0.25, 10).alpha).toBe(0);
    expect(motionAt(m, 2, 1, 0.75, 10).dx).toBeCloseTo(-0.375);
    expect(motionAt(m, 2, 0, 9.25, 10).alpha).toBeCloseTo(0.25);
    expect(motionAt(m, 2, 1, 9.25, 10).alpha).toBeCloseTo(0.75);
  });
  it("blurs while moving and not once in", () => {
    const b: Motion = { ...m, in: { ...m.in, blur: 8 } };
    expect(motionAt(b, 1, 0, 0.5, 10).blur).toBeCloseTo(4);
    expect(motionAt(b, 1, 0, 5, 10).blur).toBeUndefined();
  });
  it("counts the stagger in the moving time", () => {
    const t = { style: "title", text: "A", sub: "B", motion: m } as TextFx;
    expect(moving(t)).toEqual([1.5, 1.5]);
    expect(moving({ style: "callout", text: "A" } as TextFx)).toEqual([MOTION_DEFAULTS.callout.in.duration, MOTION_DEFAULTS.callout.out.duration]);
  });
});
