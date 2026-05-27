import { useState, useEffect, useRef } from "react";

/**
 * Fetches transcripts from the backend, filtered by viewport bbox.
 * Debounced so rapid pan/zoom doesn't hammer the API.
 *
 * @param fraction  0–1 fraction of viewport transcripts to request.
 *                  Passed straight to the backend; 1.0 = all transcripts.
 *
 * Returns { transcripts, total, loading, error }.
 *   total — pre-sample count in the viewport (from backend); 0 when unknown.
 */
export function useTranscripts(apiBase, dataset, viewport, imageSize, enabled = true, fraction = 1.0) {
  const [transcripts, setTranscripts] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!enabled || !dataset) {
      setTranscripts([]);
      setTotal(0);
      return;
    }

    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        let url = `${apiBase}/spatial/${dataset}/transcripts?fraction=${fraction}`;
        if (viewport && imageSize?.w) {
          const { xmin, ymin, xmax, ymax } = viewport;
          const fracW = (xmax - xmin) / imageSize.w;
          if (fracW >= 0.7) {
            // Zoomed too far out — transcripts are sub-pixel; skip fetch.
            setTranscripts([]);
            setTotal(0);
            setLoading(false);
            return;
          }
          url += `&xmin=${xmin}&ymin=${ymin}&xmax=${xmax}&ymax=${ymax}`;
        }
        const res = await fetch(url);
        if (!res.ok) { setTranscripts([]); setTotal(0); return; }
        const data = await res.json();
        // Response is { transcripts: [...], total: N }
        const arr = Array.isArray(data) ? data : (data.transcripts ?? []);
        const tot = typeof data.total === "number" ? data.total : arr.length;
        setTranscripts(arr);
        setTotal(tot);
      } catch (e) {
        setError(e.message);
        setTotal(0);
      } finally {
        setLoading(false);
      }
    }, 200);

    return () => clearTimeout(timerRef.current);
  }, [apiBase, dataset, viewport?.xmin, viewport?.ymin, viewport?.xmax, viewport?.ymax, enabled, fraction]); // eslint-disable-line

  return { transcripts, total, loading, error };
}
