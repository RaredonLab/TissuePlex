/**
 * The auto colour window (utils/colormap.rangeOf). "full" is the data's ends;
 * "robust" is the 5th–95th percentile so a thin tail cannot own the palette.
 * Both describe what is drawn, which is what makes the legend honest.
 */
import { describe, it, expect } from "vitest";
import { rangeOf } from "./utils/colormap";

describe("rangeOf", () => {
  it("full mode is min..max", () => {
    expect(rangeOf([3, 1, 2], "full")).toEqual({ min: 1, max: 3, lo: 1, hi: 3 });
  });
  it("robust mode trims the tails to the 5th and 95th percentiles", () => {
    const v = Array.from({ length: 101 }, (_, i) => i);   // 0..100
    const r = rangeOf(v, "robust");
    expect([r.min, r.max]).toEqual([0, 100]);
    expect(r.lo).toBe(5);
    expect(r.hi).toBe(95);
  });
  it("robust mode falls back to the full range below 20 values", () => {
    expect(rangeOf([0, 50, 100], "robust")).toEqual({ min: 0, max: 100, lo: 0, hi: 100 });
  });
  it("is empty-safe", () => {
    expect(rangeOf([], "full")).toEqual({ min: 0, max: 0, lo: 0, hi: 0 });
  });
  it("accepts typed arrays", () => {
    expect(rangeOf(Float64Array.from([2, 4]), "full")).toEqual({ min: 2, max: 4, lo: 2, hi: 4 });
  });
});
