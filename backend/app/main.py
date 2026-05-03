from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routers import tiles, xenium, edges, layers

app = FastAPI(title="ConnectivityExplorer API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(tiles.router, prefix="/tiles", tags=["tiles"])
app.include_router(xenium.router, prefix="/xenium", tags=["xenium"])
app.include_router(edges.router, prefix="/edges", tags=["edges"])
app.include_router(layers.router, prefix="/layers", tags=["layers"])


@app.get("/health")
def health():
    return {"status": "ok"}
