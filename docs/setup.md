# Setup Guide

TissuePlex runs as a two-container Docker application (backend API + frontend web server). Each lab member can run their own local instance, or a single shared server can be deployed for the whole lab.

---

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Mac or Windows) or Docker Engine + docker-compose (Linux)
- Your spatial transcriptomics output folder(s) on disk

No Python, Node.js, or other dependencies are required on the host machine.

---

## Quick start

```bash
# Clone the repository
git clone <repo-url>
cd TissuePlex

# Launch against your data
DATA_PATH=/absolute/path/to/your/datasets \
  docker compose up --build
```

Then open **http://localhost:3000** in your browser.

`DATA_PATH` should be the **parent folder** containing one or more platform output directories:

```
/your/datasets/
  xenium_experiment_A/
    experiment.xenium
    morphology.ome.tif
    transcripts.parquet
    ...
  merscope_experiment_B/
    cell_by_gene.csv
    cell_metadata.csv
    ...
  visium_hd_experiment_C/
    square_002um/
      ...
```

TissuePlex auto-detects the platform for each subdirectory based on its contents.

---

## Supported platforms and sentinel files

| Platform | Sentinel file / directory |
|---|---|
| **Xenium** (10x Genomics) | `experiment.xenium` |
| **Visium HD** (10x Genomics) | `square_???um/` subdirectory |
| **MERSCOPE** (Vizgen) | `cell_by_gene.csv` or `cell_metadata.csv` |
| **CosMx** (Nanostring) | `*_tx_file.csv` |

Directories that don't match any sentinel are silently ignored.

---

## First launch

The first time a dataset with a morphology image is opened, the viewer builds a DZI tile pyramid from the OME-TIFF. This takes **10–30 seconds** for a typical imaging-based dataset. Subsequent launches reuse the cached pyramid (stored in a Docker named volume — it persists across container restarts).

---

## Using sample data

The repo includes a small test dataset. To use it without setting `DATA_PATH`:

```bash
docker compose up --build
```

This mounts `sample_data/` from the repo root.

---

## Stopping

```bash
docker compose down
```

Add `-v` to also delete the tile pyramid cache:

```bash
docker compose down -v
```

---

## Updating

```bash
git pull
docker compose up --build
```

The `--build` flag rebuilds the images with any code changes. Your data and tile cache are unaffected.

---

## Shared lab server

To host a shared instance accessible to the whole lab, run the same command on the server. The frontend is served on port 3000; expose it via nginx or a reverse proxy as needed. The data folder is mounted **read-only** — TissuePlex never modifies source data.

To change the ports, edit `docker-compose.yml`:

```yaml
ports:
  - "8080:8000"   # backend
  - "80:80"       # frontend
```

---

## Edge connectivity data

TissuePlex can display an additional connectivity layer on top of the standard platform output. This requires an `edges.parquet` file in each dataset folder, produced by the NICHESv2 R connectivity pipeline.

See [data_format.md](data_format.md) for the file specification.

If `edges.parquet` is absent, the Edges layer is hidden — all other layers work normally.

---

## Troubleshooting

**Blank viewer / no image**: The tile pyramid may still be building. Wait 15–30 seconds and refresh.

**Dataset not listed**: Check that `DATA_PATH` points to the parent folder (not the dataset folder itself), and that the dataset directory contains the platform sentinel file (see table above).

**Port conflict**: If port 3000 or 8000 is already in use, change the host ports in `docker-compose.yml` and rebuild.

**Tile cache corruption**: Run `docker compose down -v` to clear the cache, then restart.
