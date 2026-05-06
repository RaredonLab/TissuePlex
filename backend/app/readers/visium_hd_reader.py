"""
10x Genomics Visium HD reader.

Visium HD produces square bin-level data at 2 µm, 8 µm, and 16 µm resolution.
Bins are arranged on a regular grid; there are no per-molecule transcript
coordinates (only spot/bin-level UMI counts).

Expected directory layout
-------------------------
  dataset_dir/
    square_002um/            ← primary resolution (or square_008um / square_016um)
      spatial/
        tissue_positions.parquet   ← barcode, pxl_row_in_fullres, pxl_col_in_fullres
      filtered_feature_bc_matrix.h5
    spatial/
      tissue_hires_image.png       ← H&E morphology image
      scalefactors_json.json       ← contains tissue_hires_scalef

Detection sentinel: any square_???um/ subdirectory.

STATUS: This reader is a stub.  The cell/spot data methods are implemented for
tissue_positions.parquet; gene expression and morphology image handling are not
yet wired in.  Contributions welcome.
"""
from pathlib import Path
from typing import Optional
import math

import pandas as pd

from app.readers.base_reader import SpatialDatasetReader

# Default pixel size for Visium HD 2 µm bins (square_002um).
# The actual value should be read from scalefactors_json.json.
_DEFAULT_PIXEL_SIZE = 1.0  # coordinates in tissue_positions are already in pixels


class VisiumHDReader(SpatialDatasetReader):

    @property
    def platform(self) -> str:
        return "visium_hd"

    @property
    def pixel_size(self) -> float:
        # tissue_positions.parquet already stores pixel coordinates relative to
        # the full-resolution image, so no unit conversion is needed.
        return _DEFAULT_PIXEL_SIZE

    def _bin_dir(self) -> Optional[Path]:
        """Return the highest-resolution square_???um directory present."""
        for res in ("square_002um", "square_008um", "square_016um"):
            p = self.path / res
            if p.is_dir():
                return p
        return None

    def _tissue_positions(self) -> pd.DataFrame:
        bin_dir = self._bin_dir()
        if bin_dir is None:
            return pd.DataFrame()
        pos_file = bin_dir / "spatial" / "tissue_positions.parquet"
        if not pos_file.exists():
            # Fallback to CSV for older Visium HD outputs
            csv = bin_dir / "spatial" / "tissue_positions.csv"
            if csv.exists():
                return pd.read_csv(csv)
            return pd.DataFrame()
        return pd.read_parquet(pos_file)

    # ── Experiment metadata ───────────────────────────────────────────────────

    def info(self) -> dict:
        return {
            "platform": self.platform,
            "pixel_size": self.pixel_size,
        }

    def capabilities(self) -> dict:
        return {
            "has_morphology": (self.path / "spatial" / "tissue_hires_image.png").exists(),
            "has_transcripts": False,   # bin-level counts only, no per-molecule locations
            "has_boundaries": False,    # square bins rendered as points, not polygons
            "unit_label": "bin",
        }

    # ── Gene catalogue ────────────────────────────────────────────────────────

    def gene_list(self) -> list[str]:
        # TODO: read from filtered_feature_bc_matrix.h5
        return []

    # ── Spatial data ──────────────────────────────────────────────────────────

    def transcripts(self, bbox=None, genes=None, limit=50_000) -> list[dict]:
        # Visium HD has no per-molecule transcript locations.
        return []

    def cells(self, bbox: Optional[tuple] = None) -> list[dict]:
        df = self._tissue_positions()
        if df.empty:
            return []
        # Standard tissue_positions columns
        x_col = "pxl_col_in_fullres"
        y_col = "pxl_row_in_fullres"
        if x_col not in df.columns or y_col not in df.columns:
            return []
        df = df.rename(columns={x_col: "x_centroid", y_col: "y_centroid"})
        df = df.rename(columns={"barcode": "cell_id"}) if "barcode" in df.columns else df
        if "in_tissue" in df.columns:
            df = df[df["in_tissue"] == 1]
        if bbox:
            xmin, ymin, xmax, ymax = bbox
            df = df[
                (df["x_centroid"] >= xmin) & (df["x_centroid"] <= xmax) &
                (df["y_centroid"] >= ymin) & (df["y_centroid"] <= ymax)
            ]
        return self._to_records(df[["cell_id", "x_centroid", "y_centroid"]].copy())

    def cells_schema(self) -> dict:
        return {"columns": {"cell_id": "string", "x_centroid": "double", "y_centroid": "double"}}

    def cell_boundaries(self, bbox=None, limit=20_000) -> list[dict]:
        # Square bins are rendered as points; no polygon boundaries.
        return []

    def cell_detail(self, cell_id: str) -> Optional[dict]:
        df = self._tissue_positions()
        if df.empty:
            return None
        row = df[df.get("barcode", df.index) == cell_id]
        if row.empty:
            return None
        rec = row.iloc[0].to_dict()
        rec["expression"] = {}
        return rec

    def cell_expression(self, cell_id: str) -> dict:
        # TODO: read from H5 feature matrix
        return {}

    def color_values(self, mode: str, field=None, genes=None) -> dict:
        return {"type": "continuous", "values": {}, "min": 0, "max": 0}
