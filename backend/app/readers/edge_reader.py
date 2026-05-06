"""
Reads edge-list Parquet files.

Required columns: x1, y1, x2, y2  (native coordinate space, e.g. µm)
All other columns are open metadata (layer type, strength, p-value, etc.)

Coordinates are returned in image pixel space (divided by pixel_size).
BBox query parameters are also expected in image pixel space.
"""
import math
from pathlib import Path
from typing import Optional
import pandas as pd
import pyarrow.parquet as pq


class EdgeReader:
    def __init__(self, path: Path, pixel_size: float = 1.0):
        self.path = path
        self._schema_cache = None
        self._pixel_size = pixel_size

    @property
    def pixel_size(self) -> float:
        return self._pixel_size

    def _parquet_schema(self):
        if self._schema_cache is None:
            self._schema_cache = pq.read_schema(self.path)
        return self._schema_cache

    def schema(self) -> dict:
        schema = self._parquet_schema()
        return {
            "columns": {
                name: str(schema.field(name).type)
                for name in schema.names
            }
        }

    def lrm_catalogue(self) -> list[dict]:
        """Return unique LRM rows sorted by lrm_id. Includes string 'lrm' field if present."""
        want = [c for c in ("lrm_id", "lrm", "ligand", "receptor")
                if c in self._parquet_schema().names]
        df = pd.read_parquet(self.path, columns=want)
        df = df.drop_duplicates().copy()
        # Synthesise string 'lrm' from ligand|receptor if the column is absent
        if "lrm" not in df.columns and "ligand" in df.columns and "receptor" in df.columns:
            df["lrm"] = df["ligand"] + "|" + df["receptor"]
        if "lrm_id" in df.columns:
            df = df.sort_values("lrm_id")
        return df.to_dict(orient="records")

    def edge_color_values(self, mode: str, lrms: list[str] | None = None,
                          field: str | None = None) -> dict:
        """
        Return per-directed-edge color values.

        mode='lrm_set'  — sum score across requested LRMs per edge; continuous
        mode='metadata' — group by edge, take first value of `field` per edge;
                          auto-detect categorical vs continuous
        """
        schema = self._parquet_schema()
        col_names = set(schema.names)

        if mode == "lrm_set":
            need = ["edge", "lrm", "score"]
            if not all(c in col_names for c in need):
                return {"type": "continuous", "values": {}, "min": 0, "max": 0}
            df = pd.read_parquet(self.path, columns=need)
            if lrms:
                df = df[df["lrm"].isin(set(lrms))]
            grouped = df.groupby("edge", sort=False)["score"].sum()
            if grouped.empty:
                return {"type": "continuous", "values": {}, "min": 0, "max": 0}
            vmin, vmax = float(grouped.min()), float(grouped.max())
            return {
                "type": "continuous",
                "values": grouped.to_dict(),
                "min": vmin,
                "max": vmax,
            }

        if mode == "metadata":
            if not field or field not in col_names:
                return {"type": "continuous", "values": {}, "min": 0, "max": 0}
            df = pd.read_parquet(self.path, columns=["edge", field])
            grouped = df.groupby("edge", sort=False)[field].first()
            col = grouped
            dtype = str(col.dtype)
            n_unique = col.nunique()
            is_cat = (
                dtype in ("object", "string", "bool")
                or (dtype.startswith("int") and n_unique <= 30)
            )
            if is_cat:
                categories = sorted(col.dropna().unique().tolist(), key=str)
                return {
                    "type": "categorical",
                    "values": col.to_dict(),
                    "categories": categories,
                }
            vmin, vmax = float(col.min()), float(col.max())
            return {
                "type": "continuous",
                "values": col.to_dict(),
                "min": vmin,
                "max": vmax,
            }

        return {"type": "continuous", "values": {}, "min": 0, "max": 0}

    def edge_detail(self, edge_id: str) -> dict | None:
        """Return all LRM rows for a single directed edge, structured for the info panel."""
        col_names = set(self._parquet_schema().names)
        df = pd.read_parquet(self.path)
        rows = df[df["edge"] == edge_id] if "edge" in col_names else pd.DataFrame()
        if rows.empty:
            return None
        first = rows.iloc[0]
        lrm_rows = []
        for _, r in rows.iterrows():
            entry: dict = {}
            for c in ("lrm", "lrm_id", "ligand", "receptor", "score", "score_norm"):
                if c in r.index:
                    v = r[c]
                    entry[c] = None if (isinstance(v, float) and not math.isfinite(v)) else v
            lrm_rows.append(entry)
        lrm_rows.sort(key=lambda x: x.get("score") or 0, reverse=True)
        result: dict = {"edge": edge_id, "lrms": lrm_rows}
        for c in ("sending_cell", "receiving_cell", "sending_type", "receiving_type"):
            if c in first.index:
                result[c] = first[c]
        if "is_autocrine" in first.index:
            result["is_autocrine"] = bool(first["is_autocrine"])
        return result

    def column_summary(self, column: str) -> dict:
        df = pd.read_parquet(self.path, columns=[column])
        col = df[column]
        if pd.api.types.is_numeric_dtype(col):
            return {
                "type": "numeric",
                "min": float(col.min()),
                "max": float(col.max()),
                "mean": float(col.mean()),
            }
        else:
            return {
                "type": "categorical",
                "values": col.dropna().unique().tolist(),
                "count": int(col.nunique()),
            }

    def query(
        self,
        bbox: Optional[tuple] = None,
        filters: Optional[dict] = None,
        min_strength: Optional[float] = None,
        limit: int = 200_000,
    ) -> list[dict]:
        df = pd.read_parquet(self.path)
        ps = self.pixel_size

        # BBox is in image pixel coords; convert to native units for filtering
        if bbox:
            xmin, ymin, xmax, ymax = bbox
            if None not in (xmin, ymin, xmax, ymax):
                xmin_u, ymin_u = xmin * ps, ymin * ps
                xmax_u, ymax_u = xmax * ps, ymax * ps
                src_in = (
                    (df["x1"] >= xmin_u) & (df["x1"] <= xmax_u) &
                    (df["y1"] >= ymin_u) & (df["y1"] <= ymax_u)
                )
                tgt_in = (
                    (df["x2"] >= xmin_u) & (df["x2"] <= xmax_u) &
                    (df["y2"] >= ymin_u) & (df["y2"] <= ymax_u)
                )
                df = df[src_in | tgt_in]

        if filters:
            for col, val in filters.items():
                if col not in df.columns:
                    continue
                if isinstance(val, list):
                    df = df[df[col].isin(val)]
                else:
                    df = df[df[col] == val]

        if min_strength is not None and "strength" in df.columns:
            df = df[df["strength"] >= min_strength]

        df = df.head(limit).copy()
        # Scale spatial columns to image pixel coords
        for col in ("x1", "y1", "x2", "y2"):
            if col in df.columns:
                df[col] = df[col] / ps

        return [
            {k: (None if isinstance(v, float) and not math.isfinite(v) else v)
             for k, v in row.items()}
            for row in df.to_dict(orient="records")
        ]
