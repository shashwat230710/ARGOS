"""Land polygons: Natural Earth if reachable, else rasterized mask polygons."""

from __future__ import annotations

import json
import urllib.request
from pathlib import Path

import numpy as np

from polarroute.config import PROCESSED_DIR
from polarroute.grid import load_meta


NE_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_land.geojson"


def _from_natural_earth(path: Path) -> bool:
    try:
        urllib.request.urlretrieve(NE_URL, path.with_suffix(".full.geojson"))
    except Exception as exc:
        print("Natural Earth download failed:", exc)
        return False
    raw = json.loads(path.with_suffix(".full.geojson").read_text(encoding="utf-8"))
    feats = []
    for f in raw.get("features", []):
        geom = f.get("geometry") or {}
        coords = geom.get("coordinates")
        if not coords:
            continue
        # keep features that intersect the southern hemisphere
        blob = json.dumps(coords)
        if "-4" in blob or "-5" in blob or "-6" in blob or "-7" in blob or "-8" in blob or "-9" in blob:
            feats.append(f)
    out = {"type": "FeatureCollection", "features": feats, "name": "Natural Earth 110m land (subset)"}
    path.write_text(json.dumps(out), encoding="utf-8")
    return True


def _from_raster() -> None:
    meta = load_meta()
    land = np.load(PROCESSED_DIR / "land.npy")
    x = np.load(PROCESSED_DIR / "x.npy")
    y = np.load(PROCESSED_DIR / "y.npy")
    dx = float(x[1] - x[0]) / 2
    dy = float(y[0] - y[1]) / 2  # y descending
    feats = []
    H, W = land.shape
    step = 2
    for r in range(0, H, step):
        for c in range(0, W, step):
            if land[r, c] == 0:
                continue
            cx, cy = float(x[c]), float(y[r])
            poly = [
                [cx - dx * step, cy - dy * step],
                [cx + dx * step, cy - dy * step],
                [cx + dx * step, cy + dy * step],
                [cx - dx * step, cy + dy * step],
                [cx - dx * step, cy - dy * step],
            ]
            feats.append(
                {
                    "type": "Feature",
                    "properties": {},
                    "geometry": {"type": "Polygon", "coordinates": [poly]},
                }
            )
    geo = {
        "type": "FeatureCollection",
        "crs": {"type": "name", "properties": {"name": "EPSG:3412"}},
        "features": feats,
        "name": "land mask polygons (EPSG:3412)",
    }
    (PROCESSED_DIR / "land.geojson").write_text(json.dumps(geo), encoding="utf-8")
    (PROCESSED_DIR / "land_crs.txt").write_text("EPSG:3412", encoding="utf-8")


def run() -> None:
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    dest = PROCESSED_DIR / "land.geojson"
    if _from_natural_earth(dest):
        print("land from Natural Earth 110m ->", dest)
        return
    _from_raster()
    print("land from raster mask ->", dest)


if __name__ == "__main__":
    run()
