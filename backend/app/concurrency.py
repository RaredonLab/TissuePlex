"""
Run a blocking reader call for one request, and stop it if the client leaves.

Every viewport-bounded fetch in the frontend aborts its predecessor the moment a
newer viewport arrives, but until now that abort stopped at the socket: the
backend kept scanning the parquet file for a view nobody would see. On a laptop
that could not keep up this compounds — each abandoned query still holds a
concurrency slot and a share of the buffer pool, so the query the user is
actually waiting for queues behind the ones they are not.

`run_cancellable` runs the reader call on a worker thread inside a
`duck.QueryScope`, and meanwhile polls the request for a disconnect. When the
client is gone it interrupts every DuckDB cursor the call opened and returns a
499 (nginx's "client closed request"), which nobody will read.

Polling is the only option: Starlette offers no disconnect callback for a
request that is still being handled, and DuckDB has no asynchronous API. The
poll interval is a compromise — a cancelled query runs at most this much longer
than it needed to.
"""
import asyncio
import logging
import time

import anyio
from fastapi import Request
from fastapi.responses import Response

from app.readers import duck

log = logging.getLogger("tissueplex.query")

POLL_SECONDS = 0.1


async def run_cancellable(request: Request, fn, *args, **kwargs):
    """Await `fn(*args, **kwargs)` on a worker thread; cancel it if the client disconnects."""
    scope = duck.QueryScope()
    token = duck._current_scope.set(scope)
    started = time.perf_counter()

    async def watch():
        try:
            while True:
                await asyncio.sleep(POLL_SECONDS)
                if await request.is_disconnected():
                    scope.interrupt()
                    return
        except asyncio.CancelledError:
            pass

    watcher = asyncio.create_task(watch())
    try:
        # The contextvar is copied onto the worker thread by anyio, which is how
        # duck.connect() finds the scope without being told about it.
        return await anyio.to_thread.run_sync(lambda: fn(*args, **kwargs))
    except Exception as exc:
        if scope.cancelled and duck.is_cancelled_error(exc):
            log.info("cancelled %s %s after %.0f ms (client disconnected)",
                     request.method, request.url.path,
                     (time.perf_counter() - started) * 1000)
            return Response(status_code=499)
        raise
    finally:
        watcher.cancel()
        duck._current_scope.reset(token)
