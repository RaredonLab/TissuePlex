import { useState, useEffect, useRef } from "react";

/**
 * Fetches transcripts from the backend, filtered by viewport bbox.
 * Debounced so rapid pan/zoom doesn't hammer the API.
 * Returns { transcripts, loading, error }.
 */
export function useTranscripts(apiBase, dataset, viewport, imageSize, enabled = true) {
  const [transcripts, setTranscripts] = useState([]);
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
        let url = `${apiBase}/xenium/${dataset}/transcripts?limit=50000`;
        if (viewport && imageSize?.w) {
          const { xmin, ymin, xmax, ymax } = viewport;
          const fracW = (xmax - xmin) / imageSize.w;
          if (fracW >= 0.7) {
            // Zoomed too far out — transcripts are sub-pixel; skip fetch.
            setTranscripts([]);
            setLoading(false);
            return;
          }
          if (fracW < 0.5) {
            url += `&xmin=${xmin}&ymin=${ymin}&xmax=${xmax}&ymax=${ymax}`;
          }
        }
        const res = await fetch(url);
        if (!res.ok) { setTranscripts([]); return; }
        const data = await res.json();
        setTranscripts(Array.isArray(data) ? data : []);
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    }, 200); // 200ms debounce

    return () => clearTimeout(timerRef.current);
  }, [apiBase, dataset, viewport?.xmin, viewport?.ymin, viewport?.xmax, viewport?.ymax, enabled]);

  return { transcripts, loading, error };
}
