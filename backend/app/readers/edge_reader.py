"""
Reads edge-list Parquet files.

Required columns: x1, y1, x2, y2  (native coordinate space, e.g. µm)
All other columns are open metadata (layer type, strength, p-value, etc.)

Coordinates are returned in image pixel space (divided by pixel_size).
BBox query parameters are also expected in image pixel space.

Uses DuckDB for all parquet queries so large files (1+ GB) are processed in
streaming chunks without loading the full dataset into RAM.
"""
import logging
import math
import os
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Optional
import duckdb
import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

from app.readers import duck, metadata_filter, spatial_cache, supplemental
from app.readers.metadata_filter import MetadataFilter

log = logging.getLogger("tissueplex.edges")



_UNSET = object()


def _records(df: pd.DataFrame) -> list[dict]:
    """DataFrame → JSON-safe records, without a Python loop over every value.

    The old form, `{c: (None if not isfinite(v) else v) for c, v in row.items()}`
    over `df.to_dict("records")`, visited every cell of the result in Python —
    for a 500K-edge viewport that is six million isfinite calls per pan, more
    time than the DuckDB query itself. Here the non-finite check is vectorised
    per float column and the per-row fix-up runs only on columns that actually
    contain a NaN or Inf (usually none). Building rows from column lists is also
    ~2.5x faster than pandas' own to_dict.

    Same output as before, including None in place of NaN/Inf, so the golden
    snapshot digests do not move.
    """
    if df.empty:
        return []
    names = list(df.columns)
    cols = []
    for c in names:
        col = df[c]
        if col.dtype.kind == "f":
            arr = col.to_numpy()
            if not np.isfinite(arr).all():
                col = col.astype(object).where(np.isfinite(arr), None)
        elif col.dtype == object and col.isna().any():
            # A NaN float inside an object column (a null string in pandas'
            # hands) must become None too, as it did before.
            col = col.where(col.notna(), None)
        cols.append(col.tolist())
    return [dict(zip(names, row)) for row in zip(*cols)]


# The pipeline, in one place:
#
#     all edges in viewport
#       → density filter          (spatially random, this predicate)
#       → EDGESET A               → tissue-graph layer
#       → sending filter
#       → receiving filter
#       → edge-table filters
#       → EDGESET B               → edge-data layer
#
# So B ⊆ A always: edge data can never be drawn where the graph beneath it has
# been sampled away.
#
# The two layers are fetched by separate queries, and the order above is only
# guaranteed because this predicate is *deterministic per edge*. A given edge
# gets the same verdict in every query regardless of what else ran, so the
# predicate commutes with the filters and "density then filter" and "filter then
# density" select the identical set.
#
# `USING SAMPLE` cannot do this. Two independent bernoulli draws at 10% give the
# graph one random tenth and the edge layer a different one — an overlap of ~1%,
# with edge data floating free of the structure it is supposed to sit on.
#
# A deterministic hash of the edge identity fixes that. The same edge gets the
# same verdict in every query, whatever filters ran, so the edge layer is always
# a subset of the graph:
#
#     graph      = { e : keep(e) }
#     edge data  = { e : passes_filters(e) and keep(e) }  ⊆ graph
#
# It is also spatially uniform (the hash ignores position) and stable across
# re-fetches, which matters because the alternative flickers on every pan.
#
# Unlike USING SAMPLE this is an ordinary predicate, so it composes with the
# filters by AND and cannot be reordered below them — the property the
# subquery-wrapping was there to guarantee.
_DENSITY_MODULUS = 1_000_000


def density_predicate(density: float, key_sql: str = '"edge"') -> str:
    """SQL keeping a deterministic, spatially uniform fraction of edges."""
    if density is None or density >= 1.0:
        return ""
    cut = max(1, int(density * _DENSITY_MODULUS))
    return f"(hash(CAST({key_sql} AS VARCHAR)) % {_DENSITY_MODULUS}) < {cut}"


def _density_cut(density: float) -> int:
    return _DENSITY_MODULUS if density is None or density >= 1.0 \
        else max(1, int(density * _DENSITY_MODULUS))


# ── Density tier ──────────────────────────────────────────────────────────────
#
# At whole-tissue zoom nothing can be pruned by position, so every LRM toggle
# and every pan at that zoom was a scan of the full edge file. But the density
# predicate is deterministic: the edges kept at density ≤ 0.1 are a *fixed*
# subset of the file, and a query at any density ≤ 0.1 selects a subset of that
# subset. So the reader keeps a second derived parquet — the ≤10% tier, sorted
# the same way — and reads it whenever the requested density allows. At the
# default density that is a tenth of the rows for every query, zoomed in or out.
TIER_DENSITY = 0.1


# ── Per-viewport score matrix ─────────────────────────────────────────────────
#
# Toggling a mechanism in the LRM list does not change which edges are in view,
# only which of their rows count. The SQL path re-scanned the viewport's rows and
# re-aggregated them on every click; this keeps those rows in memory once, as
# three flat arrays (edge index, LRM index, score), so a toggle is a masked
# `bincount` — a few milliseconds for a few hundred thousand rows — instead of
# a query. The matrix is a pure function of (bbox, density), so it is keyed on
# exactly that; filters do not enter because `query_scores` never applied them
# (the frontend overlays scores onto the already-filtered structural rows).
#
# Bounded: entries are evicted least-recently-used once the process-wide budget
# is reached, and a viewport whose rows would exceed the budget on its own is
# simply not cached and answered by SQL as before.

def _score_budget_bytes() -> int:
    env = (os.getenv("SCORE_CACHE_MB") or "").strip()
    if env:
        return int(float(env) * 1024 * 1024)
    avail = duck._available_memory_bytes() or (2 << 30)
    return int(min(256 << 20, avail * 0.08))


_SCORE_BUDGET = _score_budget_bytes()
_score_entries: "OrderedDict[tuple, _ScoreMatrix]" = OrderedDict()
_score_bytes = 0
_score_lock = threading.Lock()


class _ScoreMatrix:
    __slots__ = ("edges", "lrm_index", "edge_idx", "lrm_idx", "score", "nbytes", "has_score")

    def __init__(self, edges, lrm_index, edge_idx, lrm_idx, score, has_score):
        self.edges = edges            # np.ndarray[object], one id per distinct edge
        self.lrm_index = lrm_index    # {lrm: column index}
        self.edge_idx = edge_idx      # int32 per row
        self.lrm_idx = lrm_idx        # int32 per row, -1 for a null lrm
        self.score = score            # float64 per row (nulls → 0, NaN kept), or None
        self.has_score = has_score
        self.nbytes = (edge_idx.nbytes + lrm_idx.nbytes
                       + (score.nbytes if score is not None else 0)
                       + 80 * (len(edges) + len(lrm_index)))

    def compute(self, included, excluded, max_limit: int) -> list[dict]:
        n_lrm = len(self.lrm_index)
        if included is not None:
            vis = np.zeros(n_lrm, dtype=bool)
            for l in included:
                i = self.lrm_index.get(l)
                if i is not None:
                    vis[i] = True
        else:
            vis = np.ones(n_lrm, dtype=bool)
            for l in (excluded or []):
                i = self.lrm_index.get(l)
                if i is not None:
                    vis[i] = False
        mask = (self.lrm_idx >= 0) & vis[np.maximum(self.lrm_idx, 0)]
        n_edges = len(self.edges)
        counts = np.bincount(self.edge_idx[mask], minlength=n_edges)
        cols = {"edge": self.edges, "visible_lrm_count": counts}
        if self.score is not None:
            cols["visible_score_sum"] = np.bincount(
                self.edge_idx[mask], weights=self.score[mask], minlength=n_edges)
        elif included is not None:
            cols["visible_score_sum"] = np.zeros(n_edges, dtype=np.int64)
        df = pd.DataFrame(cols)
        if included is not None:
            # The SQL form filters rows first and so never produces an edge with
            # nothing visible; the exclusion form reports every edge in view.
            df = df[df["visible_lrm_count"] > 0]
        if len(df) > max_limit:
            df = df.iloc[:max_limit]
        return _records(df.reset_index(drop=True))


class EdgeReader:
    def __init__(self, path: Path, pixel_size: float = 1.0):
        self.path = path
        # SQL-safe path string (escape single quotes)
        self._sql_path = str(path).replace("'", "''")
        self._schema_cache = None
        self._lrm_catalogue_cache = None
        self._pixel_size = pixel_size
        self._supp_cache = _UNSET
        # Longest edge in the file, native units; see _bbox_sql. _UNSET until
        # first needed, None when it cannot be measured.
        self._max_edge_len = _UNSET
        # Per-field colour summaries (type, categories, range) — see
        # edge_color_summary — and per-column filter summaries.
        self._summary_cache: dict = {}
        self._col_summary_cache: dict = {}
        self._matrix_lock = threading.Lock()

    # ── Supplemental edge metadata ────────────────────────────────────────────
    #
    # Mirrors the cell-metadata/ convention exactly, one level up: the user drops
    # CSV/parquet keyed on `edge` into an edge-metadata/ folder beside the dataset,
    # and the columns appear in the edge color-by dropdown without regenerating
    # edges.parquet from R.
    #
    # The folder lives next to the *dataset*, not next to the edge file, so a single
    # set of annotations applies across every edge source in a dataset (see the
    # multiple-edge-files feature). Annotations describe cell pairs, which are a
    # property of the tissue rather than of one scoring run.

    @property
    def _dataset_dir(self) -> Path:
        # self.path is either <dataset>/edges.parquet or <dataset>/edges/<name>.parquet.
        parent = self.path.parent
        return parent.parent if parent.name == "edges" else parent

    def _supplemental(self):
        """User edge annotations keyed on `edge`, or None. Cached per instance."""
        if self._supp_cache is not _UNSET:
            return self._supp_cache
        files = supplemental.collect_files(self._dataset_dir / "edge-metadata")
        self._supp_cache = supplemental.load_supplemental(
            files, key="edge", log_prefix="edge_reader"
        )
        return self._supp_cache

    def _supplemental_columns(self) -> dict:
        """{column: dtype_str} for supplemental columns, excluding the join key."""
        df = self._supplemental()
        if df is None:
            return {}
        return {c: str(df[c].dtype) for c in df.columns if c != "edge"}

    @property
    def pixel_size(self) -> float:
        return self._pixel_size

    def _parquet_schema(self):
        if self._schema_cache is None:
            self._schema_cache = pq.read_schema(self.path)
        return self._schema_cache

    def _from(self, density: float = 1.0) -> str:
        """FROM fragment for the edge file — the spatially-sorted copy when there is one.

        Same mechanism the transcript and boundary readers use (`spatial_cache`):
        a one-time background rewrite of the file sorted by a coarse grid on the
        sending centroid, with small row groups, so the bbox predicate can skip
        most of the file. Until the build lands, or for files under the size
        threshold, this is the original file and the query is simply slower.
        Results are identical either way — every query here aggregates or
        filters by edge id, and nothing depends on row order.

        A query that will apply the density predicate at ≤ `TIER_DENSITY` reads
        the tier file instead (see the module note): the same rows the predicate
        would keep, and nothing else, so the query's own predicate is a no-op on
        it and the scan is a tenth of the size. Derived from the sorted file once
        that exists, so the two builds never run at the same time.
        """
        src = spatial_cache.sorted_path(
            self.path, self._dataset_dir, "x1", "y1", cache_name=self._cache_name())
        if src is None:
            return f"read_parquet('{self._sql_path}')"
        if (density is not None and _density_cut(density) <= _density_cut(TIER_DENSITY)
                and "edge" in self._parquet_schema().names):
            tier = spatial_cache.sorted_path(
                src, self._dataset_dir, "x1", "y1",
                cache_name=f"{self._cache_name()}.d{int(round(TIER_DENSITY * 100)):02d}",
                where_sql=density_predicate(TIER_DENSITY))
            if tier is not None:
                return duck.scan(tier)
        return duck.scan(src)

    def _cache_name(self) -> str:
        # "edges" for the top-level file, "edges__edge.raw.minimum" for one in
        # edges/, so two edge sources in one dataset never share a cache file.
        rel = self.path.relative_to(self._dataset_dir) if self.path.is_relative_to(
            self._dataset_dir) else Path(self.path.name)
        stem = str(rel.with_suffix("")).replace(os.sep, "__")
        return stem

    def max_edge_length(self) -> Optional[float]:
        """Length of the longest edge in native units, measured once per file."""
        if self._max_edge_len is _UNSET:
            self._max_edge_len = None
            if {"x1", "y1", "x2", "y2"} <= set(self._parquet_schema().names):
                try:
                    with self._conn() as conn:
                        v = conn.execute(
                            f"SELECT MAX(sqrt((x1 - x2) * (x1 - x2) + (y1 - y2) * (y1 - y2))) "
                            f"FROM read_parquet('{self._sql_path}')").fetchone()[0]
                    if v is not None and math.isfinite(float(v)):
                        self._max_edge_len = float(v)
                except Exception as exc:
                    log.warning("%s: could not measure max edge length: %s", self.path.name, exc)
        return self._max_edge_len

    def _bbox_sql(self, bbox: Optional[tuple]) -> str:
        """WHERE fragment keeping edges with either endpoint in `bbox` (pixel space).

        Two parts, and both are needed:

        * The *exact* test, `(x1,y1) in box OR (x2,y2) in box`. This is what the
          layer means, but DuckDB cannot prune parquet row groups through an OR
          over two different column pairs — measured on a 33M-row sorted file, it
          scanned every row group whatever the viewport.
        * A *prunable* envelope on the sending centroid alone: `x1,y1` within the
          box grown by the longest edge in the file. Any edge whose receiving end
          is in view has its sending end within that distance of the box, so the
          envelope keeps a superset of the exact set and changes nothing — but it
          is a plain conjunction on one column pair, which is exactly what zone
          maps can use. On the same file this took a 10% viewport from 231 ms to
          28 ms and a 2% viewport from 213 ms to 16 ms.

        Bounds are inlined as literals rather than bound as `?`, because DuckDB
        prunes at plan time and bound values are not known then (see
        `duck.bbox_predicate`, where this was measured). Every value goes through
        `float()` first, so only finite numeric literals can reach the SQL.
        """
        if not bbox or None in bbox:
            return ""
        ps = self.pixel_size
        try:
            vals = [float(v) * ps for v in bbox]
        except (TypeError, ValueError):
            return ""
        if not all(math.isfinite(v) for v in vals):
            return ""
        xmin, ymin, xmax, ymax = (repr(v) for v in vals)
        exact = (f"((x1 >= {xmin} AND x1 <= {xmax} AND y1 >= {ymin} AND y1 <= {ymax}) OR "
                 f"(x2 >= {xmin} AND x2 <= {xmax} AND y2 >= {ymin} AND y2 <= {ymax}))")
        reach = self.max_edge_length()
        if reach is None:
            return exact
        ex0, ey0, ex1, ey1 = (repr(v) for v in (
            vals[0] - reach, vals[1] - reach, vals[2] + reach, vals[3] + reach))
        envelope = f"(x1 >= {ex0} AND x1 <= {ex1} AND y1 >= {ey0} AND y1 <= {ey1})"
        return f"{envelope} AND {exact}"

    def _conn(self):
        # Shared with the spatial readers via duck.connect(), which also gives a
        # fresh isolated connection per call (duckdb's default connection is not
        # thread-safe and returns empty or corrupt results under FastAPI's
        # threadpool rather than raising).
        #
        # This used to build its own connection with
        # `os.getenv("DUCKDB_MEMORY_LIMIT", "8GB")`. That default only applies
        # when the variable is *absent*: set-but-empty returns "", so
        # `SET memory_limit=''` raised a ParserException and every /edges
        # endpoint 500'd. Compose sets it empty on purpose now, to let the limit
        # be sized from available memory — so the two disagreed and edges stopped
        # loading everywhere. Going through duck.connect() means there is one
        # defaulting rule instead of two, and EdgeReader also picks up the
        # temp_directory it never had, so a large edge query can spill instead of
        # failing outright.
        return duck.connect()

    def schema(self) -> dict:
        """Column names and dtypes, parquet columns plus any supplemental ones.

        The frontend builds the edge color-by dropdown straight from this, so
        including supplemental columns here is all it takes for them to appear —
        no frontend change required.
        """
        schema = self._parquet_schema()
        columns = {name: str(schema.field(name).type) for name in schema.names}
        # Parquet wins a name collision: it is the authoritative source, and a
        # supplemental column shadowing a real one would be confusing to debug.
        for col, dtype in self._supplemental_columns().items():
            columns.setdefault(col, dtype)
        return {"columns": columns}

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
                          field: str | None = None,
                          categorical: bool | None = None,
                          summary: bool = False) -> dict:
        """
        Return per-directed-edge color values.

        mode='lrm_set'  — sum score across requested LRMs per edge; continuous
        mode='metadata' — group by edge, take first value of `field` per edge;
                          categorical vs continuous auto-detected unless the caller
                          overrides it with `categorical` (issue #35)

        `summary=True` (metadata mode) returns the column's type, categories and
        range *without* the per-edge values — what a legend or a filter needs.
        The viewer no longer asks for the full map at all: the per-edge value
        rides on `query_grouped` rows as `color_value`.
        """
        if summary and mode == "metadata":
            return self.edge_color_summary(field, categorical)
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
            if not field:
                return {"type": "continuous", "values": {}, "min": 0, "max": 0}

            if field in col_names:
                with self._conn() as conn:
                    df = conn.execute(
                        f'SELECT edge, FIRST("{field}") AS val FROM {self._from()} GROUP BY edge'
                    ).df()
                col = df.set_index("edge")["val"]
            else:
                # Supplemental column from edge-metadata/. Already one row per edge,
                # so there is nothing to aggregate.
                supp = self._supplemental()
                if supp is None or field not in supp.columns:
                    return {"type": "continuous", "values": {}, "min": 0, "max": 0}
                col = supp.set_index("edge")[field].dropna()
                if col.empty:
                    return {"type": "continuous", "values": {}, "min": 0, "max": 0}
            # Same typing rule as the cell side, from the shared module, so the
            # two color panels can never disagree about what is categorical.
            if metadata_filter.is_categorical(col, categorical):
                labels = col.dropna().astype(str)
                return {
                    "type": "categorical",
                    "values": labels.to_dict(),
                    "categories": metadata_filter.sort_categories(labels.unique()),
                }
            numeric = pd.to_numeric(col, errors="coerce").dropna()
            if numeric.empty:
                return {"type": "continuous", "values": {}, "min": 0, "max": 0}
            return {
                "type": "continuous",
                "values": numeric.to_dict(),
                "min": float(numeric.min()),
                "max": float(numeric.max()),
            }

        return {"type": "continuous", "values": {}, "min": 0, "max": 0}

    def edge_color_summary(self, field: str | None,
                           categorical: bool | None = None) -> dict:
        """Type, categories and range of an edge metadata column, cached per field.

        The legend, the filter panel and the colour panel all need to know what
        kind of column this is and what its span is — none of them need a value
        per edge, which is what they used to download (a GROUP BY over the whole
        file and a map with one entry per edge in the dataset) just to read
        `type` and `categories` off it. Distinct values are a single-column scan;
        the continuous range aggregates per-edge first values once, so `p95`
        matches what the old client-side percentile over the full map gave.
        """
        empty = {"type": "continuous", "min": 0.0, "max": 0.0, "p95": None,
                 "categories": [], "empty": True}
        if not field:
            return empty
        key = (field, categorical)
        hit = self._summary_cache.get(key)
        if hit is not None:
            return hit
        col_names = set(self._parquet_schema().names)
        res = empty
        try:
            if field in col_names:
                q = f'"{field}"'
                with self._conn() as conn:
                    distinct = conn.execute(
                        f"SELECT DISTINCT {q} FROM {self._from()} WHERE {q} IS NOT NULL"
                    ).df().iloc[:, 0]
                if distinct.empty:
                    res = empty
                elif metadata_filter.is_categorical(distinct, categorical):
                    res = {"type": "categorical", "empty": False,
                           "categories": metadata_filter.sort_categories(
                               distinct.astype(str).unique())}
                else:
                    with self._conn() as conn:
                        row = conn.execute(f"""
                            SELECT MIN(v), MAX(v), quantile_cont(v, 0.95) FROM (
                                SELECT FIRST({q}) AS v FROM {self._from()} GROUP BY edge
                            ) WHERE v IS NOT NULL AND isfinite(v)
                        """).fetchone()
                    if row is None or row[0] is None:
                        res = empty
                    else:
                        res = {"type": "continuous", "min": float(row[0]),
                               "max": float(row[1]), "p95": float(row[2]),
                               "categories": [], "empty": False}
            else:
                supp = self._supplemental()
                if supp is not None and field in supp.columns:
                    col = supp.set_index("edge")[field].dropna()
                    if col.empty:
                        res = empty
                    elif metadata_filter.is_categorical(col, categorical):
                        labels = col.astype(str)
                        res = {"type": "categorical", "empty": False,
                               "categories": metadata_filter.sort_categories(labels.unique())}
                    else:
                        num = pd.to_numeric(col, errors="coerce").dropna()
                        num = num[np.isfinite(num)]
                        if num.empty:
                            res = empty
                        else:
                            res = {"type": "continuous", "min": float(num.min()),
                                   "max": float(num.max()),
                                   "p95": float(num.quantile(0.95)),
                                   "categories": [], "empty": False}
        except Exception as exc:
            log.warning("%s: could not summarise column %s: %s", self.path.name, field, exc)
            res = empty
        self._summary_cache[key] = res
        return res

    # ── Metadata filtering (issue #45) ────────────────────────────────────────

    def edge_filter_sql(self, spec: Optional[MetadataFilter], conn) -> tuple[str, list]:
        """WHERE fragment restricting the query to edges matching `spec`.

        Two paths, because edge metadata has two sources:

        * A column in ``edges.parquet`` becomes an ordinary SQL predicate, which
          DuckDB can push down and use for row-group pruning.
        * A column from ``edge-metadata/`` only exists in pandas, so the matching
          edge ids are resolved there and registered as a relation to semi-join
          against — the same trick the cell filter uses, and for the same reason:
          the id list is far too long to bind as parameters.

        Raises ValueError for an unknown column rather than quietly returning the
        unfiltered view, which would look like the filter had failed.
        """
        if spec is None:
            return "", []
        schema = self._parquet_schema()
        parquet_cols = set(schema.names)
        if spec.field in parquet_cols:
            quoted = f'"{spec.field}"'
            if spec.values is not None:
                # Compare as text so one code path covers int, float and string
                # columns. Booleans need lowering: the categories the panel offers
                # come from pandas, which writes "True", while DuckDB's cast writes
                # "true", so a literal comparison would never match.
                cast = f"CAST({quoted} AS VARCHAR)"
                vals = list(spec.values)
                if pa.types.is_boolean(schema.field(spec.field).type):
                    cast = f"lower({cast})"
                    vals = [v.lower() for v in vals]
                ph = ", ".join("?" for _ in vals)
                sql = f"{cast} IN ({ph})"
                params = vals
            else:
                parts, params = [], []
                if spec.vmin is not None:
                    parts.append(f"{quoted} >= ?"); params.append(spec.vmin)
                if spec.vmax is not None:
                    parts.append(f"{quoted} <= ?"); params.append(spec.vmax)
                sql = " AND ".join(parts) if parts else ""
            if spec.include_missing and sql:
                sql = f"({sql} OR {quoted} IS NULL)"
            return sql, params

        supp = self._supplemental()
        if supp is None or spec.field not in supp.columns:
            raise ValueError(f"unknown edge metadata column '{spec.field}'")
        keep = supp.loc[spec.mask(supp[spec.field]), "edge"].astype(str)
        if keep.empty:
            return "FALSE", []
        pred = duck.register_ids(conn, keep.tolist(), name="tp_edge_filter", col="edge")
        return f'CAST("edge" AS VARCHAR) {pred}', []

    @staticmethod
    def endpoint_filter_sql(
        sending_ids: Optional[set],
        receiving_ids: Optional[set],
        conn,
    ) -> tuple[str, list]:
        """WHERE fragment constraining each endpoint of an edge independently.

        Either side may be None, which leaves that end unconstrained — so setting
        only `sending_ids` answers "everything sent *from* these cells, to
        anywhere". With both set the result is the intersection: an edge is kept
        when its sender is in one set and its receiver in the other.

        This replaces a single set applied to both ends. That older rule tied edge
        visibility to the *cell* filter, which the lab wants independent: filtering
        cells is one action, filtering edges another, and an edge may now terminate
        on a cell that is not drawn. See docs/edge_filter_independence.md.

        An empty set means "nothing matches" and short-circuits to FALSE. It must
        not fall through to no-predicate, or a filter matching no cells would
        return every edge — and `register_ids` refuses an empty frame anyway.

        Both predicates are ordinary semi-joins in the WHERE clause, so they run
        before the GROUP BY and before the density sample.
        """
        conds: list[str] = []
        for ids, col, name in (
            (sending_ids,   "sending_cell",   "tp_send_filter"),
            (receiving_ids, "receiving_cell", "tp_recv_filter"),
        ):
            if ids is None:
                continue
            if not ids:
                return "FALSE", []
            pred = duck.register_ids(conn, ids, name=name)
            conds.append(f'CAST("{col}" AS VARCHAR) {pred}')
        return (" AND ".join(conds), []) if conds else ("", [])

    def neighborhood(self, cell_id: str, top_lrms: int = 12) -> dict | None:
        """Everything a cell is connected to, unfiltered and unsampled (issue #60).

        The neighbourhood is a property of the tissue, not of the current view, so
        this deliberately ignores density, the viewport and every filter. Computing
        it from the frontend's `edges` array instead would look like it worked and
        be wrong twice over: that array is density-sampled (a tenth of the
        neighbours by default) and viewport-bounded (missing any neighbour just
        off-screen, and changing as you pan).

        Direction is ignored for membership — a cell that only *sends* to this one
        is still a neighbour — but the returned edge counts are directed, because
        that is what the edge layer draws.

        Returns None when the cell appears in no edge at all, which is an ordinary
        outcome rather than an error.
        """
        cols = set(self._parquet_schema().names)
        if not {"sending_cell", "receiving_cell"} <= cols:
            return None
        ps = self.pixel_size
        has_lrm, has_score = "lrm" in cols, "score" in cols

        with self._conn() as conn:
            rows = conn.execute(f"""
                SELECT * FROM {self._from()}
                WHERE CAST("sending_cell" AS VARCHAR) = ?
                   OR CAST("receiving_cell" AS VARCHAR) = ?
            """, [str(cell_id), str(cell_id)]).df()
        if rows.empty:
            return None

        me = str(cell_id)
        send = rows["sending_cell"].astype(str)
        recv = rows["receiving_cell"].astype(str)

        # The partner cell, and the coordinates of whichever end is not us. Both
        # come from the edge file, which is the one source every platform has —
        # MERSCOPE and CosMx ship no boundary polygons to derive a centroid from.
        partner = recv.where(send == me, send)
        px = rows["x2"].where(send == me, rows["x1"]) if "x2" in rows else None
        py = rows["y2"].where(send == me, rows["y1"]) if "y2" in rows else None

        self_x = rows["x1"].where(send == me, rows["x2"]) if "x1" in rows else None
        self_y = rows["y1"].where(send == me, rows["y2"]) if "y1" in rows else None
        centre = ([float(self_x.iloc[0]) / ps, float(self_y.iloc[0]) / ps]
                  if self_x is not None and len(self_x) else None)

        # One point per distinct partner. Autocrine rows name us as the partner;
        # they are counted separately rather than drawn as a neighbour of ourself.
        pts, radius_px = [], 0.0
        if px is not None:
            frame = {}
            for pid, x, y in zip(partner, px, py):
                if pid == me or pid in frame:
                    continue
                frame[pid] = (float(x) / ps, float(y) / ps)
            pts = [{"cell_id": k, "x": v[0], "y": v[1]} for k, v in frame.items()]
            if centre and pts:
                radius_px = max(((q["x"] - centre[0]) ** 2 +
                                 (q["y"] - centre[1]) ** 2) ** 0.5 for q in pts)

        neighbours = sorted({p for p in partner if p != me})

        lrms = []
        if has_lrm:
            agg = rows.groupby("lrm", dropna=True)
            summed = (agg["score"].sum() if has_score else agg.size()).sort_values(ascending=False)
            lrms = [{"lrm": str(k),
                     "value": float(v) if has_score else int(v),
                     "n": int(agg.size()[k])}
                    for k, v in summed.head(top_lrms).items()]

        return {
            "cell_id": me,
            "center": centre,
            "neighbors": neighbours,
            "neighbor_points": pts,
            "n_neighbors": len(neighbours),
            # Directed edges incident to this cell, deduplicated by edge id — the
            # raw rows are one per (edge x LRM), which would overcount by ~500x.
            "n_edges": int(rows["edge"].nunique()) if "edge" in rows else len(rows),
            "n_autocrine": int(((send == me) & (recv == me)).any()),
            "radius_px": radius_px,
            "radius_um": radius_px * ps,
            "lrm_composition": lrms,
            "score_basis": "score" if has_score else "count",
        }

    def edge_detail(self, edge_id: str, near: Optional[tuple] = None) -> dict | None:
        """Return all LRM rows for a single directed edge, structured for the info panel.

        `near` is the edge's sending centroid in pixel space, when the caller has
        it (the clicked row carries `x1`/`y1`). Matching on the id alone is a
        scan of the whole file's `edge` column — about a second per click on a
        lab-scale file; with the position the bbox envelope prunes it to the row
        groups around that cell. The id is still what decides the match.
        """
        where, params = "WHERE edge = ?", [edge_id]
        if near is not None and None not in near:
            x, y = near
            loc = self._bbox_sql((x - 2, y - 2, x + 2, y + 2))
            if loc:
                where += f" AND {loc}"
        with self._conn() as conn:
            df = conn.execute(
                f"SELECT * FROM {self._from()} {where}", params
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

        # Attach user annotations under their own key so the info panel can present
        # them separately from the platform's own fields.
        supp = self._supplemental()
        if supp is not None:
            row = supp[supp["edge"].astype(str) == str(edge_id)]
            if not row.empty:
                extras = {}
                for c, v in row.iloc[0].items():
                    if c == "edge" or pd.isna(v):
                        continue
                    extras[c] = (None if isinstance(v, float) and not math.isfinite(v)
                                 else (v.item() if hasattr(v, "item") else v))
                if extras:
                    result["metadata"] = extras
        return result

    def column_summary(self, column: str) -> dict:
        col_names = set(self._parquet_schema().names)
        if column not in col_names:
            return {"type": "categorical", "values": [], "count": 0}
        hit = self._col_summary_cache.get(column)
        if hit is not None:
            return hit
        res = self._column_summary(column)
        self._col_summary_cache[column] = res
        return res

    def _column_summary(self, column: str) -> dict:
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

    def query_structure(
        self,
        bbox: Optional[tuple] = None,
        density: float = 1.0,
        max_limit: int = 500_000,
    ) -> list[dict]:
        """Every distinct edge in the viewport, with no filters of any kind.

        This backs the tissue-graph layer, which is *ground truth*: the total set
        of edges, shown or hidden, never subset. It deliberately takes no filter
        arguments at all — not "filters default to none", but no way to pass one,
        so the layer cannot be narrowed by a future caller wiring one through.

        It is a separate query from `query_grouped`, not a flag on it, because the
        two want opposite orderings of the same pipeline. The edge-data layer must
        filter *then* sample, so a rare subset draws at full density; the graph
        must not filter at all. Returning every edge with a `passes_filter` column
        would sample the rare subset away before the flag was ever read.

        The projection is deliberately lean — `edge` and the four coordinates.
        Scores, types and LRM counts are most of `query_grouped`'s payload and the
        structural layer draws none of them; `edge` is kept only because the layer
        is pickable and the info panel resolves by id.
        """
        cols = set(self._parquet_schema().names)
        if not {"x1", "y1", "x2", "y2"} <= cols:
            return []
        ps = self.pixel_size

        bbox_sql = self._bbox_sql(bbox)
        where, params = (f"WHERE {bbox_sql}" if bbox_sql else ""), []

        has_edge = "edge" in cols
        key = "edge" if has_edge else "x1, y1, x2, y2"
        sel = ("edge, " if has_edge else "") + \
              "FIRST(x1) AS x1, FIRST(y1) AS y1, FIRST(x2) AS x2, FIRST(y2) AS y2"
        # The *same* predicate query_grouped uses, on the same key, so the two
        # layers select an identical subset and edge data is never drawn where
        # the graph beneath it has been sampled away.
        dens = density_predicate(
            density, '"edge"' if has_edge else "concat_ws('|',x1,y1,x2,y2)")
        sample = f"WHERE {dens}" if dens else ""

        with self._conn() as conn:
            df = conn.execute(f"""
                SELECT * FROM (
                    SELECT {sel} FROM {self._from(density)} {where} GROUP BY {key}
                ) {sample}
                LIMIT {max_limit}
            """, params).df()

        for c in ("x1", "y1", "x2", "y2"):
            df[c] = df[c] / ps
        return _records(df)

    def query_grouped(
        self,
        bbox: Optional[tuple] = None,
        min_lrm_count: int = 1,
        density: float = 1.0,
        max_limit: int = 500_000,
        sending_ids: Optional[set] = None,
        receiving_ids: Optional[set] = None,
        edge_filters: Optional[list] = None,
        color_field: Optional[str] = None,
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

        `sending_ids` / `receiving_ids` constrain the two endpoints independently
        (issue #59); `edge_filters` is a list of MetadataFilter and-ed together,
        which is the composition #45 deferred. All of them go into the WHERE
        clause, so they run before the GROUP BY and before the density sample:
        narrowing to a rare subset keeps it at full density rather than sampling
        it away. Density is last, and deliberately so — it is a rendering-volume
        control, not a selection criterion.

        `color_field` names an edge metadata column (parquet or edge-metadata/)
        whose per-edge value is returned as `color_value` on each row. The
        metadata colour-by used to be a separate request that grouped the
        *whole* file and shipped a value for every edge in the dataset; carrying
        it on the rows already being fetched costs one extra aggregate over the
        viewport and nothing else. Unknown fields are ignored.
        """
        ps = self.pixel_size
        schema_names = set(self._parquet_schema().names)
        has_lrm   = "lrm"   in schema_names
        has_score = "score" in schema_names

        where_conditions: list[str] = []
        where_params: list = []

        bbox_sql = self._bbox_sql(bbox)
        if bbox_sql:
            where_conditions.append(bbox_sql)

        # Build SELECT columns
        agg_cols = ["edge"]
        for col in ("sending_cell", "receiving_cell", "is_autocrine",
                    "sending_type", "receiving_type"):
            if col in schema_names:
                agg_cols.append(f'FIRST("{col}") AS "{col}"')
        for coord in ("x1", "y1", "x2", "y2"):
            if coord in schema_names:
                agg_cols.append(f'FIRST("{coord}") AS "{coord}"')

        supp_color = None
        if color_field:
            if color_field in schema_names:
                agg_cols.append(f'FIRST("{color_field}") AS color_value')
            else:
                supp = self._supplemental()
                if supp is not None and color_field in supp.columns:
                    supp_color = supp[["edge", color_field]].copy()
                    supp_color["edge"] = supp_color["edge"].astype(str)

        # lrm_count  = total LRMs for this edge (tissue-graph structural layer)
        # score_sum  = SUM(all scores) — default visible_score_sum when no LRM filter
        if has_lrm:
            agg_cols.append("COUNT(*) AS lrm_count")
        else:
            agg_cols.append("1 AS lrm_count")
        if has_score:
            agg_cols.append("SUM(score) AS score_sum")

        select = ", ".join(agg_cols)

        # Deterministic, shared with query_structure so the edge layer is always a
        # subset of the tissue graph at the same density. See density_predicate.
        dens = density_predicate(density)
        sample_clause = f"WHERE {dens}" if dens else ""

        # The connection is opened before the WHERE clause is finalised because the
        # metadata filters may need to register a relation on it to semi-join
        # against. Filter conditions are appended after the bbox so the parameter
        # order still matches the order the placeholders appear in the SQL text —
        # DuckDB binds positionally by text order, not by clause.
        # An edge file without endpoint columns cannot be filtered by cell; the
        # tissue graph still draws, it just ignores the cell subset.
        if not {"sending_cell", "receiving_cell"} <= schema_names:
            sending_ids = receiving_ids = None

        with self._conn() as conn:
            fragments = [self.endpoint_filter_sql(sending_ids, receiving_ids, conn)]
            fragments += [self.edge_filter_sql(f, conn) for f in (edge_filters or [])]
            for cond, prm in fragments:
                if cond:
                    where_conditions.append(cond)
                    where_params.extend(prm)
            where = f"WHERE {' AND '.join(where_conditions)}" if where_conditions else ""

            sql = f"""
                SELECT * FROM (
                    SELECT {select}
                    FROM {self._from(density)}
                    {where}
                    GROUP BY edge
                    HAVING lrm_count >= 1
                ) {sample_clause}
                LIMIT {max_limit}
            """
            if supp_color is not None:
                # The colour column lives in edge-metadata/, one row per edge, so
                # it joins onto the grouped rows rather than into the aggregate.
                conn.register("tp_color_supp", supp_color)
                sql = f"""
                    SELECT g.*, s."{color_field}" AS color_value
                    FROM ({sql}) g LEFT JOIN tp_color_supp s ON g.edge = s.edge
                """
            df = conn.execute(sql, where_params).df()

        for col in ("x1", "y1", "x2", "y2"):
            if col in df.columns:
                df[col] = df[col] / ps

        if "is_autocrine" in df.columns:
            df["is_autocrine"] = df["is_autocrine"].astype(bool)

        return _records(df)

    def query_scores(
        self,
        bbox: Optional[tuple] = None,
        included_lrms: Optional[list] = None,
        excluded_lrms: Optional[list] = None,
        max_limit: int = 500_000,
        density: float = 1.0,
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

        `density` applies the *same* deterministic predicate as `query_grouped`
        (hash of the edge id), so the sampled structural edges always find their
        scores — the two selections are identical by construction, not by luck.
        It used to be absent here, which meant every LRM toggle aggregated and
        shipped scores for every edge in the viewport while the layer drew a
        tenth of them: at default density, ten times the rows for no benefit.
        The predicate is applied before the GROUP BY, so the aggregation itself
        shrinks with it. Defaults to 1.0 (unchanged behaviour).
        """
        ps = self.pixel_size
        schema_names = set(self._parquet_schema().names)
        has_lrm   = "lrm"   in schema_names
        has_score = "score" in schema_names

        if not has_lrm:
            return []

        # A viewport query with a real filter is what the LRM checklist sends on
        # every click; answer it from the cached matrix when there is one. The
        # whole-file form (no bbox) and the empty exclusion are left to SQL —
        # the first is unbounded, the second is never sent by the UI.
        if bbox and None not in bbox and (included_lrms is not None or excluded_lrms):
            mat = self._score_matrix(bbox, density)
            if mat is not None:
                return mat.compute(included_lrms, excluded_lrms, max_limit)

        where_conditions: list[str] = []
        where_params: list = []

        bbox_sql = self._bbox_sql(bbox)
        if bbox_sql:
            where_conditions.append(bbox_sql)
        dens = density_predicate(density)
        if dens:
            where_conditions.append(dens)

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
                FROM {self._from(density)}
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
                FROM {self._from(density)}
                {where}
                GROUP BY edge
                LIMIT {max_limit}
            """
            params = excl_params + where_params

        with self._conn() as conn:
            df = conn.execute(sql, params).df()

        if df.empty:
            return []
        return _records(df)

    def _score_matrix(self, bbox: tuple, density: float) -> Optional[_ScoreMatrix]:
        """The viewport's (edge, lrm, score) rows as flat arrays, cached; see the module note.

        Returns None when the rows would not fit the budget, in which case the
        caller falls back to the SQL aggregate. The build runs outside the
        request's cancellation scope: it is the *next* toggle that benefits from
        it, and a user clicking quickly would otherwise interrupt it on every
        click and never see it land.
        """
        global _score_bytes
        try:
            key = (self._sql_path, tuple(float(v) for v in bbox), _density_cut(density))
        except (TypeError, ValueError):
            return None
        with _score_lock:
            hit = _score_entries.get(key)
            if hit is not None:
                _score_entries.move_to_end(key)
                return hit
        # One build at a time per reader: concurrent toggles for the same view
        # wait for the first build rather than each scanning the file.
        with self._matrix_lock:
            with _score_lock:
                hit = _score_entries.get(key)
                if hit is not None:
                    _score_entries.move_to_end(key)
                    return hit
            mat = self._build_score_matrix(bbox, density)
            if mat is None:
                return None
            with _score_lock:
                _score_entries[key] = mat
                _score_bytes += mat.nbytes
                while _score_bytes > _SCORE_BUDGET and len(_score_entries) > 1:
                    _, old = _score_entries.popitem(last=False)
                    _score_bytes -= old.nbytes
            return mat

    def _build_score_matrix(self, bbox: tuple, density: float) -> Optional[_ScoreMatrix]:
        schema_names = set(self._parquet_schema().names)
        has_score = "score" in schema_names
        conds = [c for c in (self._bbox_sql(bbox), density_predicate(density)) if c]
        where = f"WHERE {' AND '.join(conds)}" if conds else ""
        cols = "edge, lrm" + (", score" if has_score else "")
        t0 = time.perf_counter()
        with duck.uninterruptible(), self._conn() as conn:
            tbl = conn.execute(f"SELECT {cols} FROM {self._from(density)} {where}").arrow()
        n = tbl.num_rows
        # Rough size before decoding, so an oversized viewport costs no more
        # than the scan it would have cost anyway.
        if n * 16 > _SCORE_BUDGET:
            log.info("%s: %s rows in view exceed the score cache budget; using SQL",
                     self.path.name, f"{n:,}")
            return None
        if n == 0:
            return _ScoreMatrix(np.empty(0, dtype=object), {}, np.empty(0, np.int32),
                                np.empty(0, np.int32),
                                np.empty(0, np.float64) if has_score else None, has_score)
        e = pc.dictionary_encode(tbl.column("edge").combine_chunks())
        edges = np.asarray(e.dictionary.to_pylist(), dtype=object)
        edge_idx = e.indices.to_numpy(zero_copy_only=False).astype(np.int32)
        l = pc.dictionary_encode(tbl.column("lrm").combine_chunks())
        lrm_index = {v: i for i, v in enumerate(l.dictionary.to_pylist())}
        lrm_idx = pc.fill_null(l.indices, -1).to_numpy(zero_copy_only=False).astype(np.int32)
        score = None
        if has_score:
            sc = tbl.column("score").combine_chunks()
            score = sc.to_numpy(zero_copy_only=False).astype(np.float64, copy=True)
            # SUM() skips NULLs but propagates NaN; keep both behaviours.
            nulls = sc.is_null().to_numpy(zero_copy_only=False)
            if nulls.any():
                score[nulls] = 0.0
        mat = _ScoreMatrix(edges, lrm_index, edge_idx, lrm_idx, score, has_score)
        log.info("%s: cached score matrix for the view: %s rows, %s edges, %.0f MB in %.0f ms",
                 self.path.name, f"{n:,}", f"{len(edges):,}", mat.nbytes / 1e6,
                 (time.perf_counter() - t0) * 1000)
        return mat

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

        bbox_sql = self._bbox_sql(bbox)
        if bbox_sql:
            conditions.append(bbox_sql)

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

        return _records(df)
