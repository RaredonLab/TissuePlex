"""
Cell-registered data layers router.
Serves arbitrary per-cell scalar or categorical values that drive cell
segment coloring in the viewer. Each layer is a column (or set of columns)
in a Parquet file keyed by cell_id.

This is distinct from Xenium gene expression (served via /xenium/expression)
in that it handles lab-computed metadata: cell-type annotations, signaling
scores, spatial metrics, clustering results, etc.

Expected file format (cell_layers.parquet or any registered file):
    cell_id  — must match the cell IDs in cell_boundaries.parquet
    <col1>, <col2>, ...  — any number of scalar or categorical columns
"""
from fastapi import APIRouter, HTTPException, Query
from pathlib import Path
import os
from typing import Optional

from app.readers.layer_reader import CellLayerReader

router = APIRouter()

DATA_ROOT = Path(os.getenv("DATA_ROOT", "/data"))


def _reader(dataset: str, layer_file: str) -> CellLayerReader:
    path = DATA_ROOT / dataset
    if not path.exists():
        raise HTTPException(404, f"Dataset '{dataset}' not found")
    layer_path = path / layer_file
    if not layer_path.exists():
        raise HTTPException(404, f"Layer file '{layer_file}' not found in dataset '{dataset}'")
    return CellLayerReader(layer_path)


@router.get("/{dataset}/files")
def list_layer_files(dataset: str):
    """List candidate cell-layer Parquet files in the dataset folder."""
    path = DATA_ROOT / dataset
    if not path.exists():
        raise HTTPException(404, f"Dataset '{dataset}' not found")
    return {"files": [f.name for f in path.glob("*.parquet")]}


@router.get("/{dataset}/schema")
def layer_schema(dataset: str, layer_file: str = Query("cell_layers.parquet")):
    """Return column names and dtypes."""
    return _reader(dataset, layer_file).schema()


@router.get("/{dataset}/column-summary")
def column_summary(dataset: str, column: str, layer_file: str = Query("cell_layers.parquet")):
    """Return distinct values (categorical) or min/max/mean (numeric) for a column."""
    return _reader(dataset, layer_file).column_summary(column)


@router.get("/{dataset}/values")
def cell_values(
    dataset: str,
    column: str,
    layer_file: str = Query("cell_layers.parquet"),
    cell_ids: Optional[list[str]] = Query(None),
):
    """
    Return {cell_id: value} mapping for a given column.
    Optionally restrict to a list of cell_ids.
    """
    return _reader(dataset, layer_file).values(column, cell_ids=cell_ids)
