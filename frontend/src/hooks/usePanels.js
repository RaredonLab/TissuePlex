/**
 * Helpers for a sidebar that drives more than one panel.
 *
 * In split mode the two panels can show different datasets, so anything the
 * sidebar offers has to be reconciled across them. The rule throughout is
 * **union, then degrade per panel**: show a control if *either* panel can use
 * it, and let the panel that cannot simply render nothing. The alternative —
 * intersecting — hides controls that work perfectly well on one side, which is
 * worse when the whole point is comparing unlike things.
 */
import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";

/** The panels currently on screen (1 or 2), in panel order. */
export function useActivePanels() {
  const panelCount = useStore((s) => s.panelCount);
  const panels = useStore((s) => s.panels);
  return useMemo(() => panels.slice(0, panelCount), [panels, panelCount]);
}

/** Datasets currently on screen, de-duplicated and null-free. */
export function useActiveDatasets() {
  const active = useActivePanels();
  return useMemo(
    () => [...new Set(active.map((p) => p.dataset).filter(Boolean))],
    [active]
  );
}

/**
 * Capabilities merged across the visible panels.
 *
 * Booleans are OR-ed: a layer is offered when at least one panel can serve it,
 * and the panel that cannot just hides it (the Viewer already gates on its own
 * capabilities). `unitLabel` is the shared one when the panels agree and the
 * neutral "unit" when they do not — calling a Visium spot a "cell" because the
 * other panel is Xenium would be worse than saying nothing.
 */
export function useUnionCapabilities() {
  const active = useActivePanels();
  return useMemo(() => {
    const caps = active.map((p) => p.platformCapabilities).filter(Boolean);
    if (caps.length === 0) {
      return { has_morphology: true, has_transcripts: true, has_boundaries: true,
               has_transcript_qv: false, unit_label: "cell", mixed: false };
    }
    const labels = [...new Set(caps.map((c) => c.unit_label ?? "cell"))];
    return {
      has_morphology:  caps.some((c) => c.has_morphology  ?? true),
      has_transcripts: caps.some((c) => c.has_transcripts ?? true),
      has_boundaries:  caps.some((c) => c.has_boundaries  ?? true),
      // Defaults false, unlike the others: a Q-Score is a property of a few
      // formats, not a layer a platform might lack.
      has_transcript_qv: caps.some((c) => c.has_transcript_qv ?? false),
      unit_label: labels.length === 1 ? labels[0] : "unit",
      mixed: labels.length > 1,
    };
  }, [active]);
}

/**
 * Union of a per-dataset list across the visible panels.
 *
 * `fetchFor(dataset)` must resolve to an array (or null). Results are unioned
 * preserving first-seen order, so panel 0's ordering wins where the two overlap
 * — which keeps the common single-panel case byte-identical to before.
 */
export function useUnionList(fetchFor, deps = []) {
  const datasets = useActiveDatasets();
  // Joined on an escaped NUL, which cannot occur in a directory name, so two
  // datasets can never combine into the same key. Written as \u0000 rather
  // than a literal control byte: an embedded NUL makes git classify this
  // source file as binary, which suppresses diffs and line-level review.
  const key = datasets.join("\u0000");
  const [list, setList] = useState([]);

  useEffect(() => {
    if (datasets.length === 0) { setList([]); return; }
    let cancelled = false;
    Promise.all(datasets.map((d) => Promise.resolve(fetchFor(d)).catch(() => null)))
      .then((results) => {
        if (cancelled) return;
        const seen = new Set(), out = [];
        for (const r of results) {
          if (!Array.isArray(r)) continue;
          for (const v of r) if (!seen.has(v)) { seen.add(v); out.push(v); }
        }
        setList(out);
      });
    return () => { cancelled = true; };
  }, [key, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps

  return list;
}
