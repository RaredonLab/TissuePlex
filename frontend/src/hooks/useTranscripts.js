import { useState, useEffect, useRef, useMemo } from "react";
import { loggedFetch } from "../utils/clientLog";
import { filterTranscriptsByGene, fetchDelay, geneListParams } from "../utils/viewportFilters";

/**
 * Xenium Explorer hides transcripts below this Q-Score by default, and so do we.
 * It is Phred-scaled: 20 means a 1% estimated decoding error.
 */
export const TRANSCRIPT_MIN_QV = 20;

const VIEWPORT_DEBOUNCE_MS = 200;
const EMPTY = { rows: [], total: 0 };

/**
 * Fetches transcripts for the viewport and applies the gene filter in the browser.
 *
 * Two layers, and the split is the point:
 *
 *   base   — the viewport's *unfiltered* sample: one request per viewport /
 *            fraction / quality-threshold change, debounced like a pan.
 *   genes  — applied to `base` synchronously (`filterTranscriptsByGene`), so a
 *            click in the species list changes the canvas on the next render
 *            with no request at all. The server samples by a seeded hash of each
 *            row, kept with probability `fraction`, so filtering the unfiltered
 *            sample yields exactly the rows a filtered fetch would — unless the
 *            200K row cap, not `fraction`, decided the sample size. In that one
 *            case (whole-tissue zoom on a large run) the filtered rows are
 *            fetched from the server, immediately and abortably, and replace the
 *            client-side result when they land.
 *
 * A fetch whose viewport is unchanged from the last one (fraction or quality
 * toggled) is not debounced either: the debounce exists to coalesce drag events.
 *
 * @param fraction      0–1 fraction of viewport transcripts to request.
 * @param selectedGenes null = all species; Set<string> = only those genes.
 * @param allGenes      the dataset's full gene panel, used only to decide whether
 *                      to state a server-side filter as an allowlist or as its
 *                      complement.
 * @param minQv         null = no quality filter; a number = keep Q-Score >= it.
 *                      The backend ignores it for platforms without a Q-Score.
 *
 * Returns { transcripts, total, loading, error }.
 *   transcripts — already gene-filtered.
 *   total       — pre-sample count in the viewport after gene and quality
 *                 filtering; estimated from the sample's keep rate while a gene
 *                 filter is served client-side.
 */
export function useTranscripts(apiBase, dataset, viewport, imageSize, enabled = true, fraction = 1.0, selectedGenes = null, allGenes = null, minQv = null) {
  const [base, setBase] = useState(EMPTY);
  const [exact, setExact] = useState(null);       // { key, rows, total } server-filtered
  const [loadingBase, setLoadingBase] = useState(false);
  const [loadingExact, setLoadingExact] = useState(false);
  const [error, setError] = useState(null);
  const timerRef = useRef(null);
  const abortRef = useRef(null);
  const exactAbortRef = useRef(null);
  const lastViewKeyRef = useRef(null);
  const fetchedKeyRef = useRef(null);

  const genesKey = selectedGenes === null ? "" : [...selectedGenes].sort().join(",");
  const hasView = !!(viewport && imageSize?.w);
  const viewKey = hasView
    ? `${viewport.xmin},${viewport.ymin},${viewport.xmax},${viewport.ymax}` : "";
  const baseKey = `${dataset}|${viewKey}|${fraction}|${minQv}`;
  // An empty allowlist means "show no species": nothing to fetch for, and the
  // base is kept so re-selecting a gene is instant.
  const wantBase = !!(enabled && dataset) && !(selectedGenes !== null && selectedGenes.size === 0);

  // ── Base fetch: unfiltered viewport sample ────────────────────────────────
  useEffect(() => {
    if (!enabled || !dataset) {
      setBase(EMPTY);
      setExact(null);
      fetchedKeyRef.current = null;
      setLoadingBase(false);
      return;
    }
    if (!wantBase) { setLoadingBase(false); return; }
    if (fetchedKeyRef.current === baseKey) return;   // already have this exact sample

    const delay = fetchDelay(lastViewKeyRef.current, viewKey, VIEWPORT_DEBOUNCE_MS);
    lastViewKeyRef.current = viewKey;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      if (abortRef.current) abortRef.current.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      setLoadingBase(true);
      setError(null);
      try {
        let url = `${apiBase}/spatial/${dataset}/transcripts?fraction=${fraction}`;
        // Applied server-side before sampling, so the kept transcripts render at
        // the full sample density rather than as a thinned remainder.
        if (minQv !== null) url += `&min_qv=${minQv}`;
        // Always send bbox when available so the backend can sample uniformly
        // within the viewport. No zoom-out skip — the backend cap handles volume.
        if (hasView) {
          const { xmin, ymin, xmax, ymax } = viewport;
          url += `&xmin=${xmin}&ymin=${ymin}&xmax=${xmax}&ymax=${ymax}`;
        }
        const res = await loggedFetch("transcripts", { dataset }, url, { signal: ctrl.signal });
        if (!res.ok) { setBase(EMPTY); fetchedKeyRef.current = baseKey; return; }
        const data = await res.json();
        // Response is { transcripts: [...], total: N }
        const arr = Array.isArray(data) ? data : (data.transcripts ?? []);
        const tot = typeof data.total === "number" ? data.total : arr.length;
        setBase({ rows: arr, total: tot });
        fetchedKeyRef.current = baseKey;
      } catch (e) {
        if (e.name === "AbortError") return; // a newer fetch is in flight
        setError(e.message);
      } finally {
        if (abortRef.current === ctrl) setLoadingBase(false);
      }
    }, delay);

    return () => clearTimeout(timerRef.current);
  }, [apiBase, baseKey, wantBase, enabled, dataset]); // eslint-disable-line

  // ── Gene filter, in the browser ───────────────────────────────────────────
  const derived = useMemo(
    () => filterTranscriptsByGene(base, selectedGenes, fraction),
    [base, selectedGenes, fraction]);

  // ── Exact fetch, only when the cap thinned the base sample ────────────────
  // The gene list travels in the URL of a GET, stated as an allowlist or as its
  // complement, whichever is shorter: 479 of 480 genes is a 7.8 KB URL, ~220
  // bytes under nginx's 8 KB request line, and 600 genes 414s outright.
  const exactKey = `${baseKey}|${genesKey}`;
  const needExact = wantBase && selectedGenes !== null && derived.capped
    && fetchedKeyRef.current === baseKey;
  useEffect(() => {
    if (!needExact) {
      if (exactAbortRef.current) { exactAbortRef.current.abort(); exactAbortRef.current = null; }
      setLoadingExact(false);
      return;
    }
    if (exact?.key === exactKey) return;
    if (exactAbortRef.current) exactAbortRef.current.abort();
    const ctrl = new AbortController();
    exactAbortRef.current = ctrl;
    setLoadingExact(true);
    (async () => {
      try {
        let url = `${apiBase}/spatial/${dataset}/transcripts?fraction=${fraction}`;
        if (minQv !== null) url += `&min_qv=${minQv}`;
        url += geneListParams(selectedGenes, allGenes, "genes", "exclude_genes");
        if (hasView) {
          const { xmin, ymin, xmax, ymax } = viewport;
          url += `&xmin=${xmin}&ymin=${ymin}&xmax=${xmax}&ymax=${ymax}`;
        }
        const res = await loggedFetch("transcripts", { dataset, genes: selectedGenes.size }, url,
          { signal: ctrl.signal });
        if (!res.ok) return;
        const data = await res.json();
        const arr = Array.isArray(data) ? data : (data.transcripts ?? []);
        const tot = typeof data.total === "number" ? data.total : arr.length;
        setExact({ key: exactKey, rows: arr, total: tot });
      } catch (e) {
        if (e.name !== "AbortError") setError(e.message);
      } finally {
        if (exactAbortRef.current === ctrl) setLoadingExact(false);
      }
    })();
  // allGenes.length decides the URL *form*; re-run once the panel arrives.
  }, [needExact, exactKey, allGenes?.length]); // eslint-disable-line

  // Abort in-flight requests on unmount
  useEffect(() => {
    return () => {
      clearTimeout(timerRef.current);
      if (abortRef.current) abortRef.current.abort();
      if (exactAbortRef.current) exactAbortRef.current.abort();
    };
  }, []);

  const useExact = needExact && exact?.key === exactKey;
  return {
    transcripts: useExact ? exact.rows : derived.rows,
    total: useExact ? exact.total : derived.total,
    loading: loadingBase || loadingExact,
    error,
  };
}
