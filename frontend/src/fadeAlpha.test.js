/**
 * The fade-by-value mapping (utils/colormap.fadeAlpha), behind the draggable
 * opacity minimum on value-coloured layers. Pinned because the whole feature
 * is "nothing changes unless you drag the minimum down", and that invariant is
 * what makes it safe to ship on by default.
 */
import { describe, it, expect } from "vitest";
import { fadeAlpha } from "./utils/colormap";

describe("fadeAlpha", () => {
  it("is 255 everywhere when the minimum sits at the maximum (no fade)", () => {
    for (const t of [0, 0.25, 0.5, 1]) expect(fadeAlpha(t, 1)).toBe(255);
    for (const t of [0, 0.5, 1]) expect(fadeAlpha(t, null)).toBe(255);
  });

  it("runs linearly from the minimum fraction to full", () => {
    expect(fadeAlpha(0, 0.2)).toBe(51);      // 0.2 * 255
    expect(fadeAlpha(1, 0.2)).toBe(255);
    expect(fadeAlpha(0.5, 0.2)).toBe(153);   // 0.6 * 255
    expect(fadeAlpha(0, 0)).toBe(0);
  });

  it("clamps the position into the colour window and tolerates bad input", () => {
    expect(fadeAlpha(-3, 0.2)).toBe(51);
    expect(fadeAlpha(7, 0.2)).toBe(255);
    expect(fadeAlpha(NaN, 0.2)).toBe(51);
    expect(fadeAlpha(0.5, 2)).toBe(255);     // a minimum above the maximum is no fade
  });
});
