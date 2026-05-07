"""
Reads edge-list Parquet files.

Required columns: x1, y1, x2, y2  (native coordinate space, e.g. µm)
All other columns are open metadata (layer type, strength, p-value, etc.)

Coordinates are returned in image pixel space (divided by pixel_size).
BBox query parameters are also expected in image pixel space.

Uses DuckDB for all parquet queries so large files (1+ GB) are processed in
streaming chunks without loading the full dataset into RAM.
"""
import math
from pathlib import Path
from typing import Optional
import duckdb
import pyarrow.parquet as pq


class EdgeReader:
    def __init__(self, path: Path, pixel_size: float = 1.0):
        self.path = path
        # SQL-safe path string (escape single quotes)
        self._sql_path = str(path).replace("'", "''")
        self._schema_cache = None
        self._pixel_size = pixel_size

    @property
    def pixel_size(self) -> float:
        return self._pixel_size

    def _parquet_schema(self):
        if self._schema_cache is None:
            self._schema_cache = pq.read_schema(self.path)
        return self._schema_cache

    def _from(self) -> str:
        return f"read_parquet('{self._sql_path}')"

    def _conn(self):
        # Each call gets a fresh, isolated connection — duckdb's default connection
        # is not thread-safe and causes empty/corrupt results under FastAPI concurrency.
        return duckdb.connect()

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
        if not want:
            return []
        cols = ", ".join(f'"{c}"' for c in want)
        order = "ORDER BY lrm_id" if "lrm_id" in want else ""
        with self._conn() as conn:
            df = conn.execute(
                f"SELECT DISTINCT {cols} FROM {self._from()} {order}"
            ).df()
        if "lrm" not in df.columns and "ligand" in df.columns and "receptor" in df.columns:
            df["lrm"] = df["ligand"] + "|" + df["receptor"]
        return df.to_dict(orient="records")

    def edge_color_values(self, mode: str, lrms: list[str] | None = None,
                          field: str | None = None) -> dict:
        """
        Return per-directed-edge color values.

        mode='lrm_set'  — sum score across requested LRMs per edge; continuous
        mode='metadata' — group by edge, take first value of `field` per edge;
                          auto-detect categorical vs continuous
        """
        col_names = set(self._parquet_schema().names)

        if mode == "lrm_set":
            if not all(c in col_names for c in ("edge", "lrm", "score")):
                return {"type": "continuous", "values": {}, "min": 0, "max": 0}
            with self._conn() as conn:
                if lrms:
                    placeholders = ", ".join(["?" for _ in lrms])
                    sql = (f"SELECT edge, SUM(score) AS total FROM {self._from()} "
                           f"WHERE lrm IN ({placeholders}) GROUP BY edge")
                    df = conn.execute(sql, lrms).df()
                else:
                    df = conn.execute(
                        f"SELECT edge, SUM(score) AS total FROM {self._from()} GROUP BY edge"
                    ).df()
            if df.empty:
                return {"type": "continuous", "values": {}, "min": 0, "max": 0}
            grouped = df.set_index("edge")["total"]
            return {
                "type": "continuous",
                "values": grouped.to_dict(),
                "min": float(grouped.min()),
                "max": float(grouped.max()),
            }

        if mode == "metadata":
            if not field or field not in col_names:
                return {"type": "continuous", "values": {}, "min": 0, "max": 0}
            with self._conn() as conn:
                df = conn.execute(
                    f'SELECT edge, FIRST("{field}") AS val FROM {self._from()} GROUP BY edge'
                ).df()
            col = df.set_index("edge")["val"]
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
            return {
                "type": "continuous",
                "values": col.to_dict(),
                "min": float(col.min()),
                "max": float(col.max()),
            }

        return {"type": "continuous", "values": {}, "min": 0, "max": 0}

    def edge_detail(self, edge_id: str) -> dict | None:
        """Return all LRM rows for a single directed edge, structured for the info panel."""
        with self._conn() as conn:
            df = conn.execute(
                f"SELECT * FROM {self._from()} WHERE edge = ?", [edge_id]
            ).df()
        if df.empty:
            return None
        first = df.iloc[0]
        lrm_rows = []
        for _, r in df.iterrows():
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
        col_names = set(self._parquet_schema().names)
        if column not in col_names:
            return {"type": "categorical", "values": [], "count": 0}
        quoted = f'"{column}"'
        try:
            with self._conn() as conn:
                row = conn.execute(
                    f"SELECT MIN({quoted}), MAX({quoted}), AVG({quoted}) "
                    f"FROM {self._from()}"
                ).fetchone()
            vmin, vmax, vmean = row
            if isinstance(vmin, (int, float)) and not isinstance(vmin, bool):
                return {
                    "type": "numeric",
                    "min": float(vmin),
                    "max": float(vmax),
                    "mean": float(vmean),
                }
        except Exception:
            pass
        with self._conn() as conn:
            vals = conn.execute(
                f"SELECT DISTINCT {quoted} FROM {self._from()} WHERE {quoted} IS NOT NULL"
            ).df().iloc[:, 0].tolist()
        return {"type": "categorical", "values": vals, "count": len(vals)}

    def query(
        self,
        bbox: Optional[tuple] = None,
        filters: Optional[dict] = None,
        min_strength: Optional[float] = None,
        limit: int = 200_000,
    ) -> list[dict]:
        ps = self.pixel_size
        schema_names = set(self._parquet_schema().names)

        conditions: list[str] = []
        params: list = []

        if bbox:
            xmin, ymin, xmax, ymax = bbox
            if None not in (xmin, ymin, xmax, ymax):
                xmin_u, ymin_u = xmin * ps, ymin * ps
                xmax_u, ymax_u = xmax * ps, ymax * ps
                conditions.append(
                    "((x1 >= ? AND x1 <= ? AND y1 >= ? AND y1 <= ?) OR "
                    "(x2 >= ? AND x2 <= ? AND y2 >= ? AND y2 <= ?))"
                )
                params.extend([xmin_u, xmax_u, ymin_u, ymax_u,
                                xmin_u, xmax_u, ymin_u, ymax_u])

        if filters:
            for col, val in filters.items():
                if col not in schema_names:
                    continue
                if isinstance(val, list):
                    placeholders = ", ".join(["?" for _ in val])
                    conditions.append(f'"{col}" IN ({placeholders})')
                    params.extend(val)
                else:
                    conditions.append(f'"{col}" = ?')
                    params.append(val)

        if min_strength is not None and "strength" in schema_names:
            conditions.append("strength >= ?")
            params.append(min_strength)

        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        can_stratify = "sending_cell" in schema_names

        with self._conn() as conn:
            if can_stratify:
                # Two-stage cell-stratified sampling:
                #   1. Reservoir-sample the bbox-filtered rows down to PRE_LIMIT (fast,
                #      single pass over parquet; USING SAMPLE must go on the inner subquery
                #      so the WHERE filter runs first).
                #   2. Apply per-cell ROW_NUMBER window on the small pre-sample, keeping
                #      at most K edges per cell, then shuffle and cap at limit.
                # This distributes the budget evenly across all visible cells rather than
                # over-representing high-degree hub cells that appear first in the file.
                PRE_LIMIT = min(limit * 5, 500_000)
                K = max(1, limit // 50)  # per-cell cap (assumes ≥50 cells in view)
                df = conn.execute(
                    f"""
                    SELECT * EXCLUDE (_rn) FROM (
                        SELECT *,
                            ROW_NUMBER() OVER (
                                PARTITION BY sending_cell ORDER BY RANDOM()
                            ) AS _rn
                        FROM (
                            SELECT * FROM (
                                SELECT * FROM {self._from()} {where}
                            ) USING SAMPLE reservoir({PRE_LIMIT} ROWS)
                        )
                    ) WHERE _rn <= {K}
                    ORDER BY RANDOM()
                    LIMIT {limit}
                    """,
                    params,
                ).df()
            else:
                df = conn.execute(
                    f"SELECT * FROM {self._from()} {where} LIMIT {limit}", params
                ).df()

        for col in ("x1", "y1", "x2", "y2"):
            if col in df.columns:
                df[col] = df[col] / ps

        return [
            {c: (None if isinstance(v, float) and not math.isfinite(v) else v)
             for c, v in row.items()}
            for row in df.to_dict(orient="records")
        ]
