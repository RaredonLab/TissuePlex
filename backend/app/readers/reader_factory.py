"""
Platform auto-detection and reader instantiation.

Detection is based on the presence of platform-specific sentinel files in the
dataset directory.  Priority order matters when files from multiple platforms
could theoretically co-exist in one folder (unlikely in practice).
"""
from pathlib import Path

from app.readers.base_reader import SpatialDatasetReader


# Ordered list of (detector_fn, reader_import_path) pairs.
# Each detector takes a Path and returns True if it recognises the platform.
_DETECTORS: list[tuple] = []


def _register(detect_fn, reader_fn):
    _DETECTORS.append((detect_fn, reader_fn))


def _is_xenium(path: Path) -> bool:
    return (path / "experiment.xenium").exists()


def _is_merscope(path: Path) -> bool:
    return (
        (path / "cell_by_gene.csv").exists() or
        (path / "cell_metadata.csv").exists()
    )


def _is_cosmx(path: Path) -> bool:
    return any(path.glob("*_tx_file.csv"))


def _make_xenium(path: Path) -> SpatialDatasetReader:
    from app.readers.xenium_reader import XeniumReader
    return XeniumReader(path)


def _make_merscope(path: Path) -> SpatialDatasetReader:
    from app.readers.merscope_reader import MerscopeReader
    return MerscopeReader(path)


def _make_cosmx(path: Path) -> SpatialDatasetReader:
    from app.readers.cosmx_reader import CosMxReader
    return CosMxReader(path)


_register(_is_xenium, _make_xenium)
_register(_is_merscope, _make_merscope)
_register(_is_cosmx, _make_cosmx)


class ReaderFactory:

    @staticmethod
    def detect(path: Path) -> SpatialDatasetReader:
        """Instantiate the appropriate reader for the given dataset directory.
        Raises ValueError if no platform is recognised."""
        for detect, make in _DETECTORS:
            if detect(path):
                return make(path)
        raise ValueError(
            f"Cannot detect spatial platform for '{path.name}'. "
            "Expected one of: experiment.xenium (Xenium), "
            "cell_by_gene.csv / cell_metadata.csv (MERSCOPE), "
            "*_tx_file.csv (CosMx)."
        )

    @staticmethod
    def is_dataset(path: Path) -> bool:
        """Return True if the directory looks like a supported spatial dataset."""
        return any(detect(path) for detect, _ in _DETECTORS)

    @staticmethod
    def supported_platforms() -> list[str]:
        """Names of all registered platforms, in detection-priority order."""
        # Instantiate a dummy to get the name — avoid importing all readers
        return ["xenium", "merscope", "cosmx"]
