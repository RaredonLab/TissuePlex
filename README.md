# ConnectivityExplorer

A spatial transcriptomics viewer for Xenium data with support for cell-cell connectivity layers produced by NICHESv2.

Built on OpenSeadragon (deep zoom) + deck.gl (WebGL layers) + FastAPI.

---

## Quick start

### Requirements
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker Engine + Compose v2)

### Run with sample data

```bash
git clone https://github.com/your-lab/ConnectivityExplorer.git
cd ConnectivityExplorer
docker compose up --build
```

Open **http://localhost:3000** in your browser.

The first launch builds tile pyramids for the morphology images — this takes a minute or two per dataset. Pyramids are cached in a Docker volume (`dzi_cache`) and reused on subsequent starts.

### Run with your own Xenium data

Point `DATA_PATH` at the parent folder containing one or more Xenium output directories:

```bash
DATA_PATH=/path/to/your/xenium_outputs docker compose up --build
```

Each subdirectory of `DATA_PATH` that contains a valid Xenium output (`experiment.xenium`, `morphology_mip.ome.tif`, etc.) will appear as a selectable dataset in the viewer.

Your data is mounted **read-only** — the tool never modifies source files.

---

## Data folder layout

```
DATA_PATH/
  my_experiment/
    experiment.xenium
    morphology_mip.ome.tif
    morphology_focus.ome.tif
    transcripts.parquet
    cells.zarr.zip
    cell_feature_matrix.zarr.zip
    cell_boundaries.parquet
    edges.parquet          ← NICHESv2 connectivity output (optional)
```

If `edges.parquet` is absent the edge layers are simply hidden.

---

## edges.parquet format (NICHESv2 output)

The viewer expects the NICHESv2-aligned edge format. Use `export_NICHESObject_for_viewer()` from the lab's R package to generate this file, or see [docs/data_format.md](docs/data_format.md) for the full column spec.

Required columns:

| Column | Type | Description |
|---|---|---|
| `edge` | string | `"SendingCell\|ReceivingCell"` directed edge ID |
| `sending_cell` | string | Xenium cell barcode |
| `receiving_cell` | string | Xenium cell barcode |
| `is_autocrine` | bool | True when sending == receiving |
| `lrm` | string | `"ligand\|receptor"` mechanism ID |
| `lrm_id` | int | Integer index |
| `ligand` | string | |
| `receptor` | string | |
| `score` | float | Raw LRM score for this edge |
| `score_norm` | float | Score normalized within the edge (sums to 1) |
| `x1`, `y1` | float | Sending cell centroid (Xenium µm coords) |
| `x2`, `y2` | float | Receiving cell centroid |
| `sending_type` | string | Cell type label (optional) |
| `receiving_type` | string | Cell type label (optional) |

---

## Features

**Morphology** — OME-TIFF deep zoom with pan/zoom via OpenSeadragon

**Transcripts** — dot overlay colored by gene species, filterable by gene

**Cell segmentation** — polygon boundaries, color-by-gene-set or color-by-metadata

**Tissue graph** — full cell-cell connectivity structure (LRM-agnostic background layer)

**Edge data** — directed colored edges colored by LRM set score or metadata column, with arrowheads, autocrine rings, and per-LRM filtering

**Annotations** — freehand region drawing with cell selection export, distance measurement tool

**Dataset picker** — switch between multiple datasets without restarting

---

## Development

### Backend (FastAPI)

```bash
cd backend
pip install -r requirements.txt
DATA_ROOT=../sample_data uvicorn app.main:app --reload
```

### Frontend (Vite + React)

```bash
cd frontend
npm install
npm run dev        # → http://localhost:3000, proxies /api → localhost:8000
```

---

## Architecture

```
browser
  OpenSeadragon   pan/zoom tile pyramid (morphology image)
  deck.gl         WebGL layers (transcripts, cells, edges) — coordinate-synced to OSD

FastAPI backend
  /tiles          OME-TIFF → DZI pyramid (libvips), tile serving
  /xenium         transcripts, cell boundaries, cell metadata, gene expression
  /edges          edge list, LRM catalogue, per-edge color values, edge detail
```

Tile pyramids are generated on first access and cached. All other data is served directly from parquet/zarr without pre-processing.
