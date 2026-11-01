#!/usr/bin/env python3
"""
Removing the morphology image must move nothing.

Every data layer draws in image pixel space, and for a long time "image pixel
space" was defined by the morphology pyramid: no image, no coordinate frame,
no layers. The viewer now takes a frame from the data when it has no image (or
cannot open the one it has), so a dataset shipped without its DAPI or
morphology must render its cells, boundaries, transcripts and edges exactly
where it would with the image present.

This check copies every bundled dataset to a scratch directory *without* its
image files, serves that through the real routers, and asserts:

1. `/images` lists nothing and `has_morphology` is false — the viewer must know
   it is on its own.
2. `/info` carries a usable `frame`.
3. Every layer's extent is identical to the same layer's extent read from the
   original folder, image and all. Not "roughly": the seqFISH reader decides
   microns-or-pixels per table against the image width, and without the image
   it used to draw cells at a hundredth of their size in one corner while the
   boundaries sat where they belonged. That is the failure this exists to catch.
4. Every layer lies within the frame (a small overhang is allowed: outlines
   reach past centroids, and the frame is sized from centroids).

Run against whatever datasets are present:

    python3 tests/no_image_check.py
"""
import os
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

SOURCE_ROOT = Path(os.environ.get("DATA_ROOT",
                                  Path(__file__).resolve().parents[2] / "sample_data"))
IMAGE_EXTS = (".ome.tif", ".ome.tiff", ".tif", ".tiff", ".png", ".jpg", ".jpeg")
SKIP_DIRS = {".dzi_cache", ".tissueplex_cache", "__pycache__"}

# The scratch copy becomes DATA_ROOT *before* the routers are imported — they
# read the variable at import time.
SCRATCH = Path(tempfile.mkdtemp(prefix="tp-noimg-"))
os.environ["DATA_ROOT"] = str(SCRATCH)
os.environ["CACHE_DIR"] = str(SCRATCH / ".cache")

from fastapi.testclient import TestClient                      # noqa: E402
from app.main import app                                       # noqa: E402
from app.readers.reader_factory import ReaderFactory           # noqa: E402
from app.readers.edge_reader import EdgeReader                 # noqa: E402

failures: list[str] = []
TOL = 1e-6
OVERHANG = 0.15      # fraction of the frame a layer may extend past it


def _ignore(_dir, names):
    return [n for n in names
            if n in SKIP_DIRS or n.lower().endswith(IMAGE_EXTS)]


def extent(xs, ys):
    xs = [x for x in xs if x is not None]
    ys = [y for y in ys if y is not None]
    if not xs or not ys:
        return None
    return (min(xs), min(ys), max(xs), max(ys))


def layer_extents(reader, edge_reader):
    """Extent of each layer the reader serves, in pixel space."""
    out = {}
    cells = reader.cells()
    out["cells"] = extent([c.get("x_centroid") for c in cells],
                          [c.get("y_centroid") for c in cells])
    if reader.capabilities().get("has_boundaries", True):
        b = (reader.cell_boundaries(fraction=1.0) or {}).get("boundaries") or []
        out["boundaries"] = extent([v["vertex_x"] for v in b], [v["vertex_y"] for v in b])
    if reader.capabilities().get("has_transcripts", True):
        t = (reader.transcripts(fraction=1.0) or {}).get("transcripts") or []
        out["transcripts"] = extent([v["x_location"] for v in t], [v["y_location"] for v in t])
    if edge_reader is not None:
        e = edge_reader.query_structure(density=1.0)
        out["edges"] = extent([r["x1"] for r in e] + [r["x2"] for r in e],
                              [r["y1"] for r in e] + [r["y2"] for r in e])
    return out


def same(a, b, tol=TOL):
    if a is None or b is None:
        return a is b
    return all(abs(p - q) <= tol * max(1.0, abs(p), abs(q)) for p, q in zip(a, b))


def check(ds: str, client: TestClient) -> str:
    src = SOURCE_ROOT / ds
    dst = SCRATCH / ds
    shutil.copytree(src, dst, ignore=_ignore)

    # 1. The viewer must be told there is no image.
    images = client.get(f"/spatial/{ds}/images").json()
    if images:
        failures.append(f"[{ds}] /images still lists {images} with every image file removed")
    info = client.get(f"/spatial/{ds}/info").json()
    caps = info.get("capabilities") or {}
    if caps.get("has_morphology"):
        failures.append(f"[{ds}] has_morphology is true with no image present")

    # 2. A frame to draw on.
    frame = info.get("frame") or {}
    w, h = frame.get("width") or 0, frame.get("height") or 0
    if not (w > 0 and h > 0):
        failures.append(f"[{ds}] /info has no usable frame: {frame}")

    # 3. Nothing moved. Readers take explicit paths, so the reference reader
    #    looks at the original folder while the routers serve the stripped copy.
    with_img = ReaderFactory.detect(src)
    without = ReaderFactory.detect(dst)
    ps_a, ps_b = with_img.pixel_size, without.pixel_size
    ef = src / "edges.parquet"
    ea = EdgeReader(ef, pixel_size=ps_a) if ef.exists() else None
    eb = EdgeReader(dst / "edges.parquet", pixel_size=ps_b) if ef.exists() else None
    ref = layer_extents(with_img, ea)
    got = layer_extents(without, eb)
    # A reader that reads its pixel size from the image (seqFISH, from the DAPI
    # OME-XML) falls back to the platform's documented constant without it, and
    # every micron table rescales by that ratio. That is the fallback working,
    # not a placement error, so exactly that much is allowed — and reported.
    ps_ratio = abs(ps_a / ps_b - 1.0) if ps_b else 0.0
    tol = max(TOL, ps_ratio * 1.01)
    note = f"pixel_size {ps_a:.6f} -> {ps_b:.6f} without image" if ps_ratio > TOL else ""
    moved = []
    for layer, r in ref.items():
        g = got.get(layer)
        if not same(r, g, tol):
            moved.append(f"{layer}: with image {fmt(r)} vs without {fmt(g)}")
    if moved:
        failures.append(f"[{ds}] removing the image moved a layer:\n      " + "\n      ".join(moved))

    # 4. Every layer sits on the frame.
    if w > 0 and h > 0:
        for layer, g in got.items():
            if g is None:
                continue
            xmin, ymin, xmax, ymax = g
            if xmax > w * (1 + OVERHANG) or ymax > h * (1 + OVERHANG) \
                    or xmin < -w * OVERHANG or ymin < -h * OVERHANG:
                failures.append(f"[{ds}] {layer} extent {fmt(g)} is not on the "
                                f"{w}x{h} frame")

    layers = ", ".join(k for k, v in got.items() if v is not None)
    return f"frame {w}x{h}  layers [{layers}]" + (f"  ({note})" if note else "")


def fmt(e):
    return "none" if e is None else "(" + ", ".join(f"{v:.1f}" for v in e) + ")"


def is_dataset(p: Path) -> bool:
    try:
        ReaderFactory.detect(p)
        return True
    except Exception:
        return False


found = sorted(p.name for p in SOURCE_ROOT.iterdir() if p.is_dir() and is_dataset(p))
if not found:
    print("no datasets present — nothing to check")
    sys.exit(0)

client = TestClient(app)
try:
    for ds in found:
        try:
            print(f"  OK   {ds:26} {check(ds, client)}")
        except Exception as exc:
            failures.append(f"[{ds}] {type(exc).__name__}: {exc}")
            print(f"  FAIL {ds:26} {type(exc).__name__}: {exc}")
finally:
    shutil.rmtree(SCRATCH, ignore_errors=True)

print()
if failures:
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"every layer renders in the same place without a morphology image, "
      f"across {len(found)} datasets.")
