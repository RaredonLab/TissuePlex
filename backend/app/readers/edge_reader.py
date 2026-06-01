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
import os
from pathlib import Path
from typing import Optional
import duckdb
import pyarrow.parquet as pq

_DUCKDB_MEMORY_LIMIT = os.getenv("DUCKDB_MEMORY_LIMIT", "8GB")


class EdgeReader:
    def __init__(self, path: Path, pixel_size: float = 1.0):
        self.path = path
        # SQL-safe path string (escape single quotes)
        self._sql_path = str(path).replace("'", "''")
        self._schema_cache = None
        self._lrm_catalogue_cache = None
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
        conn = duckdb.connect()
        conn.execute(f"SET memory_limit='{_DUCKDB_MEMORY_LIMIT}'")
        conn.execute("SET threads=4")
        return conn

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
        if self._lrm_catalogue_cache is not None:
            return self._lrm_catalogue_cache
        want = [c for c in ("lrm_id", "lrm", "ligand", "receptor")
                if c in self._parquet_schema().names]
        if not want:
            self._lrm_catalogue_cache = []
            return []
        cols = ", ".join(f'"{c}"' for c in want)
        order = "ORDER BY lrm_id" if "lrm_id" in want else ""
        with self._conn() as conn:
            df = conn.execute(
                f"SELECT DISTINCT {cols} FROM {self._from()} WHERE lrm IS NOT NULL {order}"
                if "lrm" in want else
                f"SELECT DISTINCT {cols} FROM {self._from()} WHERE ligand IS NOT NULL AND receptor IS NOT NULL {order}"
            ).df()
        if "lrm" not in df.columns and "ligand" in df.columns and "receptor" in df.columns:
            df["lrm"] = df["ligand"] + "|" + df["receptor"]
        df = df.dropna(subset=["lrm"] if "lrm" in df.columns else [])
        self._lrm_catalogue_cache = df.to_dict(orient="records")
        return self._lrm_catalogue_cache

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

    def query_grouped(
        self,
        bbox: Optional[tuple] = None,
        min_lrm_count: int = 1,
        density: float = 1.0,
        max_limit: int = 500_000,
    ) -> list[dict]:
        """
        Return one row per directed edge (GROUP BY edge), pre-aggregated.
        ~500x fewer rows than query() for typical LRM-rich parquet files.

        Returns structural columns (positions, metadata, lrm_count) plus
        score_sum = SUM(score) over ALL LRMs — the unfiltered total used as
        the default when no LRM filter is active.

        LRM-filter-aware scores (visible_lrm_count / visible_score_sum) are
        served separately by query_scores() so that LRM selection changes do
        not require re-fetching the heavy structural data.

        density=1.0 returns all edges in the viewport (up to max_limit).
        density<1.0 uses bernoulli sampling so each edge is independently
        included with probability `density` — spatially uniform.
        """
        ps = self.pixel_size
        schema_names = set(self._parquet_schema().names)
        has_lrm   = "lrm"   in schema_names
        has_score = "score" in schema_names

        where_conditions: list[str] = []
        where_params: list = []

        if bbox:
            xmin, ymin, xmax, ymax = bbox
            if None not in (xmin, ymin, xmax, ymax):
                xmin_u, ymin_u = xmin * ps, ymin * ps
                xmax_u, ymax_u = xmax * ps, ymax * ps
                where_conditions.append(
                    "((x1 >= ? AND x1 <= ? AND y1 >= ? AND y1 <= ?) OR "
                    "(x2 >= ? AND x2 <= ? AND y2 >= ? AND y2 <= ?))"
                )
                where_params.extend([xmin_u, xmax_u, ymin_u, ymax_u,
                                      xmin_u, xmax_u, ymin_u, ymax_u])

        where = f"WHERE {' AND '.join(where_conditions)}" if where_conditions else ""

        # Build SELECT columns
        agg_cols = ["edge"]
        for col in ("sending_cell", "receiving_cell", "is_autocrine",
                    "sending_type", "receiving_type"):
            if col in schema_names:
                agg_cols.append(f'FIRST("{col}") AS "{col}"')
        for coord in ("x1", "y1", "x2", "y2"):
            if coord in schema_names:
                agg_cols.append(f'FIRST("{coord}") AS "{coord}"')

        # lrm_count  = total LRMs for this edge (tissue-graph structural layer)
        # score_sum  = SUM(all scores) — default visible_score_sum when no LRM filter
        if has_lrm:
            agg_cols.append("COUNT(*) AS lrm_count")
        else:
            agg_cols.append("1 AS lrm_count")
        if has_score:
            agg_cols.append("SUM(score) AS score_sum")

        select = ", ".join(agg_cols)

        # Bernoulli sampling: each grouped edge row is included independently
        # at probability `density`. At density=1.0 no sampling clause is added
        # and all viewport edges are returned (up to max_limit safety cap).
        sample_clause = (
            f"USING SAMPLE {density * 100:.4f} PERCENT (bernoulli)"
            if density < 1.0 else ""
        )

        sql = f"""
            SELECT * FROM (
                SELECT {select}
                FROM {self._from()}
                {where}
                GROUP BY edge
                HAVING lrm_count >= 1
            ) {sample_clause}
            LIMIT {max_limit}
        """

        with self._conn() as conn:
            df = conn.execute(sql, where_params).df()

        for col in ("x1", "y1", "x2", "y2"):
            if col in df.columns:
                df[col] = df[col] / ps

        if "is_autocrine" in df.columns:
            df["is_autocrine"] = df["is_autocrine"].astype(bool)

        return [
            {c: (None if isinstance(v, float) and not math.isfinite(v) else v)
             for c, v in row.items()}
            for row in df.to_dict(orient="records")
        ]

    def query_scores(
        self,
        bbox: Optional[tuple] = None,
        included_lrms: Optional[list] = None,
        excluded_lrms: Optional[list] = None,
        max_limit: int = 500_000,
    ) -> list[dict]:
        """
        Return per-edge LRM visibility scores: visible_lrm_count + visible_score_sum.
        Much lighter than query_grouped — no coordinates or metadata columns.

        Two query strategies, chosen by the caller based on set sizes:

        included_lrms (preferred when visible set is small):
            WHERE lrm IN (included_lrms) — DuckDB only reads matching rows,
            giving roughly a (visible / total) fraction of the scan cost.
            Edges absent from the result have visible_lrm_count = 0.

        excluded_lrms (preferred when excluded set is small):
            CASE WHEN lrm NOT IN (excluded_lrms) — full scan with per-row mask.
            All bbox edges appear in the result.

        The frontend picks whichever produces the smaller IN-list.
        No density sampling — returns scores for all bbox edges so the
        density-sampled structural edges always find their matching scores.
        """
        ps = self.pixel_size
        schema_names = set(self._parquet_schema().names)
        has_lrm   = "lrm"   in schema_names
        has_score = "score" in schema_names

        if not has_lrm:
            return []

        where_conditions: list[str] = []
        where_params: list = []

        if bbox:
            xmin, ymin, xmax, ymax = bbox
            if None not in (xmin, ymin, xmax, ymax):
                xmin_u, ymin_u = xmin * ps, ymin * ps
                xmax_u, ymax_u = xmax * ps, ymax * ps
                where_conditions.append(
                    "((x1 >= ? AND x1 <= ? AND y1 >= ? AND y1 <= ?) OR "
                    "(x2 >= ? AND x2 <= ? AND y2 >= ? AND y2 <= ?))"
                )
                where_params.extend([xmin_u, xmax_u, ymin_u, ymax_u,
                                      xmin_u, xmax_u, ymin_u, ymax_u])

        where = f"WHERE {' AND '.join(where_conditions)}" if where_conditions else ""

        if included_lrms is not None:
            # Fast path: filter to visible rows only, then aggregate.
            # Edges with 0 visible LRMs simply don't appear — the frontend
            # treats missing entries as visible_lrm_count = 0.
            ph = ", ".join("?" for _ in included_lrms)
            lrm_filter = f" AND lrm IN ({ph})" if included_lrms else " AND FALSE"
            full_where = (
                f"WHERE {' AND '.join(where_conditions)}{lrm_filter}"
                if where_conditions
                else f"WHERE lrm IN ({ph})" if included_lrms else "WHERE FALSE"
            )
            score_col = "SUM(score) AS visible_score_sum" if has_score else "0 AS visible_score_sum"
            sql = f"""
                SELECT edge,
                       COUNT(*) AS visible_lrm_count,
                       {score_col}
                FROM {self._from()}
                {full_where}
                GROUP BY edge
                LIMIT {max_limit}
            """
            params = where_params + list(included_lrms)

        else:
            # Standard path: full scan with CASE WHEN exclusion mask.
            excl = excluded_lrms or []
            ph = ", ".join("?" for _ in excl)
            vis_count = (
                f"SUM(CASE WHEN lrm NOT IN ({ph}) THEN 1 ELSE 0 END)"
                if excl else "COUNT(*)"
            )
            vis_score = ""
            if has_score:
                vis_score = (
                    f", SUM(CASE WHEN lrm NOT IN ({ph}) THEN score ELSE 0 END) AS visible_score_sum"
                    if excl else ", SUM(score) AS visible_score_sum"
                )
            # CASE WHEN placeholders come before WHERE placeholders in bind order
            excl_params = list(excl) * (2 if (excl and has_score) else (1 if excl else 0))
            sql = f"""
                SELECT edge,
                       {vis_count} AS visible_lrm_count
                       {vis_score}
                FROM {self._from()}
                {where}
                GROUP BY edge
                LIMIT {max_limit}
            """
            params = excl_params + where_params

        with self._conn() as conn:
            df = conn.execute(sql, params).df()

        if df.empty:
            return []

        return [
            {c: (None if isinstance(v, float) and not math.isfinite(v) else v)
             for c, v in row.items()}
            for row in df.to_dict(orient="records")
        ]

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
