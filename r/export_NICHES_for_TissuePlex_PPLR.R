## Export NICHESv2 PPLR results → TissuePlex edges.parquet
##
## Prerequisite: run run_NICHESv2_Xenium_PPLR.R first so the RDS file exists.
## The output directory is printed at the end and can be pointed at directly
## in TissuePlex as a new dataset.
##
## All edges in $edge.list are exported.  Scored edges (in $edge.data) produce
## one row per LRM; unscored edges produce one placeholder row with NA for LRM
## fields — this lets TissuePlex render the full tissue graph.
##
## For large objects (10 M+ edges) set n.threads to your MacBook's
## performance-core count (e.g. 10 on M3 Pro) to maximise throughput.

library(NICHESv2)
library(data.table)

# ── 0. Paths ──────────────────────────────────────────────────────────────────

rds.path <- "/Users/msbr/Large Files/Xenium/for-docker-testing/RQ32878-002_Slide_2_PPLR_726-2/Rat-PPLR-Run1/NICHESv2_PPLR_rad25.rds"

# TissuePlex dataset directory (one folder = one dataset in TissuePlex)
tp.dir   <- "/Users/msbr/Large Files/TissuePlex/PPLR_rad25"
tp.edges <- file.path(tp.dir, "edges.parquet")

# ── 1. Load NICHESObject ──────────────────────────────────────────────────────

message("Loading NICHESObject...")
niches.obj <- readRDS(rds.path)
message(sprintf(
  "  Loaded: %d edges, %d LRMs in edge.data",
  nrow(niches.obj$edge.list),
  data.table::uniqueN(niches.obj$edge.data[["LRM"]])
))

# ── 2. Export ─────────────────────────────────────────────────────────────────

# 'Type.6' is the cell-type column used when building this object.
# Adjust celltype.col if you built with a different annotation level.
export_to_TissuePlex(
  object       = niches.obj,
  output.path  = tp.edges,
  x.col        = "x",
  y.col        = "y",
  celltype.col = "Type.6",
  n.threads    = 8L          # set to number of performance cores on your Mac
)

# ── 3. Sanity-check the output ────────────────────────────────────────────────

message("\nVerifying output...")
library(arrow)

pq <- arrow::read_parquet(tp.edges)

message(sprintf("  Rows        : %d", nrow(pq)))
message(sprintf("  Edges       : %d", dplyr::n_distinct(pq$edge)))
message(sprintf("  LRMs        : %d", dplyr::n_distinct(pq$lrm)))
message(sprintf("  Autocrine   : %d rows", sum(pq$is_autocrine)))
message(sprintf("  Score range : %.3g – %.3g", min(pq$score), max(pq$score)))
message(sprintf("  score_norm  : sums to 1 per edge? %s",
  all(abs(tapply(pq$score_norm, pq$edge, sum) - 1) < 1e-6)
))

message("\nColumn schema:")
print(sapply(pq, class))

message("\nFirst 6 rows:")
print(head(as.data.frame(pq)))

message(sprintf("\nTissuePlex dataset directory: %s", tp.dir))
message("Point TissuePlex at this directory to load the edge layer.")
