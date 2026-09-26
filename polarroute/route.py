"""Time-dependent A* on the 25 km SIC grid."""

from __future__ import annotations

import heapq
import math

import numpy as np

from polarroute.config import CELL_KM, HEAVY_ICE_SIC, MAX_SIC, OPEN_WATER_KMH


MOVES = [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)]


def speed_factor(sic: np.ndarray, max_sic: float = MAX_SIC) -> np.ndarray:
    s = np.where(sic < 0.15, 1.0, 1.0 - 0.8 * (sic - 0.15) / (max_sic - 0.15))
    return np.where(sic > max_sic, 0.0, np.clip(s, 0.2, 1.0))


def astar(
    forecast: np.ndarray,
    start: tuple[int, int],
    goal: tuple[int, int],
    cell_km: float = CELL_KM,
    v_kmh: float = OPEN_WATER_KMH,
    w_time: float = 1.0,
    w_risk: float = 0.35,
    risk: np.ndarray | None = None,
    land: np.ndarray | None = None,
) -> tuple[list[tuple[int, int]] | None, float | None]:
    """forecast: [days,H,W] SIC 0..1. Cost is hours (+ optional risk)."""
    D, H, W = forecast.shape
    sf = [speed_factor(forecast[d]) for d in range(D)]
    if land is not None:
        for d in range(D):
            sf[d] = np.where(land > 0, 0.0, sf[d])

    def h(a, b):
        return math.hypot(a[0] - b[0], a[1] - b[1]) * cell_km / v_kmh

    pq = [(h(start, goal), 0.0, start)]
    best = {start: 0.0}
    prev = {}
    while pq:
        _, g, cur = heapq.heappop(pq)
        if cur == goal:
            path = [cur]
            while cur in prev:
                cur = prev[cur]
                path.append(cur)
            return path[::-1], g
        if g > best.get(cur, 1e18):
            continue
        day = min(int(g // 24), D - 1)
        for dr, dc in MOVES:
            nr, nc = cur[0] + dr, cur[1] + dc
            if not (0 <= nr < H and 0 <= nc < W):
                continue
            v = v_kmh * float(sf[day][nr, nc])
            if v <= 0:
                continue
            dist = cell_km * math.hypot(dr, dc)
            rterm = 0.0
            if risk is not None:
                rterm = w_risk * float(risk[min(day, risk.shape[0] - 1), nr, nc]) * dist
            ng = g + w_time * dist / v + rterm
            nxt = (nr, nc)
            if ng < best.get(nxt, 1e18):
                best[nxt] = ng
                prev[nxt] = cur
                heapq.heappush(pq, (ng + h(nxt, goal), ng, nxt))
    return None, None


def path_metrics(
    path: list[tuple[int, int]],
    observed: np.ndarray,
    v_kmh: float = OPEN_WATER_KMH,
    cell_km: float = CELL_KM,
) -> dict:
    """Score a path on observed SIC as the ship sails (hours from open-water speed laws)."""
    if not path:
        return {"ok": False}
    D = observed.shape[0]
    hours = 0.0
    dist = 0.0
    heavy = 0.0
    fuel = 0.0
    max_sic = 0.0
    high_risk = []
    sfs = [speed_factor(observed[d]) for d in range(D)]
    for i in range(1, len(path)):
        r0, c0 = path[i - 1]
        r1, c1 = path[i]
        step = cell_km * math.hypot(r1 - r0, c1 - c0)
        day = min(int(hours // 24), D - 1)
        sic = float(observed[day, r1, c1])
        v = v_kmh * float(sfs[day][r1, c1])
        if v <= 0:
            v = 0.5  # forced crawl if the planned cell later ices in
        dt = step / v
        hours += dt
        dist += step
        max_sic = max(max_sic, sic)
        fuel += step * (1.0 + 1.5 * sic * sic)
        if sic >= HEAVY_ICE_SIC:
            heavy += dt
            high_risk.append({"i": i, "row": r1, "col": c1, "sic": sic, "hour": hours})
    return {
        "ok": True,
        "hours": hours,
        "distance_km": dist,
        "heavy_ice_hours": heavy,
        "fuel_proxy": fuel,
        "max_sic": max_sic,
        "n_cells": len(path),
        "high_risk": high_risk[:80],
        "mean_sic": float(np.mean([observed[min(int(i * hours / max(len(path), 1) // 24), D - 1), r, c] for i, (r, c) in enumerate(path)])),
    }


def path_to_xy(path: list[tuple[int, int]], x: np.ndarray, y: np.ndarray) -> list[list[float]]:
    return [[float(x[c]), float(y[r])] for r, c in path]
