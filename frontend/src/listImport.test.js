/**
 * Gene-list / LRM-list CSV import (utils/listImport.js) and the two store
 * actions that apply it.
 *
 * The contract mirrors Xenium Explorer's gene-group upload: a required header,
 * header names in any case, values matched exactly. Most of what is pinned here
 * is a refusal — every one of them stands between the user and a layer that
 * silently draws nothing.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useStore, makePanel } from "./store";
import {
  ListImportError, decodeListFile, parseCsv, readGeneList, readLrmList,
  geneListCsv, lrmListCsv,
} from "./utils/listImport";

const GENES = ["Ccl2", "Ccr2", "Egf", "Egfr", "Itgav", "Itgb3"];
const CATALOGUE = [
  { lrm: "Ccl2|Ccr2", ligand: "Ccl2", receptor: "Ccr2" },
  { lrm: "Egf|Egfr", ligand: "Egf", receptor: "Egfr" },
  { lrm: "Fn1|Itgav,Itgb3", ligand: "Fn1", receptor: "Itgav,Itgb3" },
];
const bytes = (s) => new TextEncoder().encode(s);
const refused = (fn, pattern) => {
  expect(fn).toThrow(ListImportError);
  if (pattern) expect(fn).toThrow(pattern);
};

describe("parseCsv", () => {
  it("keeps a quoted comma inside one field", () => {
    expect(parseCsv('lrm\n"Fn1|Itgav,Itgb3"\n')).toEqual([["lrm"], ["Fn1|Itgav,Itgb3"]]);
  });

  it("handles CRLF, doubled quotes and blank lines", () => {
    expect(parseCsv('gene,note\r\n\r\nCcl2,"say ""hi"""\r\n')).toEqual(
      [["gene", "note"], ["Ccl2", 'say "hi"']]);
  });

  it("falls back to tab or semicolon when the header has no comma", () => {
    expect(parseCsv("gene\tgroup\nCcl2\tA")).toEqual([["gene", "group"], ["Ccl2", "A"]]);
    expect(parseCsv("gene;group\nCcl2;A")).toEqual([["gene", "group"], ["Ccl2", "A"]]);
  });
});

describe("decodeListFile", () => {
  it("strips Excel's UTF-8 BOM so the header still reads as 'gene'", () => {
    const text = decodeListFile(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("gene\nCcl2")]));
    expect(readGeneList(text, GENES)).toEqual(new Set(["Ccl2"]));
  });

  it("refuses an xlsx even when it has been renamed to .csv", () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]);
    refused(() => decodeListFile(zip, "genes.csv"), /Excel workbook/);
  });

  it("refuses a legacy .xls and anything named .xlsx", () => {
    refused(() => decodeListFile(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]), "a.csv"), /Excel/);
    refused(() => decodeListFile(bytes("gene\nCcl2"), "genes.XLSX"), /Excel/);
  });

  it("decodes UTF-16 (Excel's 'Unicode Text')", () => {
    const s = "gene\nEgf";
    const u16 = new Uint8Array(2 + s.length * 2);
    u16[0] = 0xff; u16[1] = 0xfe;
    for (let i = 0; i < s.length; i++) u16[2 + i * 2] = s.charCodeAt(i);
    expect(decodeListFile(u16)).toBe(s);
  });
});

describe("readGeneList", () => {
  it("accepts the header in any case and ignores other columns", () => {
    expect(readGeneList("Group,GENE\nA,Ccl2\nB,Egf\n", GENES)).toEqual(new Set(["Ccl2", "Egf"]));
  });

  it("reads a Xenium Explorer gene-group file unchanged", () => {
    expect(readGeneList("gene,group\nCcl2,chemokine\nCcr2,chemokine\n", GENES))
      .toEqual(new Set(["Ccl2", "Ccr2"]));
  });

  it("matches values exactly — case included — and drops the misses", () => {
    expect(readGeneList("gene\nCCL2\nEgf\n", GENES)).toEqual(new Set(["Egf"]));
  });

  it("trims surrounding whitespace on values", () => {
    expect(readGeneList("gene\n  Egf  \n", GENES)).toEqual(new Set(["Egf"]));
  });

  it("refuses a file without a gene header, naming what it found", () => {
    refused(() => readGeneList("symbol,p_val\nCcl2,0.01\n", GENES), /found "symbol, p_val"/);
    // A headerless list is the classic case: the first gene is read as the header.
    refused(() => readGeneList("Ccl2\nEgf\n", GENES), /Missing header/);
  });

  it("refuses an empty file and a header with nothing under it", () => {
    refused(() => readGeneList("", GENES), /empty/);
    refused(() => readGeneList("gene\n\n", GENES), /no gene names/);
  });

  it("refuses zero matches rather than blanking the layer", () => {
    refused(() => readGeneList("gene\nCCL2\nEGF\n", GENES), /None of the 2 gene names.*"CCL2"/);
  });
});

describe("readLrmList", () => {
  it("reads an lrm column, header in any case", () => {
    expect(readLrmList("LRM\nCcl2|Ccr2\n", CATALOGUE)).toEqual(new Set(["Ccl2|Ccr2"]));
  });

  it("reads ligand + receptor columns in either order", () => {
    expect(readLrmList("Receptor,Ligand\nEgfr,Egf\n", CATALOGUE)).toEqual(new Set(["Egf|Egfr"]));
  });

  it("keeps a quoted complex receptor intact", () => {
    expect(readLrmList('ligand,receptor\nFn1,"Itgav,Itgb3"\n', CATALOGUE))
      .toEqual(new Set(["Fn1|Itgav,Itgb3"]));
  });

  it("prefers lrm when both forms are present", () => {
    expect(readLrmList("lrm,ligand,receptor\nCcl2|Ccr2,Egf,Egfr\n", CATALOGUE))
      .toEqual(new Set(["Ccl2|Ccr2"]));
  });

  it("treats a reversed pair as unmatched", () => {
    expect(readLrmList("lrm\nCcr2|Ccl2\nEgf|Egfr\n", CATALOGUE)).toEqual(new Set(["Egf|Egfr"]));
    refused(() => readLrmList("ligand,receptor\nCcr2,Ccl2\n", CATALOGUE), /None of the 1/);
  });

  it("refuses a ligand column with no receptor column", () => {
    refused(() => readLrmList("ligand\nCcl2\n", CATALOGUE), /"lrm" column, or "ligand" and "receptor"/);
  });

  it("skips rows missing either half instead of inventing a mechanism", () => {
    expect(readLrmList("ligand,receptor\nCcl2,\nEgf,Egfr\n", CATALOGUE)).toEqual(new Set(["Egf|Egfr"]));
  });
});

describe("export round-trips through import", () => {
  it("genes", () => {
    expect(readGeneList(geneListCsv(["Egf", "Ccl2"]), GENES)).toEqual(new Set(["Ccl2", "Egf"]));
  });

  it("mechanisms, complexes included", () => {
    const csv = lrmListCsv(CATALOGUE);
    expect(csv.split("\n")[0]).toBe("lrm,ligand,receptor");
    expect(readLrmList(csv, CATALOGUE)).toEqual(new Set(CATALOGUE.map((e) => e.lrm)));
  });
});

// ── Store ───────────────────────────────────────────────────────────────────

const S = () => useStore.getState();
const settings = (i) => S().panels[i].settings;

describe("applying an imported list", () => {
  beforeEach(() => {
    useStore.setState({ panels: [makePanel(), makePanel()], panelCount: 2,
                        activePanel: 0, linkSettings: true });
  });

  it("replaces the LRM selection: everything not in the list is hidden", () => {
    S().toggleLrm("Ccl2|Ccr2");                        // prior state must not survive
    S().applyLrmList(new Set(["Ccl2|Ccr2"]), CATALOGUE.map((e) => e.lrm));
    expect(settings(0).hiddenLrms).toEqual(new Set(["Egf|Egfr", "Fn1|Itgav,Itgb3"]));
    expect(settings(1).hiddenLrms).toEqual(settings(0).hiddenLrms);   // linked
  });

  it("does not outlive a change of edge file", () => {
    S().applyLrmList(new Set(["Ccl2|Ccr2"]), CATALOGUE.map((e) => e.lrm));
    S().setPanelEdgeFile(0, "edges/other.parquet");
    expect(settings(0).hiddenLrms.size).toBe(0);
  });

  it("replaces the gene selection", () => {
    S().setSelectedGenes(new Set(["Itgav"]));
    S().applyGeneList(new Set(["Ccl2", "Egf"]), GENES);
    expect(settings(0).selectedGenes).toEqual(new Set(["Ccl2", "Egf"]));
  });

  it("collapses a list covering every gene to 'no filter'", () => {
    S().applyGeneList(new Set(GENES), GENES);
    expect(settings(0).selectedGenes).toBeNull();
  });
});
