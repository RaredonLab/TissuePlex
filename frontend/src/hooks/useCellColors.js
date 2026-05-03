import { useState, useEffect, useRef } from "react";
import { valueToColor, QUAL_PALETTE } from "../utils/colormap";

/**
 * Fetches per-cell color values and maps them to RGBA.
 *
 * Modes:
 *   gene_set  — POST with selected genes; returns continuous sum
 *   metadata  — POST with field; backend auto-detects continuous vs. categorical
 *
 * Returns:
 *   colorValues   Map<cell_id, [r,g,b,a]> or null when disabled
 *   type          "continuous" | "categorical"
 *   vmin, vmax    for continuous legend
 *   categories    string[] for categorical legend
 *   categoryColors Map<label, [r,g,b,a]> for categorical legend
 *   loading
 */
export function useCellColors(apiBase, dataset, colorBy, allGenes, hiddenGenes, palette, enabled, clamp) {
  const [result, setResult] = useState({
    colorValues: null, type: "continuous", vmin: 0, vmax: 0,
    categories: [], categoryColors: new Map(),
  });
  const [loading, setLoading] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!enabled || !colorBy || colorBy.mode === "off") {
      setResult({ colorValues: null, type: "continuous", vmin: 0, vmax: 0, categories: [], categoryColors: new Map() });
      return;
    }

    const { mode, field } = colorBy;

    // gene_set requires at least one selected gene
    const selectedGenes = mode === "gene_set"
      ? allGenes.filter((g) => !hiddenGenes.has(g))
      : null;
    if (mode === "gene_set" && (!selectedGenes || selectedGenes.length === 0)) {
      setResult({ colorValues: null, type: "continuous", vmin: 0, vmax: 0, categories: [], categoryColors: new Map() });
      return;
    }
    if (mode === "metadata" && !field) {
      setResult({ colorValues: null, type: "continuous", vmin: 0, vmax: 0, categories: [], categoryColors: new Map() });
      return;
    }

    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const body = mode === "gene_set"
          ? { mode: "gene_set", genes: selectedGenes }
          : { mode: "metadata", field };

        const res = await fetch(`${apiBase}/xenium/${dataset}/color-values`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        if (data.type === "categorical") {
          const { categories } = data;
          const colorMap = new Map(
            categories.map((cat, i) => [cat, QUAL_PALETTE[i % QUAL_PALETTE.length]])
          );
          const cellColors = new Map(
            Object.entries(data.values).map(([id, label]) => [id, colorMap.get(label) ?? [128, 128, 128, 255]])
          );
          setResult({ colorValues: cellColors, type: "categorical", vmin: 0, vmax: 0, categories, categoryColors: colorMap });
        } else {
          const { min, max } = data;
          const lo = clamp?.low ?? min;
          const hi = clamp?.high ?? max;
          const colorMap = new Map(
            Object.entries(data.values).map(([id, v]) => [id, valueToColor(v, lo, hi, palette)])
          );
          setResult({ colorValues: colorMap, type: "continuous", vmin: min, vmax: max, categories: [], categoryColors: new Map() });
        }
      } catch {
        setResult({ colorValues: null, type: "continuous", vmin: 0, vmax: 0, categories: [], categoryColors: new Map() });
      } finally {
        setLoading(false);
      }
    }, 150);
    return () => clearTimeout(timerRef.current);
  }, [apiBase, dataset, colorBy?.mode, colorBy?.field, allGenes, hiddenGenes, palette, enabled, clamp?.low, clamp?.high]);

  return { ...result, loading };
}
