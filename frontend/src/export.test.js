/**
 * Figure export: store scoping and PNG post-processing.
 *
 * The export rectangle is per panel for the same reason annotations are (see
 * store.annotations.test.js): its corners are image pixels of one dataset, so a
 * rectangle drawn over a 6.5 mm Visium capture area frames nothing meaningful in
 * a panel showing a 55 µm seqFISH ROI.
 *
 * The pHYs tests cover chunk surgery on bytes, which is the part that would fail
 * silently — a malformed chunk yields a file that still *looks* fine in a
 * browser preview while the journal's resolution check reads garbage.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "./store";
import { niceScaleBarUm, formatScaleLabel, withPngDpi } from "./utils/pngExport";

const S = () => useStore.getState();

// ── Store ───────────────────────────────────────────────────────────────────

const RECT = (n) => ({ corners: [[n, n], [n + 1, n], [n + 1, n + 1], [n, n + 1]], rotation: 0 });

describe("the export rectangle belongs to one panel", () => {
  beforeEach(() => S().clearAnnotations());

  it("records the panel it was drawn in", () => {
    S().setExportRect(RECT(1), 1);
    expect(S().exportRectForPanel(1)).toBeTruthy();
    expect(S().exportRectForPanel(0)).toBeNull();
  });

  it("defaults to panel 0", () => {
    S().setExportRect(RECT(2));
    expect(S().exportRectForPanel(0).panelIndex).toBe(0);
  });

  it("keeps at most one rectangle per panel, replacing the previous", () => {
    S().setExportRect(RECT(1), 0);
    S().setExportRect(RECT(5), 0);
    expect(S().exportRects.filter((r) => r.panelIndex === 0)).toHaveLength(1);
    expect(S().exportRectForPanel(0).corners[0]).toEqual([5, 5]);
  });

  it("holds one rectangle per panel independently", () => {
    S().setExportRect(RECT(1), 0);
    S().setExportRect(RECT(9), 1);
    expect(S().exportRectForPanel(0).corners[0]).toEqual([1, 1]);
    expect(S().exportRectForPanel(1).corners[0]).toEqual([9, 9]);
  });

  it("clears only the named panel", () => {
    S().setExportRect(RECT(1), 0);
    S().setExportRect(RECT(9), 1);
    S().clearExportRect(0);
    expect(S().exportRectForPanel(0)).toBeNull();
    expect(S().exportRectForPanel(1)).toBeTruthy();
  });

  it("is cleared by that panel's Clear button, and only that panel's", () => {
    S().setExportRect(RECT(1), 0);
    S().setExportRect(RECT(9), 1);
    S().clearAnnotations(0);
    expect(S().exportRectForPanel(0)).toBeNull();
    expect(S().exportRectForPanel(1)).toBeTruthy();
  });

  it("stores the rotation it was drawn at, so a later rotate cannot skew it", () => {
    S().setExportRect({ ...RECT(1), rotation: 90 }, 0);
    S().setPanelRotation(0, 30);
    expect(S().exportRectForPanel(0).rotation).toBe(90);
  });
});

// ── Scale bar rounding ──────────────────────────────────────────────────────

describe("scale bars snap to round numbers", () => {
  it("snaps to 1/2/5 x 10^n", () => {
    expect(niceScaleBarUm(214)).toBe(200);
    expect(niceScaleBarUm(1.2)).toBe(1);
    expect(niceScaleBarUm(3)).toBe(2);
    expect(niceScaleBarUm(6)).toBe(5);
    expect(niceScaleBarUm(800)).toBe(1000);
  });

  it("survives degenerate input rather than producing NaN", () => {
    expect(niceScaleBarUm(0)).toBe(1);
    expect(niceScaleBarUm(-5)).toBe(1);
    expect(niceScaleBarUm(Infinity)).toBe(1);
  });

  it("promotes to mm past 1000 µm", () => {
    expect(formatScaleLabel(200)).toBe("200 µm");
    expect(formatScaleLabel(1000)).toBe("1 mm");
    expect(formatScaleLabel(2500)).toBe("2.5 mm");
  });
});

// ── PNG pHYs surgery ────────────────────────────────────────────────────────

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function u32(v) {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}
function chunk(type, data = []) {
  return [...u32(data.length), ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
}
/** Structurally valid PNG. CRCs are not checked by the reader under test. */
function fakePng({ withPhys = false } = {}) {
  const bytes = [
    ...SIG,
    ...chunk("IHDR", new Array(13).fill(0)),
    ...(withPhys ? chunk("pHYs", new Array(9).fill(7)) : []),
    ...chunk("IDAT", [1, 2, 3]),
    ...chunk("IEND"),
  ];
  return new Blob([new Uint8Array(bytes)], { type: "image/png" });
}

async function chunkTypes(blob) {
  const b = new Uint8Array(await blob.arrayBuffer());
  const out = [];
  let pos = 8;
  while (pos + 8 <= b.length) {
    const len = (b[pos] << 24) | (b[pos + 1] << 16) | (b[pos + 2] << 8) | b[pos + 3];
    out.push(String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]));
    pos += 12 + len;
  }
  return out;
}

describe("withPngDpi", () => {
  it("inserts pHYs directly after IHDR, where the spec requires it", async () => {
    const out = await withPngDpi(fakePng(), 500);
    expect(await chunkTypes(out)).toEqual(["IHDR", "pHYs", "IDAT", "IEND"]);
  });

  it("replaces an existing pHYs rather than adding a second", async () => {
    const out = await withPngDpi(fakePng({ withPhys: true }), 500);
    const types = await chunkTypes(out);
    expect(types.filter((t) => t === "pHYs")).toHaveLength(1);
    expect(types).toEqual(["IHDR", "pHYs", "IDAT", "IEND"]);
  });

  it("writes the DPI as pixels per metre", async () => {
    const out = await withPngDpi(fakePng(), 500);
    const b = new Uint8Array(await out.arrayBuffer());
    // 8 sig + 25 IHDR chunk, then pHYs: 4 len + 4 type, then the x axis value.
    const o = 8 + 25 + 8;
    const ppm = (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
    expect(ppm).toBe(Math.round(500 / 0.0254)); // 19685
    expect(b[o + 8]).toBe(1); // unit specifier: metres
  });

  it("returns non-PNG input untouched instead of corrupting it", async () => {
    const junk = new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])]);
    expect(await withPngDpi(junk, 500)).toBe(junk);
  });

  it("is a no-op for a missing or nonsensical DPI", async () => {
    const png = fakePng();
    expect(await withPngDpi(png, 0)).toBe(png);
    expect(await withPngDpi(png, NaN)).toBe(png);
  });
});
