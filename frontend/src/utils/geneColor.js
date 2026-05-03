/**
 * Deterministic per-gene color using a hash-derived hue.
 * Returns [r, g, b] in 0–255 range.
 * Uses full saturation + fixed lightness so all genes are vivid and legible
 * on a dark background.
 */
export function geneColor(geneName) {
  let hash = 5381;
  for (let i = 0; i < geneName.length; i++) {
    hash = (Math.imul(hash, 31) + geneName.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return hslToRgb(hue, 90, 60);
}

function hslToRgb(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

/** Pre-built palette for the first N selected genes (used by the layer panel). */
export const PALETTE = [
  [255, 100, 100], [100, 200, 255], [100, 255, 150],
  [255, 200, 80],  [220, 100, 255], [80, 230, 200],
  [255, 140, 40],  [160, 255, 80],  [255, 80, 200],
  [80, 160, 255],
];
