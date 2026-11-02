/**
 * Multi-palette colormap utilities.
 * Each palette is defined by 5 stops: [[t, [r,g,b,a]], ...]
 */

const PALETTES = {
  viridis: [
    [0,    [68,  1,   84,  255]],
    [0.25, [59,  82,  139, 255]],
    [0.5,  [33,  145, 140, 255]],
    [0.75, [94,  201, 98,  255]],
    [1.0,  [253, 231, 37,  255]],
  ],
  plasma: [
    [0,    [13,  8,   135, 255]],
    [0.25, [126, 3,   168, 255]],
    [0.5,  [204, 71,  120, 255]],
    [0.75, [248, 149, 64,  255]],
    [1.0,  [240, 249, 33,  255]],
  ],
  magma: [
    [0,    [0,   0,   4,   255]],
    [0.25, [81,  18,  124, 255]],
    [0.5,  [183, 55,  121, 255]],
    [0.75, [252, 140, 99,  255]],
    [1.0,  [252, 253, 191, 255]],
  ],
  inferno: [
    [0,    [0,   0,   4,   255]],
    [0.25, [87,  16,  110, 255]],
    [0.5,  [188, 55,  84,  255]],
    [0.75, [249, 142, 9,   255]],
    [1.0,  [252, 255, 164, 255]],
  ],
};

// Qualitative palette for categorical data (20 visually distinct colors)
export const QUAL_PALETTE = [
  [76,  114, 176, 255],
  [221, 132, 82,  255],
  [85,  168, 104, 255],
  [196, 78,  82,  255],
  [129, 114, 179, 255],
  [147, 120, 96,  255],
  [218, 139, 195, 255],
  [140, 140, 140, 255],
  [204, 185, 116, 255],
  [100, 181, 205, 255],
  [255, 187, 120, 255],
  [152, 223, 138, 255],
  [255, 152, 150, 255],
  [197, 176, 213, 255],
  [196, 156, 148, 255],
  [247, 182, 210, 255],
  [199, 199, 199, 255],
  [219, 219, 141, 255],
  [158, 218, 229, 255],
  [57,  59,  121,  255],
];

function interpolateStops(stops, t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) {
    const [t0, c0] = stops[i - 1];
    const [t1, c1] = stops[i];
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0);
      return c0.map((v, j) => Math.round(v + f * (c1[j] - v)));
    }
  }
  return stops[stops.length - 1][1];
}

export function scalarToColor(t, palette = "viridis") {
  return interpolateStops(PALETTES[palette] ?? PALETTES.viridis, t);
}

export function valueToColor(value, vmin, vmax, palette = "viridis") {
  if (vmax <= vmin) return scalarToColor(0, palette);
  return scalarToColor((value - vmin) / (vmax - vmin), palette);
}

/**
 * Alpha (0–255) for a value at normalised position `t` in the colour window,
 * when the layer's opacity has a draggable minimum: the lowest value draws at
 * `minFrac` of the layer's opacity, the highest at the full opacity, linearly
 * between. `minFrac` is opacityMin / opacity, so with the minimum at the
 * maximum every value gets 255 and the layer looks exactly as it did before
 * the minimum existed. The layer's `opacity` prop still multiplies the result,
 * which is what makes the existing slider the ceiling.
 */
/**
 * The colour window for a set of drawn values.
 *
 * "full"   → [min, max] of the values: the legend's ends are the data's ends.
 * "robust" → [5th, 95th percentile]: the ends are where the bulk of the data
 *            stops, so a thin tail cannot own most of the palette. Values past
 *            the ends saturate. With fewer than 20 values there is no bulk to
 *            speak of and the full range is used.
 * Both are "auto": they follow what is drawn. Returns min/max alongside lo/hi
 * so a legend can show the window against the data.
 */
export function rangeOf(values, mode = "full") {
  let min = Infinity, max = -Infinity, n = 0;
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; n++; }
  if (!n) return { min: 0, max: 0, lo: 0, hi: 0 };
  if (mode !== "robust" || n < 20) return { min, max, lo: min, hi: max };
  const sorted = Float64Array.from(values).sort();
  const q = (p) => sorted[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
  return { min, max, lo: q(0.05), hi: q(0.95) };
}

export function fadeAlpha(t, minFrac) {
  const f = Math.max(0, Math.min(1, minFrac ?? 1));
  const u = Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0;
  return Math.round(255 * (f + (1 - f) * u));
}

export function legendGradient(palette = "viridis") {
  const stops = (PALETTES[palette] ?? PALETTES.viridis)
    .map(([t, [r, g, b]]) => `rgb(${r},${g},${b}) ${Math.round(t * 100)}%`)
    .join(", ");
  return `linear-gradient(to right, ${stops})`;
}

export const PALETTE_NAMES = Object.keys(PALETTES);
