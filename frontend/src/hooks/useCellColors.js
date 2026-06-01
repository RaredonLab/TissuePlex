import { useState, useEffect, useRef } from "react";
import { valueToColor, QUAL_PALETTE } from "../utils/colormap";
import { geneColor } from "../utils/geneColor";

/**
 * Fetches per-cell color values and maps them to RGBA.
 *
 * Debounced at 400ms so rapid sequential changes (e.g. toggling genes one by
 * one) collapse into a single server request for the final state.
 * In-flight requests are aborted when superseded, so intermediate results never
 * overwrite the response for the user's actual target settings.
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
export function useCellColors(apiBase, dataset, colorBy, allGenes, selectedGenes, palette, enabled, clamp, categoryColorOverrides) {
  const [result, setResult] = useState({
    colorValues: null, type: "continuous", vmin: 0, vmax: 0,
    categories: [], categoryColors: new Map(),
  });
  const [loading, setLoading] = useState(false);
  const timerRef = useRef(null);
  const abortRef = useRef(null);

  // rawCat: the last categorical response from the server { categories, values }
  // stored separately so color remapping doesn't trigger a re-fetch.
  const [rawCat, setRawCat] = useState(null);

  // ── Effect 1: fetch server data ──────────────────────────────────────────
  useEffect(() => {
    if (!enabled || !colorBy || colorBy.mode === "off") {
      setResult({ colorValues: null, type: "continuous", vmin: 0, vmax: 0, categories: [], categoryColors: new Map() });
      setRawCat(null);
      setLoading(false);
      return;
    }

    const { mode, field } = colorBy;

    // gene_set: null selectedGenes means show all; Set means use only those genes
    const genesToSend = mode === "gene_set"
      ? (selectedGenes === null ? allGenes : [...selectedGenes])
      : null;
    if (mode === "gene_set" && (!genesToSend || genesToSend.length === 0)) {
      setResult({ colorValues: null, type: "continuous", vmin: 0, vmax: 0, categories: [], categoryColors: new Map() });
      setRawCat(null);
      setLoading(false);
      return;
    }
    if (mode === "metadata" && !field) {
      setResult({ colorValues: null, type: "continuous", vmin: 0, vmax: 0, categories: [], categoryColors: new Map() });
      setRawCat(null);
      setLoading(false);
      return;
    }

    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      // Cancel any in-flight request before starting a new one
      if (abortRef.current) abortRef.current.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      setLoading(true);
      try {
        const body = mode === "gene_set"
          ? { mode: "gene_set", genes: genesToSend }
          : { mode: "metadata", field };

        const res = await fetch(`${apiBase}/spatial/${dataset}/color-values`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        if (!data?.values) throw new Error("color-values response missing 'values'");

        if (data.type === "categorical") {
          // Store raw server response; color mapping happens in Effect 2.
          setRawCat({ categories: data.categories, values: data.values });
        } else {
          setRawCat(null);
          const { min, max } = data;
          const lo = clamp?.low ?? min;
          const hi = clamp?.high ?? max;
          const colorMap = new Map(
            Object.entries(data.values).map(([id, v]) => [id, valueToColor(v, lo, hi, palette)])
          );
          setResult({ colorValues: colorMap, type: "continuous", vmin: min, vmax: max, categories: [], categoryColors: new Map() });
        }
      } catch (e) {
        if (e.name === "AbortError") return; // silently ignore — a newer fetch is in flight
        setRawCat(null);
        setResult({ colorValues: null, type: "continuous", vmin: 0, vmax: 0, categories: [], categoryColors: new Map() });
      } finally {
        if (abortRef.current === ctrl) setLoading(false);
      }
    }, 400);
    return () => clearTimeout(timerRef.current);
  }, [apiBase, dataset, colorBy?.mode, colorBy?.field, allGenes, selectedGenes, palette, enabled, clamp?.low, clamp?.high]); // eslint-disable-line

  // ── Effect 2: remap categorical colors client-side (no server call) ──────
  // Runs whenever raw server data changes OR the user edits a swatch color.
  useEffect(() => {
    if (!rawCat) return;
    const { categories, values } = rawCat;
    const field = colorBy?.field;
    const colorMap = new Map(
      categories.map((cat, i) => {
        const key = `${field}::${cat}`;
        const override = categoryColorOverrides?.[key];
        return [cat, override ?? (i < QUAL_PALETTE.length ? QUAL_PALETTE[i] : [...geneColor(cat), 255])];
      })
    );
    const cellColors = new Map(
      Object.entries(values).map(([id, label]) => [id, colorMap.get(label) ?? [128, 128, 128, 255]])
    );
    setResult({ colorValues: cellColors, type: "categorical", vmin: 0, vmax: 0, categories, categoryColors: colorMap });
  }, [rawCat, categoryColorOverrides, colorBy?.field]); // eslint-disable-line

  // Abort in-flight request on unmount
  useEffect(() => {
    return () => {
      clearTimeout(timerRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  return { ...result, loading };
}
