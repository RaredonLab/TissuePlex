"""
OME-TIFF → DZI tile pyramid.

Two backends:
  1. pyvips  — fast, used in Docker (libvips installed in Dockerfile)
  2. tifffile + Pillow  — pure Python fallback for local dev without libvips

The OME-TIFF format stores pyramid levels internally; we read each level
directly rather than resampling from full resolution.

DZI level numbering: level 0 = 1×1, level max = full resolution.
OME level numbering: level 0 = full resolution, level n = most downsampled.
"""
import math
import os
import shutil
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Optional

import numpy as np
from PIL import Image

TILE_SIZE = 256
OVERLAP = 1
TILE_FORMAT = "jpeg"
JPEG_QUALITY = 85
DZI_CACHE_SUBDIR = ".dzi_cache"

# If CACHE_DIR is set (e.g. a writable Docker volume), tile pyramids are stored
# there as {CACHE_DIR}/{dataset_name}/{image_name}/ instead of inside the
# (potentially read-only) data folder.
_CACHE_DIR = os.getenv("CACHE_DIR")  # None means "write alongside the data"

# ──────────────────────────────────────────────────────────────────────────────
# Public API
# ──────────────────────────────────────────────────────────────────────────────

def ensure_pyramid(dataset_path: Path, image_name: str) -> dict:
    """Build DZI pyramid from the OME-TIFF if not already cached. Idempotent."""
    src = _find_source(dataset_path, image_name)
    if src is None:
        return {"status": "error", "message": f"Source image '{image_name}' not found"}

    out_dir = _pyramid_root(dataset_path, image_name)
    dzi_file = out_dir / f"{image_name}.dzi"
    if dzi_file.exists():
        return {"status": "ready", "path": str(dzi_file)}

    out_dir.mkdir(parents=True, exist_ok=True)

    try:
        _build_dzi_tifffile(src, out_dir, image_name)
        return {"status": "ready", "path": str(dzi_file)}
    except Exception as exc:
        shutil.rmtree(out_dir, ignore_errors=True)
        return {"status": "error", "message": str(exc)}


def get_dzi_descriptor(dataset_path: Path, image_name: str) -> dict:
    """Return the DZI descriptor as a dict (serialised to JSON by the router)."""
    dzi_file = _pyramid_root(dataset_path, image_name) / f"{image_name}.dzi"
    if not dzi_file.exists():
        raise FileNotFoundError(
            f"DZI not built for '{image_name}'. POST /tiles/{{dataset}}/build-pyramid/{image_name} first."
        )
    tree = ET.parse(dzi_file)
    root = tree.getroot()
    ns = "http://schemas.microsoft.com/deepzoom/2008"
    size_el = root.find(f"{{{ns}}}Size")
    return {
        "xmlns": ns,
        "Format": root.attrib.get("Format", TILE_FORMAT),
        "Overlap": int(root.attrib.get("Overlap", OVERLAP)),
        "TileSize": int(root.attrib.get("TileSize", TILE_SIZE)),
        "Size": {
            "Width": int(size_el.attrib["Width"]),
            "Height": int(size_el.attrib["Height"]),
        },
    }


def get_tile_path(
    dataset_path: Path, image_name: str, level: int, col: int, row: int, fmt: str
) -> Optional[Path]:
    tile = (
        _pyramid_root(dataset_path, image_name)
        / f"{image_name}_files"
        / str(level)
        / f"{col}_{row}.{fmt}"
    )
    return tile if tile.exists() else None


# ──────────────────────────────────────────────────────────────────────────────
# Internal helpers
# ──────────────────────────────────────────────────────────────────────────────

def _pyramid_root(dataset_path: Path, image_name: str) -> Path:
    if _CACHE_DIR:
        return Path(_CACHE_DIR) / dataset_path.name / image_name
    return dataset_path / DZI_CACHE_SUBDIR / image_name


def _find_source(dataset_path: Path, image_name: str) -> Optional[Path]:
    for ext in (".ome.tif", ".ome.tiff", ".tif", ".tiff"):
        candidate = dataset_path / f"{image_name}{ext}"
        if candidate.exists():
            return candidate
    return None


def _read_ome_as_uint8(tif_path: Path) -> tuple[list[np.ndarray], int, int]:
    """
    Return (pyramid_levels_as_uint8, full_width, full_height).

    Handles:
      ZYX  — max-intensity projection across Z
      CYX  — first channel only (DAPI / brightfield)
      YX   — used as-is

    uint16 values are contrast-normalised per level using the 2nd–98th
    percentile of level 0 (so all levels share the same LUT).
    """
    import tifffile

    with tifffile.TiffFile(tif_path) as tif:
        series = tif.series[0]
        full_shape = series.levels[0].shape  # e.g. (Z, Y, X) or (C, Y, X) or (Y, X)
        axes = series.axes  # e.g. "ZYX", "CYX", "YX"

        # Determine which axes are spatial vs. projection
        ax = axes.upper()

        def _read_level(lvl) -> np.ndarray:
            arr = lvl.asarray()
            # Collapse non-spatial leading dims
            if ax.startswith("Z") or ax.startswith("C"):
                # Z: MIP; C: first channel
                if ax.startswith("Z"):
                    arr = arr.max(axis=0)
                else:
                    arr = arr[0]
            elif len(arr.shape) == 3:
                arr = arr[0]
            return arr  # (Y, X), uint16 or uint8

        # Read level 0 to compute the normalisation LUT
        arr0 = _read_level(series.levels[0])
        if arr0.dtype == np.uint16:
            lo = float(np.percentile(arr0, 2))
            hi = float(np.percentile(arr0, 98))
            if hi <= lo:
                hi = lo + 1.0

        def _to_uint8(arr: np.ndarray) -> np.ndarray:
            if arr.dtype == np.uint8:
                return arr
            clipped = np.clip(arr.astype(np.float32), lo, hi)
            scaled = ((clipped - lo) / (hi - lo) * 255).astype(np.uint8)
            return scaled

        levels_u8 = []
        for lvl in series.levels:
            arr = _read_level(lvl)
            levels_u8.append(_to_uint8(arr))

        h, w = levels_u8[0].shape
        return levels_u8, w, h


def _build_dzi_tifffile(src: Path, out_dir: Path, image_name: str) -> None:
    """
    Generate DZI tile pyramid using tifffile + Pillow.
    Reads OME pyramid levels directly; no libvips required.
    """
    levels_u8, full_w, full_h = _read_ome_as_uint8(src)

    # Total DZI level count: 0 (1×1) … max_dzi_level (full res)
    max_dzi_level = math.ceil(math.log2(max(full_w, full_h)))

    tiles_root = out_dir / f"{image_name}_files"

    # Generate tiles for each DZI level
    for dzi_level in range(max_dzi_level + 1):
        level_w = max(1, math.ceil(full_w / 2 ** (max_dzi_level - dzi_level)))
        level_h = max(1, math.ceil(full_h / 2 ** (max_dzi_level - dzi_level)))

        # Pick the OME pyramid level whose resolution is ≥ the target
        img_arr = _pick_ome_level(levels_u8, full_w, full_h, level_w, level_h)

        # Resize to exact DZI dimensions if needed
        pil_img = Image.fromarray(img_arr, mode="L")
        if pil_img.width != level_w or pil_img.height != level_h:
            pil_img = pil_img.resize((level_w, level_h), Image.LANCZOS)

        # Tile the level
        level_dir = tiles_root / str(dzi_level)
        level_dir.mkdir(parents=True, exist_ok=True)

        n_cols = math.ceil(level_w / TILE_SIZE)
        n_rows = math.ceil(level_h / TILE_SIZE)

        for row in range(n_rows):
            for col in range(n_cols):
                x0 = col * TILE_SIZE - (OVERLAP if col > 0 else 0)
                y0 = row * TILE_SIZE - (OVERLAP if row > 0 else 0)
                x1 = min(x0 + TILE_SIZE + OVERLAP * 2, level_w)
                y1 = min(y0 + TILE_SIZE + OVERLAP * 2, level_h)
                x0 = max(x0, 0)
                y0 = max(y0, 0)

                tile = pil_img.crop((x0, y0, x1, y1))
                tile.save(
                    level_dir / f"{col}_{row}.{TILE_FORMAT}",
                    quality=JPEG_QUALITY,
                )

    # Write DZI descriptor
    dzi_xml = (
        f'<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<Image xmlns="http://schemas.microsoft.com/deepzoom/2008" '
        f'Format="{TILE_FORMAT}" Overlap="{OVERLAP}" TileSize="{TILE_SIZE}">\n'
        f'  <Size Width="{full_w}" Height="{full_h}"/>\n'
        f'</Image>\n'
    )
    (out_dir / f"{image_name}.dzi").write_text(dzi_xml)


def _pick_ome_level(
    levels_u8: list[np.ndarray],
    full_w: int,
    full_h: int,
    target_w: int,
    target_h: int,
) -> np.ndarray:
    """
    Return the OME pyramid level whose dimensions are closest to but
    at least as large as (target_w, target_h). Falls back to level 0.
    """
    n = len(levels_u8)
    for i in range(n - 1, -1, -1):
        arr = levels_u8[i]
        h, w = arr.shape
        # Scale factor relative to full res
        scale = 2 ** i  # OME level i is ~2^i downsampled
        approx_w = max(1, math.ceil(full_w / scale))
        approx_h = max(1, math.ceil(full_h / scale))
        if approx_w >= target_w and approx_h >= target_h:
            return arr
    return levels_u8[0]
