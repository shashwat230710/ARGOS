"""Crop NSIDC south polar grid to the Indian-Ocean / East Antarctica corridor."""

from __future__ import annotations

import json
from datetime import date

import numpy as np
from pyproj import Transformer

from polarroute.config import (
    BHARATI,
    CAPE_TOWN,
    CELL_M,
    CROP_H,
    CROP_W,
    ICE_ENTRY,
    MAITRI,
    PROCESSED_DIR,
)


def transformer() -> Transformer:
    return Transformer.from_crs("EPSG:4326", "EPSG:3412", always_xy=True)


def lonlat_to_xy(lon: float, lat: float) -> tuple[float, float]:
    x, y = transformer().transform(lon, lat)
    return float(x), float(y)


def compute_crop_slices(x: np.ndarray, y: np.ndarray) -> dict:
    """Return slices that yield CROP_H x CROP_W covering ~10W-90E, 55S-78S."""
    t = transformer()
    lons = np.linspace(-10, 90, 400)
    lats = np.linspace(-55, -78, 400)
    xx, yy = np.meshgrid(lons, lats)
    cx, cy = t.transform(xx, yy)
    ix0 = int(np.argmin(np.abs(x - cx.min())))
    ix1 = ix0 + CROP_W
    if ix1 > x.size:
        ix0 = x.size - CROP_W
        ix1 = x.size
    # y is descending in G02202
    iy_north = int(np.argmin(np.abs(y - cy.max())))
    iy0 = max(0, iy_north - 3)  # a few extra rows of open ocean
    iy1 = iy0 + CROP_H
    if iy1 > y.size:
        iy0 = y.size - CROP_H
        iy1 = y.size
    return {
        "iy0": iy0,
        "iy1": iy1,
        "ix0": ix0,
        "ix1": ix1,
        "xmin": float(x[ix0] - CELL_M / 2),
        "xmax": float(x[ix1 - 1] + CELL_M / 2),
        "ymax": float(y[iy0] + CELL_M / 2),
        "ymin": float(y[iy1 - 1] - CELL_M / 2),
    }


def xy_to_index(x_m: float, y_m: float, x: np.ndarray, y: np.ndarray) -> tuple[int, int]:
    ix = int(np.argmin(np.abs(x - x_m)))
    iy = int(np.argmin(np.abs(y - y_m)))
    return iy, ix


def station_indices(x: np.ndarray, y: np.ndarray) -> dict:
    out = {}
    for name, (lon, lat) in {
        "cape_town": CAPE_TOWN,
        "ice_entry": ICE_ENTRY,
        "bharati": BHARATI,
        "maitri": MAITRI,
    }.items():
        xm, ym = lonlat_to_xy(lon, lat)
        iy, ix = xy_to_index(xm, ym, x, y)
        out[name] = {
            "lon": lon,
            "lat": lat,
            "x_m": xm,
            "y_m": ym,
            "row": iy,
            "col": ix,
            "in_grid": 0 <= iy < y.size and 0 <= ix < x.size,
        }
    return out


def read_sic_array(ds) -> np.ndarray:
    """Return SIC in [0,1] with NaN → 0."""
    da = ds["cdr_seaice_conc"]
    arr = da.values.astype(np.float32)
    if arr.max() > 1.5:
        arr = arr / 100.0
    arr = np.nan_to_num(arr, nan=0.0)
    return np.clip(arr, 0.0, 1.0)


def save_meta(meta: dict) -> None:
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    (PROCESSED_DIR / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")


def load_meta() -> dict:
    return json.loads((PROCESSED_DIR / "meta.json").read_text(encoding="utf-8"))


def iso_to_date(s: str) -> date:
    return date.fromisoformat(s[:10])
