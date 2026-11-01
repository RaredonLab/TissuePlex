# TissuePlex

**v1.0.1** · [GNU AGPL v3](LICENSE), commercial licence available

An interactive viewer for spatial transcriptomics that puts cell–cell communication on the tissue image. It reads the output of [NICHESv2](https://github.com/RaredonLab/NICHESv2) alongside Xenium, Visium, Visium HD, MERSCOPE, CosMx and seqFISH data, and lets you ask, in a browser: which cells are signalling, to whom, through which ligand–receptor mechanisms, and where.

![TissuePlex demo](docs/demo.gif)

📖 **[User manual](https://raredonlab.github.io/TissuePlex/)** · 🔬 **[Worked examples](https://raredonlab.github.io/TissuePlex/vignettes.html)** · 📝 **[Changelog](CHANGELOG.md)**

---

## Quick start

You need [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Mac or Windows) or Docker Engine with Compose v2 (Linux). Nothing else is installed on your machine.

```bash
git clone https://github.com/RaredonLab/TissuePlex.git
cd TissuePlex
docker compose up --build
```

Open **http://localhost:3000**. Four small demo datasets are included; three larger real ones are one command away:

```bash
python3 sample_data/fetch_samples.py
```

To view your own data, point `DATA_PATH` at a folder that contains one or more platform output directories. TissuePlex detects the platform from each directory's contents.

```bash
DATA_PATH=/absolute/path/to/your/datasets docker compose up --build
```

The [manual](https://raredonlab.github.io/TissuePlex/) walks through installation step by step, including Windows specifics, and documents every control. The [worked examples](https://raredonlab.github.io/TissuePlex/vignettes.html) show seven things to try in the first ten minutes.

---

## What you can do

- **See communication on the tissue.** NICHESv2 edges are drawn between the cells they connect, directed, with arrowheads, coloured by score or by any annotation. Autocrine signalling draws as a ring per cell.
- **Interrogate mechanisms.** Tick and untick any of hundreds of ligand–receptor mechanisms and the map updates instantly. Click an edge to see every mechanism scored on that cell pair.
- **Ask about one cell.** Click a cell for its expression and metadata, then show its local neighbourhood: every connected cell, the enclosing radius, the composition by cell type, and the dominant mechanisms.
- **Filter by metadata.** Restrict cells, or the sending and receiving ends of edges, by cluster, sample, cell type or a numeric range. Filters are applied before sampling, so a rare population renders at full density.
- **Bring your own annotations.** Drop a CSV beside the dataset (`cell-metadata/` for cells, `edge-metadata/` for cell pairs) and the columns appear as colour and filter options, with no re-export.
- **Compare side by side.** Two panels, one set of controls, a shared colour scale and a match-zoom button, for two edge sets, two images or two datasets.
- **Make figures.** Frame a region and export the data layers at any pixel size with a DPI tag and scale bar, or save a quick PNG. Draw regions to export the cells inside them as CSV; measure distances in microns.
- **Handle real data sizes.** Viewport-bounded queries over a spatial index keep a multi-gigabyte transcript file or a 100-million-row edge file responsive on a laptop, and datasets without an image render on a data-sized frame.

## Supported platforms

| Platform | Vendor | Morphology | Transcripts | Segments | Edges |
|---|---|:---:|:---:|:---:|:---:|
| **Xenium** | 10x Genomics | ✓ | ✓ | ✓ | ✓ |
| **Visium HD** | 10x Genomics | ✓ | — | ✓ (bins) | ✓ |
| **Visium** | 10x Genomics | ✓ | — | ✓ (spots) | ✓ |
| **MERSCOPE** | Vizgen | ✓ | ✓ | ✓ | ✓ |
| **CosMx** | Bruker / NanoString | optional | ✓ | ✓ | ✓ |
| **seqFISH** (Spatial Genomics GenePS) | Spatial Genomics | ✓ | ✓ | ✓ | ✓ |

The array platforms carry no per-molecule coordinates, so a Visium spot and a Visium HD bin are drawn as polygons and behave like cells everywhere else. Each reader declares what it can serve, and the interface hides the rest. The edge layer is platform-agnostic: it joins to any dataset whose cell barcodes match.

---

## Bringing your own analysis

**Communication edges** come from NICHESv2. After scoring a spatial object in R, export it beside the dataset and the layer appears on the next launch:

```r
export_to_TissuePlex(niches_object, output.path = "/your/datasets/xenium_run_A/edges.parquet")
```

One ready-made script per platform is in [`r/`](r/), handling each platform's coordinate units; [`docs/data_format.md`](docs/data_format.md) specifies the file so any pipeline can produce one. Several edge sets can sit in an `edges/` folder and be switched from a menu.

**Cell and edge annotations** need no export at all. `write.csv(df, "cell-metadata/clusters.csv")` from R, keyed on the cell barcode, adds columns to the colour and filter menus; `edge-metadata/`, keyed on `"Sender|Receiver"`, does the same for cell pairs. See the manual's [Enriching your data](https://raredonlab.github.io/TissuePlex/#step6).

## Demo datasets

| Folder | Platform | Source | How it ships |
|---|---|---|---|
| `mouse_ileum_tiny` | Xenium | 10x tiny example (36 cells), with annotation and multi-edge-set examples | in the repository |
| `visium_hd_tiny` | Visium HD | subset of 10x "Tiny Mouse Brain", CC BY 4.0 | in the repository |
| `visium_tiny` | Visium | synthetic slide | in the repository |
| `seqfish_synthetic` | seqFISH | synthetic region | in the repository |
| `xenium_human_breast_2fov` | Xenium | 10x human breast, 2 FOV, CC BY 4.0 | `fetch_samples.py` (290 MB) |
| `visium_mouse_kidney` | Visium | 10x mouse kidney, CC BY 4.0 | `fetch_samples.py` (40 MB) |
| `cosmx-mousebrain` | CosMx | Bruker mouse brain via the OSTA project, non-commercial licence | `fetch_samples.py` (60 MB) |

Every fetched folder includes a `PROVENANCE.md` stating its source, licence and what was changed. [`docs/public_datasets.md`](docs/public_datasets.md) has the full inventory and further public data.

---

## Deployment

TissuePlex runs as two containers and serves one browser or a whole lab. [`docs/setup.md`](docs/setup.md) covers a shared lab server; [`docs/cloud-deploy.md`](docs/cloud-deploy.md) is a step-by-step cloud runbook with automatic TLS. Access control is opt-in: enable Caddy's `basicauth` before exposing data to the internet.

## Development

```bash
cd backend && pip install -r requirements.txt && DATA_ROOT=../sample_data uvicorn app.main:app --reload
cd frontend && npm install && npm run dev        # http://localhost:5173, proxies /api → :8000
```

Tests: `npm test` in `frontend/`, and in `backend/` the reader regression guard `tests/golden_snapshot.py`, `tests/edge_pipeline_check.py`, `tests/no_image_check.py` and `tests/duckdb_config_check.py`.

The stack is a FastAPI backend querying parquet through DuckDB, with OpenSeadragon for the image pyramid and deck.gl for every data layer in the browser. [`CLAUDE.md`](CLAUDE.md) is the full technical brief: architecture, reader interface, data model, and the design decisions behind each subsystem.

---

## Licence

TissuePlex is dual-licensed.

- **Open source** under the [GNU Affero General Public License v3.0](LICENSE). Use, modify and share it freely; if you distribute a modified version or offer it over a network, the AGPL requires that your modified source be made available under the same terms. Academic and non-profit use is unaffected in practice.
- **Commercial licence** for use in products or services without the AGPL's source-sharing obligations: contact the Raredon Lab.

The demo datasets carry their own terms, stated in each dataset's `PROVENANCE.md`.

## Citation

If you use TissuePlex in published work, please cite: *(preprint / paper link to follow)*
