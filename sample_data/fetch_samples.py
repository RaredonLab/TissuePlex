#!/usr/bin/env python3
"""Fetch the larger TissuePlex demo datasets into sample_data/.

Four small datasets are committed to the repository. The real, larger ones are
too big for git and are attached to the v1.0.0 GitHub release instead. This
script downloads them, verifies their SHA-256 checksums, and unpacks each into
its own folder beside this file, where `docker compose up` (which mounts
sample_data/ as /data) and the dev backend (DATA_ROOT=../sample_data) find them.

    python3 sample_data/fetch_samples.py            # fetch every dataset
    python3 sample_data/fetch_samples.py --list     # show what is available
    python3 sample_data/fetch_samples.py --only xenium_human_breast_2fov
    python3 sample_data/fetch_samples.py --dest /path/to/datasets

Each unpacked folder contains a PROVENANCE.md naming the original source, its
licence, and exactly what was trimmed or added. The datasets are redistributed
under their own licences, not TissuePlex's MIT licence; the CosMx set in
particular is for non-commercial use only (its licence PDF is in the folder).

Standard library only; no third-party packages needed.
"""
from __future__ import annotations

import argparse
import hashlib
import shutil
import sys
import tempfile
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

RELEASE_TAG = "v1.0.0"
RELEASE_BASE = f"https://github.com/RaredonLab/TissuePlex/releases/download/{RELEASE_TAG}"

# name -> metadata. `sha256` is of the zip asset; `size_mb` is the download size.
MANIFEST = {
    "xenium_human_breast_2fov": {
        "platform": "Xenium (10x Genomics)",
        "summary": "10x 'Human Breast 2 FOV' example run: 7,275 cells, DAPI morphology, NICHESv2 edges",
        "licence": "CC BY 4.0 (10x Genomics)",
        "size_mb": 290,
        "sha256": "06fda6529e91cef5e696e38442c277d5f63e5e763baeea0d8508bb84ecc44d82",
    },
    "visium_mouse_kidney": {
        "platform": "Visium (10x Genomics)",
        "summary": "10x 'Mouse Kidney: Coronal Section': 1,438 spots in tissue, NICHESv2 spot-spot edges",
        "licence": "CC BY 4.0 (10x Genomics)",
        "size_mb": 39,
        "sha256": "0afeb534aca76937ba49ea04a219a3d9f7e01c11db4621bea37fe9a9cb26307d",
    },
    "cosmx-mousebrain": {
        "platform": "CosMx (Bruker / NanoString)",
        "summary": "1000-plex mouse brain FFPE via the OSTA project: 38,996 cells, no image, NICHESv2 edges",
        "licence": "Bruker Spatial Biology non-commercial data licence (PDF included)",
        "size_mb": 58,
        "sha256": "d0481270cc3695e8491b03b0c626e56e0226d3157ef4f3ebdbdb76a47bf7c575",
    },
}

CHUNK = 1 << 20


def _human(n: float) -> str:
    return f"{n / 1e6:.0f} MB" if n >= 1e6 else f"{n / 1e3:.0f} kB"


def _download(url: str, dest: Path) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": "TissuePlex-fetch_samples"})
    with urllib.request.urlopen(req) as r, open(dest, "wb") as out:
        total = int(r.headers.get("Content-Length") or 0)
        done = 0
        while True:
            buf = r.read(CHUNK)
            if not buf:
                break
            out.write(buf)
            done += len(buf)
            if total:
                sys.stdout.write(f"\r  {_human(done)} / {_human(total)} ({100 * done // total}%)")
            else:
                sys.stdout.write(f"\r  {_human(done)}")
            sys.stdout.flush()
    sys.stdout.write("\n")


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for buf in iter(lambda: f.read(CHUNK), b""):
            h.update(buf)
    return h.hexdigest()


def _extract(zip_path: Path, dest_root: Path, name: str) -> None:
    """Unpack into dest_root/name, refusing any member that would land elsewhere."""
    target = (dest_root / name).resolve()
    with zipfile.ZipFile(zip_path) as z:
        for info in z.infolist():
            member = (dest_root / info.filename).resolve()
            if member != target and target not in member.parents:
                raise RuntimeError(f"refusing to extract {info.filename!r}: escapes {name}/")
        z.extractall(dest_root)


def fetch(name: str, dest_root: Path, force: bool, keep_zip: bool) -> bool:
    meta = MANIFEST[name]
    folder = dest_root / name
    if folder.exists() and not force:
        marker = folder / "PROVENANCE.md"
        state = "already present" if marker.exists() else "folder exists (not from this script)"
        print(f"- {name}: {state}; skipping (use --force to replace)")
        return True

    url = f"{RELEASE_BASE}/{name}.zip"
    print(f"- {name}  [{meta['platform']}]  {meta['licence']}")
    print(f"  {url}")
    with tempfile.TemporaryDirectory(prefix="tissueplex-fetch-") as tmp:
        zip_path = Path(tmp) / f"{name}.zip"
        try:
            _download(url, zip_path)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                print(f"  not found (HTTP 404). The release '{RELEASE_TAG}' or its asset "
                      f"'{name}.zip' is not published; see docs/public_datasets.md for the "
                      f"original sources.")
            else:
                print(f"  download failed: HTTP {e.code} {e.reason}")
            return False
        except (urllib.error.URLError, OSError) as e:
            print(f"  download failed: {e}")
            return False

        digest = _sha256(zip_path)
        if meta["sha256"] and digest != meta["sha256"]:
            print(f"  checksum mismatch — expected {meta['sha256'][:16]}…, got {digest[:16]}…; "
                  f"not unpacking")
            return False
        if not meta["sha256"]:
            print(f"  (no checksum recorded for this asset; sha256 {digest[:16]}…)")

        if folder.exists():
            shutil.rmtree(folder)
        _extract(zip_path, dest_root, name)
        if keep_zip:
            shutil.copy2(zip_path, dest_root / f"{name}.zip")
    print(f"  unpacked to {folder}")
    return True


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--list", action="store_true", help="list the datasets and exit")
    ap.add_argument("--only", nargs="+", metavar="NAME", help="fetch only these datasets")
    ap.add_argument("--dest", type=Path, default=Path(__file__).resolve().parent,
                    help="parent folder to unpack into (default: this sample_data/ folder)")
    ap.add_argument("--force", action="store_true", help="re-download and replace existing folders")
    ap.add_argument("--keep-zip", action="store_true", help="also keep the downloaded zip")
    args = ap.parse_args(argv)

    if args.list:
        for name, m in MANIFEST.items():
            size = f"{m['size_mb']} MB" if m["size_mb"] else "?"
            print(f"{name:28s} {m['platform']:28s} {size:>8s}  {m['licence']}")
            print(f"{'':28s} {m['summary']}")
        return 0

    names = args.only or list(MANIFEST)
    unknown = [n for n in names if n not in MANIFEST]
    if unknown:
        print(f"unknown dataset(s): {', '.join(unknown)}; try --list", file=sys.stderr)
        return 2

    args.dest.mkdir(parents=True, exist_ok=True)
    print(f"Fetching into {args.dest}\n")
    ok = all([fetch(n, args.dest, args.force, args.keep_zip) for n in names])
    print("\nDone." if ok else "\nSome datasets were not fetched.")
    if ok:
        print("Restart the app (docker compose up) and the new datasets appear in the dataset menu.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
