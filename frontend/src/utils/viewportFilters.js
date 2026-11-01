/**
 * Pure helpers for the "filter changed, viewport did not" case.
 *
 * Toggling a gene in the transcript species list used to be a server round
 * trip behind a debounce, like a pan. But the viewport's *unfiltered* sample is
 * already in memory, and the server's sample is a seeded hash of each row's
 * identity kept with probability `n / total`. With no cap in play that
 * probability is `fraction` whatever the gene filter, so "the rows the server
 * would return for this gene set" is exactly "the rows already here, filtered
 * by gene" — the same rows, not a thinner subset. The filter can therefore be
 * applied in the browser, synchronously, and the server asked again only in the
 * one case where that is not true.
 */

/**
 * Apply a gene allowlist to the viewport's unfiltered transcript sample.
 *
 * @param base          { rows, total } — the unfiltered sample and its pre-sample count
 * @param selectedGenes null (no filter) | Set<string>
 * @param fraction      the sample fraction the base was requested at
 * @returns { rows, total, estimated, capped }
 *   total     — pre-sample count for the selected genes. Exact with no filter;
 *               otherwise estimated from the sample's keep rate (± sampling noise).
 *   capped    — the server's row cap, not `fraction`, decided the sample size,
 *               so a gene-filtered fetch would return *more* rows for the
 *               selected genes than this filter can. The caller refetches then.
 */
export function filterTranscriptsByGene(base, selectedGenes, fraction) {
  const rows = base?.rows ?? [];
  const total = base?.total ?? 0;
  if (selectedGenes === null) {
    return { rows, total, estimated: false, capped: false };
  }
  if (selectedGenes.size === 0) {
    return { rows: [], total: 0, estimated: false, capped: false };
  }
  const kept = rows.filter((t) => selectedGenes.has(t.feature_name));
  const keepRate = total > 0 ? rows.length / total : 0;
  // The cap binds when the sample is noticeably thinner than `fraction` says it
  // should be. The 1.1 margin absorbs hash-sampling noise; the size floor keeps
  // tiny viewports, where a few rows either way is noise, from ever re-fetching.
  const capped = total > 0 && rows.length > 1000 && fraction * total > rows.length * 1.1;
  return {
    rows: kept,
    total: keepRate > 0 ? Math.round(kept.length / keepRate) : 0,
    estimated: true,
    capped,
  };
}

/**
 * Debounce only what needs it. A viewport change arrives as a stream of events
 * during a drag and must be coalesced; a filter or style change is a single
 * click and should be acted on at once. Returns the delay to use for a fetch
 * whose viewport key is `nextKey` when the last fetch used `prevKey`.
 */
export function fetchDelay(prevKey, nextKey, debounceMs) {
  return prevKey === nextKey ? 0 : debounceMs;
}

/**
 * Build the gene-list query parameters as an allowlist or its complement,
 * whichever is shorter (see useTranscripts for why the length matters).
 * Returns "" when `selected` is null (no filter) or the list cannot be stated.
 */
export function geneListParams(selected, allGenes, nameAllow, nameExclude) {
  if (selected === null || selected === undefined) return "";
  const sel = selected instanceof Set ? selected : new Set(selected);
  if (sel.size === 0) return "";
  const total = Array.isArray(allGenes) ? allGenes.length : 0;
  const excluded = total > 0 ? allGenes.filter((g) => !sel.has(g)) : [];
  let out = "";
  if (total > 0 && excluded.length < sel.size) {
    for (const g of excluded) out += `&${nameExclude}=${encodeURIComponent(g)}`;
  } else {
    for (const g of sel) out += `&${nameAllow}=${encodeURIComponent(g)}`;
  }
  return out;
}
