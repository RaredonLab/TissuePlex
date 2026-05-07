import { useState, useEffect, useRef } from "react";

const DEBOUNCE_MS = 400;

export function useEdges(apiBase, dataset, viewport, imageSize, enabled, minStrength) {
  const [edges, setEdges] = useState([]);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!enabled || !viewport || !imageSize?.w) {
      setEdges([]);
      return;
    }

    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const { xmin, ymin, xmax, ymax } = viewport;
      const fracW = (xmax - xmin) / imageSize.w;
      // Scale limit with zoom: more zoomed in → fewer edges in view → raise ceiling.
      const limit =
        fracW < 0.05 ? 500_000 :
        fracW < 0.15 ? 200_000 :
        fracW < 0.35 ? 100_000 : 50_000;
      const params = new URLSearchParams({
        xmin, ymin, xmax, ymax,
        limit,
      });
      if (minStrength != null && minStrength > 0) {
        params.set("min_strength", minStrength);
      }

      fetch(`${apiBase}/edges/${dataset}/query?${params}`)
        .then((r) => (r.ok ? r.json() : []))
        .then(setEdges)
        .catch(() => {});
    }, DEBOUNCE_MS);

    return () => clearTimeout(timerRef.current);
  }, [apiBase, dataset, viewport, imageSize, enabled, minStrength]);

  return { edges };
}
