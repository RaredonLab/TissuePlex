## NICHESv2 on Xenium PPLR Rat Data
## Dataset: RQ32878-002_Slide_2_PPLR_726-2 / Rat-PPLR-Run1
## ~330K cells, spatial mode (kNN neighborhood graph)

library(NICHESv2)
library(Matrix)
library(data.table)

# ── 0. Paths ───────────────────────────────────────────────────────────────────

data.dir  <- "/Users/msbr/Large Files/Xenium/for-docker-testing/RQ32878-002_Slide_2_PPLR_726-2/Rat-PPLR-Run1"
mtx.dir   <- file.path(data.dir, "cell_feature_matrix")
meta.path <- file.path(data.dir, "cell-metadata", "PPLR.meta.data.csv")

# ── 1. Load count matrix (standard 10X MEX format) ────────────────────────────

message("Loading count matrix...")
barcodes <- read.table(file.path(mtx.dir, "barcodes.tsv.gz"),
                       header = FALSE, stringsAsFactors = FALSE)[[1]]
features <- read.table(file.path(mtx.dir, "features.tsv.gz"),
                       header = FALSE, stringsAsFactors = FALSE, sep = "\t")

count.mtx <- readMM(file.path(mtx.dir, "matrix.mtx.gz"))
# MEX format is features x barcodes
rownames(count.mtx) <- features[[2]]   # gene symbols (column 2)
colnames(count.mtx) <- barcodes
count.mtx <- as(count.mtx, "CsparseMatrix")   # convert to dgCMatrix

message(sprintf("  Matrix: %d genes x %d cells", nrow(count.mtx), ncol(count.mtx)))

# ── 2. Load cell metadata ─────────────────────────────────────────────────────

message("Loading cell metadata...")
meta.data <- read.csv(meta.path, row.names = 1, check.names = FALSE)
message(sprintf("  Metadata: %d cells x %d columns", nrow(meta.data), ncol(meta.data)))

# ── 3. Align barcodes ─────────────────────────────────────────────────────────
# Keep only cells present in both count matrix and metadata

shared <- intersect(colnames(count.mtx), rownames(meta.data))
message(sprintf("  Shared barcodes: %d (matrix has %d, metadata has %d)",
                length(shared), ncol(count.mtx), nrow(meta.data)))

count.mtx <- count.mtx[, shared, drop = FALSE]
meta.data  <- meta.data[shared, , drop = FALSE]

# Verify x/y are numeric
meta.data$x <- as.numeric(meta.data$x)
meta.data$y <- as.numeric(meta.data$y)

# ── 4. Choose cell-type annotation column ────────────────────────────────────
# Available options (comment/uncomment to choose):
#   "Class.1"     — broadest: Immune / Mesenchyme / Epithelium / ...
#   "LM_Type"     — Myeloid / Lymphoid / ... (lineage-level)
#   "Type.5"      — recommended default: cell-type level
#   "Type.3.fine" — finest resolution

cell.type.col <- "Type.6"

# ── 5. Run NICHESv2 ──────────────────────────────────────────────────────────

# Neighborhood parameter: radius in micrometers.
# Use Explore_Radius_Neighborhood() to interactively tune this value.
radius.um <- 25

message(sprintf("Running NICHESv2 (spatial, rad=%g um, cell.type.col='%s')...", radius.um, cell.type.col))

niches.obj <- create_NICHESObject(
  count.mtx    = count.mtx,
  meta.data    = meta.data,
  LRM.db       = "connectomedb2025",
  species      = "rat",
  mode         = "spatial",
  sample.col   = "TMA",          # process each TMA core independently, then merge
  cell.type.col = cell.type.col, # used for neighborhood composition aggregation
  rad          = radius.um,
  method       = "product",
  normalize.method = "prop",
  n.cores      = 4L,
  verbose      = TRUE
)

message("NICHESObject created.")
print(niches.obj)

# ── 6. Aggregate neighborhoods ────────────────────────────────────────────────

message("Aggregating neighborhoods...")
niches.obj <- aggregate_NICHESObject(
  niches.obj,
  cell.type.col = cell.type.col,
  n.cores       = 4L
)

message("Done. Aggregations available:")
print(names(niches.obj$aggregations))

# ── 7. Save output ────────────────────────────────────────────────────────────

out.path <- file.path(data.dir, "NICHESv2_PPLR_rad25.rds")
saveRDS(niches.obj, out.path)
message(sprintf("Saved NICHESObject to: %s", out.path))
