"""
Edge data router.
Serves edge-list data (x1,y1 → x2,y2 + arbitrary metadata columns) from
one or more Parquet files in the dataset folder.

Edges represent any kind of cell-to-cell relationship: ligand-receptor
mechanisms, morphogen gradients, proximity scores, etc. The schema is
open — any column beyond the required spatial ones is a filterable attribute.

Required columns in edges.parquet (or any registered edge file):
    x1, y1  — source cell centroid (Xenium pixel coords)
    x2, y2  — target cell centroid

All other columns are optional metadata that the frontend can filter/color by.
"""
from fastapi import APIRouter, HTTPException, Query
from pathlib import Path
from pydantic import BaseModel
import os
from typing import Optional, List

from app.readers.edge_reader import EdgeReader

router = APIRouter()

DATA_ROOT = Path(os.getenv("DATA_ROOT", "/data"))


def _reader(dataset: str, edge_file: str = "edges.parquet") -> EdgeReader:
    path = DATA_ROOT / dataset
    if not path.exists():
        raise HTTPException(404, f"Dataset '{dataset}' not found")
    edge_path = path / edge_file
    if not edge_path.exists():
        raise HTTPException(404, f"Edge file '{edge_file}' not found in dataset '{dataset}'")
    return EdgeReader(edge_path)


@router.get("/{dataset}/schema")
def edge_schema(dataset: str, edge_file: str = Query("edges.parquet")):
    """Return column names and dtypes for the edge file."""
    return _reader(dataset, edge_file).schema()


@router.get("/{dataset}/lrm-catalogue")
def lrm_catalogue(dataset: str, edge_file: str = Query("edges.parquet")):
    """Return unique (lrm_id, ligand, receptor) rows, sorted by lrm_id."""
    return _reader(dataset, edge_file).lrm_catalogue()


@router.get("/{dataset}/layer-values")
def layer_values(dataset: str, column: str, edge_file: str = Query("edges.parquet")):
    """Return the distinct values (or min/max for numerics) for a given column."""
    return _reader(dataset, edge_file).column_summary(column)


@router.get("/{dataset}/query")
def query_edges(
    dataset: str,
    edge_file: str = Query("edges.parquet"),
    xmin: float = Query(None),
    ymin: float = Query(None),
    xmax: float = Query(None),
    ymax: float = Query(None),
    filters: Optional[str] = Query(
        None,
        description="JSON-encoded dict of {column: value_or_list} equality filters",
    ),
    min_strength: Optional[float] = Query(None, description="Minimum value of 'strength' column if present"),
    limit: int = Query(200_000),
):
    """
    Return edges filtered by viewport bounding box and optional column filters.
    Edges are included if either endpoint falls within the bbox.
    """
    import json
    parsed_filters = json.loads(filters) if filters else {}
    return _reader(dataset, edge_file).query(
        bbox=(xmin, ymin, xmax, ymax) if xmin is not None else None,
        filters=parsed_filters,
        min_strength=min_strength,
        limit=limit,
    )


@router.get("/{dataset}/files")
def list_edge_files(dataset: str):
    """List all .parquet files in the dataset folder that can be used as edge sources."""
    path = DATA_ROOT / dataset
    if not path.exists():
        raise HTTPException(404, f"Dataset '{dataset}' not found")
    parquet_files = [f.name for f in path.glob("*.parquet")]
    return {"files": parquet_files}


class EdgeColorRequest(BaseModel):
    mode: str                        # "lrm_set" | "metadata"
    lrms: Optional[List[str]] = None # for lrm_set: list of "ligand|receptor" strings
    field: Optional[str] = None      # for metadata: column name


@router.post("/{dataset}/edge-color-values")
def edge_color_values(dataset: str, body: EdgeColorRequest,
                      edge_file: str = Query("edges.parquet")):
    """
    Return per-directed-edge color values.
    lrm_set: sum score for the supplied LRM list, one value per edge.
    metadata: return first value of `field` per edge (auto-detects cat/continuous).
    """
    return _reader(dataset, edge_file).edge_color_values(body.mode, body.lrms, body.field)


@router.get("/{dataset}/edge/{edge_id:path}")
def edge_detail(dataset: str, edge_id: str,
                edge_file: str = Query("edges.parquet")):
    """Return all LRM rows for a single directed edge (for the info panel)."""
    detail = _reader(dataset, edge_file).edge_detail(edge_id)
    if detail is None:
        raise HTTPException(404, f"Edge '{edge_id}' not found")
    return detail
