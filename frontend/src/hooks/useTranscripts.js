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
        let url = `${apiBase}/xenium/${dataset}/transcripts?limit=100000`;
        // Add bbox if we have a real viewport (not loading the whole dataset)
        if (viewport && imageSize?.w) {
          const { xmin, ymin, xmax, ymax } = viewport;
          // Only filter if the viewport covers less than ~25% of the image
          // (at high zoom); at low zoom just load everything
          const fracW = (xmax - xmin) / imageSize.w;
          if (fracW < 0.5) {
            url += `&xmin=${xmin}&ymin=${ymin}&xmax=${xmax}&ymax=${ymax}`;
          }
        }
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setTranscripts(data);
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
