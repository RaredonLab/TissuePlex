import { useState, useEffect, useRef } from "react";
import { valueToColor, QUAL_PALETTE } from "../utils/colormap";

/**
 * Fetches per-directed-edge color values from the backend.
 *
 * Modes:
 *   lrm_set  — POST with selected LRM strings; backend sums score per edge
 *   metadata — POST with field name; backend auto-detects continuous vs categorical
 *
 * Returns:
 *   colorValues   Map<edge_id, [r,g,b,a]> or null when mode is "default"
 *   type          "continuous" | "categorical"
 *   vmin, vmax    for continuous legend
 *   categories    string[] for categorical legend
 *   categoryColors Map<label, [r,g,b,a]> for categorical legend
 *   loading
 */
export function useEdgeColors(apiBase, dataset, edgeColorBy, hiddenLrms, lrmCatalogue, palette, enabled, clamp, hiCutFraction) {
  const [result, setResult] = useState({
    colorValues: null, type: "continuous", vmin: 0, vmax: 0,
    categories: [], categoryColors: new Map(),
  });
  const [loading, setLoading] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!enabled || !edgeColorBy || edgeColorBy.mode === "default") {
      setResult({ colorValues: null, type: "continuous", vmin: 0, vmax: 0, categories: [], categoryColors: new Map() });
      return;
    }

    const { mode, field } = edgeColorBy;

    // lrm_set: compute selected LRMs (all catalogue minus hidden)
    const selectedLrms = mode === "lrm_set"
      ? lrmCatalogue
          .map((e) => e.lrm ?? `${e.ligand}|${e.receptor}`)
          .filter((lrm) => !hiddenLrms.has(lrm))
      : null;

    if (mode === "lrm_set" && (!selectedLrms || selectedLrms.length === 0)) {
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
        const body = mode === "lrm_set"
          ? { mode: "lrm_set", lrms: selectedLrms }
          : { mode: "metadata", field };

        const res = await fetch(`${apiBase}/edges/${dataset}/edge-color-values`, {
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
          const edgeColors = new Map(
            Object.entries(data.values).map(([id, label]) => [id, colorMap.get(label) ?? [128, 128, 128, 255]])
          );
          setResult({ colorValues: edgeColors, type: "categorical", vmin: 0, vmax: 0, categories, categoryColors: colorMap });
        } else {
          const { min, max } = data;
          const lo = clamp?.low ?? min;
          const hi = clamp?.high ?? (hiCutFraction != null ? hiCutFraction * max : max);
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
  }, [apiBase, dataset, edgeColorBy?.mode, edgeColorBy?.field, hiddenLrms, lrmCatalogue, palette, enabled, clamp?.low, clamp?.high, hiCutFraction]);

  return { ...result, loading };
}
