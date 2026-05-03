"""
Reads cell-registered data layer Parquet files.

Required column: cell_id
All other columns are per-cell values (scores, annotations, cluster labels, etc.)
"""
from pathlib import Path
from typing import Optional
import pandas as pd
import pyarrow.parquet as pq


class CellLayerReader:
    def __init__(self, path: Path):
        self.path = path

    def schema(self) -> dict:
        schema = pq.read_schema(self.path)
        return {
            "columns": {
                name: str(schema.field(name).type)
                for name in schema.names
            }
        }

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

    def values(self, column: str, cell_ids: Optional[list[str]] = None) -> dict:
        cols = ["cell_id", column]
        df = pd.read_parquet(self.path, columns=cols)
        if cell_ids:
            df = df[df["cell_id"].isin(cell_ids)]
        return dict(zip(df["cell_id"].astype(str), df[column]))
