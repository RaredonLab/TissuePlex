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

export function legendGradient(palette = "viridis") {
  const stops = (PALETTES[palette] ?? PALETTES.viridis)
    .map(([t, [r, g, b]]) => `rgb(${r},${g},${b}) ${Math.round(t * 100)}%`)
    .join(", ");
  return `linear-gradient(to right, ${stops})`;
}

export const PALETTE_NAMES = Object.keys(PALETTES);
