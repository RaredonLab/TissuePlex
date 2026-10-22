/**
 * Gene-list and LRM-list CSV import / export.
 *
 * The format contract follows Xenium Explorer's gene-group upload: a required
 * header row, a named column, and names that must match the dataset exactly.
 * A Xenium Explorer `gene,group` file therefore works here unchanged — `group`
 * and any other extra column are ignored.
 *
 *   transcript species   header `gene`                 values: exact gene names
 *   LRM mechanisms       header `lrm`                  values: exact "ligand|receptor"
 *                        or headers `ligand`,`receptor` values: exact ligand / receptor
 *
 * Header names match in any letter case; values match exactly, case included.
 * A reversed pair ("Ccr2|Ccl2") is simply a different mechanism and does not
 * match. The only forgiveness on values is trimming surrounding whitespace,
 * which Excel adds and no gene symbol contains.
 *
 * Everything here is pure so it can be tested without a DOM. `readFileText` is
 * the one function that touches a File, and it only reads bytes.
 */

/** Thrown for any file the import refuses; `message` is shown to the user. */
export class ListImportError extends Error {}

// Excel workbooks are binary. Renaming one to .csv does not change its bytes,
// so the check is on content, with the extension as a second chance.
const XLSX_MAGIC = [0x50, 0x4b, 0x03, 0x04];             // zip container
const XLS_MAGIC  = [0xd0, 0xcf, 0x11, 0xe0];             // legacy OLE2

function startsWith(bytes, magic) {
  return magic.every((b, i) => bytes[i] === b);
}

/**
 * Decode an uploaded file's bytes to text, refusing Excel workbooks.
 * Handles the UTF-8 BOM Excel writes with "CSV UTF-8", and UTF-16 ("Unicode Text").
 */
export function decodeListFile(bytes, filename = "") {
  if (startsWith(bytes, XLSX_MAGIC) || startsWith(bytes, XLS_MAGIC) || /\.xlsx?$/i.test(filename)) {
    throw new ListImportError(
      "This is an Excel workbook, not a CSV. In Excel use File → Save As → \"CSV UTF-8\".");
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  const text = new TextDecoder("utf-8").decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Read a File (or Blob) and return its decoded text. */
export async function readFileText(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return decodeListFile(bytes, file.name ?? "");
}

/**
 * RFC 4180 parser: quoted fields may contain the delimiter, doubled quotes and
 * newlines. Quoting matters here, not just in principle — complex mechanisms
 * name several subunits joined by commas ("Itgav,Itgb3"), which a plain
 * split(",") tears into two columns.
 *
 * The delimiter is a comma unless the first line has none, in which case a tab
 * or a semicolon (Excel's CSV in comma-decimal locales) is used instead.
 */
export function parseCsv(text) {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  let delim = ",";
  if (!firstLine.includes(",")) {
    if (firstLine.includes("\t")) delim = "\t";
    else if (firstLine.includes(";")) delim = ";";
  }

  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delim) {
      row.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row);
      row = []; field = "";
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  // Blank lines carry no entry and are dropped wherever they occur.
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

/** Header row (first non-blank line) and a name → column-index lookup. */
function header(rows, expected) {
  if (rows.length === 0) throw new ListImportError("The file is empty.");
  const names = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name) => names.indexOf(name);
  const found = () => {
    const shown = rows[0].map((h) => h.trim()).join(", ");
    return shown.length > 80 ? `${shown.slice(0, 80)}…` : shown;
  };
  return { col, missing: () => new ListImportError(
    `Missing header: expected ${expected} in the first row, found "${found()}".`) };
}

function column(rows, idx) {
  return rows.slice(1).map((r) => (r[idx] ?? "").trim()).filter(Boolean);
}

function refuseEmpty(values, what) {
  if (values.length === 0) throw new ListImportError(`The file has a header but no ${what} below it.`);
}

function refuseNoMatch(values, what) {
  throw new ListImportError(
    `None of the ${values.length} ${what} in the file exist in this dataset `
    + `(e.g. "${values[0]}"). Names must match exactly, including letter case.`);
}

/**
 * Gene list → the Set of genes to show.
 * `vocab` is the gene list the picker offers (union across visible panels).
 */
export function readGeneList(text, vocab) {
  const rows = parseCsv(text);
  const h = header(rows, `a "gene" column`);
  const gi = h.col("gene");
  if (gi < 0) throw h.missing();

  const values = column(rows, gi);
  refuseEmpty(values, "gene names");
  const known = new Set(vocab);
  const matched = new Set(values.filter((g) => known.has(g)));
  if (matched.size === 0) refuseNoMatch(values, "gene names");
  return matched;
}

/** The id a catalogue entry is keyed on — mirrors LayerPanel and store.js. */
export const lrmId = (e) => e.lrm ?? `${e.ligand}|${e.receptor}`;

/**
 * LRM list → the Set of mechanism ids ("ligand|receptor") to keep visible.
 * `catalogue` is the LRM catalogue entries (union across visible panels).
 *
 * An `lrm` column wins when both forms are present; it is the one TissuePlex
 * itself writes, and it names the mechanism directly.
 */
export function readLrmList(text, catalogue) {
  const rows = parseCsv(text);
  const h = header(rows, `an "lrm" column, or "ligand" and "receptor" columns`);
  const li = h.col("lrm");
  const ids = new Set(catalogue.map(lrmId));

  let values;
  if (li >= 0) {
    values = column(rows, li);
  } else {
    const a = h.col("ligand"), b = h.col("receptor");
    if (a < 0 || b < 0) throw h.missing();
    // A row missing either half names no mechanism; skip it rather than
    // inventing "Ccl2|".
    values = rows.slice(1)
      .map((r) => [(r[a] ?? "").trim(), (r[b] ?? "").trim()])
      .filter(([l, r]) => l && r)
      .map(([l, r]) => `${l}|${r}`);
  }
  refuseEmpty(values, "mechanisms");
  const matched = new Set(values.filter((v) => ids.has(v)));
  if (matched.size === 0) refuseNoMatch(values, "mechanisms");
  return matched;
}

// ── Export ───────────────────────────────────────────────────────────────────

function csvField(v) {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows) {
  return rows.map((r) => r.map(csvField).join(",")).join("\n") + "\n";
}

/** Genes in the import format; re-importing the file reproduces the selection. */
export function geneListCsv(genes) {
  return toCsv([["gene"], ...[...genes].sort().map((g) => [g])]);
}

/**
 * Mechanisms in the import format. `lrm` comes first because the import reads
 * it in preference; ligand and receptor ride along for whoever opens it in R.
 */
export function lrmListCsv(entries) {
  return toCsv([["lrm", "ligand", "receptor"],
    ...entries.map((e) => [lrmId(e), e.ligand ?? "", e.receptor ?? ""])]);
}
