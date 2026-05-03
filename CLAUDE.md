# ConnectivityExplorer — Claude Code Project Brief

This file is read automatically by Claude Code at the start of every session.
It provides full context on the architecture, design decisions, and current state
of the project so any Claude instance can contribute immediately.

---

## What This Is

A web-based spatial transcriptomics viewer for Xenium data with custom connectivity
layers produced by the lab's NICHESv2 R pipeline. Built because Xenium Explorer does
not support cell-cell ligand-receptor mechanism (LRM) visualization.

**Core insight**: Rather than rasterizing 488 LRM outputs as PNG images, we store
connectivity data as a single `edges.parquet` file (analogous to Xenium's
`transcripts.parquet`) and render it as WebGL vector lines. This allows instant
toggling of 488 LRMs, coloring by any metadata, and zoom-independent rendering.

---

## Architecture

```
Browser
  OpenSeadragon    — pan/zoom over OME-TIFF tile pyramid (morphology image)
  deck.gl (WebGL)  — all data layers rendered as vectors, coordinate-synced to OSD
  React + Zustand  — UI state management

FastAPI backend
  /tiles     — OME-TIFF → DZI tile pyramid (pyvips/tifffile), tile serving
  /xenium    — transcripts, cell boundaries, cell metadata, gene expression
  /edges     — edge list, LRM catalogue, per-edge color values, edge detail
  /layers    — generic parquet layer serving (extensible)
```

**Key architectural constraint**: OpenSeadragon handles all pan/zoom events. deck.gl
sits in an absolutely-positioned canvas on top, with its viewport synced to OSD via a
custom `syncDeckFromOSD` function on every OSD viewport-change event. All data uses
Xenium pixel coordinates (µm / pixel_size).

---

## Repository Layout

```
backend/
  app/
    main.py                  FastAPI entry point, CORS, router registration
    routers/
      tiles.py               DZI descriptor + tile serving; auto-builds pyramid on first request
      xenium.py              transcripts, cell boundaries, cells, gene expression, color-values,
                             dataset list, per-dataset image list
      edges.py               edge query, LRM catalogue, edge color values, edge detail
      layers.py              generic parquet layer router
    readers/
      xenium_reader.py       reads all standard Xenium output files
      edge_reader.py         reads edges.parquet; lrm_catalogue(), edge_color_values(), edge_detail()
      layer_reader.py        generic parquet reader
    tiling/
      pyramid.py             OME-TIFF → DZI; pyvips streaming primary, tifffile+Pillow fallback
  requirements.txt           pinned deps; cffi<2.0 required for pyvips 2.2.3 compatibility
  Dockerfile

frontend/
  src/
    store.js                 Zustand store — ALL shared state lives here
    components/
      App.jsx                Root component; wraps everything in a React ErrorBoundary
      Viewer.jsx             Main component: OSD + deck.gl + all layer logic
      LayerPanel.jsx         Right-side panel: toggles, opacity, color-by, legends,
                             dataset/image picker, transcript species filter
      CellInfoPanel.jsx      Floating panel on cell click
      EdgeInfoPanel.jsx      Floating panel on edge/autocrine click
      AnnotationToolbar.jsx  Region drawing + measurement tools
    hooks/
      useTranscripts.js      Viewport-bounded transcript fetch (bbox always sent; skip at low zoom)
      useCellBoundaries.js   Viewport-bounded cell boundary fetch (skip when fracW >= 0.5)
      useCellColors.js       POST color-values; maps cell_id → RGBA; supports clamp
      useEdgeColors.js       POST edge-color-values; maps edge_id → RGBA; supports clamp
      useEdges.js            Viewport-bounded edge fetch
    utils/
      colormap.js            Palette definitions (viridis/plasma/magma/inferno) + valueToColor()
      geneColor.js           Deterministic gene → color mapping
  vite.config.js             Dev server proxies /api → localhost:8000
  nginx.conf                 Production: proxies /api/ → backend:8000/
  Dockerfile                 Multi-stage: node build → nginx serve

docker-compose.yml           Repo root; mounts DATA_PATH (or sample_data/) as /data:ro
docker/docker-compose.yml    Legacy path (kept for compatibility)
sample_data/                 GITIGNORED — default data mount for local dev/demo
docs/
  data_format.md             edges.parquet column spec for NICHESv2 R export
  setup.md                   Docker deployment guide
  public_datasets.md         Links to public Xenium datasets used for development
```

---

## Data Model: edges.parquet (NICHESv2 Format)

One row per **(directed edge) × (LRM)**. This is the long/sparse format from NICHESv2.

| Column | Type | Notes |
|---|---|---|
| `edge` | string | `"SendingCell\|ReceivingCell"` — directed edge ID |
| `sending_cell` | string | Xenium barcode |
| `receiving_cell` | string | Xenium barcode |
| `is_autocrine` | bool | True when sending == receiving |
| `lrm` | string | `"ligand\|receptor"` mechanism ID |
| `lrm_id` | int | Integer index (1–N) |
| `ligand` | string | |
| `receptor` | string | |
| `score` | float | Raw NICHESv2 score |
| `score_norm` | float | Score normalized within edge (sums to 1) |
| `x1`, `y1` | float | Sending cell centroid, Xenium µm coords |
| `x2`, `y2` | float | Receiving cell centroid |
| `sending_type` | string | Optional cell type label |
| `receiving_type` | string | Optional cell type label |

**Important**: Coordinates are in Xenium µm. The backend divides by `pixel_size`
(from `experiment.xenium`) when serving to the frontend.

The `sample_data/make_edges.py` script generates synthetic demo data in this format.
Real data should come from `export_NICHESObject_for_viewer()` in the NICHESv2 R package
(**this function does not yet exist — it is the next major work item**).

---

## State Management (store.js)

All shared state lives in a single Zustand store. Key sections:

- **Dataset / image**: `dataset` (null on init, auto-set from `/xenium/datasets`),
  `activeImage` (which OME-TIFF to show; auto-set from `/xenium/{dataset}/images`)
- **Layer visibility**: `layers` object — each layer has `visible` + `opacity`;
  `cellSegments` also has `outlineOpacity` (independent from fill opacity)
- **Cell color**: `cellColorEnabled`, `colorBy` (`mode`: off/gene_set/metadata, `field`),
  `cellColorPalette`, `cellColorClamp` (squish/oob cutoffs)
- **Transcript gene filter**: `selectedGenes` — `null` = no filter (show all);
  `Set<string>` = allowlist (show only those genes). Dataset-scoped; resets on
  dataset change. See Gene Filter section below.
- **Edge style**: `edgeWidth`, `showArrowheads`, `arrowStyle` (full/half-harpoon),
  `arrowheadScale`, `edgeDirectional`, `edgeOffset` (perpendicular separation), `showAutocrine`
- **Edge color**: `edgeColorBy` (`mode`: default/lrm_set/metadata), `edgeColorPalette`,
  `edgeColorClamp`
- **LRM filter**: `hiddenLrms` (Set of "ligand|receptor" strings), `lrmCatalogue`
- **Selection**: `selectedCell`, `selectedEdge`
- **Annotations**: `regions`, `measurements`, `activeRegion`, `annotationMode`

---

## Dataset & Image Auto-Initialization

`dataset` starts as `null`. `LayerPanel.jsx::DatasetPicker` fetches
`/xenium/datasets` on mount and calls `setDataset(list[0])` if the current dataset
is null or no longer in the list. Similarly, `activeImage` is auto-set from
`/xenium/{dataset}/images` (OME-TIFFs in the dataset folder, morphology-first).

`Viewer.jsx` renders a "Loading datasets…" placeholder while `dataset === null` so
no hooks fire against a null dataset. All data hooks guard against non-ok HTTP
responses — each returns an empty array on 404/500 so a missing file never causes
a render crash.

---

## Transcript Gene Filter (selectedGenes)

The gene filter uses an **allowlist** model, not a denylist:

- `selectedGenes = null` — no filter; all transcripts are shown
- `selectedGenes = Set{...}` — only transcripts whose `feature_name` is in the set are rendered

The selection is built from `allGenes` (fetched once per dataset from
`/xenium/{dataset}/genes`), so it is stable across pan/zoom. The UI in
`LayerPanel.jsx::TranscriptSpeciesSection`:

- **Collapsed / no filter**: shows `all N genes` with a `select ▼` button
- **Collapsed / filter active**: shows `M / N genes selected`, a compact list of
  selected genes (each with a ✕ remove button), a `clear` button, and an `edit ▼` button
- **Expanded picker**: full gene list (searchable) with checkboxes, `all` (→ null)
  and `none` (→ empty Set) buttons

`toggleSelectedGene(gene)`: if `selectedGenes` is null, starts a new Set with just
that gene. If it's a Set, toggles membership. Opening the picker while null shows all
genes as checked; unchecking one starts an allowlist.

`useCellColors` `gene_set` mode: if `selectedGenes === null`, uses all `allGenes`;
otherwise uses `[...selectedGenes]`.

---

## deck.gl Layers (Viewer.jsx)

Layers rendered in order (bottom to top):

1. `cell-segments-fill` — SolidPolygonLayer, cell fill colors
2. `cell-segments-outline` — PathLayer, cell boundaries
3. `transcripts` — ScatterplotLayer, transcript dots
4. `tissue-graph` — LineLayer, ALL unique undirected cell pairs (structural background, LRM-agnostic)
5. `edges-directed` — LineLayer, directed edges (LRM-filtered, colored)
6. `edges-arrowheads` — SolidPolygonLayer, filled arrowhead triangles (full or harpoon style)
7. `edges-autocrine` — ScatterplotLayer (stroked only), autocrine rings
8. Annotation layers (region fills, outlines, measurement lines)

**Tissue graph vs Edge data**: Tissue graph = binary structural layer (which cells are connected
at all, regardless of LRM). Edge data = quantitative/categorical overlay on top. Analogous to
cell segment outlines (structure) vs cell fill color (expression).

**Directional rendering**: A→B and B→A are offset perpendicular to the edge axis so they
appear as two distinct parallel lines. Offset amount is tunable (`edgeOffset`, default 4px).
Both are offset to their own LEFT, so harpoon arrowheads on the outer side naturally form
the chemistry ⇌ notation.

**Picking**: OSD consumes pointer events. After each click, `deck.pickObject()` is called
manually at the click coordinates. Cell fill layer is checked first; if no hit, edge layers
are checked. Results set `selectedCell` or `selectedEdge` in the store.

---

## Viewport-Bounded Data Fetching

All data hooks (transcripts, cell boundaries, edges) are debounced and skip fetches
that would be wasted at the current zoom level:

| Hook | Skip condition | Bbox filter | Limit |
|---|---|---|---|
| `useTranscripts` | `fracW >= 0.7` | Always sent when viewport available | 50K (random sample) |
| `useCellBoundaries` | `fracW >= 0.5` | Always sent | 20K cells |
| `useEdges` | no viewport | Always sent | 50K |

`fracW = (xmax - xmin) / imageSize.w` — fraction of image width visible.

**Transcript sampling**: the backend uses `df.sample(n=limit)` (random, not `head`)
so the 50K returned transcripts are spatially uniform across the viewport rather than
biased toward whatever region appears first in the parquet row order.

---

## Color System

`valueToColor(value, vmin, vmax, palette)` in `colormap.js` maps a scalar to RGBA.
`interpolateStops` clamps t to [0,1], so passing a tighter [lo, hi] window achieves
`oob::squish` behavior — values outside the window get the palette endpoints.

The `cellColorClamp` / `edgeColorClamp` store values are passed into the color hooks
and applied as `lo = clamp.low ?? dataMin`, `hi = clamp.high ?? dataMax`.

Categorical data uses `QUAL_PALETTE` (20 visually distinct colors) from `colormap.js`.

---

## Tile Pyramid

The backend uses pyvips when available (fast streaming, handles very large OME-TIFFs
without loading the full image into RAM) with a tifffile+Pillow fallback for
environments without libvips. Key details:

- Pyramids are built on first DZI request (auto-triggered by `tiles.py::dzi_descriptor`)
  and cached in `CACHE_DIR` (Docker volume `dzi_cache`, or alongside data in dev).
  The build is idempotent.
- **pyvips path**: detects availability with `pyvips.version(0)` (catches `OSError`
  when the C library is missing — `except ImportError` is not sufficient). Builds a
  lazy MIP pipeline across all Z-planes using `ifthenelse` chains; no full image
  in RAM. Calls `img.dzsave(...)` to stream tiles.
- **tifffile fallback**: reads one OME level at a time, skips levels too large for
  available RAM (guard: `MAX_TIFFFILE_DIM = 16384`), computes normalisation stats
  from the smallest available level.
- OME-TIFFs from Xenium use JPEG2000 compression — requires `imagecodecs` pip package.

---

## Development Workflow

**Local dev (no Docker):**
```bash
# Backend
cd backend
pip install -r requirements.txt
DATA_ROOT=../sample_data uvicorn app.main:app --reload

# Frontend (separate terminal)
cd frontend
npm install
npm run dev   # → http://localhost:3000, proxies /api → :8000
```

**Docker — demo data (sample_data/):**
```bash
docker compose up --build   # first time or after code changes
docker compose up           # subsequent runs
docker compose down
```

**Docker — external data directory:**
```bash
DATA_PATH="/absolute/path/to/xenium/datasets" docker compose up --build
```
`DATA_PATH` must be an absolute host path with no colons (macOS Docker Desktop
resolves symlinks to the real path, so symlinks through colon-containing network
paths do not help — the data must live under a colon-free path).

The app auto-discovers all Xenium dataset folders under the mounted directory.
Add new datasets by dropping a standard Xenium output folder into `DATA_PATH`.

---

## Known Issues / Gotchas

- `pyvips==2.2.3` is incompatible with `cffi>=2.0` — pinned as `cffi<2.0` in requirements.txt
- `imagecodecs` is required for JPEG2000 OME-TIFFs (Xenium standard format)
- `pyvips` raises `OSError` (not `ImportError`) when the libvips C library is missing;
  catch `Exception` broadly or test with `pyvips.version(0)`
- The `/{edge_id:path}` FastAPI route converter is required to handle `|` in edge IDs
- `is_autocrine` from pandas parquet is `numpy.bool_` — must cast to `bool()` before JSON serialization
- OSD and deck.gl use different coordinate systems; the `syncDeckFromOSD` function in
  Viewer.jsx is the critical bridge — do not break it
- Docker volume specs use `:` as separator; host paths containing `:` (e.g. network
  mount paths on macOS) will cause `invalid volume specification` errors
- All data hooks must guard against non-ok HTTP responses (return `[]` on error);
  storing a `{"detail": "..."}` error object as the edges/transcripts/cells array
  causes deck.gl to throw "not iterable" errors in minified code

---

## What's Not Built Yet

1. **R export function** — `export_NICHESObject_for_viewer()` to convert a NICHESv2 R object
   to `edges.parquet`. This is the critical bridge to real data. See `docs/data_format.md`
   for the column spec it must produce.

2. **Cell expression bar chart** — click panel currently shows cell metadata but not a sorted
   gene expression readout. The `/xenium/{dataset}/cell/{cell_id}/expression` endpoint exists
   but the UI component is not built.

3. **Performance at scale** — large datasets (100K+ cells, 400K+ transcript rows per viewport)
   can be laggy. Transcripts are already randomly sampled and zoom-skipped. Further
   improvements: LOD for arrowheads at low zoom, server-side edge aggregation, or reducing
   the edge limit in `useEdges.js`.

4. **Authentication** — no auth. Fine for local/lab use, needs work for any public deployment.
