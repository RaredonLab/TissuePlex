# TissuePlex

An interactive spatial transcriptomics viewer for exploring cell-cell communication from [NICHESv2](https://github.com/your-lab/NICHESv2) directly on the tissue image.

<!-- TODO: add a GIF or screenshot here showing edge toggling / LRM filtering -->

---

## What it does

Spatial transcriptomics platforms (Xenium, MERSCOPE, CosMx) produce high-resolution images with hundreds of genes measured per cell. NICHESv2 infers which cells are communicating and through which ligand-receptor mechanisms (LRMs). TissuePlex bridges those two outputs: it overlays the NICHESv2 communication graph on the tissue image and lets you explore it interactively.

**Key capabilities:**

- **Toggle individual LRMs in real time** — select any subset of 100s of ligand-receptor mechanisms and instantly see which cell pairs are communicating through them
- **Color edges by communication score or metadata** — visualize LRM set strength, cell type, or any custom column from your analysis as a continuous or categorical color scale
- **Click any edge for full detail** — inspect every active LRM for a given cell pair with their individual scores
- **Directed edges with arrowheads** — A→B and B→A are visually distinct; autocrine communication renders as rings
- **Pan and zoom on high-resolution morphology images** — OME-TIFF tile pyramid with smooth zoom from whole-tissue to single-cell scale
- **Transcript dot overlay** — per-gene colored dots, filterable by gene species
- **Cell/spot segmentation** — polygon boundaries with color-by-gene-set or color-by-metadata
- **Region drawing and measurement tools** — annotate areas, export cell selections
- **Supplemental metadata** — drop any CSV or parquet into a `cell-metadata/` folder to add custom color-by columns (clusters, pseudotime, etc.) without touching the original data
- **Multi-dataset support** — switch between datasets without restarting; each is auto-detected by platform

---

## Supported platforms

| Platform | Vendor | Morphology | Transcripts | Cell segments | Edges |
|---|---|:---:|:---:|:---:|:---:|
| **Xenium** | 10x Genomics | ✓ | ✓ | ✓ | ✓ |
| **MERSCOPE** | Vizgen | — | ✓ | — | ✓ |
| **CosMx** | Nanostring | — | ✓ | — | ✓ |

The edge connectivity layer (NICHESv2 output) works with any platform — it is platform-agnostic as long as cell barcodes match.

---

## Quick start

**Requirements:** [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Mac/Windows) or Docker Engine + Compose v2 (Linux). Nothing else needed on the host.

### Demo with sample data

```bash
git clone https://github.com/your-lab/TissuePlex.git
cd TissuePlex
docker compose up --build
```

Open **http://localhost:3000**.

### Your own data

```bash
DATA_PATH=/absolute/path/to/your/datasets docker compose up --build
```

`DATA_PATH` should be a **parent folder** containing one or more platform output directories. TissuePlex auto-detects the platform from each subdirectory's contents:

```
/your/datasets/
  xenium_run_A/
    experiment.xenium       ← Xenium sentinel
    morphology.ome.tif
    cells.parquet
    transcripts.parquet
    cell_boundaries.parquet
    edges.parquet           ← NICHESv2 output (optional)

  merscope_run_B/
    cell_by_gene.csv        ← MERSCOPE sentinel
    cell_metadata.csv
    detected_transcripts.csv
    edges.parquet

  cosmx_run_C/
    my_experiment_tx_file.csv   ← CosMx sentinel
    edges.parquet
```

If `edges.parquet` is absent the edge layers are hidden — all other layers work normally.

The first launch builds DZI tile pyramids from OME-TIFF morphology images. This takes ~30 seconds per dataset and is cached across restarts.

---

## NICHESv2 workflow

TissuePlex is designed as a downstream visualization step for [NICHESv2](https://github.com/your-lab/NICHESv2). After running NICHESv2 on your spatial dataset, export the connectivity object:

```r
# In R, after running NICHESv2:
export_for_TissuePlex(
  niches_object,
  output_path = "/your/datasets/xenium_run_A/edges.parquet"
)
```

Then launch TissuePlex — the edge layer will appear automatically.

The `edges.parquet` format is one row per **(directed edge) × (LRM)**. A→B and B→A are separate rows. Any additional columns in the file (cell types, scores, custom metadata) are automatically available as color-by options in the UI. See [docs/data_format.md](docs/data_format.md) for the full column specification.

---

## Supplemental cell metadata

To add custom annotation columns (clusters, pseudotime, leiden labels, etc.) to the cell color-by menu without modifying the original platform output:

```
dataset_folder/
  experiment.xenium
  cells.parquet
  cell-metadata/          ← create this directory
    clusters.csv          ← barcodes in first column (or cell_id column)
    pseudotime.parquet
```

Standard R export works out of the box:

```r
write.csv(my_metadata, file.path(dataset_dir, "cell-metadata", "metadata.csv"))
```

Columns appear automatically in the **Cell Color** dropdown. Continuous columns get a gradient; string and low-cardinality integer columns get discrete colors.

---

## Development setup

```bash
# Backend (FastAPI + DuckDB)
cd backend
pip install -r requirements.txt
DATA_ROOT=../sample_data uvicorn app.main:app --reload

# Frontend (React + Vite) — in a separate terminal
cd frontend
npm install
npm run dev   # → http://localhost:3000, proxies /api → :8000
```

---

## Architecture

```
Browser
  OpenSeadragon   — pan/zoom over OME-TIFF tile pyramid
  deck.gl (WebGL) — all data layers; coordinate-synced to OSD

FastAPI backend
  /tiles    — OME-TIFF → DZI tile pyramid (pyvips / tifffile fallback)
  /spatial  — transcripts, cell boundaries, cell metadata, gene expression
  /edges    — edge query, LRM catalogue, per-edge color values, edge detail
```

All data is served directly from parquet files via DuckDB — no database setup or import step. Tile pyramids are built on first access and cached.

### Adding a new platform

1. Create `backend/app/readers/my_platform_reader.py` extending `SpatialDatasetReader`
2. Implement the abstract methods (`cells`, `transcripts`, `cell_boundaries`, etc.)
3. Override `capabilities()` to declare which layers the platform supports
4. Register a detector in `reader_factory.py`

The frontend automatically adapts its layer controls to the capabilities your reader declares.

---

## Citation

If you use TissuePlex in published work, please cite: *(preprint / paper link — coming soon)*
