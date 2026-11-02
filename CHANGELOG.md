# Changelog

Release notes for TissuePlex. Earlier releases are listed on the
[GitHub releases page](https://github.com/RaredonLab/TissuePlex/releases).

## v1.0.1

In progress.

- **Honest colour ranges.** Cell and edge colour scales are now *auto* by default: their endpoints are the minimum and maximum of what is actually drawn, recomputed on every pan and every mechanism toggle, and the legend says whether it is auto or clamped. A second auto mode, **robust 5–95%**, ranges on the 5th to 95th percentile of the drawn values for heavy-tailed scores and is named in the legend. Previously the viewer silently clamped the top of the scale at the 95th percentile of the viewport on every pan, so colours saturated at a value the legend did not show, `reset range` was undone by the next pan, and a clamp set by hand was overwritten.
- **The shared colour scale now covers edges.** With `shared colour scale across panels` on, both panels' edge colours go through one window, as the cells' already did; it is the union of each panel's own auto window (full or robust), and the legend reads `shared`. Edge colours used to range per panel regardless of the setting, so two panels of edges that looked comparable were not.
- **The breast demo dataset is real data only.** `xenium_human_breast_2fov` no longer ships the generated placeholder `edges.parquet` (mouse gene names on a human panel); its one edge source is the NICHESv2 run `edges/niches_rad30.parquet`, its `edge-metadata/` is recomputed from that run with the invented review flag dropped, and 10x's own graph-based clustering ships as `cell-metadata/graphclust_10x.csv`. The release zip is rebuilt and `fetch_samples.py` now points at the `v1.0.1` release.
- **Integer metadata stays integer.** A cluster column with a few unlabelled cells was promoted to float by the join, so the legend read `1.0`, `2.0` and a filter on `1` matched nothing. Whole-number columns are restored to a nullable integer dtype after the join.
- **Edge colour ranges over drawn edges only.** Pairs carrying none of the selected mechanisms (score 0) no longer enter the auto window; with one mechanism selected the robust window used to start at 0 and end well below the drawn edges' own 95th percentile.
- Re-selecting the edge source already in use no longer empties the mechanism checklist.
- **Transcript dot size.** A `dot` slider under Transcripts sets the largest radius a transcript dot draws at (default 3 px; it was a fixed 8 px, which at 100% sample buried the cells).
- Two importable mechanism lists for the mouse brain (`sample_data/example_lists/`), used by worked example 6.
- README rewritten as a concise, public-facing page; release notes moved here.
- Worked examples re-shot for clarity.

## v1.0.0

The release reviewed alongside the manuscript. Functionally the v0.9.x viewer, with the public-facing material brought up to date.

- **Worked examples.** A new [screenshot-led tour](https://raredonlab.github.io/TissuePlex/vignettes.html) of seven workflows on the demo datasets, and a manual re-checked control by control against the software.
- **Real demo data in one command.** `python3 sample_data/fetch_samples.py` adds the 10x Xenium breast, 10x Visium mouse kidney and Bruker CosMx mouse brain datasets, each with NICHESv2 edges and a provenance note, from the release's attached files.
- **Two sidebar fixes.** The edge-table filter dropdown threw when a column was chosen; the inert *min strength* slider is gone.
- **Licence.** TissuePlex is distributed under the GNU AGPL v3, with a commercial licence available from the lab.

## v0.9.1

- **Fade low values.** When cells are coloured by gene set or edges by LRM set, the layer's opacity slider gains a draggable minimum (*fade to*): the lowest values draw at that opacity and the highest at the slider's maximum. Left at the maximum, nothing changes.
- **Edge Data holds everything connectivity.** The Tissue Graph row and the sampling slider now live under Edge Data, and the slider is called *sample*, matching the cell segments' own.

## v0.9.0

A performance and robustness release aimed at lab laptops and Docker deployments.

- **Gene and mechanism toggles are instant.** Unchecking a transcript species filters in the browser with no request; toggling an LRM is answered from a cached per-viewport score matrix in milliseconds. Only a moving viewport is debounced.
- **Nothing is processed beyond the field of view.** Edge queries are spatially indexed (a 10% viewport on a 33M-row edge file: 372 → 28 ms), whole-tissue views read a 10% density tier, and colour values arrive only for the cells and edges on screen instead of one value per unit in the dataset.
- **Datasets without an image render.** A missing DAPI or morphology, or a TIFF the tiler cannot open, no longer blanks the cell segments and edges: every layer draws on a frame sized from the data, and an unreadable image is reported rather than silently fatal. seqFISH coordinate detection no longer needs the DAPI.
- **The backend survives a laptop.** One shared DuckDB instance with process-wide memory and thread caps, a bounded query queue, and cancellation of queries the browser has abandoned. CosMx transcripts stream through DuckDB instead of re-reading the whole CSV per pan.
- **Failures are logged to disk.** A rotating log on the cache volume records slow requests, errors with tracebacks, memory pressure before an out-of-memory kill, and any fetch the browser saw fail; a red badge in the viewer shows the most recent one. `docker compose exec backend tail -n 300 /cache/logs/tissueplex.log`.
