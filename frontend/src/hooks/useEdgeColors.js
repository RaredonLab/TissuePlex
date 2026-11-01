import { useState, useEffect, useMemo, useRef } from "react";
import { valueToColor, QUAL_PALETTE, fadeAlpha } from "../utils/colormap";
import { loggedFetch } from "../utils/clientLog";

const EMPTY = {
  colorValues: null, type: "continuous", vmin: 0, vmax: 0, p95: null,
  categories: [], categoryColors: new Map(),
};

/**
 * Computes per-directed-edge color values.
 *
 * Both modes are now computed in the browser from the edge rows already in
 * memory, so neither a colour change nor a pan makes a colour request:
 *
 * lrm_set mode: from `visible_score_sum` on each row.
 *
 * metadata mode: from `color_value` on each row. `useEdges` asks the structural
 *   query to carry the chosen column (`color_field`), so the value arrives with
 *   the edge instead of as a separate whole-file GROUP BY that returned a value
 *   for every edge in the dataset. What *is* fetched, once per column, is a
 *   summary — type, categories, min / max / p95 over the whole dataset — so the
 *   legend and the linked colour scale describe the dataset, not the viewport.
 *
 * Clamp and palette changes update the canvas immediately in both modes.
 *
 * Returns:
 *   colorValues   Map<edge_id, [r,g,b,a]> or null when mode is "default"
 *   type          "continuous" | "categorical"
 *   vmin, vmax    for continuous legend
 *   p95           95th-percentile value (used for auto-calibration)
 *   categories    string[] for categorical legend
 *   categoryColors Map<label, [r,g,b,a]> for categorical legend
 *   loading
 */
export function useEdgeColors(
  apiBase, dataset, edgeColorBy, hiddenLrms, lrmCatalogue,
  palette, enabled, clamp,
  edges,  // array from useEdges — carries visible_score_sum / color_value per row
  edgeFile = "edges.parquet",
  categorical = null,  // issue #35 override: null = auto-detect, true/false = forced
  fadeFrac = null      // opacityMin / opacity for lrm_set, or null for no fade
) {
  const efParam = `?edge_file=${encodeURIComponent(edgeFile)}`;
  const mode = edgeColorBy?.mode;
  const field = edgeColorBy?.field;

  // ── lrm_set: compute synchronously from edges.visible_score_sum ──────────
  //
  // Autocrine edges are included. They used to be filtered out here, which left
  // the autocrine rings permanently on their default orange no matter what the
  // colour control said — the one edge type that ignored "colour by LRM set".
  // A shared scale is safe: measured across the bundled datasets, autocrine
  // score_sum medians run 1.00–1.33× the directed medians, so they neither
  // dominate the range nor need a scale of their own. One scale, one legend,
  // and every edge on screen is described by it.
  const lrmSetResult = useMemo(() => {
    if (!enabled || mode !== "lrm_set" || !edges || edges.length === 0) return null;
    // visible_score_sum is present only while an LRM filter is active; with no
    // filter the rows are the raw structural rows and score_sum is the total.
    const n = edges.length;
    const scores = new Float64Array(n);
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = edges[i].visible_score_sum ?? edges[i].score_sum ?? 0;
      scores[i] = v;
      if (v < min) min = v; if (v > max) max = v;
    }
    if (!isFinite(min)) min = 0;
    if (!isFinite(max)) max = 0;
    const sorted = Float64Array.from(scores).sort();
    const p95 = sorted[Math.floor(n * 0.95)] ?? max;
    const lo = clamp?.low  ?? min;
    const hi = clamp?.high ?? max;  // use max (not p95) so reset matches the legend
    const colorMap = new Map();
    // The alpha channel carries the fade: 255 everywhere without a minimum,
    // otherwise fadeAlpha over the same window the colour uses, so the palette
    // and the translucency describe the same thing. Viewer scales its per-layer
    // base alpha by it.
    const span = hi - lo;
    for (let i = 0; i < n; i++) {
      const c = valueToColor(scores[i], lo, hi, palette);
      const a = fadeFrac == null ? 255 : fadeAlpha(span > 0 ? (scores[i] - lo) / span : 1, fadeFrac);
      colorMap.set(edges[i].edge, [c[0], c[1], c[2], a]);
    }
    return { colorValues: colorMap, type: "continuous", vmin: min, vmax: max, p95, categories: [], categoryColors: new Map() };
  }, [enabled, mode, edges, palette, clamp?.low, clamp?.high, fadeFrac]);

  // ── metadata: one summary per column, then colours from the rows ─────────
  const [summary, setSummary] = useState(null);   // { key, type, categories, min, max, p95 }
  const [loading, setLoading] = useState(false);
  const abortRef = useRef(null);
  const summaryKey = `${dataset}|${efParam}|${field}|${categorical}`;

  useEffect(() => {
    if (!enabled || mode !== "metadata" || !field) {
      if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
      setLoading(false);
      return;
    }
    if (summary?.key === summaryKey) return;
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    (async () => {
      try {
        const res = await loggedFetch("edges/edge-color-values", { dataset, edgeFile, field },
          `${apiBase}/edges/${dataset}/edge-color-values${efParam}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "metadata", field, categorical, summary: true }),
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setSummary({ key: summaryKey, type: data.type, categories: data.categories ?? [],
                     min: data.min ?? 0, max: data.max ?? 0, p95: data.p95 ?? null,
                     empty: !!data.empty });
      } catch (e) {
        if (e.name === "AbortError") return;
        setSummary({ key: summaryKey, type: "continuous", categories: [], min: 0, max: 0, p95: null, empty: true });
      } finally {
        if (abortRef.current === ctrl) setLoading(false);
      }
    })();
  }, [enabled, mode, summaryKey]); // eslint-disable-line

  const metaResult = useMemo(() => {
    if (!enabled || mode !== "metadata" || !field) return null;
    if (!summary || summary.key !== summaryKey || summary.empty) return EMPTY;
    if (summary.type === "categorical") {
      const categories = summary.categories;
      const colorMap = new Map(categories.map((cat, i) => [cat, QUAL_PALETTE[i % QUAL_PALETTE.length]]));
      const edgeColors = new Map();
      for (const e of edges ?? []) {
        const v = e.color_value;
        if (v === null || v === undefined) continue;
        // Labels were made with Python's str(): booleans read "True"/"False".
        const label = typeof v === "boolean" ? (v ? "True" : "False") : String(v);
        edgeColors.set(e.edge, colorMap.get(label) ?? [128, 128, 128, 255]);
      }
      return { colorValues: edgeColors, type: "categorical", vmin: 0, vmax: 0, p95: null, categories, categoryColors: colorMap };
    }
    const { min, max, p95 } = summary;
    const lo = clamp?.low  ?? min;
    const hi = clamp?.high ?? (p95 ?? max);
    const edgeColors = new Map();
    for (const e of edges ?? []) {
      const v = e.color_value;
      if (typeof v !== "number" || !isFinite(v)) continue;
      edgeColors.set(e.edge, valueToColor(v, lo, hi, palette));
    }
    return { colorValues: edgeColors, type: "continuous", vmin: min, vmax: max, p95, categories: [], categoryColors: new Map() };
  }, [enabled, mode, field, summary, summaryKey, edges, clamp?.low, clamp?.high, palette]);

  useEffect(() => () => { if (abortRef.current) abortRef.current.abort(); }, []);

  if (mode === "lrm_set") return { ...(lrmSetResult ?? EMPTY), loading: false };
  if (mode === "metadata") return { ...(metaResult ?? EMPTY), loading };
  return { ...EMPTY, loading: false };
}
