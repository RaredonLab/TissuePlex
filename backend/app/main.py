from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import ORJSONResponse

from app import logging_setup
from app.routers import tiles, spatial, edges, layers

APP_VERSION = "0.9.0"

# ORJSONResponse as the default: orjson serialises a 200K-row edge response in
# ~10 ms where the stdlib took ~150 ms, and it writes NaN/Inf as null natively.
# The hot endpoints return an ORJSONResponse *explicitly*, which also skips
# FastAPI's `jsonable_encoder` pass — measured at 0.8 s on 200K records, more
# than the DuckDB query it was wrapping.
app = FastAPI(title="TissuePlex API", version=APP_VERSION,
              default_response_class=ORJSONResponse)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# File logging, request timing, the memory watchdog and POST /client-log.
logging_setup.install(app, APP_VERSION)

app.include_router(tiles.router, prefix="/tiles", tags=["tiles"])
app.include_router(spatial.router, prefix="/spatial", tags=["spatial"])
app.include_router(edges.router, prefix="/edges", tags=["edges"])
app.include_router(layers.router, prefix="/layers", tags=["layers"])


@app.get("/health")
def health():
    return {"status": "ok", "version": APP_VERSION, **logging_setup.health_extras()}
