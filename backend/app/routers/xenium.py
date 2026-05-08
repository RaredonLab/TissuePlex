"""
Xenium core data router.
Serves transcripts, cell boundaries, cell metadata, and expression from a
standard Xenium output folder. Handles v2/v3/v4 format differences via
XeniumReader.
"""
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from pathlib import Path
from typing import List, Optional
import io
import os

from app.readers.xenium_reader import XeniumReader

router = APIRouter()

DATA_ROOT = Path(os.getenv("DATA_ROOT", "/data"))


def _reader(dataset: str) -> XeniumReader:
    path = DATA_ROOT / dataset
    if not path.exists():
        raise HTTPException(404, f"Dataset '{dataset}' not found")
    return XeniumReader(path)


@router.get("/datasets")
def list_datasets():
    """Return all dataset directory names that contain experiment.xenium."""
    if not DATA_ROOT.exists():
        return []
    return sorted(
        d.name for d in DATA_ROOT.iterdir()
        if d.is_dir() and (d / "experiment.xenium").exists()
    )


@router.get("/{dataset}/images")
def list_images(dataset: str):
    """Return base names of available morphology images (OME-TIFF / TIFF) in a dataset folder."""
    path = DATA_ROOT / dataset
    if not path.exists():
        raise HTTPException(404, f"Dataset '{dataset}' not found")
    names = []
    for f in sorted(path.iterdir()):
        if not f.is_file():
            continue
        name = f.name
        for ext in (".ome.tiff", ".ome.tif", ".tiff", ".tif"):
            if name.lower().endswith(ext):
                names.append(name[: -len(ext)])
                break
    # Sort so "morphology" variants come first
    names.sort(key=lambda n: (not n.startswith("morphology"), n))
    return names


@router.get("/{dataset}/info")
def dataset_info(dataset: str):
    """Return experiment metadata from experiment.xenium."""
    return _reader(dataset).info()


@router.get("/{dataset}/transcripts")
def transcripts(
    dataset: str,
    xmin: float = Query(None),
    ymin: float = Query(None),
    xmax: float = Query(None),
    ymax: float = Query(None),
    genes: list[str] = Query(None),
    limit: int = Query(100_000),
):
    """
    Return transcript records filtered by bounding box and/or gene list.
    Returns a JSON-serialisable list of records (dicts).
    """
    return _reader(dataset).transcripts(
        bbox=(xmin, ymin, xmax, ymax) if xmin is not None else None,
        genes=genes,
        limit=limit,
    )


@router.get("/{dataset}/cells")
def cells(
    dataset: str,
    xmin: float = Query(None),
    ymin: float = Query(None),
    xmax: float = Query(None),
    ymax: float = Query(None),
):
    """Return cell records (centroid + metadata) filtered by bounding box."""
    return _reader(dataset).cells(
        bbox=(xmin, ymin, xmax, ymax) if xmin is not None else None,
    )


@router.get("/{dataset}/cell-boundaries")
def cell_boundaries(
    dataset: str,
    xmin: float = Query(None),
    ymin: float = Query(None),
    xmax: float = Query(None),
    ymax: float = Query(None),
    limit: int = Query(20_000),
):
    """Return cell polygon boundaries filtered by bounding box."""
    return _reader(dataset).cell_boundaries(
        bbox=(xmin, ymin, xmax, ymax) if xmin is not None else None,
        limit=limit,
    )


@router.get("/{dataset}/cells/schema")
def cells_schema(dataset: str):
    """Return column names and dtypes for cells.parquet."""
    return _reader(dataset).cells_schema()


@router.get("/{dataset}/cells/{cell_id}")
def cell_detail(dataset: str, cell_id: str):
    """Return merged metadata + expression for a single cell."""
    detail = _reader(dataset).cell_detail(cell_id)
    if detail is None:
        raise HTTPException(404, f"Cell '{cell_id}' not found")
    return detail


@router.get("/{dataset}/expression/{cell_id}")
def cell_expression(dataset: str, cell_id: str):
    """Return the gene expression vector for a single cell."""
    return _reader(dataset).cell_expression(cell_id)


@router.get("/{dataset}/genes")
def gene_list(dataset: str):
    """Return real gene names from the feature matrix."""
    return _reader(dataset).gene_list()


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


@router.post("/{dataset}/color-values")
def color_values_post(dataset: str, body: ColorValuesRequest):
    """Return per-cell color values. Accepts gene_set (list of genes) or metadata."""
    return _reader(dataset).color_values(body.mode, body.field, body.genes)
