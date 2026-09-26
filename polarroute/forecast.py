"""Run U-Net / baselines for a given last-observation date."""

from __future__ import annotations

from datetime import date, timedelta
from functools import lru_cache

import numpy as np
import torch

from polarroute.config import IN_CH, K_OUT, MODELS_DIR, PROCESSED_DIR, T_IN, TRAIN_YEARS
from polarroute.dataset import _doy, baseline_persistence, baseline_seasonal, load_processed
from polarroute.evaluate import load_model


def date_index(dates: np.ndarray, iso: str) -> int:
    iso = iso[:10]
    for i, d in enumerate(dates):
        if str(d)[:10] == iso:
            return i
    raise KeyError(iso)


def available_d0(dates: np.ndarray) -> list[str]:
    out = []
    for i in range(T_IN - 1, len(dates) - K_OUT):
        # need T_IN consecutive ending at i, and K_OUT after
        from polarroute.dataset import consecutive_indices

        if consecutive_indices(dates, i - T_IN + 1, T_IN + K_OUT):
            out.append(str(dates[i])[:10])
    return out


@lru_cache(maxsize=1)
def _bundle():
    return load_processed()


@lru_cache(maxsize=1)
def _delta():
    p = PROCESSED_DIR / "clim_delta.npy"
    if p.exists():
        return np.load(p)
    return None


@lru_cache(maxsize=1)
def _clim_mean():
    p = PROCESSED_DIR / "clim_mean.npy"
    if p.exists():
        return np.load(p)
    return None


@lru_cache(maxsize=1)
def _model():
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    return load_model(device), device


def build_input(bundle, last_i: int) -> np.ndarray:
    sic = bundle["sic"]
    x_sic = sic[last_i - T_IN + 1 : last_i + 1]
    iso = str(bundle["dates"][last_i])
    doy = _doy(iso)
    ang = 2 * np.pi * doy / 366.0
    h, w = x_sic.shape[1:]
    mask = bundle["ocean"][None]
    sin_ch = np.full((1, h, w), np.sin(ang), np.float32)
    cos_ch = np.full((1, h, w), np.cos(ang), np.float32)
    return np.concatenate([x_sic, mask, sin_ch, cos_ch], 0)


@torch.no_grad()
def forecast_for(iso: str) -> dict:
    bundle = _bundle()
    dates = bundle["dates"]
    i = date_index(dates, iso)
    if i < T_IN - 1:
        raise ValueError("Need 7 days of history before this date")
    x = build_input(bundle, i)
    last = bundle["sic"][i]
    ocean = bundle["ocean"]
    model, device = _model()
    xt = torch.from_numpy(x[None].astype(np.float32)).to(device)
    lt = torch.from_numpy(last[None, None].astype(np.float32)).to(device)
    ml = (lt + model(xt)).clamp(0, 1)[0].cpu().numpy()
    doy = _doy(iso)
    b0 = baseline_persistence(last)
    delta = _delta()
    if delta is None:
        b1 = b0.copy()
    else:
        b1 = baseline_seasonal(last, doy, delta)
    obs = bundle["sic"][i + 1 : i + 1 + K_OUT]
    history = bundle["sic"][i - T_IN + 1 : i + 1]
    hist_dates = [str(d)[:10] for d in dates[i - T_IN + 1 : i + 1]]
    fut_dates = []
    d0 = date.fromisoformat(iso)
    for k in range(1, K_OUT + 1):
        fut_dates.append((d0 + timedelta(days=k)).isoformat())
    return {
        "d0": iso,
        "history": history,
        "history_dates": hist_dates,
        "ml": ml,
        "b0": b0,
        "b1": b1,
        "obs": obs,
        "obs_dates": [str(d)[:10] for d in dates[i + 1 : i + 1 + K_OUT]],
        "forecast_dates": fut_dates,
        "ocean": ocean,
        "land": bundle["land"],
        "last": last,
        "doy": doy,
    }


def climatology_stack(iso: str, days: int = 14) -> np.ndarray:
    mean = _clim_mean()
    d0 = date.fromisoformat(iso[:10])
    H, W = _bundle()["sic"].shape[1:]
    if mean is None:
        return np.repeat(_bundle()["sic"][date_index(_bundle()["dates"], iso)][None], days, 0)
    stack = []
    for k in range(days):
        d = d0 + timedelta(days=k)
        doy = d.timetuple().tm_yday - 1
        stack.append(mean[doy])
    return np.stack(stack, 0)


def observed_stack(iso: str, days: int = 14) -> np.ndarray:
    bundle = _bundle()
    i = date_index(bundle["dates"], iso)
    end = min(i + days, len(bundle["dates"]))
    sl = bundle["sic"][i:end]
    if sl.shape[0] < days:
        sl = np.concatenate([sl, np.repeat(sl[-1:], days - sl.shape[0], 0)], 0)
    return sl
