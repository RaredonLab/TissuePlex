import { useState, useEffect, useRef } from "react";

/**
 * Fetches cell boundary vertices and groups them into polygon objects.
 * Returns { cells: [{cell_id, polygon: [[x,y],...]}], loading, error }.
 * Debounced like useTranscripts to avoid hammering the API on every pan frame.
 */
export function useCellBoundaries(apiBase, dataset, viewport, imageSize, enabled = true) {
  const [cells, setCells] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!enabled || !dataset) return;

    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        // Always send bbox + limit so the backend can filter and cap the result.
        // No zoom-out skip — the 20k limit handles data volume at any zoom level.
        let url = `${apiBase}/spatial/${dataset}/cell-boundaries`;
        if (viewport && imageSize?.w) {
          const { xmin, ymin, xmax, ymax } = viewport;
          url += `?xmin=${xmin}&ymin=${ymin}&xmax=${xmax}&ymax=${ymax}&limit=20000`;
        } else {
          url += `?limit=20000`;
        }
        const res = await fetch(url);
        if (!res.ok) { setCells([]); return; }
        const data = await res.json();
        if (!Array.isArray(data)) { setCells([]); return; }

        // Group flat vertex list by cell_id → polygon arrays
        const byCell = new Map();
        for (const row of data) {
          if (!byCell.has(row.cell_id)) byCell.set(row.cell_id, []);
          byCell.get(row.cell_id).push([row.vertex_x, row.vertex_y]);
        }
        setCells(
          Array.from(byCell.entries()).map(([cell_id, polygon]) => ({ cell_id, polygon }))
        );
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    }, 200);

    return () => clearTimeout(timerRef.current);
  }, [apiBase, dataset, viewport?.xmin, viewport?.ymin, viewport?.xmax, viewport?.ymax, enabled]);

  return { cells, loading, error };
}
