import { useState, useEffect, useRef } from "react";

/**
 * Fetches cell boundary vertices and groups them into polygon objects.
 * Returns { cells, total, effectiveFraction, loading, error }.
 *
 * In-flight requests are aborted when a newer fetch supersedes them, so stale
 * responses from prior viewport positions never overwrite current data.
 *
 * fraction param:
 *   null   → auto mode: hook targets ~TARGET_CELLS rendered cells, adapting the
 *            fraction to the actual density seen in the last fetch.
 *   number → user override: send exactly this fraction (0–1).
 *
 * prevTotalRef seeds to a conservative estimate (50k) so the very first probe
 * is 10% rather than 100%.  After the first response the estimate self-corrects.
 */

const TARGET_CELLS = 5_000;
const SEED_TOTAL   = 50_000; // conservative first-probe estimate

export function useCellBoundaries(
  apiBase, dataset, viewport, imageSize, enabled = true, fraction = null
) {
  const [cells, setCells]                     = useState([]);
  const [total, setTotal]                     = useState(0);
  const [effectiveFraction, setEffective]     = useState(TARGET_CELLS / SEED_TOTAL);
  const [loading, setLoading]                 = useState(false);
  const [error, setError]                     = useState(null);
  const timerRef    = useRef(null);
  const abortRef    = useRef(null);
  const prevTotalRef = useRef(SEED_TOTAL);   // running estimate of cells in viewport

  useEffect(() => {
    if (!enabled || !dataset) {
      setLoading(false);
      return;
    }

    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      // Cancel any in-flight request before starting a new one
      if (abortRef.current) abortRef.current.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      // Compute the fraction we'll actually send this round
      const autoFrac = Math.min(1.0, TARGET_CELLS / Math.max(1, prevTotalRef.current));
      const eff = fraction !== null
        ? Math.max(0.0001, Math.min(1.0, fraction))
        : autoFrac;
      setEffective(eff);

      setLoading(true);
      setError(null);
      try {
        let url = `${apiBase}/spatial/${dataset}/cell-boundaries`;
        const fracParam = `fraction=${eff}`;
        if (viewport && imageSize?.w) {
          const { xmin, ymin, xmax, ymax } = viewport;
          url += `?xmin=${xmin}&ymin=${ymin}&xmax=${xmax}&ymax=${ymax}&${fracParam}`;
        } else {
          url += `?${fracParam}`;
        }
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) { setCells([]); setTotal(0); return; }
        const data = await res.json();

        // Expect { boundaries: [...], total: N }
        const rows = Array.isArray(data) ? data : (data.boundaries ?? []);
        const totalCells = typeof data.total === "number" ? data.total : rows.length;

        // Update the running estimate so the next auto fraction is better calibrated
        if (totalCells > 0) prevTotalRef.current = totalCells;
        setTotal(totalCells);

        if (!Array.isArray(rows)) { setCells([]); return; }

        // Group flat vertex list by cell_id → polygon arrays
        const byCell = new Map();
        for (const row of rows) {
          if (!byCell.has(row.cell_id)) byCell.set(row.cell_id, []);
          byCell.get(row.cell_id).push([row.vertex_x, row.vertex_y]);
        }
        setCells(
          Array.from(byCell.entries()).map(([cell_id, polygon]) => ({ cell_id, polygon }))
        );
      } catch (e) {
        if (e.name === "AbortError") return; // silently ignore — a newer fetch is in flight
        setError(e.message);
      } finally {
        if (abortRef.current === ctrl) setLoading(false);
      }
    }, 200);

    return () => clearTimeout(timerRef.current);
  }, [apiBase, dataset, viewport?.xmin, viewport?.ymin, viewport?.xmax, viewport?.ymax, enabled, fraction]);

  // Abort in-flight request on unmount
  useEffect(() => {
    return () => {
      clearTimeout(timerRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  return { cells, total, effectiveFraction, loading, error };
}
