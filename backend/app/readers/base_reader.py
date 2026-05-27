"""
Abstract base class for spatial transcriptomics dataset readers.

Each concrete reader handles one platform's output format and is responsible
for normalizing all coordinates to image pixel space before returning data.
The router layer is platform-agnostic — it only calls the methods defined here.
"""
import math
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Optional

import pandas as pd


class SpatialDatasetReader(ABC):
    """
    Interface every platform reader must satisfy.

    Coordinate contract
    -------------------
    All coordinates returned to the API are in **image pixel space**:
      native_coord / pixel_size → pixel_coord
    Each reader is responsible for this conversion internally.  The frontend
    always receives pixel coordinates and never needs to know the native unit.
    """

    def __init__(self, dataset_path: Path):
        self.path = dataset_path

    # ── Identity ──────────────────────────────────────────────────────────────

    @property
    @abstractmethod
    def platform(self) -> str:
        """Short lowercase platform identifier, e.g. 'xenium', 'merscope', 'cosmx'."""
        ...

    @property
    @abstractmethod
    def pixel_size(self) -> float:
        """Native coordinate units per image pixel (e.g. µm/px).
        Used to convert native → pixel space: pixel = native / pixel_size."""
        ...

    # ── Experiment metadata ───────────────────────────────────────────────────

    @abstractmethod
    def info(self) -> dict:
        """Experiment-level metadata as a JSON-serializable dict.
        Must include at minimum: {'platform': self.platform}."""
        ...

    # ── Gene catalogue ────────────────────────────────────────────────────────

    @abstractmethod
    def gene_list(self) -> list[str]:
        """All assayed gene names, excluding controls and blanks."""
        ...

    # ── Spatial data ──────────────────────────────────────────────────────────

    @abstractmethod
    def transcripts(
        self,
        bbox: Optional[tuple] = None,
        genes: Optional[list[str]] = None,
        fraction: float = 1.0,
    ) -> dict:
        """Transcript records in pixel space.
        Returns {"transcripts": list[dict], "total": int} where total is the
        pre-sample count after bbox/gene filtering.
        Required keys per record: x_location, y_location, feature_name."""
        ...

    @abstractmethod
    def cells(self, bbox: Optional[tuple] = None) -> list[dict]:
        """Cell records in pixel space.
        Required keys: cell_id, x_centroid, y_centroid."""
        ...

    @abstractmethod
    def cells_schema(self) -> dict:
        """Column names and dtype strings: {'columns': {col: dtype_str, ...}}."""
        ...

    @abstractmethod
    def cell_boundaries(
        self,
        bbox: Optional[tuple] = None,
        limit: int = 20_000,
    ) -> list[dict]:
        """Boundary vertex records in pixel space.
        Required keys: cell_id, vertex_x, vertex_y."""
        ...

    @abstractmethod
    def cell_detail(self, cell_id: str) -> Optional[dict]:
        """Full metadata + expression for one cell, or None if not found.
        Must include an 'expression' key: {gene: count}."""
        ...

    @abstractmethod
    def cell_expression(self, cell_id: str) -> dict:
        """Non-zero gene expression counts for one cell: {gene: count}."""
        ...

    @abstractmethod
    def color_values(
        self,
        mode: str,
        field: Optional[str] = None,
        genes: Optional[list[str]] = None,
    ) -> dict:
        """Per-cell values for coloring.
        Returns one of:
          {type:'continuous', values:{cell_id:float}, min:float, max:float}
          {type:'categorical', values:{cell_id:str},  categories:[str,...]}
        """
        ...

    # ── Platform capabilities ─────────────────────────────────────────────────

    def capabilities(self) -> dict:
        """Platform capability flags consumed by the frontend to show/hide layers.

        Defaults represent a fully-featured imaging-based platform.  Override in
        readers that lack specific capabilities (e.g. spot-based platforms with
        no per-molecule transcript coordinates or no polygon boundaries).

        Keys
        ----
        has_morphology  : bool  — dataset includes a tile-able morphology image
        has_transcripts : bool  — individual molecule/transcript detections are available
        has_boundaries  : bool  — polygon cell/spot boundary vertices are available
        unit_label      : str   — display name for spatial units ("cell", "spot", "bin")
        """
        return {
            "has_morphology": True,
            "has_transcripts": True,
            "has_boundaries": True,
            "unit_label": "cell",
        }

    # ── Shared utilities ──────────────────────────────────────────────────────

    def _to_px(self, val: float) -> float:
        """Convert one native coordinate to pixel space."""
        return val / self.pixel_size

    def _bbox_to_native(self, bbox: tuple) -> tuple:
        """Convert an image-pixel bounding box to native coordinate space."""
        xmin, ymin, xmax, ymax = bbox
        ps = self.pixel_size
        return xmin * ps, ymin * ps, xmax * ps, ymax * ps

    @staticmethod
    def _to_records(df: pd.DataFrame) -> list[dict]:
        """Convert a DataFrame to JSON-safe records (NaN/Inf → None)."""
        return [
            {k: (None if isinstance(v, float) and not math.isfinite(v) else v)
             for k, v in row.items()}
            for row in df.to_dict(orient="records")
        ]
