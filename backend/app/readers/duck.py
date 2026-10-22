"""
Shared DuckDB helpers for parquet-backed readers.

Every reader that queries a large parquet file should go through here rather
than loading the file into pandas. The win is predicate pushdown: DuckDB reads
only the row groups whose statistics can satisfy the WHERE clause, so a viewport
query touches a fraction of the file instead of all of it.

The alternative — ``pq.read_table(path).to_pandas()`` followed by a pandas mask —
reads and materializes every row on every request, which is what made transcript
and boundary panning slow on full-size datasets.
"""
import contextvars
import math
import os
import tempfile
import threading
from pathlib import Path
from typing import Optional

import duckdb
import pyarrow.parquet as pq

def _available_memory_bytes() -> Optional[int]:
    """Memory this process may actually use, or None if it cannot be determined.

    Takes the **minimum** of the cgroup limit and physical RAM, because either
    can be the real ceiling and they routinely disagree. On Docker Desktop the
    container limit is whatever compose declares (12 GB here) while the Linux VM
    hosting it may have far less (7.8 GB) — trusting the cgroup alone invites the
    VM's OOM killer, which kills the process without the container ever reporting
    OOMKilled.
    """
    limits = []
    for p in ("/sys/fs/cgroup/memory.max",                    # cgroup v2
              "/sys/fs/cgroup/memory/memory.limit_in_bytes"):  # cgroup v1
        try:
            raw = Path(p).read_text().strip()
            if raw and raw != "max":
                v = int(raw)
                # v1 reports a sentinel near 2^63 to mean "unlimited".
                if 0 < v < (1 << 62):
                    limits.append(v)
        except (OSError, ValueError):
            pass
    try:
        limits.append(os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES"))
    except (OSError, ValueError, AttributeError):
        pass
    return min(limits) if limits else None


def _default_memory_limit() -> str:
    """A memory cap that leaves room for everything else in the process.

    The old default was a flat ``8GB`` regardless of the machine. That is not a
    cap at all on a standard 8 GB Docker Desktop VM — it authorises DuckDB to
    take essentially all of RAM, and a large sort then dies to the OOM killer
    mid-request, taking uvicorn with it. Sizing from what is actually present
    keeps the same intent (bound the scan) while making the bound real.

    60% leaves headroom for the Python process, pyvips tile builds, and the
    page cache the parquet scan itself depends on.
    """
    total = _available_memory_bytes()
    if not total:
        return "4GB"                       # unknowable → conservative, not greedy
    mb = max(1024, int(total * 0.60 / (1024 * 1024)))
    return f"{mb}MB"


# .strip() matters: an unset variable and one set to "" or "   " must all fall
# through to the computed default. A whitespace value is truthy, so without it
# DuckDB receives `SET memory_limit='   '` and raises a ParserException.
_MEMORY_LIMIT = (os.getenv("DUCKDB_MEMORY_LIMIT") or "").strip() or _default_memory_limit()


def _default_threads() -> int:
    """DuckDB worker threads: the cores actually available, capped.

    This used to be a flat 4, which on a two-core Docker Desktop VM meant every
    concurrent query oversubscribed the machine twice over — and before the
    database became shared (below) *each* request had its own pool of 4.
    """
    try:
        n = len(os.sched_getaffinity(0))        # honours the container's cpuset
    except (AttributeError, OSError):
        n = os.cpu_count() or 2
    return max(1, min(8, n))


_THREADS = int((os.getenv("DUCKDB_THREADS") or "").strip() or _default_threads())


def _temp_dir() -> Optional[str]:
    """Writable scratch directory for DuckDB to spill to, or None.

    Without this an in-memory DuckDB cannot spill, so any operation whose working
    set exceeds ``memory_limit`` fails outright instead of going out-of-core. The
    spatial-index build sorts the entire transcripts file, which on a real Xenium
    run is 132M rows — far past any sane cap — so spilling is what makes that
    build possible at all rather than merely slower.

    CACHE_DIR is the right home: it is the one writable volume the backend owns
    (/data is mounted read-only), and it already holds derived artifacts.
    """
    base = os.getenv("CACHE_DIR") or tempfile.gettempdir()
    try:
        d = Path(base) / "duckdb-tmp"
        d.mkdir(parents=True, exist_ok=True)
        return str(d)
    except OSError:
        return None


_TEMP_DIR = _temp_dir()


# ── One database, many cursors ────────────────────────────────────────────────
#
# Every query used to open its own `duckdb.connect()`. That *looks* like a cheap
# connection but is a whole new in-memory database instance: its own buffer
# pool, its own thread pool, and — the part that matters on a small laptop — its
# own copy of `memory_limit`. Five requests in flight (two panels, several
# layers each, plus the ones the browser already abandoned) were five databases
# each entitled to 60% of RAM. That is how a backend that "respects" its memory
# cap still gets killed by the VM's OOM killer.
#
# One shared database fixes the accounting: `memory_limit` and `threads` apply
# to the process as a whole. Per-request isolation comes from `cursor()`, which
# DuckDB documents as the way to use one database from several threads — each
# cursor is its own connection, with its own registered Python objects (verified:
# a frame `register`ed on one cursor is not visible from another), so the
# `register_ids` semi-join trick is unaffected.
#
# Concurrency is bounded on top of that. FastAPI runs sync endpoints on a
# 40-thread pool, so without a limit a user panning quickly on a slow machine
# stacks up dozens of full-file scans that all compete for the same cores and
# the same buffer pool, and the one they are actually waiting for finishes last.
# `QUERY_CONCURRENCY` queries run at a time; the rest wait their turn in order.

_db: Optional[duckdb.DuckDBPyConnection] = None
_db_lock = threading.Lock()


def _default_concurrency() -> int:
    return max(2, min(8, (_THREADS + 1) // 2 + 1))


QUERY_CONCURRENCY = int((os.getenv("QUERY_CONCURRENCY") or "").strip()
                        or _default_concurrency())
_query_slots = threading.BoundedSemaphore(QUERY_CONCURRENCY)


def _database() -> duckdb.DuckDBPyConnection:
    global _db
    if _db is None:
        with _db_lock:
            if _db is None:
                db = duckdb.connect()
                db.execute(f"SET memory_limit='{_MEMORY_LIMIT}'")
                db.execute(f"SET threads={_THREADS}")
                if _TEMP_DIR:
                    db.execute(f"SET temp_directory='{_TEMP_DIR}'")
                # Keep parquet footers / metadata cached across queries: every
                # viewport change re-opens the same handful of files.
                try:
                    db.execute("SET enable_object_cache=true")
                except duckdb.Error:
                    pass
                _db = db
    return _db


def settings() -> dict:
    """What this process is actually running with, for the log and /health."""
    return {"memory_limit": _MEMORY_LIMIT, "threads": _THREADS,
            "query_concurrency": QUERY_CONCURRENCY, "temp_directory": _TEMP_DIR}


# ── Cancellation ──────────────────────────────────────────────────────────────
#
# The browser aborts a fetch the moment a newer viewport supersedes it, but the
# abort never used to reach the server: the query ran to completion for a
# viewport nobody would see, holding a concurrency slot and a share of the
# buffer pool. A `QueryScope` is opened by the router around one request (see
# `app.concurrency.run_cancellable`); every cursor opened under it is recorded,
# and `interrupt()` stops them all. The scope travels in a contextvar so it
# follows the request onto the worker thread without any plumbing through the
# readers — they just call `connect()` as before.

class QueryScope:
    __slots__ = ("_cursors", "cancelled", "_lock")

    def __init__(self):
        self._cursors: list = []
        self.cancelled = False
        self._lock = threading.Lock()

    def _attach(self, cur) -> None:
        with self._lock:
            self._cursors.append(cur)

    def _detach(self, cur) -> None:
        with self._lock:
            try:
                self._cursors.remove(cur)
            except ValueError:
                pass

    def interrupt(self) -> None:
        """Stop every query running under this scope; safe from any thread."""
        self.cancelled = True
        with self._lock:
            cursors = list(self._cursors)
        for cur in cursors:
            try:
                cur.interrupt()
            except Exception:
                pass


_current_scope: contextvars.ContextVar = contextvars.ContextVar("tp_query_scope", default=None)


class QueryCancelled(Exception):
    """Raised inside a query whose request has already been abandoned."""


class _Conn:
    """A cursor on the shared database plus the bookkeeping around it.

    Behaves like a `DuckDBPyConnection` for everything the readers do with one
    (`execute`, `register`, `with … as conn:`), while holding a concurrency slot
    for exactly as long as it is open. Readers never see this class by name.
    """
    __slots__ = ("_cur", "_scope", "_slot")

    def __init__(self):
        scope = _current_scope.get()
        if scope is not None and scope.cancelled:
            raise QueryCancelled()
        _query_slots.acquire()
        self._slot = True
        # The wait for a slot may have been long; the client may be gone by now.
        if scope is not None and scope.cancelled:
            self._release()
            raise QueryCancelled()
        try:
            self._cur = _database().cursor()
        except Exception:
            self._release()
            raise
        self._scope = scope
        if scope is not None:
            scope._attach(self._cur)

    def _release(self) -> None:
        if self._slot:
            self._slot = False
            _query_slots.release()

    def close(self) -> None:
        if self._scope is not None:
            self._scope._detach(self._cur)
            self._scope = None
        try:
            self._cur.close()
        except Exception:
            pass
        self._release()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self.close()
        return False

    def __getattr__(self, name):
        return getattr(self._cur, name)


def connect() -> "_Conn":
    """Return an isolated connection (cursor) on the shared database.

    Use as a context manager. Isolation per request is still real — each cursor
    has its own transaction state and its own `register`ed frames — but memory
    and threads are now shared and capped process-wide. See the note above.
    """
    return _Conn()


def is_cancelled_error(exc: BaseException) -> bool:
    """True when `exc` is the server's own abort of an abandoned query."""
    return isinstance(exc, (QueryCancelled, duckdb.InterruptException))


def scan(path: Path) -> str:
    """SQL FROM-clause fragment that reads a parquet file.

    Single quotes in the path are escaped so a path like ``/data/o'brien/x.parquet``
    cannot terminate the string literal.
    """
    return "read_parquet('{}')".format(str(path).replace("'", "''"))


def scan_csv(path: Path) -> str:
    """SQL FROM-clause fragment that reads a CSV file.

    Platforms that ship CSV instead of parquet (seqFISH) still stream through
    DuckDB rather than pandas. CSV has no column statistics so nothing can be
    pruned, but the scan is still streamed rather than materialized, which is
    what keeps peak memory flat on a multi-GB transcript list.
    """
    return "read_csv_auto('{}')".format(str(path).replace("'", "''"))


def scan_any(path: Path) -> str:
    """FROM-clause fragment for either a parquet or CSV source.

    Lets a caller stay agnostic about whether it is reading a platform's native
    CSV or a derived parquet (e.g. the spatially-sorted cache).
    """
    return scan_csv(path) if str(path).lower().endswith((".csv", ".csv.gz")) \
        else scan(path)


def columns(path: Path) -> set[str]:
    """Column names in a parquet file, read from its footer (no data scan)."""
    return set(pq.read_schema(path).names)


def csv_columns(path: Path) -> list[str]:
    """Column names of a CSV, read from the header row only."""
    with open(path, "r", encoding="utf-8-sig", errors="replace") as fh:
        header = fh.readline().rstrip("\r\n")
    return [c.strip().strip('"') for c in header.split(",")]


def bbox_predicate(x_col: str, y_col: str, bbox: tuple) -> tuple[str, list]:
    """Build a bounding-box WHERE fragment and its bind parameters.

    ``bbox`` must already be in the file's native coordinate space. Returns
    ``("", [])`` when the bbox is absent or has any None component, so callers
    can splice the result unconditionally.

    **The bounds are inlined as literals, not bound as ``?`` parameters, and that
    is load-bearing.** DuckDB prunes parquet row groups by comparing the filter
    against per-group statistics at plan time; with bound parameters the values
    are not yet known, so it cannot prune and scans everything. Measured on a
    40M-row spatially-sorted file, one viewport query:

        COUNT   literals 6.8 ms   vs  ? params 155 ms
        SELECT  literals  35 ms   vs  ? params 321 ms

    On an unsorted file the two are identical (~180 ms) because there is nothing
    to prune either way — which is why this only started to matter once the
    spatial cache existed. Revert this to bound parameters and the entire spatial
    index quietly stops paying for itself.

    Inlining is safe here because these are numbers, never user-controlled text:
    every value is passed through ``float()``, so nothing but a finite numeric
    literal can reach the SQL. Non-finite values are rejected rather than
    formatted, since ``inf``/``nan`` do not round-trip as SQL literals. String
    filters such as gene names must still go through ``in_predicate``.
    """
    if not bbox:
        return "", []
    xmin, ymin, xmax, ymax = bbox
    if None in (xmin, ymin, xmax, ymax):
        return "", []
    try:
        # float() also normalises numpy scalars, which DuckDB cannot bind and
        # whose repr() is not valid SQL.
        vals = [float(xmin), float(xmax), float(ymin), float(ymax)]
    except (TypeError, ValueError):
        return "", []
    if not all(math.isfinite(v) for v in vals):
        return "", []
    x0, x1, y0, y1 = (repr(v) for v in vals)
    return (
        f'("{x_col}" >= {x0} AND "{x_col}" <= {x1} AND '
        f'"{y_col}" >= {y0} AND "{y_col}" <= {y1})',
        [],
    )


def where_clause(conditions: list[str]) -> str:
    """Join conditions into a WHERE clause, or return '' when there are none."""
    conditions = [c for c in conditions if c]
    return f"WHERE {' AND '.join(conditions)}" if conditions else ""


def in_predicate(col: str, values: list) -> tuple[str, list]:
    """Build an IN (...) fragment. Empty values yield a never-true predicate."""
    if not values:
        return "FALSE", []
    placeholders = ", ".join("?" for _ in values)
    return f'"{col}" IN ({placeholders})', list(values)


def register_ids(conn, ids, name: str = "tp_filter", col: str = "cell_id") -> str:
    """Register a set of ids as a relation and return a semi-join predicate on it.

    The metadata filter (issue #45) can keep hundreds of thousands of cells, which
    is far past the point where an ``IN (?, ?, …)`` list is workable — DuckDB has
    to bind every parameter, and the SQL text itself grows to megabytes. Handing
    the ids over as a one-column frame instead makes it an ordinary hash semi-join.

    ``ids`` must not be empty; an empty filter means "nothing matches" and callers
    should short-circuit rather than build a query that cannot return rows.
    """
    import pandas as pd

    frame = pd.DataFrame({col: [str(i) for i in ids]})
    conn.register(name, frame)
    return f"IN (SELECT \"{col}\" FROM {name})"


# Sampling is seeded so that re-fetching an unchanged viewport returns the same
# rows. Without this, every refetch reshuffles which transcripts are drawn and
# the layer visibly flickers.
SAMPLE_SEED = 42

_HASH_SPACE = 2 ** 64          # DuckDB's hash() returns UBIGINT


def hash_sample_predicate(key_cols: list[str], n: int, total: int) -> str:
    """WHERE predicate keeping each row with probability ``n / total``, or ''.

    A row is kept when the hash of its identity (``key_cols``, plus the seed)
    falls below a cut-off, so the verdict is a property of the row alone:
    spatially uniform, identical on every re-fetch, and unaffected by the bbox,
    so a dot does not vanish or reappear as the user pans. The edge-density
    predicate in edge_reader.py works the same way.

    This replaced ``USING SAMPLE reservoir(n ROWS)``, which is **not uniform**
    in DuckDB 1.2.2 — on a 132M-row Xenium run it drew ~85× too many dots from
    the sparse slide margin (1,641 against 19 expected in the left 500 µm, tiles
    ranging 0.68–59× their fair share), and on one thread as on four. A
    near-empty edge of the slide rendered as a dense stripe with straight sides.
    Do not swap a ``USING SAMPLE`` clause back in without measuring per-tile
    uniformity on a real dataset.

    The kept count is ``n`` in expectation rather than exactly — within a
    fraction of a percent at transcript scale. ``total`` should be the
    pre-sample count the caller already has. ``key_cols`` should identify a row:
    a unique id column where the format has one, otherwise coordinates plus
    gene. Rows sharing a key share a verdict, which is harmless at that grain.
    It is an ordinary predicate, so unlike ``USING SAMPLE`` it composes with the
    other conditions by AND and needs no subquery wrapping.
    """
    if total <= 0 or n >= total:
        return ""
    cut = int(_HASH_SPACE * max(0, n) / total)
    key = ", ".join(f'"{c}"' for c in key_cols)
    return f"hash({key}, {SAMPLE_SEED}) < {cut}::UBIGINT"


def to_records(df) -> list[dict]:
    """DataFrame to JSON-safe records (NaN/Inf → None)."""
    return [
        {k: (None if isinstance(v, float) and not math.isfinite(v) else v)
         for k, v in row.items()}
        for row in df.to_dict(orient="records")
    ]
