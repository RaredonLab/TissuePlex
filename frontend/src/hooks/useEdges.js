import { useState, useEffect, useRef } from "react";

const DEBOUNCE_MS = 400;

export function useEdges(apiBase, dataset, viewport, imageSize, enabled, minStrength, hiddenLrms, density = 1.0) {
  const [edges, setEdges] = useState([]);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!enabled || !viewport || !imageSize?.w) {
      setEdges([]);
      return;
    }

    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      const { xmin, ymin, xmax, ymax } = viewport;
      const body = { xmin, ymin, xmax, ymax, density: Math.max(0.01, Math.min(1.0, density)) };
      if (minStrength != null && minStrength > 0) body.min_strength = minStrength;
      if (hiddenLrms?.size > 0) body.excluded_lrms = [...hiddenLrms];

      try {
        const res = await fetch(`${apiBase}/edges/${dataset}/query-grouped`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        setEdges(res.ok ? await res.json() : []);
      } catch {
        setEdges([]);
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(timerRef.current);
  }, [apiBase, dataset, viewport, imageSize, enabled, minStrength, hiddenLrms, density]);

  return { edges };
}
