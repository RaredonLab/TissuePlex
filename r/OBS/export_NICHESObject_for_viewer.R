# export_NICHESObject_for_viewer.R
#
# Converts a NICHESv2 cell-cell communication result to the edges.parquet
# schema expected by TissuePlex.  Place the output file in the root
# of the Xenium output directory alongside experiment.xenium.
#
# Intended to become part of the NICHESv2 R package.  Until then, source()
# this file directly.
#
# Dependencies: Seurat, Matrix, arrow
# Optional:     jsonlite (only needed if reading experiment.xenium for
#               pixel_size validation)


#' Export a NICHESv2 result to edges.parquet for TissuePlex
#'
#' @param niches_obj  A Seurat object produced by NICHESv2 where columns are
#'   directed edges ("SendingBarcode--ReceivingBarcode") and rows are LRMs
#'   ("Ligand--Receptor").  If a named list is supplied, the element named by
#'   \code{seurat_slot} is used (e.g. the CellToCell slot of a multi-niche
#'   output list).
#'
#' @param xenium_dir  Path to the Xenium output folder.  Must contain
#'   \code{cells.parquet} (or \code{cells.csv.gz}) for centroid coordinates.
#'
#' @param output_file  Where to write the parquet.  Defaults to
#'   \code{file.path(xenium_dir, "edges.parquet")}.
#'
#' @param score_slot  Which Seurat slot holds the scores: \code{"data"}
#'   (normalised, default) or \code{"counts"} (raw).
#'
#' @param seurat_slot  When \code{niches_obj} is a list, the name of the
#'   element to extract.  Default \code{"CellToCell"}.
#'
#' @param edge_sep  Separator that NICHESv2 uses between the two barcodes in
#'   column names.  Default \code{"--"}.  Use \code{"_"} for older NICHES
#'   objects, but note that underscores are ambiguous if barcodes contain them.
#'
#' @param lrm_sep  Separator between ligand and receptor in row names.
#'   Default \code{"--"}.
#'
#' @param sending_type_col  Column in \code{niches_obj@meta.data} that holds
#'   the sending cell's type label.  Also accepts \code{"VectorType"} if types
#'   are encoded as \code{"TypeA--TypeB"} (the function will split and use the
#'   first component).  Set \code{NULL} to leave \code{sending_type} as NA.
#'
#' @param receiving_type_col  Same as above for the receiving cell.  If
#'   \code{NULL}, falls back to splitting \code{sending_type_col} on
#'   \code{"--"} (for VectorType-style encoding).
#'
#' @param min_score  Drop (edge, LRM) pairs with score <= this value.  Default
#'   0 keeps all non-zero entries.  Increase to reduce file size for very dense
#'   NICHESv2 outputs.
#'
#' @return Invisibly returns the \code{data.frame} written to disk.
#'
#' @examples
#' \dontrun{
#' # Typical usage after running NICHESv2 on a Xenium Seurat object:
#' niche_result <- RunNICHES(xenium_seurat, LR.database = "fantom5", ...)
#'
#' export_NICHESObject_for_viewer(
#'   niches_obj       = niche_result,        # list with $CellToCell slot
#'   xenium_dir       = "/data/my_run",
#'   sending_type_col = "SendingType",
#'   receiving_type_col = "ReceivingType"
#' )
#' }
export_NICHESObject_for_viewer <- function(
    niches_obj,
    xenium_dir,
    output_file        = NULL,
    score_slot         = "data",
    seurat_slot        = "CellToCell",
    edge_sep           = "--",
    lrm_sep            = "--",
    sending_type_col   = NULL,
    receiving_type_col = NULL,
    min_score          = 0
) {

  # ── 0. Dependencies ───────────────────────────────────────────────────────────
  for (pkg in c("Seurat", "Matrix", "arrow")) {
    if (!requireNamespace(pkg, quietly = TRUE)) {
      stop("Package '", pkg, "' is required. Install with: install.packages('", pkg, "')")
    }
  }

  # ── 1. Resolve the Seurat object ──────────────────────────────────────────────
  if (!inherits(niches_obj, "Seurat")) {
    if (!is.list(niches_obj)) {
      stop("niches_obj must be a Seurat object or a named list containing one.")
    }
    if (!seurat_slot %in% names(niches_obj)) {
      stop(
        "niches_obj is a list but has no element '", seurat_slot, "'.\n",
        "Available slots: ", paste(names(niches_obj), collapse = ", ")
      )
    }
    niches_obj <- niches_obj[[seurat_slot]]
    if (!inherits(niches_obj, "Seurat")) {
      stop("niches_obj[['", seurat_slot, "']] is not a Seurat object.")
    }
  }

  edge_ids <- colnames(niches_obj)   # e.g. "BarcodeA--BarcodeB"
  lrm_ids  <- rownames(niches_obj)   # e.g. "Tgfb1--Tgfbr1"

  message("Input: ", length(edge_ids), " edges × ", length(lrm_ids), " LRMs")

  # ── 2. Extract scores as a sparse triplet data.frame ─────────────────────────
  mat <- Seurat::GetAssayData(niches_obj, slot = score_slot)
  # Matrix::summary() returns a data.frame with columns i (row), j (col), x (value)
  triplet           <- as.data.frame(Matrix::summary(mat))
  colnames(triplet) <- c("lrm_idx", "edge_idx", "score")
  triplet           <- triplet[triplet$score > min_score, ]

  if (nrow(triplet) == 0) {
    stop("No scores > min_score (", min_score, ") found. ",
         "Try score_slot = 'counts' or lower min_score.")
  }

  triplet$edge_str <- edge_ids[triplet$edge_idx]
  triplet$lrm_str  <- lrm_ids[triplet$lrm_idx]
  triplet$edge_idx <- NULL
  triplet$lrm_idx  <- NULL

  # ── 3. Parse edge IDs ─────────────────────────────────────────────────────────
  # Expected format: "SendingBarcode<edge_sep>ReceivingBarcode"
  parsed_edges <- .split_ids(triplet$edge_str, edge_sep, label = "edge")
  triplet$sending_cell   <- parsed_edges[, 1]
  triplet$receiving_cell <- parsed_edges[, 2]

  # ── 4. Parse LRM IDs + assign stable integer lrm_id ─────────────────────────
  # Expected format: "Ligand<lrm_sep>Receptor"
  parsed_lrms     <- .split_ids(triplet$lrm_str, lrm_sep, label = "LRM")
  triplet$ligand   <- parsed_lrms[, 1]
  triplet$receptor <- parsed_lrms[, 2]

  # Canonical lrm string uses "|" for the viewer regardless of input sep
  triplet$lrm <- paste(triplet$ligand, triplet$receptor, sep = "|")

  # Stable 1-indexed integer IDs, sorted alphabetically
  unique_lrms    <- sort(unique(triplet$lrm))
  triplet$lrm_id <- match(triplet$lrm, unique_lrms)

  # ── 5. Canonical edge ID, is_autocrine ───────────────────────────────────────
  triplet$edge        <- paste(triplet$sending_cell, triplet$receiving_cell, sep = "|")
  triplet$is_autocrine <- triplet$sending_cell == triplet$receiving_cell

  # ── 6. score_norm: score / sum(score) within each directed edge ───────────────
  edge_totals         <- tapply(triplet$score, triplet$edge, sum)
  triplet$score_norm  <- triplet$score / pmax(edge_totals[triplet$edge], .Machine$double.eps)

  # ── 7. Cell type labels ────────────────────────────────────────────────────────
  triplet$sending_type   <- NA_character_
  triplet$receiving_type <- NA_character_

  meta <- niches_obj@meta.data
  # meta rownames are the original edge column names (e.g. "BarcodeA--BarcodeB")
  edge_meta_key <- paste(triplet$sending_cell, triplet$receiving_cell, sep = edge_sep)

  if (!is.null(sending_type_col)) {
    triplet$sending_type <- .lookup_meta(
      meta, sending_type_col, edge_meta_key, split_sep = edge_sep, part = 1L
    )
  }

  if (!is.null(receiving_type_col)) {
    triplet$receiving_type <- .lookup_meta(
      meta, receiving_type_col, edge_meta_key, split_sep = edge_sep, part = 2L
    )
  } else if (!is.null(sending_type_col)) {
    # If only one column provided and it looks like "TypeA--TypeB", fill receiving
    # from the second component
    combined <- .lookup_meta(meta, sending_type_col, edge_meta_key, split_sep = NULL)
    if (any(grepl(edge_sep, combined, fixed = TRUE))) {
      parts <- strsplit(combined, edge_sep, fixed = TRUE)
      triplet$sending_type   <- vapply(parts, function(x) x[[1]], character(1))
      triplet$receiving_type <- vapply(parts, function(x) if (length(x) >= 2L) x[[2L]] else NA_character_, character(1))
    }
  }

  # ── 8. Cell centroid coordinates from Xenium cells.parquet ──────────────────
  # Coordinates are in Xenium µm — do NOT convert; the viewer expects µm.
  cells_df <- .read_xenium_cells(xenium_dir)

  triplet <- merge(
    triplet, cells_df,
    by.x = "sending_cell", by.y = "cell_id",
    all.x = TRUE, sort = FALSE
  )
  names(triplet)[names(triplet) == "x_centroid"] <- "x1"
  names(triplet)[names(triplet) == "y_centroid"] <- "y1"

  triplet <- merge(
    triplet, cells_df,
    by.x = "receiving_cell", by.y = "cell_id",
    all.x = TRUE, sort = FALSE
  )
  names(triplet)[names(triplet) == "x_centroid"] <- "x2"
  names(triplet)[names(triplet) == "y_centroid"] <- "y2"

  n_missing <- sum(is.na(triplet$x1) | is.na(triplet$x2))
  if (n_missing > 0) {
    warning(
      n_missing, " rows have NA centroid coordinates — their barcodes were not ",
      "found in cells.parquet.\nCheck that NICHESv2 barcodes match Xenium ",
      "cell_id values (common issue: trailing '-1' suffix)."
    )
  }

  # ── 9. Column order and coercion ─────────────────────────────────────────────
  triplet$score       <- as.double(triplet$score)
  triplet$score_norm  <- as.double(triplet$score_norm)
  triplet$lrm_id      <- as.integer(triplet$lrm_id)
  triplet$is_autocrine <- as.logical(triplet$is_autocrine)
  triplet$x1 <- as.double(triplet$x1); triplet$y1 <- as.double(triplet$y1)
  triplet$x2 <- as.double(triplet$x2); triplet$y2 <- as.double(triplet$y2)

  required_cols <- c(
    "edge", "sending_cell", "receiving_cell", "is_autocrine",
    "lrm", "lrm_id", "ligand", "receptor",
    "score", "score_norm",
    "x1", "y1", "x2", "y2",
    "sending_type", "receiving_type"
  )
  extra_cols <- setdiff(names(triplet), required_cols)
  triplet    <- triplet[, c(required_cols, extra_cols), drop = FALSE]

  # ── 10. Write ─────────────────────────────────────────────────────────────────
  if (is.null(output_file)) {
    output_file <- file.path(xenium_dir, "edges.parquet")
  }
  arrow::write_parquet(triplet, output_file)

  n_directed   <- sum(!triplet$is_autocrine)
  n_autocrine  <- sum(triplet$is_autocrine)
  n_uniq_edges <- length(unique(triplet$edge[!triplet$is_autocrine]))
  n_uniq_lrms  <- length(unique(triplet$lrm))
  message(
    "Wrote ", nrow(triplet), " rows to: ", output_file, "\n",
    "  directed:   ", n_directed, " rows across ", n_uniq_edges, " unique edges\n",
    "  autocrine:  ", n_autocrine, " rows\n",
    "  LRMs:       ", n_uniq_lrms
  )

  invisible(triplet)
}


# ── Internal helpers ──────────────────────────────────────────────────────────

# Split a character vector on sep; returns an N×2 character matrix.
# Falls back to "_" if sep produces no valid 2-part splits.
.split_ids <- function(ids, sep, label = "ID") {
  attempt <- function(s) {
    parts <- strsplit(ids, s, fixed = TRUE)
    lens  <- lengths(parts)
    if (all(lens == 2L)) return(do.call(rbind, parts))
    NULL
  }

  result <- attempt(sep)
  if (!is.null(result)) return(result)

  if (sep != "_") {
    result <- attempt("_")
    if (!is.null(result)) {
      message(
        "Note: '", sep, "' did not produce clean 2-part splits for ", label,
        " IDs; fell back to '_'. Verify barcodes do not contain underscores."
      )
      return(result)
    }
  }

  # Show a few examples to help the user diagnose
  stop(
    "Cannot split ", label, " IDs into exactly 2 parts using '", sep, "' or '_'.\n",
    "First few IDs: ", paste(utils::head(ids, 4), collapse = ", "), "\n",
    "Adjust the ", if (label == "edge") "edge_sep" else "lrm_sep", " argument."
  )
}

# Lookup a meta.data column by edge key; optionally split and return one part.
# split_sep = NULL means return value as-is.
.lookup_meta <- function(meta, col, keys, split_sep, part = 1L) {
  if (!col %in% colnames(meta)) {
    warning("Column '", col, "' not found in meta.data — returning NA.")
    return(rep(NA_character_, length(keys)))
  }
  vals <- setNames(as.character(meta[[col]]), rownames(meta))
  raw  <- vals[keys]  # NA for unmatched keys

  if (is.null(split_sep)) return(unname(raw))

  parts <- strsplit(raw, split_sep, fixed = TRUE)
  vapply(parts, function(x) {
    if (is.null(x) || is.na(x[[1]])) NA_character_
    else if (length(x) >= part)       x[[part]]
    else                               x[[1L]]
  }, character(1))
}

# Read cell_id + centroids from Xenium output (parquet or csv.gz fallback).
# Returns µm coordinates unchanged.
.read_xenium_cells <- function(xenium_dir) {
  parquet_path <- file.path(xenium_dir, "cells.parquet")
  csv_path     <- file.path(xenium_dir, "cells.csv.gz")

  if (file.exists(parquet_path)) {
    df <- arrow::read_parquet(parquet_path)
  } else if (file.exists(csv_path)) {
    df <- utils::read.csv(csv_path)
  } else {
    stop("Neither cells.parquet nor cells.csv.gz found in: ", xenium_dir)
  }

  id_col <- grep("^cell_id$",   colnames(df), value = TRUE)
  x_col  <- grep("x_centroid",  colnames(df), value = TRUE)[1]
  y_col  <- grep("y_centroid",  colnames(df), value = TRUE)[1]

  if (length(id_col) == 0) stop("No 'cell_id' column in cells file.")
  if (is.na(x_col))        stop("No 'x_centroid' column in cells file.")
  if (is.na(y_col))        stop("No 'y_centroid' column in cells file.")

  df           <- df[, c(id_col, x_col, y_col)]
  colnames(df) <- c("cell_id", "x_centroid", "y_centroid")
  df$cell_id   <- as.character(df$cell_id)
  df
}
