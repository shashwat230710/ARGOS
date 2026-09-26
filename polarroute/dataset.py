"""Sequence dataset + persistence / seasonal-tendency baselines."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import torch
from torch.utils.data import Dataset

from polarroute.config import K_OUT, PROCESSED_DIR, T_IN


def load_processed() -> dict:
    sic = np.load(PROCESSED_DIR / "sic.npy").astype(np.float32)
    dates = np.load(PROCESSED_DIR / "dates.npy")
    splits = np.load(PROCESSED_DIR / "splits.npy")
    land = np.load(PROCESSED_DIR / "land.npy")
    ocean = np.load(PROCESSED_DIR / "ocean.npy").astype(np.float32)
    return {
        "sic": sic,
        "dates": dates,
        "splits": splits,
        "land": land,
        "ocean": ocean,
        "x": np.load(PROCESSED_DIR / "x.npy"),
        "y": np.load(PROCESSED_DIR / "y.npy"),
    }


def _ordinal(iso: str) -> int:
    y, m, d = map(int, iso[:10].split("-"))
    from datetime import date

    return date(y, m, d).toordinal()


def _doy(iso: str) -> int:
    y, m, d = map(int, iso[:10].split("-"))
    from datetime import date

    return date(y, m, d).timetuple().tm_yday


def consecutive_indices(dates: np.ndarray, i: int, length: int) -> bool:
    o0 = _ordinal(str(dates[i]))
    o1 = _ordinal(str(dates[i + length - 1]))
    return (o1 - o0) == (length - 1)


class SicSequenceDataset(Dataset):
    def __init__(self, bundle: dict, split: str, t_in: int = T_IN, k_out: int = K_OUT):
        self.sic = bundle["sic"]
        self.dates = bundle["dates"]
        self.ocean = bundle["ocean"]
        self.t_in = t_in
        self.k_out = k_out
        n = len(self.dates)
        self.indices = []
        span = t_in + k_out
        for i in range(n - span + 1):
            if not consecutive_indices(self.dates, i, span):
                continue
            # Label the sample by the last input day's split
            last = i + t_in - 1
            if str(bundle["splits"][last]) != split:
                continue
            self.indices.append(i)

    def __len__(self) -> int:
        return len(self.indices)

    def __getitem__(self, j: int):
        i = self.indices[j]
        x_sic = self.sic[i : i + self.t_in]
        y = self.sic[i + self.t_in : i + self.t_in + self.k_out]
        last_iso = str(self.dates[i + self.t_in - 1])
        doy = _doy(last_iso)
        ang = 2 * np.pi * doy / 366.0
        h, w = x_sic.shape[1:]
        mask = np.broadcast_to(self.ocean, (1, h, w))
        sin_ch = np.full((1, h, w), np.sin(ang), dtype=np.float32)
        cos_ch = np.full((1, h, w), np.cos(ang), dtype=np.float32)
        x = np.concatenate([x_sic, mask, sin_ch, cos_ch], axis=0)
        return {
            "x": torch.from_numpy(x.copy()),
            "y": torch.from_numpy(y.copy()),
            "last": torch.from_numpy(x_sic[-1:].copy()),
            "ocean": torch.from_numpy(self.ocean.copy()),
            "date": last_iso,
            "index": i,
        }


def climatology_mean(bundle: dict, train_years: list[int]) -> np.ndarray:
    """Smoothed mean SIC by day-of-year on training years. Shape [366, H, W]."""
    sic, dates = bundle["sic"], bundle["dates"]
    years = np.array([int(str(d)[:4]) for d in dates])
    H, W = sic.shape[1:]
    acc = np.zeros((366, H, W), dtype=np.float64)
    cnt = np.zeros(366, dtype=np.float64)
    for i, d in enumerate(dates):
        if years[i] not in train_years:
            continue
        doy = _doy(str(d)) - 1
        acc[doy] += sic[i]
        cnt[doy] += 1
    cnt = np.maximum(cnt, 1.0)[:, None, None]
    raw = (acc / cnt).astype(np.float32)
    kern = np.ones(15, dtype=np.float32) / 15.0
    pad = np.concatenate([raw[-7:], raw, raw[:7]], axis=0)
    sm = np.zeros_like(raw)
    for d in range(366):
        sm[d] = (pad[d : d + 15] * kern[:, None, None]).sum(axis=0)
    return sm


def climatology_delta(bundle: dict, train_years: list[int]) -> np.ndarray:
    """Mean k-day change by day-of-year on training years. Shape [366, K, H, W]."""
    sic, dates = bundle["sic"], bundle["dates"]
    years = np.array([int(str(d)[:4]) for d in dates])
    H, W = sic.shape[1:]
    acc = np.zeros((366, K_OUT, H, W), dtype=np.float64)
    cnt = np.zeros((366, K_OUT), dtype=np.float64)
    n = len(dates)
    for i in range(n - K_OUT):
        if years[i] not in train_years:
            continue
        if not consecutive_indices(dates, i, K_OUT + 1):
            continue
        doy = _doy(str(dates[i])) - 1
        for k in range(K_OUT):
            acc[doy, k] += sic[i + 1 + k] - sic[i]
            cnt[doy, k] += 1
    cnt = np.maximum(cnt, 1.0)[:, :, None, None]
    raw = (acc / cnt).astype(np.float32)
    # Smooth ±7 days along DOY (circular)
    kern = np.ones(15, dtype=np.float32) / 15.0
    pad = np.concatenate([raw[-7:], raw, raw[:7]], axis=0)
    sm = np.zeros_like(raw)
    for d in range(366):
        sm[d] = (pad[d : d + 15] * kern[:, None, None, None]).sum(axis=0)
    return sm


def baseline_persistence(last: np.ndarray, k: int = K_OUT) -> np.ndarray:
    return np.repeat(last[None, ...], k, axis=0)


def baseline_seasonal(last: np.ndarray, doy: int, delta: np.ndarray) -> np.ndarray:
    d = int(np.clip(doy - 1, 0, 365))
    return np.clip(last[None, ...] + delta[d], 0.0, 1.0)
