"""
Logging that survives the container.

Until now the backend wrote nothing but `print()`s to stdout. Inside Docker that
is `docker logs`, which is lost the moment the container is recreated — and a
backend that has just been OOM-killed and restarted is exactly the one whose
output you wanted. When a trainee reports "it just stopped", there is nothing to
look at.

This module sends every log record to a rotating file under CACHE_DIR, the one
writable volume the backend owns (``/cache`` in compose, which also holds the
tile pyramids and the spatial index, so it persists across restarts). It also:

* times every request and writes a line for any that is slow, failed, or was
  cancelled, with the process's resident memory at that moment;
* logs unhandled exceptions with their traceback (FastAPI's default is a bare
  500 to the client and nothing on the server);
* runs a memory watchdog that logs when the process nears its limit, so an OOM
  kill leaves a trail leading up to it rather than a silent gap;
* accepts reports from the frontend (``POST /client-log``), so a fetch that
  failed in the browser — a 504 from nginx, a network error — lands in the same
  file as the backend's own view of that request.

Nothing here changes behaviour; it only records it. Tune with ``LOG_LEVEL``
(default INFO), ``SLOW_REQUEST_MS`` (default 2000) and ``LOG_DIR`` (default
``$CACHE_DIR/logs``).
"""
from __future__ import annotations

import logging
import logging.handlers
import os
import platform
import resource
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

log = logging.getLogger("tissueplex")

SLOW_REQUEST_MS = float(os.getenv("SLOW_REQUEST_MS", "2000"))
_LOG_FILE: Optional[Path] = None
_STARTED = time.time()


def log_dir() -> Path:
    base = os.getenv("LOG_DIR") or (
        Path(os.getenv("CACHE_DIR")) / "logs" if os.getenv("CACHE_DIR") else
        Path(__file__).resolve().parents[1] / "logs")
    return Path(base)


def log_file() -> Optional[Path]:
    return _LOG_FILE


def rss_mb() -> float:
    """Resident set size of this process in MB (macOS reports bytes, Linux KB)."""
    try:
        with open("/proc/self/status") as fh:        # Linux: exact, current
            for line in fh:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) / 1024.0
    except OSError:
        pass
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return peak / (1024.0 * 1024.0 if sys.platform == "darwin" else 1024.0)


def configure() -> None:
    """Install the file handler on the root logger and route uvicorn through it.

    Idempotent, so uvicorn's ``--reload`` restarts do not stack handlers.
    """
    global _LOG_FILE
    root = logging.getLogger()
    if any(getattr(h, "_tissueplex", False) for h in root.handlers):
        return
    level = getattr(logging, os.getenv("LOG_LEVEL", "INFO").upper(), logging.INFO)
    root.setLevel(level)
    fmt = logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s")

    stream = logging.StreamHandler(sys.stdout)
    stream.setFormatter(fmt)
    stream._tissueplex = True
    root.addHandler(stream)

    try:
        d = log_dir()
        d.mkdir(parents=True, exist_ok=True)
        _LOG_FILE = d / "tissueplex.log"
        fh = logging.handlers.RotatingFileHandler(
            _LOG_FILE, maxBytes=5 * 1024 * 1024, backupCount=5, encoding="utf-8")
        fh.setFormatter(fmt)
        fh._tissueplex = True
        root.addHandler(fh)
    except OSError as exc:
        _LOG_FILE = None
        root.warning("could not open a log file under %s: %s — logging to stdout only",
                     log_dir(), exc)

    # uvicorn installs its own handlers; let its records flow to ours instead so
    # the access log and the slow-request lines land in one file, in order.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        lg = logging.getLogger(name)
        lg.handlers = []
        lg.propagate = True
    # The access log is one line per tile request — too noisy for the file.
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)


def log_startup(version: str) -> None:
    from app.readers import duck
    s = duck.settings()
    log.info("TissuePlex backend v%s starting: python %s, %s, cpus=%s, rss=%.0f MB",
             version, platform.python_version(), platform.platform(),
             os.cpu_count(), rss_mb())
    log.info("DATA_ROOT=%s CACHE_DIR=%s log=%s", os.getenv("DATA_ROOT", "/data"),
             os.getenv("CACHE_DIR"), _LOG_FILE)
    log.info("duckdb memory_limit=%s threads=%s query_concurrency=%s spill=%s",
             s["memory_limit"], s["threads"], s["query_concurrency"], s["temp_directory"])
    limit = _memory_ceiling_mb()
    if limit:
        log.info("memory ceiling (min of cgroup limit and physical RAM): %.0f MB", limit)


def _memory_ceiling_mb() -> Optional[float]:
    from app.readers.duck import _available_memory_bytes
    b = _available_memory_bytes()
    return b / (1024.0 * 1024.0) if b else None


def start_memory_watchdog(interval_s: float = 30.0) -> None:
    """Log when resident memory approaches the ceiling.

    The OOM killer leaves nothing behind: the process is gone and `docker inspect`
    says `OOMKilled=false` when it was the VM rather than the cgroup that pulled
    the trigger. A line every half minute while memory is high is the trail that
    was missing. Quiet below 70% of the ceiling.
    """
    ceiling = _memory_ceiling_mb()
    if not ceiling:
        return

    def run():
        last_bucket = None
        while True:
            time.sleep(interval_s)
            try:
                rss = rss_mb()
                frac = rss / ceiling
                bucket = 2 if frac > 0.85 else 1 if frac > 0.70 else 0
                if bucket and (bucket != last_bucket or bucket == 2):
                    (log.warning if bucket == 2 else log.info)(
                        "memory pressure: rss %.0f MB is %.0f%% of the %.0f MB ceiling",
                        rss, frac * 100, ceiling)
                last_bucket = bucket
            except Exception:
                pass

    threading.Thread(target=run, name="tp-memory-watchdog", daemon=True).start()


class _TimingMiddleware:
    """Logs slow, failed and crashed requests; see `install` for why it is raw ASGI."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        started = time.perf_counter()
        status = {"code": None}
        method = scope.get("method", "")
        path = scope.get("path", "")
        query = scope.get("query_string", b"").decode("latin-1")

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                status["code"] = message["status"]
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception as exc:
            log.error("unhandled error in %s %s?%s after %.0f ms (rss %.0f MB)\n%s",
                      method, path, query, (time.perf_counter() - started) * 1000,
                      rss_mb(), "".join(traceback.format_exception(exc)))
            raise
        ms = (time.perf_counter() - started) * 1000
        code = status["code"] or 0
        if code >= 500:
            log.error("%s %s?%s -> %d in %.0f ms (rss %.0f MB)",
                      method, path, query, code, ms, rss_mb())
        elif code >= 400 and code != 499:
            log.warning("%s %s?%s -> %d in %.0f ms", method, path, query, code, ms)
        elif ms >= SLOW_REQUEST_MS:
            log.warning("slow request: %s %s?%s -> %d in %.0f ms (rss %.0f MB)",
                        method, path, query, code, ms, rss_mb())
        else:
            log.debug("%s %s -> %d in %.0f ms", method, path, code, ms)


def install(app: FastAPI, version: str) -> None:
    """Wire the middleware, the exception handler and the client-log endpoint."""
    configure()
    log_startup(version)
    start_memory_watchdog()

    # A pure ASGI middleware rather than `@app.middleware("http")`. Starlette's
    # BaseHTTPMiddleware re-wraps the request's receive channel, and the
    # endpoint's `request.is_disconnected()` — which the cancellation path in
    # app/concurrency.py depends on — never sees the client go away through it
    # (verified: three aborted requests all ran to completion behind it). This
    # form passes `receive` straight through and only watches `send`.
    app.add_middleware(_TimingMiddleware)

    # Reports from the browser. The frontend swallows failed fetches by design
    # (an empty layer rather than a crash), which is also why a dead backend
    # looked like a hang: nothing anywhere said so. Each report is one line.
    _bucket = {"tokens": 60.0, "t": time.time()}
    _bucket_lock = threading.Lock()

    def _allow() -> bool:
        with _bucket_lock:
            now = time.time()
            _bucket["tokens"] = min(60.0, _bucket["tokens"] + (now - _bucket["t"]) * 1.0)
            _bucket["t"] = now
            if _bucket["tokens"] < 1:
                return False
            _bucket["tokens"] -= 1
            return True

    @app.post("/client-log")
    async def client_log(request: Request):
        if not _allow():
            return JSONResponse({"ok": False, "reason": "rate limited"}, status_code=429)
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"ok": False}, status_code=400)
        level = str(body.get("level", "error")).lower()
        msg = str(body.get("message", ""))[:2000]
        ctx = body.get("context")
        ctx_s = (" " + str(ctx)[:2000]) if ctx else ""
        ua = request.headers.get("user-agent", "")[:120]
        (logging.getLogger("tissueplex.client").warning
         if level in ("warn", "warning") else
         logging.getLogger("tissueplex.client").error
         if level == "error" else
         logging.getLogger("tissueplex.client").info)("%s%s [%s]", msg, ctx_s, ua)
        return {"ok": True}


def health_extras() -> dict:
    from app.readers import duck
    return {
        "rss_mb": round(rss_mb(), 1),
        "memory_ceiling_mb": (round(_memory_ceiling_mb(), 1) if _memory_ceiling_mb() else None),
        "uptime_s": round(time.time() - _STARTED, 1),
        "log_file": str(_LOG_FILE) if _LOG_FILE else None,
        "duckdb": duck.settings(),
    }
