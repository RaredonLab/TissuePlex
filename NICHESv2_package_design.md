# NICHESv2 -- Package Design & Status
# Updated: 2026-04-30

================================================================================
CONVENTIONS (no exceptions)
================================================================================

Functions       : underscore  e.g. create_NICHESObject(), CellToCell_InSitu()
Variables/args  : dot         e.g. n.cores, bg.color, edge.list
Edge ID         : "SendingCell|ReceivingCell"
LRM ID          : "ligand|receptor"
Gene complexes  : "gene1_gene2"
Score columns   : score (raw)  |  score.norm (normalised, proportional)

PARALLELISM (CRITICAL -- no exceptions):
  socket clusters ONLY: parallel::makeCluster + parLapply + on.exit(stopCluster)
  NEVER mclapply (Unix-only, crashes on macOS with ggplot2).
  Always clusterEvalQ: data.table::setDTthreads(1)

NAMESPACE: Never hand-edit. Use @import data.table / @import ggplot2 in
  NICHESv2-package.R. Run devtools::document() TWICE after changes.

ONE EXPORTED FUNCTION PER FILE.


================================================================================
NICHESObject -- 15 SLOTS
================================================================================

$cell.list     chr vector   -- barcodes (colnames of count.mtx), all modes
$cell.data     data.table   -- SPARSE: cell|gene|score|score.norm; key(cell,gene)
                               score.norm = gene/total within cell; raw counts always
$cell.meta     data.table   -- cell|x|y|<meta cols>; key: cell
$edge.list     data.table   -- edge|SendingCell|ReceivingCell; key: edge
$edge.data     data.table   -- SPARSE: edge|LRM|score|score.norm; key(edge,LRM)
                               score.norm = proportional within edge
$edge.meta     data.table   -- edge|SendingCell|ReceivingCell|Sending.*|Receiving.*|Joint.*
$neighborhood.cell.list     -- named list: cell -> character vector of neighbor barcodes
$neighborhood.edge.list     -- named list: cell -> character vector of edge IDs
$neighborhood.meta          -- data.table: cell|n.neighbors|n.edges; key: cell
$gene.list     chr vector   -- rownames(count.mtx)
$gene.meta     data.table   -- keyed: gene
$LRM.list      chr vector   -- valid "ligand|receptor" strings
$LRM.meta      data.table   -- LRM|ligand|receptor|<extras>; keyed: LRM
$segmentation  sf object    -- NULL until add_segmentation(); sf in Suggests
$aggregations  list         -- named list of aggregation data.tables:
                               $neighborhood.edge.agg   data.table, keyed (cell,LRM)
                               $neighborhood.composition data.table, keyed cell
                               Starts as list() until aggregate_NICHESObject() or
                               individual add_*() functions are called.

Neighborhood slots are always populated by create_NICHESObject() using fixed
parameters: edge.filter.mode = "both_in_neighborhood", remove.autocrine = FALSE.
They store IDs only -- join to $edge.data/$edge.meta for scores/coordinates.
When add_neighborhoods(overwrite=TRUE) is called, stale $neighborhood.edge.agg
and $neighborhood.composition entries are cleared automatically with a message.

Object attributes:
  attr(obj,"mode")             = "spatial"|"sampled"
  attr(obj,"sample.col")       = col name string (if split by sample)
  attr(obj,"edge.filter.mode") = set by add_neighborhoods(); always
                                 "both_in_neighborhood" from create_NICHESObject()
  attr(obj,"remove.autocrine") = set by add_neighborhoods(); always FALSE
                                 from create_NICHESObject()


================================================================================
EXPORTED FUNCTIONS
================================================================================

Each lives in its own file under R/.

-- LR DATABASE --
load_LRM_database(db, species, ligand.col, receptor.col, verbose)
  db: "omnipath" | "fantom5" | user data.frame
  FANTOM5: human/mouse/rat/pig from bundled .rda; no internet, no OmnipathR
  OmniPath: human/mouse/rat via import_ligrecextra_interactions(organism=<code>)
  -> data.frame with "ligand", "receptor"

-- EDGE LIST CONSTRUCTORS --
create_Edgelist_Spatial(coord, k, rad, n.cores)
  -> data.table(from|to|weight|x.from|y.from|x.to|y.to) + autocrine self-loops

create_Edgelist_PseudoBulk(meta.data, cell.type.col)
  -> data.table(from|to) with type labels; deterministic

create_Edgelist_SamplingByType(meta.data, cell.type.col, seed=42L, max.cells)
  -> data.table(from|to) with barcodes; attrs: mode="sampled"

-- SCORING --
compute_CellToCell(count.mtx, edge.list, LRM.db, ligand.col, receptor.col,
                   method, n.cores)
  -> plain named list: $edges | $lr.meta
  $edges:   data.table -- from|to|ligand|receptor|LRM|score (+ x.from|y.from|
            x.to|y.to for spatial edgelists); keyed (from, to, LRM)
  $lr.meta: data.table -- ligand|receptor|LRM + extras from LRM.db;
            keyed (ligand, receptor)

compute_PseudoBulk_Connectivity(count.mtx, meta.data, LRM.db, cell.type.col,
                                ligand.col, receptor.col, method,
                                normalize.method, n.cores, verbose)
  -> plain data.table (NOT NICHESObject):
    SendingType|ReceivingType|LRM|score|score.norm

-- OBJECT CONSTRUCTION --
create_NICHESObject(count.mtx, meta.data, LRM.db,
                    mode="spatial", species="human", sample.col=NULL,
                    cell.type.col=NULL, ligand.col, receptor.col,
                    k, rad, seed=42L, max.cells,
                    smooth=FALSE, smooth.k=9L, n.pcs=30L,
                    method, normalize.method, gene.meta, n.cores, verbose)
  Dispatcher only. Routes to .create_NICHESObject_single() or
  .create_NICHESObject_by_sample() depending on sample.col. After object
  construction, always calls add_neighborhoods() with fixed parameters:
    edge.filter.mode = "both_in_neighborhood", remove.autocrine = FALSE.
  Neighborhood slots are ALWAYS populated after create_NICHESObject().
  edge.filter.mode and remove.autocrine are NOT user-facing parameters here.
  Use add_neighborhoods() directly to experiment with other combinations.
  -> NICHESObject
  FILE: R/create_NICHESObject.R (dispatcher only -- single function in this file)

-- OBJECT EXTENSIONS --
add_neighborhoods(niches.obj, edge.filter.mode="both_in_neighborhood",
                  remove.autocrine=FALSE, overwrite=FALSE, n.cores, verbose)
  Calls extract_neighborhoods() on niches.obj$edge.list, populates 3 slots.
  overwrite=FALSE hard-errors if slots already populated.
  overwrite=TRUE clears stale $neighborhood.edge.agg and
  $neighborhood.composition before recomputing, then sets both
  attr(obj,"edge.filter.mode") and attr(obj,"remove.autocrine").
  FILE: R/add_neighborhoods.R

extract_neighborhoods(edge.list, edge.filter.mode, remove.autocrine,
                      n.cores, verbose)
  edge.filter.mode: "both_in_neighborhood" (default) |
                    "any_in_neighborhood" | "central_cell_only"
  -> list($neighborhood.cell.list, $neighborhood.edge.list, $neighborhood.meta)
  FILE: R/extract_neighborhoods.R

add_segmentation(niches.obj, seg.sf)
  Hard error if any cell missing polygon.

add_cell_meta(niches.obj, new.meta, rebuild.edge.meta=TRUE)
  Joins new metadata onto $cell.meta; calls build_edge_meta() to refresh
  $edge.meta unless suppressed.
  FILE: R/add_cell_meta.R

merge_NICHESObjects(..., verbose=TRUE)
  Accepts: positional args | pre-built list | explicit list() call.
  Hard errors: empty list | non-NICHESObject | mode mismatch | dup barcodes.
  Slot strategy: rbindlist data slots; union gene/LRM lists; sf::rbind segs.
  Self-contained -- no internal helper dependency.
  FILE: R/merge_NICHESObjects.R

-- DATA INGEST --
extract_NICHESInputs_Seurat(seurat.obj, assay="RNA", layer="counts", verbose)
  V4/V5 detection via inherits(assay.obj,"Assay5"), NOT package version.
  -> list(count.mtx, meta.data); user calls create_NICHESObject() next.
  Suggests: SeuratObject

extract_NICHESInputs_AnnData(file, layer="counts", obs.cols=NULL, verbose)
  rhdf5 only. No Python, conda, basilisk, or zellkonverter. R >= 4.2.
  -> list(count.mtx, meta.data)
  Suggests: rhdf5

-- VISUALIZATION --
CellToCell_InSitu(niches.obj, LRM.list, folder, ..., n.cores)
  Batch PNG; socket cluster; pre-computes all.edges before workers.

CellToCell_InSitu_Single_LRM(niches.obj, LRM, ..., precomputed.bg=NULL)

-- LEGACY AGGREGATION --
Aggregate_CellToCell_Edges(niches.obj, stat)
  -> list($sending, $receiving): full cell x LRM grid, zero-filled.
  NOTE: This is the legacy aggregation function predating the $aggregations
  slot design. Kept for backward compatibility.

-- AGGREGATION (current design) --
aggregate_NICHESObject(niches.obj, cell.type.col=NULL, n.cores=1L, verbose=TRUE)
  Convenience wrapper. Calls add_neighborhood_edge_agg() then optionally
  add_neighborhood_composition(). Both steps always fully recompute and
  replace their slots -- no incremental update mode (Seurat convention).
  FILE: R/aggregate_NICHESObject.R

add_neighborhood_edge_agg(niches.obj, n.cores=1L, verbose=TRUE)
  Four-category unified edge aggregation. For each (cell, LRM) pair,
  classifies every neighborhood edge into one of:
    out       -- focal cell is SendingCell (non-autocrine)
    in        -- focal cell is ReceivingCell (non-autocrine)
    cross     -- focal cell is neither endpoint (non-autocrine)
    autocrine -- SendingCell == ReceivingCell (ANY cell in neighborhood)
  Note: autocrine captures all self-loop edges in the neighborhood, not
  only those where the focal cell itself is the self-looping cell.
  Always computes all three score methods (sum, mean, cmean) for all four
  categories plus totals and score.inout.ratio. Always replaces slot.
  Requires neighborhood slots to be populated.
  -> $aggregations$neighborhood.edge.agg keyed (cell,LRM)
  Column structure:
    count.in | count.out | count.cross | count.autocrine | count.total
    score.{cat}.sum   -- total score per category
    score.{cat}.mean  -- sum / n.edges in neighborhood (LRM-agnostic denom)
    score.{cat}.cmean -- sum / count.{cat}; NA when count == 0
    score.total.*     -- sum across all four categories
    score.inout.ratio -- score.in.sum / score.out.sum; NA when out == 0
  FILE: R/add_neighborhood_edge_agg.R

add_neighborhood_composition(niches.obj, cell.type.col, include.self=TRUE,
                              normalize=TRUE, verbose=TRUE)
  Source: $edge.list + $cell.meta only. No neighborhood slot dependency.
  Neighbor = any cell sharing an edge (either direction), deduplicated.
  Spatial mode only (hard error for sampled mode).
  Always overwrites -- no overwrite parameter.
  Column names: gsub("[^A-Za-z0-9.]",".",type) + .neighbor.count/.neighbor.prop
  Zero-filled against full dataset type universe.
  FILE: R/add_neighborhood_composition.R


================================================================================
INTERNAL HELPERS (utils.R)
================================================================================

Small utilities only:
  .parse_complex(gene.str)        "gene1_gene2" -> c("gene1","gene2")
  .genes_available(gene.str, set) all components in set?
  .prop_norm(x)                   x/sum(x); zeros if sum==0
  .categorical_cols(dt, exclude)  character or factor column names
  .new_NICHESObject(...)          15-slot constructor (aggregations = list())
  .coerce_meta(meta.data)         -> keyed data.table with "cell" col
  .is_NICHESObject(x)             listed here but does NOT exist in utils.R;
                                   always use inherits(x,"NICHESObject") directly
  %||%                            null-coalescing operator

Internal branch implementations of create_NICHESObject() (each in its own file):
  .create_NICHESObject_single()    R/create_NICHESObject_single.R
  .create_NICHESObject_by_sample() R/create_NICHESObject_by_sample.R

h5ad internal helpers (in R/extract_NICHESInputs_AnnData.R, unexported):
  .h5ad_attrs, .h5ad_encoding, .h5ad_obs_names, .h5ad_var_names,
  .h5ad_available_layers, .h5ad_read_sparse, .h5ad_read_matrix, .h5ad_read_obs

Internal helpers in dedicated files:
  .compute_LRM_Score(lig.str, rec.str, count.mtx,
                  sending.cells, receiv.cells, method="product")
  Single LR pair -> numeric vector of length n.edges
  method: "product" | "minimum"; supports gene complexes via "_"
  FILE: R/compute_LRM_Score.R

  .build_cell_data(count.mtx, normalize.method="prop")
  Sparse count matrix -> long-format cell|gene|score|score.norm data.table.
  FILE: R/build_cell_data.R

  .build_edge_meta(edge.list.dt, cell.meta)
  Joins cell metadata onto edge list. Adds Sending.*, Receiving.*, Joint.*
  columns (Joint only for character/factor cols).
  FILE: R/build_edge_meta.R

  .smooth_expression(count.mtx, barcodes, k=9L, n.pcs=30L)
  PCA + kNN smoothing. Replaces target columns with neighborhood-averaged
  raw counts. Note: irlba::irlba(..., fastpath=FALSE) and NO center
  argument -- never change.
  FILE: R/smooth_expression.R

globalVariables declarations live in utils.R (NOT NICHESv2-package.R).
Organized in per-function comment blocks at the bottom of utils.R.
Current blocks: score/LRM/cell/edge core names, add_neighborhood_edge_agg
columns, add_neighborhood_composition columns.


================================================================================
PACKAGE INFRASTRUCTURE
================================================================================

Imports: data.table(>=1.14), Matrix(>=1.5), methods, RANN(>=2.6), dbscan(>=1.1),
         ggplot2(>=3.4), irlba(>=2.3.0), scales, parallel
Suggests: OmnipathR, sf, testthat(>=3.0), withr, SeuratObject, rhdf5

Bundled data (data/):
  ncomms8866_orig.rda -- FANTOM5 original unfiltered table; R object name is
    ncomms8866 (file and object names differ). data(ncomms8866) fails with
    LazyData: false. Access via load_LRM_database("fantom5", ...) only.
  ncomms8866_human/mouse/rat/pig.rda -- FANTOM5 LR pairs, species-converted
    per Raredon et al. 2019. Loaded internally via utils::data().

Tests (all passing):
  test-compute_CellToCell.R               test-create_Edgelist_Spatial.R
  test-compute_PseudoBulk_Connectivity.R  test-create_Edgelist_PseudoBulk.R
  test-create_NICHESObject.R              test-create_Edgelist_SamplingByType.R
  test-merge_NICHESObjects.R              test-utilities.R
  test-add_segmentation.R                 test-Aggregate_CellToCell_Edges.R
  test-CellToCell_InSitu.R
  test-extract_NICHESInputs_Seurat.R
  test-extract_NICHESInputs_AnnData.R
  test-compute_LRM_Score.R                (use NICHESv2::: to call internal functions)
  test-smooth_expression.R                (use NICHESv2::: to call internal functions)
  test-extract_neighborhoods.R
  test-add_neighborhoods.R

  TODO: test-add_neighborhood_edge_agg.R, test-add_neighborhood_composition.R,
        test-aggregate_NICHESObject.R

Fixtures: data-raw/build_NICHESv2_example.R -- re-run when schema or bundled
  data changes. Produces data/NICHESv2_inputs.rda and data/NICHESv2_example.rda.
  No inst/ folder; inst/testdata/ was deleted.
  NICHESv2_example now has neighborhood slots populated (always, by design).
  No aggregation slots pre-populated in fixture.

Intentional skips (3): full-batch InSitu (>5 LRMs), irlba-absent path,
  replaced placeholder in test-compute_PseudoBulk_Connectivity.R

R CMD check status: 0 errors | 0 warnings | 1 note
  (N1: timestamp/network issue on dev machine -- unfixable in code, ignore)


================================================================================
CHECKLIST -- EVERY NEW EXPORTED FUNCTION (CRAN compliance)
================================================================================

Before delivering any new exported function, verify ALL of the following:
  [ ] Input guard: inherits(x, "NICHESObject") -- NOT .is_NICHESObject()
  [ ] All dot-prefixed helpers called exist in utils.R (grep to confirm)
  [ ] All NSE column names in := or .() declared in globalVariables() in utils.R
  [ ] New globalVariables block appended at END of utils.R globalVariables list
  [ ] Socket cluster: clusterExport uses envir = environment() for local vars
  [ ] No mclapply -- socket clusters only (parallel::makeCluster + parLapply)
  [ ] devtools::document() run twice after any structural change
  [ ] One exported function per file, file named after the function
  [ ] No non-ASCII characters in .R file (tools::showNonASCII to verify)
  [ ] Use -- not em/en dash; ... not ellipsis; straight quotes only
  [ ] @seealso links only reference functions that already exist
  [ ] Verification greps: count occurrences in new text AND existing file
      before stating expected counts -- never guess from memory


================================================================================
KEY GOTCHAS (read before touching these areas)
================================================================================

irlba/Matrix:  fastpath=FALSE in smooth_expression() AND no center argument
               -- NEVER change. Matrix>=1.6-2 removed as_cholmod_sparse();
               fastpath calls it. Omitting center avoids the dependency
               entirely; kNN distances are unchanged by centering.

data.table composite key join:
  NEVER dt1[dt2, on="col"] when dt2 has composite key.
  Use: idx <- match(dt1$col, dt2$col); dt1[, new := dt2$other[idx]]

socket cluster + asNamespace():
  clusterExport(cl, c("compute_LRM_Score",".parse_complex",".genes_available"),
                envir = asNamespace("NICHESv2"))
  Works under both devtools::load_all() and installed builds. Exporting a
  function from the package does NOT remove the need to clusterExport it
  -- workers still need the symbol in their global env.
  For local functions defined inside the calling function, use
  envir = environment() instead of asNamespace().

c() on named lists prepends outer names with dot separator:
  c(list("1" = list(a = 1))) -> list("1.a" = 1)
  Fix: unname() the outer list before c(). Hit this in extract_neighborhoods()
  parallel merge path.

sf dependency: keep in Suggests, NOT Imports.

Barcode uniqueness across samples: hard error in both create_NICHESObject()
  and merge_NICHESObjects(); tip: paste0(sample.id,"_",barcode).

Outer sample loop is ALWAYS sequential -- inner compute_CellToCell() already
  uses n.cores; nested socket clusters must never be created.

FANTOM5 must NEVER be loaded via OmniPath's import_intercell_network():
  That API always returns human gene symbols regardless of the datasets
  filter. FANTOM5 must always be loaded from bundled .rda objects.

OmniPath function: use import_ligrecextra_interactions(organism=<code>),
  NOT import_intercell_network().

Seurat V4 vs V5 object detection:
  NEVER check SeuratObject package version. ALWAYS check:
    inherits(seurat.obj@assays[[assay]], "Assay5")
  TRUE = V5 Assay5 structure; FALSE = V4 Assay structure.

rhdf5 logical attributes:
  rhdf5::h5writeAttribute() does NOT support logical (TRUE/FALSE) values.
  Write boolean attributes as 0L/1L (integer) instead.

h5ad matrix orientation:
  AnnData stores all matrices as obs x vars (cells x genes). rhdf5 reads
  dense HDF5 arrays with reversed dims, so [n_obs, n_vars] HDF5 -> [n_vars,
  n_obs] in R, already genes x cells. Sparse matrices must be transposed
  explicitly after reconstruction.

Style B section markers (## Title ---- and # filename ----):
  These are RStudio-foldable. Don't 'fix' them back to banner blocks during
  future edits.

smooth = TRUE has zero test coverage:
  The smoothing branch in create_NICHESObject() is not exercised by any
  current test. A bug at the call site (line 208 of
  create_NICHESObject_single.R) sat undetected through Pass 1 because of
  this. Add at least one minimal test before relying on this code path.

[.NICHESObject attribute propagation bug:
  [.NICHESObject does not copy attr(x,"mode") or attr(x,"sample.col") to
  the subsetted result. Fix before CRAN: add
    attr(result, "mode")       <- attr(x, "mode")
    attr(result, "sample.col") <- attr(x, "sample.col")
  to R/NICHESObject_class.R before the return statement. Note: aggregation
  slots are correctly dropped on subset (message emitted).

Non-ASCII characters in .R files:
  CRAN prohibits non-ASCII characters anywhere in .R files, including
  comments and roxygen strings. Em dashes, en dashes, curly quotes, and
  ellipsis characters are common offenders. Always use:
    -- instead of em/en dash
    ... instead of ellipsis character
    straight quotes only
  Detect with: tools::showNonASCII(readLines("R/file.R"))

inherits() vs .is_NICHESObject():
  .is_NICHESObject() is listed in the design doc but does NOT exist in
  utils.R. Always use inherits(x, "NICHESObject") directly in new functions.

globalVariables pattern for data.table NSE:
  All data.table column names used with NSE must be declared via
  utils::globalVariables() in utils.R (NOT NICHESv2-package.R) to suppress
  R CMD check "no visible binding" notes. Similarly, base R functions used
  without explicit :: (head, setNames, as, median, quantile, sd) need
  @importFrom tags in NICHESv2-package.R.

FANTOM5 original file vs object name mismatch:
  data/ncomms8866_orig.rda contains the R object ncomms8866. Because
  LazyData: false, data("ncomms8866") will fail (looks for ncomms8866.rda).
  Never call data(ncomms8866) in examples or code. Always use
  load_LRM_database("fantom5", species = ...) as the access interface.

S3 method source vs test file naming:
  S3 methods (print, summary, dim, length, [) are defined in
  R/NICHESObject_class.R -- NOT a file called NICHESObject_methods.R.
  The test file test-NICHESObject_methods.R is named after the behavior
  under test (methods), not the source file. Both names are correct and
  intentional.

CI is now live on dev/main via .github/workflows/R-CMD-check.yaml

Neighborhood slots always populated after create_NICHESObject():
  edge.filter.mode and remove.autocrine are fixed (not user-facing) in
  create_NICHESObject(). Users who want different combinations must call
  add_neighborhoods() directly with overwrite=TRUE. This is intentional --
  the advisor decision was to give users less freedom here to avoid
  confusion about neighborhood definitions in the main constructor.

Aggregation slot design (current):
  $aggregations is a named list with at most two entries:
    $neighborhood.edge.agg    -- always replaced on each call (no overwrite param)
    $neighborhood.composition -- always replaced on each call (no overwrite param)
  Both functions follow the Seurat convention: call = recompute + replace.
  add_neighborhood_edge_agg() has no methods or overwrite parameters.
  aggregate_NICHESObject() has no methods, overwrite, by.direction, include.self,
  or normalize parameters -- these are all fixed internally.

autocrine edge classification in add_neighborhood_edge_agg():
  The "autocrine" category captures ALL self-loop edges (SendingCell ==
  ReceivingCell) in the neighborhood, not only those where the focal cell
  is the self-looping cell. A neighbor cell B with a self-loop B->B
  contributes to the focal cell's count.autocrine. This is intentional --
  it captures autocrine signaling activity within the local environment.

Non-spatial mode and neighborhood composition:
  add_neighborhood_composition() hard-errors for mode="sampled". In sampled
  mode, edges are statistically paired and do not reflect physical proximity,
  so composition would reflect sampling design not local tissue structure.
  add_neighborhood_edge_agg() works in sampled mode but interpretation shifts:
  results reflect signaling among co-occurring cell pairs, not a spatial
  microenvironment. Document this distinction clearly in vignettes.

print.NICHESObject neighborhood display:
  The print method now shows neighborhood slot contents explicitly:
    Neighborhoods: N cells | M edges (mode: X, autocrine: included/removed)
  And the slot legend shows all three neighborhood slots individually.
  The old "reserved (NULL)" text has been removed.


================================================================================
TEST SUITE STATUS
================================================================================

Full rewrite completed. All test files pass under both devtools::test() and
R CMD check. Coverage: ~220+ test_that blocks.

File structure (all in tests/testthat/):
  helper-testutils.R              -- keep (make_grid_coord utility)
  test-compute_LRM_Score.R        test-create_Edgelist_Spatial.R
  test-smooth_expression.R        test-create_Edgelist_PseudoBulk.R
  test-extract_neighborhoods.R    test-create_Edgelist_SamplingByType.R
  test-add_neighborhoods.R        test-compute_CellToCell.R
  test-merge_NICHESObjects.R      test-compute_PseudoBulk_Connectivity.R
  test-Explore_Radius_Neighborhood.R  test-create_NICHESObject.R
  test-extract_NICHESInputs_Seurat.R  test-load_LRM_database.R
  test-extract_NICHESInputs_AnnData.R test-add_cell_meta.R
  test-add_segmentation.R         test-Aggregate_CellToCell_Edges.R
  test-CellToCell_InSitu.R        test-NICHESObject_methods.R

Fixture strategy:
  - data(NICHESv2_example): add_cell_meta, add_segmentation,
    Aggregate_CellToCell_Edges, CellToCell_InSitu, NICHESObject_methods,
    add_neighborhood_edge_agg, add_neighborhood_composition,
    aggregate_NICHESObject examples
  - Inline synthesis: all other files
  - helper-testdata.R and inst/testdata/ DELETED
  - NICHESv2_example now always has neighborhood slots populated

Intentional skips (3):
  - Full-batch InSitu (> 5 LRMs)
  - irlba-absent path
  - Replaced placeholder in test-compute_PseudoBulk_Connectivity.R

R CMD check status: 0 errors | 0 warnings | 1 note
  (N1: timestamp/network issue on dev machine -- unfixable in code, ignore)


================================================================================
PENDING DECISIONS
================================================================================

1. [RESOLVED] extract_neighborhoods integrated into create_NICHESObject()
   with fixed parameters: edge.filter.mode="both_in_neighborhood",
   remove.autocrine=FALSE. Not user-facing in create_NICHESObject().

2. [RESOLVED] Default edge.filter.mode = "both_in_neighborhood".

3. Performance optimization for large datasets: pre-extract gene expression
   vectors once rather than per LRM pair; pre-filter silent LRM pairs.
   Identified but not yet implemented.

4. Aggregate_CellToCell_Edges future design: sparse dgCMatrix (cells x LRMs)
   plus inverted index $active -- pending advisor discussion.

5. PCA kNN smoothing validation PAUSED:
   Advisor hesitant to apply smoothing to actual project data. Function
   remains exported and tested, but no further validation work until advisor
   decision is resolved. Dataset choice consequently also paused.

6. Rename "sampled" mode to "nonspatial": affects attr(obj,"mode"),
   create_NICHESObject mode argument, and all internal checks. Do in a
   dedicated session to avoid partial changes. TODO.

7. compare_neighborhood_modes() future function: compare the same aggregation
   statistic across objects built with different neighborhood parameters.
   Returns a standalone data.table (not stored in object). Not yet designed.

8. Aggregation test suite: write together as a group.
   Needed files:
     test-add_neighborhood_edge_agg.R
     test-add_neighborhood_composition.R
     test-aggregate_NICHESObject.R

9. README and vignettes: update after aggregation test suite is complete.
   Add aggregate_NICHESObject() to the standard workflow in README.
   Vignette 1 (eval=TRUE): add minimal aggregation section using bundled data.
   Vignettes 2-3 (eval=FALSE): update workflow if warranted.

10. score.total.cmean bug in add_neighborhood_edge_agg(): currently
    score.total.cmean = score.total.sum / count.total which is correct.
    Confirm this is the intended formula (re-derived from total, not summed
    from directional cmeans) before closing.
