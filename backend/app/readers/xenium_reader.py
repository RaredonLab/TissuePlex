"""
Reads standard Xenium output folders (v2/v3/v4).
All heavy I/O is deferred to per-method calls — no data is loaded at init.
"""
import json
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

from app.readers.base_reader import SpatialDatasetReader


_UNSET = object()  # sentinel: "not yet loaded" vs "loaded, no data"


class XeniumReader(SpatialDatasetReader):

    def __init__(self, dataset_path: Path):
        super().__init__(dataset_path)
        self._pixel_size: Optional[float] = None
        self._supp_meta = _UNSET
        self._cells_full_cache = _UNSET

    # ── Identity ──────────────────────────────────────────────────────────────

    @property
    def platform(self) -> str:
        return "xenium"

    @property
    def pixel_size(self) -> float:
        if self._pixel_size is None:
            meta = self.info()
            self._pixel_size = float(meta.get("pixel_size", 1.0))
        return self._pixel_size

    # ── Experiment metadata ───────────────────────────────────────────────────

    def info(self) -> dict:
        meta_file = self.path / "experiment.xenium"
        if not meta_file.exists():
            return {"platform": self.platform, "error": "experiment.xenium not found"}
        with open(meta_file) as f:
            data = json.load(f)
        data["platform"] = self.platform
        return data

    # ── Gene catalogue ────────────────────────────────────────────────────────

    def gene_list(self) -> list[str]:
        h5 = self.path / "cell_feature_matrix.h5"
        if not h5.exists():
            return []
        try:
            import h5py
            with h5py.File(h5, "r") as f:
                names = f["matrix/features/name"][()].astype(str).tolist()
            skip = ("Blank", "NegControl", "Unassigned", "DEPRECATED",
                    "NegControlCodeword", "NegControlProbe", "antisense")
            return [g for g in names if not any(g.startswith(p) for p in skip)]
        except Exception:
            return []

    # ── Transcripts ───────────────────────────────────────────────────────────

    def transcripts(
        self,
        bbox: Optional[tuple] = None,
        genes: Optional[list[str]] = None,
        limit: int = 50_000,
    ) -> list[dict]:
        df = self._read_parquet(
            "transcripts.parquet",
            columns=["x_location", "y_location", "feature_name", "qv"],
        )
        if df is None:
            return []
        if bbox:
            xmin, ymin, xmax, ymax = self._bbox_to_native(bbox)
            if None not in (xmin, ymin, xmax, ymax):
                df = df[
                    (df["x_location"] >= xmin) & (df["x_location"] <= xmax) &
                    (df["y_location"] >= ymin) & (df["y_location"] <= ymax)
                ]
        if genes:
            df = df[df["feature_name"].isin(genes)]
        df = (df.sample(n=min(limit, len(df)), random_state=42).copy()
              if len(df) > limit else df.copy())
        df["x_location"] = df["x_location"] / self.pixel_size
        df["y_location"] = df["y_location"] / self.pixel_size
        return self._to_records(df)

    # ── Cells ─────────────────────────────────────────────────────────────────

    def cells(self, bbox: Optional[tuple] = None) -> list[dict]:
        df = self._read_parquet("cells.parquet")
        if df is None:
            csv = self.path / "cells.csv.gz"
            df = pd.read_csv(csv) if csv.exists() else None
        if df is None:
            return []
        x_col = next((c for c in df.columns if "x_centroid" in c), None)
        y_col = next((c for c in df.columns if "y_centroid" in c), None)
        if bbox and x_col and y_col:
            xmin, ymin, xmax, ymax = self._bbox_to_native(bbox)
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

    def cells_schema(self) -> dict:
        try:
            df = self._cells_full()
        except Exception as exc:
            print(f"[xenium_reader] cells_schema fallback: {exc}")
            df = self._read_parquet("cells.parquet")
        if df is None:
            return {"columns": {}}
        return {
            "columns": {
                col: str(df[col].dtype)
                for col in df.columns
                if col != "cell_id"
            }
        }

    # ── Cell boundaries ───────────────────────────────────────────────────────

    def cell_boundaries(self, bbox: Optional[tuple] = None, limit: int = 20_000) -> list[dict]:
        df = self._read_parquet("cell_boundaries.parquet")
        if df is None:
            return []
        x_col = next((c for c in df.columns if "vertex_x" in c), None)
        y_col = next((c for c in df.columns if "vertex_y" in c), None)
        if bbox and x_col and y_col:
            xmin, ymin, xmax, ymax = self._bbox_to_native(bbox)
            if None not in (xmin, ymin, xmax, ymax):
                df = df[
                    (df[x_col] >= xmin) & (df[x_col] <= xmax) &
                    (df[y_col] >= ymin) & (df[y_col] <= ymax)
                ]
        if limit and "cell_id" in df.columns:
            keep = df["cell_id"].drop_duplicates().iloc[:limit]
            df = df[df["cell_id"].isin(keep)]
        df = df.copy()
        if x_col:
            df[x_col] = df[x_col] / self.pixel_size
        if y_col:
            df[y_col] = df[y_col] / self.pixel_size
        return self._to_records(df)

    # ── Expression ────────────────────────────────────────────────────────────

    def cell_expression(self, cell_id: str) -> dict:
        h5 = self.path / "cell_feature_matrix.h5"
        if not h5.exists():
            return {}
        try:
            import h5py
            import scipy.sparse as sp
            with h5py.File(h5, "r") as f:
                barcodes = f["matrix/barcodes"][()].astype(str).tolist()
                if cell_id not in barcodes:
                    return {}
                idx = barcodes.index(cell_id)
                gene_names = f["matrix/features/name"][()].astype(str).tolist()
                data = f["matrix/data"][()]
                indices = f["matrix/indices"][()]
                indptr = f["matrix/indptr"][()]
                mat = sp.csc_matrix(
                    (data, indices, indptr),
                    shape=(len(gene_names), len(barcodes)),
                )
                col = mat.getcol(idx).toarray().flatten()
            return {gene_names[i]: int(col[i]) for i in range(len(col)) if col[i] > 0}
        except Exception:
            return {}

    def cell_detail(self, cell_id: str) -> Optional[dict]:
        df = self._cells_full()
        if df is None:
            return None
        row = df[df["cell_id"] == cell_id]
        if row.empty:
            return None
        record = self._to_records(row)[0]
        ps = self.pixel_size
        for col in ("x_centroid", "y_centroid"):
            if col in record and record[col] is not None:
                record[col] = record[col] / ps
        record["expression"] = self.cell_expression(cell_id)
        return record

    def color_values(
        self,
        mode: str,
        field: Optional[str] = None,
        genes: Optional[list[str]] = None,
    ) -> dict:
        if mode == "gene_set":
            return self._color_values_gene_set(genes or [])
        return self._color_values_meta(field or "")

    def _color_values_gene_set(self, genes: list[str]) -> dict:
        h5 = self.path / "cell_feature_matrix.h5"
        if not h5.exists() or not genes:
            return {"type": "continuous", "values": {}, "min": 0.0, "max": 0.0}
        try:
            import h5py
            import scipy.sparse as sp
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
                mat = sp.csc_matrix(
                    (data, idx, indptr),
                    shape=(len(gene_names), len(barcodes)),
                )
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
        has_value = col.notna()
        is_categorical = (
            pd.api.types.is_string_dtype(col) or
            pd.api.types.is_object_dtype(col) or
            (pd.api.types.is_integer_dtype(col) and col.nunique() <= 30)
        )
        if is_categorical:
            categories = sorted(col[has_value].astype(str).unique().tolist())
            values = {
                cell_ids[i]: str(col.iloc[i])
                for i in range(len(cell_ids)) if has_value.iloc[i]
            }
            return {"type": "categorical", "values": values, "categories": categories}
        valid = col[has_value]
        if valid.empty:
            return {"type": "continuous", "values": {}, "min": 0.0, "max": 0.0}
        values = {
            cell_ids[i]: float(col.iloc[i])
            for i in range(len(cell_ids)) if has_value.iloc[i]
        }
        return {"type": "continuous", "values": values,
                "min": float(valid.min()), "max": float(valid.max())}

    # ── Supplemental metadata ─────────────────────────────────────────────────

    # Plain-CSV filenames in the dataset root that are standard Xenium outputs.
    # .csv.gz files are always skipped at root (exclusively Xenium data files).
    _XENIUM_ROOT_SKIP = frozenset({
        "cells.csv", "transcripts.csv", "metrics_summary.csv",
        "analysis_summary.csv", "gene_panel.csv",
    })

    def _load_supplemental_metadata(self) -> Optional[pd.DataFrame]:
        """
        Merge user-defined cell metadata from:
          1. {dataset}/cell-metadata/  — all CSV / parquet
          2. {dataset}/               — plain .csv only, skipping known Xenium filenames
        Multiple files are outer-joined on cell_id.  Cached per reader instance.
        """
        if self._supp_meta is not _UNSET:
            return self._supp_meta  # type: ignore[return-value]

        candidate_files: list[Path] = []
        meta_dir = self.path / "cell-metadata"
        if meta_dir.is_dir():
            candidate_files.extend(sorted(meta_dir.iterdir()))
        for f in sorted(self.path.iterdir()):
            if not f.is_file():
                continue
            nl = f.name.lower()
            if not nl.endswith(".csv"):
                continue
            if nl in self._XENIUM_ROOT_SKIP:
                continue
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
        """Read a CSV and promote the barcode column to 'cell_id'."""
        try:
            df = pd.read_csv(path, index_col=0)
            df.index.name = "cell_id"
            return df.reset_index()
        except Exception:
            pass
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
        """cells.parquet merged with supplemental metadata. Cached."""
        if self._cells_full_cache is not _UNSET:
            return self._cells_full_cache  # type: ignore[return-value]
        cells = self._read_parquet("cells.parquet")
        supp = self._load_supplemental_metadata()
        if cells is None and supp is None:
            self._cells_full_cache = None
            return None
        if supp is None:
            self._cells_full_cache = cells
            return cells
        if cells is None:
            self._cells_full_cache = supp
            return supp
        new_cols = [c for c in supp.columns if c not in cells.columns]
        merged = cells.merge(supp[["cell_id"] + new_cols], on="cell_id", how="left") if new_cols else cells
        self._cells_full_cache = merged
        return merged

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _read_parquet(self, filename: str, columns: Optional[list[str]] = None) -> Optional[pd.DataFrame]:
        path = self.path / filename
        if not path.exists():
            return None
        try:
            return pq.read_table(path, columns=columns).to_pandas()
        except Exception:
            return pd.read_parquet(path, columns=columns)
