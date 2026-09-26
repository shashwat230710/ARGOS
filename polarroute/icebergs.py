"""Iceberg drift rule of thumb (not a calibrated operational model)."""

from __future__ import annotations

import math

# Illustrative start points in the Indian-Ocean corridor (badge: SIMULATED).
# Drift: East Wind Drift band — westward along the coast (~0.06 m/s) plus
# 2% of a climatological easterly wind rotated 25° to the left (SH).
SEEDS = [
    {"id": "IB-A", "lon": 68.0, "lat": -62.5, "label": "Illustrative berg A"},
    {"id": "IB-B", "lon": 40.0, "lat": -64.0, "label": "Illustrative berg B"},
]

ALPHA = 0.02
THETA_DEG = 25.0  # left of wind in Southern Hemisphere
U10_EAST_MS = 6.0  # climatological easterly (negative east component)
U10_NORTH_MS = 1.0
CURRENT_EAST_MS = -0.06  # westward coastal drift
CURRENT_NORTH_MS = 0.0
CONE_KM_PER_DAY = 12.0  # illustrative growth, not a NIC backtest


def _rotate_left_sh(ue: float, un: float, deg: float) -> tuple[float, float]:
    rad = math.radians(deg)
    # left of wind looking downwind
    c, s = math.cos(rad), math.sin(rad)
    return ue * c - un * s, ue * s + un * c


def drift_ms() -> tuple[float, float]:
    we, wn = -U10_EAST_MS, U10_NORTH_MS
    re, rn = _rotate_left_sh(we, wn, THETA_DEG)
    return CURRENT_EAST_MS + ALPHA * re, CURRENT_NORTH_MS + ALPHA * rn


def forecast_track(lon: float, lat: float, days: int = 7, dt_h: float = 6.0) -> list[dict]:
    ve, vn = drift_ms()
    pts = []
    t_h = 0.0
    while t_h <= days * 24 + 1e-6:
        # metres on sphere (approx)
        dlat = vn * dt_h * 3600.0 / 111000.0
        dlon = ve * dt_h * 3600.0 / (111000.0 * max(0.2, math.cos(math.radians(lat))))
        lon += dlon
        lat += dlat
        t_h += dt_h
        lead = t_h / 24.0
        pts.append(
            {
                "lon": lon,
                "lat": lat,
                "lead_days": lead,
                "cone_km": CONE_KM_PER_DAY * lead,
            }
        )
    return pts


def snapshot(day_offset: int = 0) -> list[dict]:
    out = []
    for s in SEEDS:
        track = forecast_track(s["lon"], s["lat"], days=7)
        idx = min(int(day_offset * (24 / 6)), len(track) - 1)
        cur = track[idx]
        out.append(
            {
                **s,
                "lon": cur["lon"] if day_offset else s["lon"],
                "lat": cur["lat"] if day_offset else s["lat"],
                "track": track,
                "badge": "SIMULATED",
                "method": (
                    f"v = current({CURRENT_EAST_MS} m/s west) + {ALPHA}*R({THETA_DEG}°)U10; "
                    f"cone {CONE_KM_PER_DAY} km/day (illustrative, no NIC track in this demo)"
                ),
            }
        )
    return out
