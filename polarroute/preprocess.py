"""Build cropped daily SIC arrays from downloaded G02202 files."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

import numpy as np
import xarray as xr

from polarroute.config import (
    ALL_YEARS,
    ANCILLARY_NAME,
    DATASET_DOI,
    DATASET_NAME,
    DEMO_DAILY_END,
    DEMO_DAILY_START,
    NSIDC_VERSION,
    PROCESSED_DIR,
    RAW_DIR,
    SEASON_MONTHS,
    TEST_YEARS,
    TRAIN_YEARS,
    VAL_YEARS,
)
from polarroute.grid import compute_crop_slices, read_sic_array, save_meta, station_indices


def _open(path: Path):
    return xr.open_dataset(path, decode_times=True)


def _iter_days(ds):
    times = ds["time"].values
    sic = read_sic_array(ds)
    if sic.ndim == 2:
        sic = sic[None, ...]
        times = times[None]
    for i, t in enumerate(times):
        ts = np.datetime64(t, "D")
        d = ts.astype("datetime64[D]").item()
        yield d, sic[i]


def collect_frames() -> tuple[list, list]:
    frames = {}  # date -> 2d array (full grid)
    yearly = []
    for year in ALL_YEARS:
        p = RAW_DIR / f"sic_pss25_{year}_{NSIDC_VERSION}.nc"
        if not p.exists():
            raise FileNotFoundError(f"Missing {p}. Run: python -m polarroute.download")
        yearly.append(p)
        print(f"read {p.name}")
        with _open(p) as ds:
            for d, arr in _iter_days(ds):
                if d.month in SEASON_MONTHS:
                    frames[d] = arr

    daily_dir = RAW_DIR / "daily"
    if daily_dir.exists():
        for p in sorted(daily_dir.glob("*.nc")):
            with _open(p) as ds:
                for d, arr in _iter_days(ds):
                    frames[d] = arr  # prefer daily (covers Jan 2023)

    dates = sorted(frames)
    arrays = [frames[d] for d in dates]
    return dates, arrays


def split_for(d) -> str:
    if d.year in TRAIN_YEARS:
        return "train"
    if d.year in VAL_YEARS:
        return "val"
    if d.year in TEST_YEARS or (
        DEMO_DAILY_START <= d.isoformat() <= DEMO_DAILY_END
    ):
        return "test"
    return "other"


def run() -> None:
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    anc_path = RAW_DIR / ANCILLARY_NAME
    anc = _open(anc_path)
    x_full = anc["x"].values.astype(np.float64)
    y_full = anc["y"].values.astype(np.float64)
    surface = anc["surface_type"].values
    lat = anc["latitude"].values
    lon = anc["longitude"].values
    crop = compute_crop_slices(x_full, y_full)
    sl = (slice(crop["iy0"], crop["iy1"]), slice(crop["ix0"], crop["ix1"]))

    dates, arrays = collect_frames()
    stacked = np.stack([a[sl] for a in arrays], axis=0).astype(np.float16)
    land = (surface[sl] >= 200).astype(np.uint8)
    ocean = (surface[sl] == 50).astype(np.uint8)
    x = x_full[sl[1]]
    y = y_full[sl[0]]
    stations = station_indices(x, y)

    date_iso = np.array([d.isoformat() for d in dates])
    splits = np.array([split_for(d) for d in dates])

    np.save(PROCESSED_DIR / "sic.npy", stacked)
    np.save(PROCESSED_DIR / "dates.npy", date_iso)
    np.save(PROCESSED_DIR / "splits.npy", splits)
    np.save(PROCESSED_DIR / "land.npy", land)
    np.save(PROCESSED_DIR / "ocean.npy", ocean)
    np.save(PROCESSED_DIR / "x.npy", x)
    np.save(PROCESSED_DIR / "y.npy", y)
    np.save(PROCESSED_DIR / "lat.npy", lat[sl].astype(np.float32))
    np.save(PROCESSED_DIR / "lon.npy", lon[sl].astype(np.float32))

    meta = {
        "dataset": DATASET_NAME,
        "doi": DATASET_DOI,
        "substitution": "G02202 V5 retired; using V6 (same grid, CDR algorithm family).",
        "n_days": int(stacked.shape[0]),
        "shape": [int(stacked.shape[1]), int(stacked.shape[2])],
        "crop": crop,
        "stations": stations,
        "train_years": TRAIN_YEARS,
        "val_years": VAL_YEARS,
        "test_years": TEST_YEARS,
        "season_months": sorted(SEASON_MONTHS),
        "image_extent": [crop["xmin"], crop["ymin"], crop["xmax"], crop["ymax"]],
        "created": datetime.utcnow().isoformat() + "Z",
        "spatial_resolution_km": 25,
        "target": "sea-ice concentration (0-1) at 1-7 day leads",
        "features": ["7 daily SIC maps", "ocean mask", "sin/cos day-of-year"],
    }
    save_meta(meta)
    anc.close()
    print(f"saved {stacked.shape} days={len(dates)} -> {PROCESSED_DIR}")
    print("splits", {s: int((splits == s).sum()) for s in ("train", "val", "test", "other")})
    print("stations in-grid", {k: v["in_grid"] for k, v in stations.items()})


if __name__ == "__main__":
    run()
