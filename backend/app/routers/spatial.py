"""
Platform-agnostic spatial data router.

Replaces the Xenium-specific xenium.py router.  All dataset access goes through
ReaderFactory, which auto-detects the platform and returns the appropriate reader.
Supported platforms: Xenium, MERSCOPE, CosMx (see readers/reader_factory.py).
"""
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import ORJSONResponse, StreamingResponse
from pydantic import BaseModel
from pathlib import Path
from typing import List, Optional
import io
import os

from app.concurrency import run_cancellable
from app.readers.metadata_filter import MetadataFilter
from app.readers.reader_factory import ReaderFactory

router = APIRouter()

DATA_ROOT = Path(os.getenv("DATA_ROOT", "/data"))

# Module-level cache: dataset name → reader instance.
# Keeps instance-level caches (_cells_full_cache, etc.) alive across requests.
_reader_cache: dict[str, object] = {}

# dataset → gene list. `gene_list()` is not cached by every reader — CosMx reads
# its whole transcript CSV to compute it — and it is called on every transcript
# request that arrives as `exclude_genes`, i.e. on every pan once the user has
# deselected a few genes. Memoised here so each reader computes it once.
_gene_list_cache: dict[str, list] = {}


def _genes(dataset: str) -> list:
    if dataset not in _gene_list_cache:
        _gene_list_cache[dataset] = list(_reader(dataset).gene_list() or [])
    return _gene_list_cache[dataset]


def _reader(dataset: str):
    if dataset in _reader_cache:
        return _reader_cache[dataset]
    path = DATA_ROOT / dataset
    if not path.exists():
        raise HTTPException(404, f"Dataset '{dataset}' not found")
    try:
        reader = ReaderFactory.detect(path)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    _reader_cache[dataset] = reader
    return reader


# ── Dataset discovery ─────────────────────────────────────────────────────────

@router.get("/datasets")
def list_datasets():
    """Return all dataset directory names recognised as a supported spatial platform."""
    if not DATA_ROOT.exists():
        return []
    return sorted(
        d.name for d in DATA_ROOT.iterdir()
        if d.is_dir() and ReaderFactory.is_dataset(d)
    )


@router.get("/platforms")
def list_platforms():
    """Return the supported platform identifiers."""
    return ReaderFactory.supported_platforms()


# ── Per-dataset endpoints ─────────────────────────────────────────────────────

@router.get("/{dataset}/info")
def dataset_info(dataset: str):
    """Experiment metadata, platform identifier, and capability flags."""
    r = _reader(dataset)
    # `frame` is the data-derived canvas (pixel width/height from the unit
    # extent). The viewer draws on it whenever there is no morphology image, or
    # the image's pyramid cannot be opened, so the data layers never depend on
    # an image existing. Cached per reader after the first call.
    return {**r.info(), "capabilities": r.capabilities(), "frame": r.frame()}


@router.get("/{dataset}/images")
def list_images(dataset: str):
    """Base names of available morphology images in a dataset folder.

    Delegates to `pyramid.list_image_stems`, which lives beside `_find_source` so
    the picker never lists a stem the tile builder cannot open. Returns [] for a
    dataset with no image; the viewer then renders every other layer on a frame
    sized from the data (`/info` → `frame`) rather than on nothing.
    """
    path = DATA_ROOT / dataset
    if not path.exists():
        raise HTTPException(404, f"Dataset '{dataset}' not found")
    from app.tiling.pyramid import list_image_stems
    return list_image_stems(path)


@router.get("/{dataset}/genes")
def gene_list(dataset: str):
    """All assayed gene names (excluding controls/blanks)."""
    return _genes(dataset)


@router.get("/{dataset}/transcripts")
async def transcripts(
    request: Request,
    dataset: str,
    xmin: float = Query(None),
    ymin: float = Query(None),
    xmax: float = Query(None),
    ymax: float = Query(None),
    genes: list[str] = Query(None),
    exclude_genes: list[str] = Query(None),
    fraction: float = Query(1.0),
    min_qv: float = Query(None, ge=0, description="Keep only transcripts with Q-Score >= this "
                          "(Xenium Explorer hides < 20). Ignored for platforms without a Q-Score."),
):
    """Transcript records filtered by bounding box and/or gene list.

    `genes` is an allowlist; `exclude_genes` is its complement, resolved here
    against the dataset's gene list. Both express the same filter, and the client
    sends whichever is shorter, because this is a GET and the list goes in the
    URL: on a 480-gene panel "everything except one gene" is 7.8 KB of query
    string, ~220 bytes under nginx's 8 KB request-line limit, and a 600-gene
    panel 414s outright. Stated as an exclusion the same filter is one parameter.

    Resolving here rather than in the readers keeps `SpatialDatasetReader` to a
    single gene argument — six readers implement it and none of them need to know
    the filter arrived inverted.

    Returns {"transcripts": [...], "total": N} where total is the pre-sample count.
    """
    reader = _reader(dataset)
    if exclude_genes:
        excluded = set(exclude_genes)
        remaining = [g for g in _genes(dataset) if g not in excluded]
        # An empty allowlist and "no filter" are different things, and `genes=None`
        # means the latter. Excluding every gene must therefore yield no rows, not
        # all of them, so fall back to a sentinel that matches nothing.
        genes = (genes or []) + remaining if genes else (remaining or ["\0"])
    # The Q-Score filter reaches only readers that declare it. In split view the
    # client sends one setting to both panels, and a MERSCOPE or seqFISH panel
    # beside a Xenium one simply has nothing to filter on.
    extra = {}
    if min_qv is not None and reader.capabilities().get("has_transcript_qv"):
        extra["min_qv"] = min_qv
    # Cancellable and orjson-serialised for the same reasons as the edge
    # queries: this fires on every pan and can return 200K rows.
    return await run_cancellable(request, lambda: ORJSONResponse(reader.transcripts(
        bbox=(xmin, ymin, xmax, ymax) if xmin is not None else None,
        genes=genes,
        fraction=fraction,
        **extra,
    )))


@router.get("/{dataset}/cells")
def cells(
    dataset: str,
    xmin: float = Query(None),
    ymin: float = Query(None),
    xmax: float = Query(None),
    ymax: float = Query(None),
):
    """Cell records (centroid + metadata) filtered by bounding box."""
    return _reader(dataset).cells(
        bbox=(xmin, ymin, xmax, ymax) if xmin is not None else None,
    )


@router.get("/{dataset}/cells/schema")
def cells_schema(dataset: str):
    """Column names and dtypes for the cells table."""
    return _reader(dataset).cells_schema()


@router.get("/{dataset}/cells/{cell_id}")
def cell_detail(dataset: str, cell_id: str):
    """Full metadata + expression for a single cell."""
    detail = _reader(dataset).cell_detail(cell_id)
    if detail is None:
        raise HTTPException(404, f"Cell '{cell_id}' not found")
    return detail


@router.get("/{dataset}/expression/{cell_id}")
def cell_expression(dataset: str, cell_id: str):
    """Gene expression vector for a single cell."""
    return _reader(dataset).cell_expression(cell_id)


@router.get("/{dataset}/cell-boundaries")
async def cell_boundaries(
    request: Request,
    dataset: str,
    xmin: float = Query(None),
    ymin: float = Query(None),
    xmax: float = Query(None),
    ymax: float = Query(None),
    fraction: float = Query(1.0),
    filter_field: str = Query(None, description="Metadata column to restrict on"),
    filter_values: List[str] = Query(None, description="Categorical allowlist"),
    filter_min: float = Query(None, description="Inclusive lower bound"),
    filter_max: float = Query(None, description="Inclusive upper bound"),
    filter_missing: bool = Query(False, description="Also keep units with no value"),
    color_mode: str = Query(None, description="gene_set | metadata: also return colour "
                            "values for the cells in the response"),
    color_field: str = Query(None),
    color_categorical: Optional[bool] = Query(None),
    color_genes: List[str] = Query(None),
    color_exclude_genes: List[str] = Query(None),
):
    """Cell polygon boundaries filtered by bounding box and, optionally, metadata.

    fraction: 0–1 fraction of cells in viewport to return (randomly sampled).

    The metadata filter (issue #45) is resolved to a cell-id set and applied inside
    the reader *before* sampling, so restricting to a rare cluster isolates it at
    full density instead of thinning it to almost nothing.

    With `color_mode` the response also carries `colors`: the colour-by values
    for exactly the cells returned, plus the dataset-wide type / categories /
    range. One request instead of two, and never a value for a cell that is not
    on screen. The gene list for `gene_set` follows the transcripts endpoint's
    rule — allowlist, or its complement, or neither for the whole panel.
    """
    reader = _reader(dataset)
    spec = MetadataFilter.build(
        filter_field, filter_values, filter_min, filter_max, filter_missing)
    genes = (_resolve_color_genes(dataset, color_genes, color_exclude_genes)
             if color_mode == "gene_set" else None)

    def work():
        cell_ids = reader.filter_cell_ids(spec)
        result = reader.cell_boundaries(
            bbox=(xmin, ymin, xmax, ymax) if xmin is not None else None,
            fraction=max(0.0001, min(1.0, fraction)),
            cell_ids=cell_ids,
        )
        if color_mode in ("gene_set", "metadata"):
            rows = result.get("boundaries") or []
            in_view = list({r["cell_id"] for r in rows if "cell_id" in r})
            result["colors"] = reader.color_values_for(
                color_mode, color_field, genes, color_categorical, cell_ids=in_view)
        return ORJSONResponse(result)

    try:
        return await run_cancellable(request, work)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@router.post("/{dataset}/cells/export")
def export_cells(dataset: str, cell_ids: List[str]):
    """Return cell metadata for the given cell IDs as CSV."""
    import pandas as pd
    reader = _reader(dataset)
    all_cells = reader.cells()
    if not all_cells:
        return StreamingResponse(io.StringIO(""), media_type="text/csv")
    df = pd.DataFrame(all_cells)
    subset = df[df["cell_id"].isin(set(cell_ids))]
    buf = io.StringIO()
    subset.to_csv(buf, index=False)
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{dataset}_cells.csv"'},
    )


class ColorValuesRequest(BaseModel):
    mode: str
    field: Optional[str] = None
    genes: Optional[List[str]] = None
    # None = auto-detect from dtype and cardinality; True/False force the
    # interpretation of a metadata column (issue #35 — integer cluster IDs).
    categorical: Optional[bool] = None
    # Restrict `values` to these cells (the ones in view), or drop `values`
    # altogether and return only type / categories / range.
    cell_ids: Optional[List[str]] = None
    summary: bool = False


@router.post("/{dataset}/color-values")
async def color_values_post(request: Request, dataset: str, body: ColorValuesRequest):
    """Per-cell color values for gene_set or metadata coloring.

    Without `cell_ids` or `summary` this is one value per cell in the *whole*
    dataset — the biggest single response the app can send. The viewer itself
    no longer asks for that: colours for the cells in view ride on the
    cell-boundaries response, and the sidebar asks for `summary`.
    """
    reader = _reader(dataset)
    return await run_cancellable(request, lambda: ORJSONResponse(reader.color_values_for(
        body.mode, body.field, body.genes, body.categorical,
        cell_ids=body.cell_ids, summary=body.summary)))


def _resolve_color_genes(dataset: str, genes: Optional[list], exclude: Optional[list]) -> list:
    """Allowlist / complement / all, the same rule the transcripts endpoint uses."""
    if genes:
        return list(genes)
    if exclude:
        excluded = set(exclude)
        return [g for g in _genes(dataset) if g not in excluded]
    return list(_genes(dataset))
