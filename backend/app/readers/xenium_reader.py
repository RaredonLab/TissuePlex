"""
Reads standard Xenium output folders (v2/v3/v4).
All heavy I/O is deferred to per-method calls — no data is loaded at init.
"""
import json
import math
from pathlib import Path
from typing import Optional
import numpy as np
import pandas as pd
import pyarrow.parquet as pq


_UNSET = object()  # sentinel to distinguish "not yet loaded" from "loaded, no data"


class XeniumReader:
    def __init__(self, dataset_path: Path):
        self.path = dataset_path
        self._pixel_size: Optional[float] = None
        self._supp_meta = _UNSET   # supplemental metadata cache
        self._cells_full_cache = _UNSET  # merged cells + supp cache

    # ------------------------------------------------------------------
    # Experiment metadata
    # ------------------------------------------------------------------

    def info(self) -> dict:
        meta_file = self.path / "experiment.xenium"
        if not meta_file.exists():
            return {"error": "experiment.xenium not found", "path": str(self.path)}
        with open(meta_file) as f:
            return json.load(f)

    @property
    def pixel_size(self) -> float:
        """µm per image pixel; Xenium data coords are in µm, divide to get image px."""
        if self._pixel_size is None:
            meta = self.info()
            self._pixel_size = float(meta.get("pixel_size", 1.0))
        return self._pixel_size

    def _to_px(self, val: float) -> float:
        """Convert a Xenium coordinate (µm) to image pixel coordinates."""
        return val / self.pixel_size

    def _bbox_to_xenium(self, bbox: tuple) -> tuple:
        """Convert image-pixel bbox to Xenium (µm) coords for parquet filtering."""
        xmin, ymin, xmax, ymax = bbox
        ps = self.pixel_size
        return xmin * ps, ymin * ps, xmax * ps, ymax * ps

    # ------------------------------------------------------------------
    # Transcripts
    # ------------------------------------------------------------------

    def transcripts(
        self,
        bbox: Optional[tuple] = None,
        genes: Optional[list[str]] = None,
        limit: int = 100_000,
    ) -> list[dict]:
        df = self._read_parquet("transcripts.parquet", columns=["x_location", "y_location", "feature_name", "qv"])
        if bbox:
            xmin, ymin, xmax, ymax = self._bbox_to_xenium(bbox)
            if None not in (xmin, ymin, xmax, ymax):
                df = df[
                    (df["x_location"] >= xmin) & (df["x_location"] <= xmax) &
                    (df["y_location"] >= ymin) & (df["y_location"] <= ymax)
                ]
        if genes:
            df = df[df["feature_name"].isin(genes)]
        df = df.sample(n=min(limit, len(df)), random_state=42).copy() if len(df) > limit else df.copy()
        # Scale from Xenium µm coords to image pixel coords
        df["x_location"] = df["x_location"] / self.pixel_size
        df["y_location"] = df["y_location"] / self.pixel_size
        return self._to_records(df)

    # ------------------------------------------------------------------
    # Cells
    # ------------------------------------------------------------------

    def cells(self, bbox: Optional[tuple] = None) -> list[dict]:
        df = self._read_parquet("cells.parquet")
        if df is None:
            csv = self.path / "cells.csv.gz"
            if csv.exists():
                df = pd.read_csv(csv)
            else:
                return []
        x_col = next((c for c in df.columns if "x_centroid" in c), None)
        y_col = next((c for c in df.columns if "y_centroid" in c), None)
        if bbox and x_col and y_col:
            xmin, ymin, xmax, ymax = self._bbox_to_xenium(bbox)
            if None not in (xmin, ymin, xmax, ymax):
                df = df[
                    (df[x_col] >= xmin) & (df[x_col] <= xmax) &
                    (df[y_col] >= ymin) & (df[y_col] <= ymax)
                ]
        df = df.copy()
        if x_col:
            df[x_col] = df[x_col] / self.pixel_size
        if y_col:
            df[y_col] = df[y_col] / self.pixel_size
        return self._to_records(df)

    # ------------------------------------------------------------------
    # Cell boundaries
    # ------------------------------------------------------------------

    def cell_boundaries(self, bbox: Optional[tuple] = None, limit: int = 20_000) -> list[dict]:
        df = self._read_parquet("cell_boundaries.parquet")
        if df is None:
            return []
        x_col = next((c for c in df.columns if "vertex_x" in c), None)
        y_col = next((c for c in df.columns if "vertex_y" in c), None)
        if bbox and x_col and y_col:
            xmin, ymin, xmax, ymax = self._bbox_to_xenium(bbox)
            if None not in (xmin, ymin, xmax, ymax):
                df = df[
                    (df[x_col] >= xmin) & (df[x_col] <= xmax) &
                    (df[y_col] >= ymin) & (df[y_col] <= ymax)
                ]
        # Limit by unique cell count (each cell has ~10–20 vertices)
        if limit and "cell_id" in df.columns:
            keep = df["cell_id"].drop_duplicates().iloc[:limit]
            df = df[df["cell_id"].isin(keep)]
        df = df.copy()
        if x_col:
            df[x_col] = df[x_col] / self.pixel_size
        if y_col:
            df[y_col] = df[y_col] / self.pixel_size
        return self._to_records(df)

    # ------------------------------------------------------------------
    # Expression
    # ------------------------------------------------------------------

    def gene_list(self) -> list[str]:
        """Return real gene names from the HDF5 feature matrix (no controls/blanks)."""
        h5 = self.path / "cell_feature_matrix.h5"
        if not h5.exists():
            return []
        try:
            import h5py
            with h5py.File(h5, "r") as f:
                names = f["matrix/features/name"][()].astype(str).tolist()
            skip = ("Blank", "NegControl", "Unassigned", "DEPRECATED", "NegControlCodeword",
                    "NegControlProbe", "antisense")
            return [g for g in names if not any(g.startswith(p) for p in skip)]
        except Exception:
            return []

    def color_values(self, mode: str, field: Optional[str] = None,
                     genes: Optional[list[str]] = None) -> dict:
        """
        Return per-cell values for coloring.

        mode="gene_set"  → sum of HDF5 expression across the provided gene list
                           returns {type:"continuous", values, min, max}
        mode="metadata"  → column from cells.parquet; auto-detects type
                           returns {type:"continuous"|"categorical", values, min, max}
                           or      {type:"categorical", values, categories:[...]}
        """
        if mode == "gene_set":
            return self._color_values_gene_set(genes or [])
        return self._color_values_meta(field or "")

    def _color_values_gene_set(self, genes: list[str]) -> dict:
        """Sum expression across a list of genes, one scalar per cell."""
        h5 = self.path / "cell_feature_matrix.h5"
        if not h5.exists() or not genes:
            return {"type": "continuous", "values": {}, "min": 0.0, "max": 0.0}
        try:
            import h5py, scipy.sparse as sp
            with h5py.File(h5, "r") as f:
                barcodes = f["matrix/barcodes"][()].astype(str).tolist()
                gene_names = f["matrix/features/name"][()].astype(str).tolist()
                gene_set = set(genes)
                indices_to_sum = [i for i, g in enumerate(gene_names) if g in gene_set]
                if not indices_to_sum:
                    return {"type": "continuous", "values": {}, "min": 0.0, "max": 0.0}
                data = f["matrix/data"][()]
                idx = f["matrix/indices"][()]
                indptr = f["matrix/indptr"][()]
                mat = sp.csc_matrix((data, idx, indptr),
                                    shape=(len(gene_names), len(barcodes)))
                summed = np.asarray(mat[indices_to_sum, :].sum(axis=0)).flatten()
            vmax = float(summed.max()) if summed.max() > 0 else 1.0
            values = {barcodes[i]: float(summed[i]) for i in range(len(barcodes))}
            return {"type": "continuous", "values": values, "min": 0.0, "max": vmax}
        except Exception:
            return {"type": "continuous", "values": {}, "min": 0.0, "max": 0.0}

    def _color_values_meta(self, field: str) -> dict:
        df = self._cells_full()
        if df is None or field not in df.columns:
            return {"type": "continuous", "values": {}, "min": 0.0, "max": 0.0}
        col = df[field]
        cell_ids = df["cell_id"].astype(str).tolist()
        is_categorical = (
            pd.api.types.is_string_dtype(col) or
            pd.api.types.is_object_dtype(col) or
            (pd.api.types.is_integer_dtype(col) and col.nunique() <= 30)
        )
        if is_categorical:
            labels = col.fillna("").astype(str).tolist()
            categories = sorted(col.dropna().astype(str).unique().tolist())
            values = {cell_ids[i]: labels[i] for i in range(len(cell_ids))}
            return {"type": "categorical", "values": values, "categories": categories}
        else:
            filled = col.fillna(0)
            values = {cell_ids[i]: float(filled.iloc[i]) for i in range(len(cell_ids))}
            return {"type": "continuous", "values": values,
                    "min": float(filled.min()), "max": float(filled.max())}

    def cells_schema(self) -> dict:
        """Return column names and dtypes for cells.parquet + supplemental metadata."""
        df = self._cells_full()
        if df is None:
            return {"columns": {}}
        skip = {"cell_id"}
        return {
            "columns": {
                col: str(df[col].dtype)
                for col in df.columns
                if col not in skip
            }
        }

    def cell_expression(self, cell_id: str) -> dict:
        """Return {gene: count} for nonzero genes in a single cell (from HDF5)."""
        h5 = self.path / "cell_feature_matrix.h5"
        if not h5.exists():
            return {}
        try:
            import h5py, scipy.sparse as sp
            with h5py.File(h5, "r") as f:
                barcodes = f["matrix/barcodes"][()].astype(str).tolist()
                if cell_id not in barcodes:
                    return {}
                idx = barcodes.index(cell_id)
                gene_names = f["matrix/features/name"][()].astype(str).tolist()
                data = f["matrix/data"][()]
                indices = f["matrix/indices"][()]
                indptr = f["matrix/indptr"][()]
                mat = sp.csc_matrix((data, indices, indptr), shape=(len(gene_names), len(barcodes)))
                col = mat.getcol(idx).toarray().flatten()
            return {gene_names[i]: int(col[i]) for i in range(len(col)) if col[i] > 0}
        except Exception:
            return {}

    def cell_detail(self, cell_id: str) -> Optional[dict]:
        """Return merged cell metadata (incl. supplemental) + expression for one cell."""
        df = self._cells_full()
        if df is None:
            return None
        row = df[df["cell_id"] == cell_id]
        if row.empty:
            return None
        record = self._to_records(row)[0]
        # Scale centroid coords
        ps = self.pixel_size
        for col in ("x_centroid", "y_centroid"):
            if col in record and record[col] is not None:
                record[col] = record[col] / ps
        record["expression"] = self.cell_expression(cell_id)
        return record

    # ------------------------------------------------------------------
    # Supplemental metadata (cell-metadata/ directory)
    # ------------------------------------------------------------------

    # Standard Xenium filenames that live in the dataset root and must not be
    # treated as supplemental metadata even if they happen to be CSVs.
    _XENIUM_ROOT_SKIP = frozenset({
        "cells.csv", "cells.csv.gz", "transcripts.csv", "transcripts.csv.gz",
    })

    def _load_supplemental_metadata(self) -> Optional[pd.DataFrame]:
        """
        Discover user-defined cell metadata and merge it into a single DataFrame.
        Scans two locations (files found in both are merged, earlier takes precedence):

          1. {dataset}/cell-metadata/  — dedicated subdirectory (any CSV / parquet)
          2. {dataset}/               — dataset root, CSV / CSV.GZ only, skipping
                                        known Xenium filenames

        Barcode column resolution for CSV files (in order):
          • Column explicitly named 'cell_id'
          • First column read as index (covers data.table::fwrite(row.names=TRUE)
            and base R write.csv — both write barcodes as an unnamed first column)
          • First string-typed unique column as fallback

        Parquet files must have an explicit 'cell_id' column.

        Multiple files are outer-joined on 'cell_id'.  Columns already present in
        an earlier file are not overwritten.  cells.parquet takes final precedence
        in _cells_full().  Result is cached for the reader lifetime.
        """
        if self._supp_meta is not _UNSET:
            return self._supp_meta  # type: ignore[return-value]

        candidate_files: list[Path] = []

        # 1. cell-metadata/ subdirectory (all CSV + parquet)
        meta_dir = self.path / "cell-metadata"
        if meta_dir.is_dir():
            candidate_files.extend(sorted(meta_dir.iterdir()))

        # 2. Dataset root — CSV only, skip known Xenium filenames
        for f in sorted(self.path.iterdir()):
            if not f.is_file():
                continue
            nl = f.name.lower()
            if nl in self._XENIUM_ROOT_SKIP:
                continue
            if nl.endswith(".csv.gz") or nl.endswith(".csv"):
                candidate_files.append(f)

        frames: list[pd.DataFrame] = []
        for f in candidate_files:
            try:
                nl = f.name.lower()
                if nl.endswith(".parquet"):
                    df = pd.read_parquet(f)
                    if "cell_id" not in df.columns:
                        print(f"[xenium_reader] skip {f.name}: no 'cell_id' column")
                        continue
                elif nl.endswith(".csv.gz") or nl.endswith(".csv"):
                    df = self._read_csv_with_barcodes(f)
                    if df is None:
                        continue
                else:
                    continue

                df["cell_id"] = df["cell_id"].astype(str)
                frames.append(df)
                print(f"[xenium_reader] loaded supplemental metadata: {f.name} "
                      f"({len(df)} rows, {len(df.columns)-1} extra columns)")
            except Exception as exc:
                print(f"[xenium_reader] warning: could not load {f.name}: {exc}")

        if not frames:
            self._supp_meta = None
            return None

        merged = frames[0]
        for frame in frames[1:]:
            new_cols = ["cell_id"] + [c for c in frame.columns if c not in merged.columns]
            merged = merged.merge(frame[new_cols], on="cell_id", how="outer")

        self._supp_meta = merged
        return merged

    def _read_csv_with_barcodes(self, path: Path) -> Optional[pd.DataFrame]:
        """
        Read a CSV and promote the barcode column to 'cell_id'.

        Strategy: read with index_col=0 so the first column — whether named ""
        (base R write.csv), an empty header (data.table fwrite row.names=TRUE),
        or any explicit name — becomes the DataFrame index.  We then rename it
        to 'cell_id' and reset.  Explicit 'cell_id' column is also accepted.
        """
        try:
            df = pd.read_csv(path, index_col=0)
            df.index.name = "cell_id"
            return df.reset_index()
        except Exception:
            pass

        # Fallback without index_col in case the file has no sensible first column
        df = pd.read_csv(path)
        if "cell_id" in df.columns:
            return df
        if "Unnamed: 0" in df.columns:
            return df.rename(columns={"Unnamed: 0": "cell_id"})
        first = df.columns[0]
        if df[first].dtype == object and df[first].is_unique:
            return df.rename(columns={first: "cell_id"})

        print(f"[xenium_reader] skip {path.name}: cannot identify barcode column")
        return None

    def _cells_full(self) -> Optional[pd.DataFrame]:
        """
        Return cells.parquet merged with any supplemental metadata.
        Supplemental columns are appended on the right; cells.parquet values
        take precedence for any overlapping column names.
        Result is cached.
        """
        if self._cells_full_cache is not _UNSET:
            return self._cells_full_cache  # type: ignore[return-value]

        cells = self._read_parquet("cells.parquet")
        supp  = self._load_supplemental_metadata()

        if cells is None and supp is None:
            self._cells_full_cache = None
            return None

        if supp is None:
            self._cells_full_cache = cells
            return cells

        if cells is None:
            self._cells_full_cache = supp
            return supp

        # Only merge columns not already in cells.parquet
        new_cols = [c for c in supp.columns if c not in cells.columns]
        if new_cols:
            merged = cells.merge(supp[["cell_id"] + new_cols], on="cell_id", how="left")
        else:
            merged = cells
        self._cells_full_cache = merged
        return merged

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _read_parquet(self, filename: str, columns: Optional[list[str]] = None) -> Optional[pd.DataFrame]:
        path = self.path / filename
        if not path.exists():
            return None
        try:
            return pq.read_table(path, columns=columns).to_pandas()
        except Exception:
            return pd.read_parquet(path, columns=columns)

    @staticmethod
    def _to_records(df: pd.DataFrame) -> list[dict]:
        """Convert DataFrame to JSON-safe records, replacing NaN/Inf with None."""
        return [
            {k: (None if isinstance(v, float) and not math.isfinite(v) else v)
             for k, v in row.items()}
            for row in df.to_dict(orient="records")
        ]
