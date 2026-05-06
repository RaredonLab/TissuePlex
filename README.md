# TissuePlex

A platform-agnostic spatial transcriptomics viewer with support for cell-cell connectivity layers produced by NICHESv2.

Built on OpenSeadragon (deep zoom) + deck.gl (WebGL layers) + FastAPI.

---

## Supported platforms

| Platform | Vendor | Data type | Transcripts | Cell/Spot segments |
|---|---|---|---|---|
| **Xenium** | 10x Genomics | Imaging-based | ✓ | ✓ |
| **Visium HD** | 10x Genomics | Imaging-based | — | — (bins as points) |
| **MERSCOPE** | Vizgen | Imaging-based | ✓ | — (in progress) |
| **CosMx** | Nanostring | Imaging-based | ✓ | — (in progress) |

Spot-based platforms (Visium, Stereo-seq, Curio, Slide-seq) are on the roadmap. The reader architecture is designed to accommodate them — contributions welcome.

---

## Quick start

### Requirements
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker Engine + Compose v2)

### Run with sample data

```bash
git clone https://github.com/your-lab/TissuePlex.git
cd TissuePlex
docker compose up --build
```

Open **http://localhost:3000** in your browser.

The first launch builds tile pyramids for the morphology images — this takes a minute or two per dataset. Pyramids are cached in a Docker volume (`dzi_cache`) and reused on subsequent starts.

### Run with your own data

Point `DATA_PATH` at a parent folder containing one or more platform output directories:

```bash
DATA_PATH=/path/to/your/datasets docker compose up --build
```

Each subdirectory is auto-detected by platform. Platform detection is based on sentinel files:

| Platform | Sentinel |
|---|---|
| Xenium | `experiment.xenium` |
| Visium HD | `square_???um/` subdirectory |
| MERSCOPE | `cell_by_gene.csv` or `cell_metadata.csv` |
| CosMx | `*_tx_file.csv` |

Your data is mounted **read-only** — TissuePlex never modifies source files.

---

## Data folder layout

```
DATA_PATH/
  my_xenium_run/
    experiment.xenium
    morphology.ome.tif
    transcripts.parquet
    cells.parquet
    cell_boundaries.parquet
    edges.parquet          ← NICHESv2 connectivity output (optional)

  my_merscope_run/
    cell_by_gene.csv
    cell_metadata.csv
    detected_transcripts.csv
    edges.parquet          ← optional

  my_visium_hd_run/
    square_002um/
      spatial/
        tissue_positions.parquet
    spatial/
      tissue_hires_image.png
```

If `edges.parquet` is absent, the edge layers are hidden but all other layers work normally.

---

## edges.parquet format (NICHESv2 output)

The viewer expects the NICHESv2-aligned edge format. Use `export_NICHESObject_for_viewer()` from the NICHESv2 R package to generate this file, or see [docs/data_format.md](docs/data_format.md) for the full column spec.

The format is platform-agnostic — it works with any spatial dataset as long as cell/spot barcodes match those in the platform's output.

Required columns:

| Column | Type | Description |
|---|---|---|
| `edge` | string | `"SenderBarcode\|ReceiverBarcode"` directed edge ID |
| `sending_cell` | string | Barcode of the sending cell/spot |
| `receiving_cell` | string | Barcode of the receiving cell/spot |
| `is_autocrine` | bool | True when sender == receiver |
| `lrm` | string | `"ligand\|receptor"` mechanism ID |
| `lrm_id` | int | Integer index |
| `ligand` | string | |
| `receptor` | string | |
| `score` | float | Raw LRM score for this edge |
| `score_norm` | float | Score normalized within the edge (sums to 1) |
| `x1`, `y1` | float | Sending unit centroid (native µm coords) |
| `x2`, `y2` | float | Receiving unit centroid |
| `sending_type` | string | Cell/spot type label (optional) |
| `receiving_type` | string | Cell/spot type label (optional) |

---

## Features

**Morphology** — OME-TIFF deep zoom with pan/zoom via OpenSeadragon

**Transcripts** — dot overlay colored by gene species, filterable by gene *(imaging-based platforms)*

**Cell/Spot segmentation** — polygon boundaries, color-by-gene-set or color-by-metadata *(platforms with boundary data)*

**Tissue graph** — full connectivity structure (LRM-agnostic background layer)

**Edge data** — directed colored edges by LRM set score or metadata column, with arrowheads, autocrine rings, and per-LRM filtering

**Annotations** — freehand region drawing with cell selection export, distance measurement tool

**Dataset picker** — switch between multiple datasets without restarting

The viewer automatically adjusts which layers are available based on what each platform supports. Platforms without individual transcript detection hide the Transcripts layer; platforms without polygon boundaries hide the Segments layer.

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
  deck.gl         WebGL layers (transcripts, cells/spots, edges) — coordinate-synced to OSD

FastAPI backend
  /tiles          OME-TIFF → DZI pyramid (libvips), tile serving
  /spatial        platform-agnostic: transcripts, boundaries, metadata, color values
  /edges          edge list, LRM catalogue, per-edge color values, edge detail
```

Tile pyramids are generated on first access and cached. All other data is served directly from parquet files.

### Adding a new platform

1. Create `backend/app/readers/my_platform_reader.py` extending `SpatialDatasetReader`
2. Implement all abstract methods (`cells`, `transcripts`, `cell_boundaries`, etc.)
3. Override `capabilities()` to declare what the platform supports
4. Register a detector and factory in `reader_factory.py`

The frontend automatically adapts its layer controls to the capabilities your reader declares.
