"""
Spatially-sorted parquet cache.

Why
---
Moving the spatial queries to DuckDB fixed their memory use but not their speed,
because the predicate could not be pushed down usefully: Xenium writes
``transcripts.parquet`` in acquisition order with very large row groups. Measured
on the bundled breast dataset, 1.1M rows sit in **2** row groups and the first
spans the entire x-range, so row-group statistics exclude nothing and DuckDB
scans everything to evaluate a bbox.

Rewriting the file sorted by a coarse spatial grid, with small row groups, makes
those statistics selective. Measured on a synthetic 40M-row / 0.78 GB file, one
zoomed-in viewport query:

    COUNT    206 ms -> 9 ms
    SELECT  1010 ms -> 29 ms

for a one-time ~4 s build. This follows the same "derive an artifact on first
access and cache it" pattern that ``tiling/pyramid.py`` already uses for tiles.

What it does not do
-------------------
Small files are left alone. Below ``SPATIAL_CACHE_MIN_BYTES`` the fixed cost of
building and the extra disk are not repaid — DuckDB's per-query overhead already
dominates at that size. This also keeps the bundled sample datasets uncached, so
the golden-snapshot baseline does not depend on whether a cache happens to have
been built in a given checkout.

Row *order* changes, which matters in one narrow way: seeded reservoir sampling
draws a different subset from a sorted file than from the original. Totals and
filter results are unaffected. That is acceptable — the sample is arbitrary
either way — but it is why enabling the cache moves sampled golden probes.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Optional

from app.readers import duck

log = logging.getLogger("tissueplex.spatial_cache")

# Files below this are not worth rewriting. 64 MB is comfortably above the
# bundled sample datasets and comfortably below a real Xenium transcript file.
MIN_BYTES = int(os.getenv("SPATIAL_CACHE_MIN_BYTES", str(64 * 1024 * 1024)))

# Set SPATIAL_CACHE=0 to disable entirely and always read the source file.
ENABLED = os.getenv("SPATIAL_CACHE", "1") not in ("0", "false", "False")

CACHE_SUBDIR = ".tissueplex_cache"
_CACHE_DIR = os.getenv("CACHE_DIR")  # None → write alongside the data

# Small row groups are the point: statistics are per row group, so large ones
# cannot be skipped no matter how well sorted the file is.
ROW_GROUP_SIZE = 100_000

# Target grid resolution along each axis. 64 gives ~4k spatial buckets, enough
# that a zoomed-in viewport touches few row groups without over-fragmenting.
GRID_DIVISIONS = 64

# One lock per cache path, so two concurrent first-requests do not both build.
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()

# Paths already resolved this process, to skip the stat/manifest check per query.
_resolved: dict[str, Optional[Path]] = {}

# Sources with a build currently running in a background thread.
_building: set[str] = set()


def _lock_for(key: str) -> threading.Lock:
    with _locks_guard:
        if key not in _locks:
            _locks[key] = threading.Lock()
        return _locks[key]


def _cache_root(dataset_dir: Path) -> Path:
    if _CACHE_DIR:
        return Path(_CACHE_DIR) / dataset_dir.name / "spatial"
    return dataset_dir / CACHE_SUBDIR


def _manifest_for(cache_file: Path) -> Path:
    return cache_file.with_suffix(cache_file.suffix + ".json")


def _source_stamp(source: Path) -> dict:
    st = source.stat()
    return {"size": st.st_size, "mtime_ns": st.st_mtime_ns, "name": source.name}


def sorted_path(
    source: Path,
    dataset_dir: Path,
    x_col: str,
    y_col: str,
    cache_name: Optional[str] = None,
) -> Optional[Path]:
    """Return a spatially-sorted copy of `source`, building it if needed.

    Returns None when caching is disabled, the file is too small to benefit, or
    the build fails — callers then query the original file, so this can never
    make a dataset unreadable.

    `cache_name` overrides the cache file's stem. The default is the source's
    own stem, which is right for one transcripts file per dataset but collides
    for edge files: `edges/edge.raw.minimum.parquet` and
    `edges/edge.normalized.product.parquet` both reduce to "edge", and two
    sources sharing one cache file would rebuild it on every alternate request.
    """
    if not ENABLED or not source.exists():
        return None

    # Keyed on the sort columns as well as the path. The manifest check below
    # already refuses a cache sorted on a different column pair, but this memo
    # sits in front of it and would hand back that exact file on every later
    # call — defeating the check written to prevent it. Not reachable today
    # (each source is queried with one fixed column pair) but silent if it ever
    # were: the data would be right and the row-group pruning wrong.
    key = f"{source.resolve()}::{x_col}::{y_col}"
    if key in _resolved:
        return _resolved[key]

    try:
        if source.stat().st_size < MIN_BYTES:
            _resolved[key] = None
            return None
    except OSError:
        _resolved[key] = None
        return None

    stem = cache_name or source.name.split(".")[0]
    cache_file = _cache_root(dataset_dir) / f"{stem}.sorted.parquet"
    manifest = _manifest_for(cache_file)
    stamp = _source_stamp(source)

    with _lock_for(key):
        # Re-check inside the lock: another thread may have finished the build.
        if key in _resolved:
            return _resolved[key]

        if cache_file.exists() and manifest.exists():
            try:
                m = json.loads(manifest.read_text())
                # The sort columns are part of what makes a cache valid, not just
                # the source file. The cache name is derived from the source stem
                # alone, so without this check a file sorted on one column pair
                # would be handed back for a query on a different pair — sorted
                # by the wrong axis, and silently so.
                if (m.get("source") == stamp
                        and m.get("x_col") == x_col
                        and m.get("y_col") == y_col):
                    _resolved[key] = cache_file
                    return cache_file
            except Exception:
                pass  # unreadable manifest → rebuild
            log.info("%s: cache is stale (source or sort columns changed); rebuilding",
                     source.name)

        # Build off the request thread and serve the source file meanwhile.
        #
        # The build sorts the whole file — on a real Xenium run that is 132M rows
        # and minutes of work, against nginx's 120s proxy_read_timeout. Building
        # inline meant the very first transcript request could not succeed: it
        # either timed out or, before the memory fixes in duck.py, was killed
        # outright. Either way the hook saw a non-ok response, returned [], and
        # the layer rendered empty — indistinguishable from "this dataset has no
        # transcripts", which is exactly how it was reported.
        #
        # The unsorted file answers the same query correctly, just slower, so
        # there is no reason to make anyone wait for the index. Queries are
        # served from the source until the build lands, then pick it up.
        _start_background_build(key, source, cache_file, manifest, stamp, x_col, y_col)
        return None


def _start_background_build(
    key: str,
    source: Path,
    cache_file: Path,
    manifest: Path,
    stamp: dict,
    x_col: str,
    y_col: str,
) -> None:
    """Kick off an index build in a daemon thread, at most one per source.

    `_resolved` is deliberately left unset while a build is in flight: it is the
    "decided forever" cache, and writing None into it would pin this source to
    the unsorted file for the life of the process even after the index landed.
    Queries fall through to the source until the thread publishes a result.
    """
    with _locks_guard:
        if key in _building:
            return
        _building.add(key)

    def run() -> None:
        try:
            built = _build(source, cache_file, manifest, stamp, x_col, y_col)
            # A failed build resolves to None on purpose — retrying a build that
            # just failed on every subsequent viewport change would turn one bad
            # file into a rebuild storm.
            _resolved[key] = built
        except Exception as exc:
            # _build already swallows its own errors, so reaching here means
            # something unexpected. Catch it anyway: an exception escaping a
            # thread is printed to stderr and then lost, leaving the key stuck
            # in _building so no later request would ever retry the build.
            log.error("background build for %s failed: %s", source.name, exc)
            _resolved[key] = None
        finally:
            with _locks_guard:
                _building.discard(key)

    log.info("%s: building spatial index in the background; "
             "queries use the unsorted file until it is ready", source.name)
    threading.Thread(target=run, name=f"spatial-index-{source.name}",
                     daemon=True).start()


def _build(
    source: Path,
    cache_file: Path,
    manifest: Path,
    stamp: dict,
    x_col: str,
    y_col: str,
) -> Optional[Path]:
    try:
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        # Source may be parquet (Xenium) or CSV (seqFISH); the output is always
        # parquet, so a CSV platform gets format conversion and the spatial index
        # in the same pass.
        src = duck.scan_any(source)
        cols = (set(duck.csv_columns(source))
                if str(source).lower().endswith((".csv", ".csv.gz"))
                else duck.columns(source))
        if x_col not in cols or y_col not in cols:
            return None

        # Write to a temp name and rename, so a crashed or concurrent build never
        # leaves a half-written file that looks complete. A `.building-*` file
        # from a process that died mid-build (an OOM kill, a container restart)
        # is garbage by definition — only this process builds this cache — so
        # clear any before starting rather than leaving them to accumulate.
        for leftover in cache_file.parent.glob(f"{cache_file.stem}.building-*.parquet"):
            try:
                leftover.unlink()
            except OSError:
                pass
        tmp = cache_file.with_suffix(f".building-{os.getpid()}.parquet")

        with duck.connect() as conn:
            row = conn.execute(
                f'SELECT MIN("{x_col}"), MAX("{x_col}"), '
                f'MIN("{y_col}"), MAX("{y_col}"), COUNT(*) FROM {src}'
            ).fetchone()
            xmin, xmax, ymin, ymax, n = row
            if not n:
                return None
            span = max(float(xmax) - float(xmin), float(ymax) - float(ymin), 1e-9)
            cell = span / GRID_DIVISIONS

            log.info("building spatial index for %s (%s rows, %.0f MB) — one-time",
                     source.name, f"{n:,}", source.stat().st_size / 1e6)
            t0 = time.perf_counter()
            conn.execute(f"""
                COPY (
                    SELECT * FROM {src}
                    ORDER BY floor("{x_col}" / {cell}), floor("{y_col}" / {cell})
                ) TO '{str(tmp).replace("'", "''")}'
                (FORMAT PARQUET, ROW_GROUP_SIZE {ROW_GROUP_SIZE})
            """)

        tmp.replace(cache_file)
        manifest.write_text(json.dumps({
            "source": stamp,
            "x_col": x_col, "y_col": y_col,
            "row_group_size": ROW_GROUP_SIZE,
            "grid_divisions": GRID_DIVISIONS,
        }, indent=2))
        log.info("built %s (%.0f MB) in %.1f s", cache_file.name,
                 cache_file.stat().st_size / 1e6, time.perf_counter() - t0)
        return cache_file

    except Exception as exc:
        # Never let an indexing failure break the query — fall back to the source.
        log.error("could not build index for %s: %s; querying the original file",
                  source.name, exc)
        try:
            for leftover in cache_file.parent.glob(f"{cache_file.stem}.building-*.parquet"):
                leftover.unlink()
        except Exception:
            pass
        return None
