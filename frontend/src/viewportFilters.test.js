/**
 * The client-side gene filter and the "debounce only a moving viewport" rule
 * (utils/viewportFilters.js). These are what make a species toggle instant, so
 * they are pinned here: the filter must return exactly the rows a server-side
 * filter would, and must say so when it cannot.
 */
import { describe, it, expect } from "vitest";
import { filterTranscriptsByGene, fetchDelay, geneListParams } from "./utils/viewportFilters";

const row = (g, i) => ({ feature_name: g, x_location: i, y_location: i });

describe("filterTranscriptsByGene", () => {
  const rows = [];
  for (let i = 0; i < 3000; i++) rows.push(row(["A", "B", "C"][i % 3], i));
  // 3000 rows kept from 30,000 at fraction 0.1: the cap did not bind.
  const base = { rows, total: 30_000 };

  it("passes the sample through unchanged with no filter", () => {
    const r = filterTranscriptsByGene(base, null, 0.1);
    expect(r.rows).toBe(rows);
    expect(r.total).toBe(30_000);
    expect(r.estimated).toBe(false);
    expect(r.capped).toBe(false);
  });

  it("returns nothing for an empty allowlist", () => {
    const r = filterTranscriptsByGene(base, new Set(), 0.1);
    expect(r.rows).toEqual([]);
    expect(r.total).toBe(0);
  });

  it("keeps only the selected genes and scales the total by the keep rate", () => {
    const r = filterTranscriptsByGene(base, new Set(["A"]), 0.1);
    expect(r.rows).toHaveLength(1000);
    expect(r.rows.every((t) => t.feature_name === "A")).toBe(true);
    expect(r.total).toBe(10_000);        // 1000 kept / (3000 / 30000)
    expect(r.estimated).toBe(true);
    expect(r.capped).toBe(false);
  });

  it("reports when the server cap, not the fraction, sized the sample", () => {
    // 3000 rows where fraction × total says 20,000: the cap bound.
    const r = filterTranscriptsByGene({ rows, total: 200_000 }, new Set(["A"]), 0.1);
    expect(r.capped).toBe(true);
    // Below the size floor a thin sample is noise, not a cap.
    const tiny = { rows: rows.slice(0, 5), total: 100 };
    expect(filterTranscriptsByGene(tiny, new Set(["A"]), 0.5).capped).toBe(false);
  });

  it("tolerates an empty base", () => {
    const r = filterTranscriptsByGene({ rows: [], total: 0 }, new Set(["A"]), 0.1);
    expect(r.rows).toEqual([]);
    expect(r.total).toBe(0);
    expect(r.capped).toBe(false);
  });
});

describe("fetchDelay", () => {
  it("debounces only when the viewport moved", () => {
    expect(fetchDelay("0,0,1,1", "0,0,1,1", 400)).toBe(0);
    expect(fetchDelay("0,0,1,1", "0,0,2,2", 400)).toBe(400);
    expect(fetchDelay(null, "0,0,1,1", 400)).toBe(400);
  });
});

describe("geneListParams", () => {
  const all = ["A", "B", "C", "D", "E"];
  it("sends nothing for no filter or an empty set", () => {
    expect(geneListParams(null, all, "g", "x")).toBe("");
    expect(geneListParams(new Set(), all, "g", "x")).toBe("");
  });
  it("sends the allowlist when it is the shorter form", () => {
    expect(geneListParams(new Set(["A"]), all, "g", "x")).toBe("&g=A");
  });
  it("sends the complement when that is shorter", () => {
    expect(geneListParams(new Set(["A", "B", "C", "D"]), all, "g", "x")).toBe("&x=E");
  });
  it("falls back to the allowlist when the panel is unknown", () => {
    expect(geneListParams(new Set(["A", "B"]), null, "g", "x")).toBe("&g=A&g=B");
  });
});
