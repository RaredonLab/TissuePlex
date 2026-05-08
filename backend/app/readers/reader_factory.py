"""
Platform auto-detection and reader instantiation.

Detection is based on the presence of platform-specific sentinel files in the
dataset directory.  Priority order matters when files from multiple platforms
could theoretically co-exist in one folder (unlikely in practice).

Supported platforms (detection order):
  Xenium (10x Genomics)  — experiment.xenium
  Visium HD (10x Genomics) — square_???um/ subdirectory
  MERSCOPE (Vizgen)      — cell_by_gene.csv or cell_metadata.csv
  CosMx (Nanostring)     — *_tx_file.csv

To add a new platform: define a detector function, a factory function, and
call _register(detector, factory) below.
"""
from pathlib import Path

from app.readers.base_reader import SpatialDatasetReader

# Sentinel descriptions used in the "unrecognised platform" error message.
_SENTINEL_DESCRIPTIONS: list[tuple[str, str]] = []

# Ordered list of (detector_fn, reader_factory_fn) pairs.
_DETECTORS: list[tuple] = []


def _register(detect_fn, reader_fn, sentinel_desc: str):
    _DETECTORS.append((detect_fn, reader_fn))
    _SENTINEL_DESCRIPTIONS.append((reader_fn.__name__, sentinel_desc))


# ── Detectors ─────────────────────────────────────────────────────────────────

def _is_xenium(path: Path) -> bool:
    return (path / "experiment.xenium").exists()


def _is_visium_hd(path: Path) -> bool:
    return any(path.glob("square_???um"))


def _is_merscope(path: Path) -> bool:
    return (
        (path / "cell_by_gene.csv").exists() or
        (path / "cell_metadata.csv").exists()
    )


def _is_cosmx(path: Path) -> bool:
    return any(path.glob("*_tx_file.csv"))


# ── Factories ─────────────────────────────────────────────────────────────────

def _make_xenium(path: Path) -> SpatialDatasetReader:
    from app.readers.xenium_reader import XeniumReader
    return XeniumReader(path)


def _make_visium_hd(path: Path) -> SpatialDatasetReader:
    from app.readers.visium_hd_reader import VisiumHDReader
    return VisiumHDReader(path)


def _make_merscope(path: Path) -> SpatialDatasetReader:
    from app.readers.merscope_reader import MerscopeReader
    return MerscopeReader(path)


def _make_cosmx(path: Path) -> SpatialDatasetReader:
    from app.readers.cosmx_reader import CosMxReader
    return CosMxReader(path)


_register(_is_xenium,    _make_xenium,    "experiment.xenium (Xenium / 10x)")
_register(_is_visium_hd, _make_visium_hd, "square_???um/ directory (Visium HD / 10x)")
_register(_is_merscope,  _make_merscope,  "cell_by_gene.csv or cell_metadata.csv (MERSCOPE / Vizgen)")
_register(_is_cosmx,     _make_cosmx,     "*_tx_file.csv (CosMx / Nanostring)")


class ReaderFactory:

    @staticmethod
    def detect(path: Path) -> SpatialDatasetReader:
        """Instantiate the appropriate reader for the given dataset directory.
        Raises ValueError if no platform is recognised."""
        for detect, make in _DETECTORS:
            if detect(path):
                return make(path)
        sentinels = "; ".join(desc for _, desc in _SENTINEL_DESCRIPTIONS)
        raise ValueError(
            f"Cannot detect spatial platform for '{path.name}'. "
            f"Expected one of: {sentinels}."
        )

    @staticmethod
    def is_dataset(path: Path) -> bool:
        """Return True if the directory looks like a supported spatial dataset."""
        return any(detect(path) for detect, _ in _DETECTORS)

    @staticmethod
    def supported_platforms() -> list[str]:
        """Names of all registered platforms, in detection-priority order."""
        return ["xenium", "visium_hd", "merscope", "cosmx"]
