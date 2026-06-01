import { useState, useEffect, useRef } from "react";

/**
 * Fetches transcripts from the backend, filtered by viewport bbox.
 * Debounced so rapid pan/zoom doesn't hammer the API.
 * In-flight requests are aborted when a newer fetch supersedes them, so stale
 * responses from intermediate viewport positions never overwrite current data.
 *
 * @param fraction      0–1 fraction of viewport transcripts to request.
 * @param selectedGenes null = all species; Set<string> = only those genes.
 *                      Passed to the backend so total reflects selected species only.
 *
 * Returns { transcripts, total, loading, error }.
 *   total — pre-sample count in the viewport after gene filtering (from backend).
 */
export function useTranscripts(apiBase, dataset, viewport, imageSize, enabled = true, fraction = 1.0, selectedGenes = null) {
  const [transcripts, setTranscripts] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const timerRef = useRef(null);
  const abortRef = useRef(null);

  // Stable string representation of the gene set for use as a dep.
  const genesKey = selectedGenes === null ? "" : [...selectedGenes].sort().join(",");

  useEffect(() => {
    if (!enabled || !dataset) {
      setTranscripts([]);
      setTotal(0);
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
      setError(null);
      try {
        let url = `${apiBase}/spatial/${dataset}/transcripts?fraction=${fraction}`;

        // Send selected gene filter so backend samples within those species only.
        if (selectedGenes !== null && selectedGenes.size > 0) {
          for (const g of selectedGenes) {
            url += `&genes=${encodeURIComponent(g)}`;
          }
        }

        // Always send bbox when available so the backend can sample uniformly
        // within the viewport. No zoom-out skip — the backend cap handles volume.
        if (viewport && imageSize?.w) {
          const { xmin, ymin, xmax, ymax } = viewport;
          url += `&xmin=${xmin}&ymin=${ymin}&xmax=${xmax}&ymax=${ymax}`;
        }

        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) { setTranscripts([]); setTotal(0); return; }
        const data = await res.json();
        // Response is { transcripts: [...], total: N }
        const arr = Array.isArray(data) ? data : (data.transcripts ?? []);
        const tot = typeof data.total === "number" ? data.total : arr.length;
        setTranscripts(arr);
        setTotal(tot);
      } catch (e) {
        if (e.name === "AbortError") return; // silently ignore — a newer fetch is in flight
        setError(e.message);
        setTotal(0);
      } finally {
        if (abortRef.current === ctrl) setLoading(false);
      }
    }, 200);

    return () => clearTimeout(timerRef.current);
  }, [apiBase, dataset, viewport?.xmin, viewport?.ymin, viewport?.xmax, viewport?.ymax, enabled, fraction, genesKey]); // eslint-disable-line

  // Abort in-flight request on unmount
  useEffect(() => {
    return () => {
      clearTimeout(timerRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  return { transcripts, total, loading, error };
}
