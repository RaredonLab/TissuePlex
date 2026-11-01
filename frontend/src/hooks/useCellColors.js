import { useState, useEffect } from "react";
import { valueToColor, QUAL_PALETTE, fadeAlpha } from "../utils/colormap";
import { geneColor } from "../utils/geneColor";

const EMPTY = {
  colorValues: null, type: "continuous", vmin: 0, vmax: 0,
  categories: [], categoryColors: new Map(),
};

/**
 * Maps per-cell colour values to RGBA.
 *
 * This hook no longer fetches. It used to POST /color-values and receive one
 * value for *every cell in the dataset* — on a million-cell run, tens of MB,
 * a Map with a million entries held for as long as the colouring was on, and
 * a full pass over it on every clamp or palette change. The values now arrive
 * with the cell boundaries (`useCellBoundaries` passes the colour spec along
 * and the backend attaches `colors` for exactly the cells in the response), so
 * there is never a value for a cell that is not on screen, and polygons and
 * their colours land in the same render.
 *
 * `raw` is that `colors` object: { type, values, min, max, categories, empty }.
 * `min` / `max` / `categories` describe the whole dataset, so the legend and the
 * linked colour scale keep their meaning across panels.
 *
 *   Effect 1 — continuous: apply clamp + palette (synchronous, no debounce, so
 *              slider drags update the canvas in the same render cycle).
 *   Effect 2 — categorical: assign QUAL_PALETTE colours, honouring overrides.
 *
 * Returns:
 *   colorValues   Map<cell_id, [r,g,b,a]> or null when disabled
 *   type          "continuous" | "categorical"
 *   vmin, vmax    for continuous legend
 *   categories    string[] for categorical legend
 *   categoryColors Map<label, [r,g,b,a]> for categorical legend
 *   loading       always false — the boundaries fetch carries the loading state
 */
export function useCellColors(raw, colorBy, palette, enabled, clamp, categoryColorOverrides, fadeFrac = null) {
  const [result, setResult] = useState(EMPTY);

  useEffect(() => {
    if (!enabled || !colorBy || colorBy.mode === "off" || !raw || !raw.values) {
      setResult(EMPTY);
      return;
    }
    if (raw.type === "categorical") {
      const categories = raw.categories ?? [];
      const field = colorBy?.field;
      const colorMap = new Map(
        categories.map((cat, i) => {
          const key = `${field}::${cat}`;
          const override = categoryColorOverrides?.[key];
          return [cat, override ?? (i < QUAL_PALETTE.length ? QUAL_PALETTE[i] : [...geneColor(cat), 255])];
        })
      );
      const cellColors = new Map(
        Object.entries(raw.values).map(([id, label]) => [id, colorMap.get(label) ?? [128, 128, 128, 255]])
      );
      setResult({ colorValues: cellColors, type: "categorical", vmin: 0, vmax: 0, categories, categoryColors: colorMap });
      return;
    }
    const min = raw.min ?? 0, max = raw.max ?? 0;
    const lo = clamp?.low  ?? min;
    const hi = clamp?.high ?? max;
    // Fade applies to gene-set colouring only (see colormap.fadeAlpha); the
    // alpha channel carries it and Viewer scales its base fill alpha by it.
    const span = hi - lo;
    const fade = fadeFrac != null && colorBy.mode === "gene_set";
    const colorMap = new Map(
      Object.entries(raw.values).map(([id, v]) => {
        const c = valueToColor(v, lo, hi, palette);
        const a = fade ? fadeAlpha(span > 0 ? (v - lo) / span : 1, fadeFrac) : 255;
        return [id, [c[0], c[1], c[2], a]];
      })
    );
    setResult({ colorValues: colorMap, type: "continuous", vmin: min, vmax: max, categories: [], categoryColors: new Map() });
  }, [raw, enabled, colorBy?.mode, colorBy?.field, clamp?.low, clamp?.high, palette, categoryColorOverrides, fadeFrac]); // eslint-disable-line

  return { ...result, loading: false };
}
