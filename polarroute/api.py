"""FastAPI: live forecast + A* routing for the PolarRoute dashboard."""

from __future__ import annotations

import base64
import json
from functools import lru_cache
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from polarroute.config import (
    DATASET_DOI,
    DATASET_NAME,
    DEMO_D0,
    FRONTEND_DIST,
    MODELS_DIR,
    PROCESSED_DIR,
    SHIP_CLASS,
    SHIP_NAME,
)
from polarroute.dataset import load_processed
from polarroute.forecast import (
    available_d0,
    climatology_stack,
    date_index,
    forecast_for,
    observed_stack,
)
from polarroute.grid import load_meta
from polarroute.icebergs import snapshot as iceberg_snapshot
from polarroute.route import astar, path_metrics, path_to_xy


def pack(arr: np.ndarray) -> dict:
    a = np.ascontiguousarray(arr.astype(np.float16))
    return {"shape": list(a.shape), "dtype": "float16", "b64": base64.b64encode(a.tobytes()).decode("ascii")}


@lru_cache(maxsize=1)
def ctx():
    bundle = load_processed()
    meta = load_meta()
    val = {}
    vp = MODELS_DIR / "validation.json"
    if vp.exists():
        val = json.loads(vp.read_text(encoding="utf-8"))
    hc = {}
    hp = MODELS_DIR / "hindcast.json"
    if hp.exists():
        hc = json.loads(hp.read_text(encoding="utf-8"))
    return bundle, meta, val, hc


class RouteBody(BaseModel):
    date: str
    w_risk: float = 0.35
    w_time: float = 1.0
    forecast_source: str = "auto"  # auto | unet | b1 | clim
    start: str = "ice_entry"
    goal: str = "bharati"
    from_row: int | None = None
    from_col: int | None = None


class AdvanceBody(BaseModel):
    date: str
    ship_row: int
    ship_col: int
    w_risk: float = 0.35


app = FastAPI(title="PolarRoute DSS", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _station_xy(meta, key):
    s = meta["stations"][key]
    return (int(s["row"]), int(s["col"]))


def _forecast_stack(fc, source: str, n_days: int = 14) -> np.ndarray:
    gate = json.loads((MODELS_DIR / "validation.json").read_text(encoding="utf-8"))["gate"] if (MODELS_DIR / "validation.json").exists() else {"forecast_source": "unet"}
    if source == "auto":
        source = gate.get("forecast_source", "unet")
    if source == "b1":
        core = fc["b1"]
    elif source == "clim":
        core = climatology_stack(fc["d0"], days=n_days)
        return core
    else:
        core = fc["ml"]
    extra = np.repeat(core[-1:], max(0, n_days - core.shape[0]), 0)
    return np.concatenate([core, extra], 0)[:n_days]


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/scenario")
def scenario():
    bundle, meta, val, hc = ctx()
    dates = [str(d)[:10] for d in bundle["dates"]]
    d0s = available_d0(bundle["dates"])
    d0 = DEMO_D0 if DEMO_D0 in d0s else (d0s[len(d0s) // 2] if d0s else dates[min(10, len(dates) - 1)])
    return {
        "title": "PolarRoute DSS",
        "subtitle": "Cape Town → Bharati → Maitri  ·  hindcast replay",
        "ship": {"name": SHIP_NAME, "klass": SHIP_CLASS},
        "disclaimer": "Prototype — decision-support demo, not for real navigation.",
        "dataset": DATASET_NAME,
        "doi": DATASET_DOI,
        "d0": d0,
        "available_dates": d0s,
        "extent": meta["image_extent"],
        "shape": meta["shape"],
        "stations": meta["stations"],
        "crop": meta["crop"],
        "gate": val.get("gate"),
        "hindcast_summary": {
            k: hc.get(k)
            for k in (
                "n",
                "mean_heavy_hours_forecast",
                "mean_heavy_hours_static",
                "mean_hours_saved",
                "mean_heavy_hours_saved",
                "note",
            )
        }
        if hc
        else None,
        "provenance": [
            {"layer": "Observed sea ice", "badge": "REAL", "detail": "NSIDC G02202 V6 passive-microwave SIC, 25 km"},
            {"layer": "Ice forecast", "badge": "MODEL", "detail": "Small U-Net trained on 2016–2018 shipping seasons"},
            {"layer": "Uncertainty", "badge": "DERIVED", "detail": "Validation-set mean absolute error per lead/cell"},
            {"layer": "Icebergs", "badge": "SIMULATED", "detail": "Illustrative start points; wind+current rule of thumb"},
            {"layer": "Routing", "badge": "LIVE", "detail": "Time-dependent A* on the forecast grid"},
            {"layer": "Fuel", "badge": "PROXY", "detail": "∝ distance × (1 + a·SIC²)"},
            {"layer": "Vessel class", "badge": "ILLUSTRATIVE", "detail": "PC6-like SIC limits; not POLARIS-certified"},
        ],
    }


@app.get("/api/grid")
def grid(date: str, lead: int = 0, layer: str = "obs"):
    try:
        fc = forecast_for(date)
    except Exception as exc:
        raise HTTPException(400, str(exc)) from exc
    lead = int(np.clip(lead, 0, 6))
    if layer == "obs":
        arr = fc["obs"][lead] if lead >= 0 else fc["last"]
        badge = "REAL"
    elif layer == "last":
        arr = fc["last"]
        badge = "REAL"
    elif layer == "ml":
        arr = fc["ml"][lead]
        badge = "MODEL"
    elif layer == "b0":
        arr = fc["b0"][lead]
        badge = "BASELINE"
    elif layer == "b1":
        arr = fc["b1"][lead]
        badge = "BASELINE"
    elif layer == "error":
        arr = np.abs(fc["ml"][lead] - fc["obs"][lead])
        badge = "DERIVED"
    elif layer == "uncertainty":
        u = np.load(PROCESSED_DIR / "uncertainty.npy") if (PROCESSED_DIR / "uncertainty.npy").exists() else np.abs(fc["ml"][lead] - fc["b0"][lead])
        arr = u[min(lead, u.shape[0] - 1)]
        badge = "DERIVED"
    else:
        raise HTTPException(400, "unknown layer")
    return {"layer": layer, "lead": lead, "badge": badge, "grid": pack(arr), "land": pack(fc["land"].astype(np.float32))}


@app.get("/api/forecast/{date}")
def forecast(date: str):
    try:
        fc = forecast_for(date)
    except Exception as exc:
        raise HTTPException(400, str(exc)) from exc
    ocean = fc["ocean"]
    def mae(a, b):
        return [float(np.abs(a[k] - b[k])[ocean > 0.5].mean()) for k in range(a.shape[0])]
    return {
        "d0": fc["d0"],
        "history_dates": fc["history_dates"],
        "forecast_dates": fc["forecast_dates"],
        "obs_dates": fc["obs_dates"],
        "history": pack(fc["history"]),
        "last": pack(fc["last"]),
        "ml": pack(fc["ml"]),
        "b0": pack(fc["b0"]),
        "b1": pack(fc["b1"]),
        "obs": pack(fc["obs"]),
        "land": pack(fc["land"].astype(np.float32)),
        "per_lead_mae": {
            "ml": mae(fc["ml"], fc["obs"]),
            "b0": mae(fc["b0"], fc["obs"]),
            "b1": mae(fc["b1"], fc["obs"]),
        },
        "how": (
            "The U-Net sees 7 daily SIC maps + ocean mask + season, and predicts "
            "the change from the last observed day for the next 7 days."
        ),
    }


def _plan(date: str, w_risk: float, source: str, start_key: str, goal_key: str, fr=None, fc=None):
    bundle, meta, val, _ = ctx()
    land = bundle["land"]
    fcst = forecast_for(date)
    stack = _forecast_stack(fcst, source)
    if source == "clim" or source == "static":
        stack = climatology_stack(date, days=14)
        w_risk = 0.0
    start = (fr, fc) if fr is not None else _station_xy(meta, start_key)
    goal = _station_xy(meta, goal_key)
    u = None
    up = PROCESSED_DIR / "uncertainty.npy"
    if up.exists() and w_risk > 0:
        uu = np.load(up)
        u = np.concatenate([uu, np.repeat(uu[-1:], max(0, 14 - uu.shape[0]), 0)], 0)[: stack.shape[0]]
    path, hours = astar(stack, start, goal, w_risk=w_risk, risk=u, land=land)
    obs = observed_stack(date, days=stack.shape[0])
    metrics = path_metrics(path, obs) if path else {"ok": False}
    x, y = bundle["x"], bundle["y"]
    return {
        "path": path,
        "xy": path_to_xy(path, x, y) if path else [],
        "plan_hours": hours,
        "metrics": metrics,
        "start": start,
        "goal": goal,
        "source": source,
    }


@app.post("/api/route")
def route(body: RouteBody):
    try:
        src = "clim" if body.forecast_source in ("clim", "static") else body.forecast_source
        fc = _plan(body.date, body.w_risk, src, body.start, body.goal, body.from_row, body.from_col)
        st = _plan(body.date, 0.0, "clim", body.start, body.goal, body.from_row, body.from_col)
    except Exception as exc:
        raise HTTPException(400, str(exc)) from exc
    return {
        "date": body.date,
        "forecast_aware": fc,
        "static": st,
        "w_risk": body.w_risk,
    }


@app.post("/api/advance")
def advance(body: AdvanceBody):
    from datetime import date as dt, timedelta

    nxt = (dt.fromisoformat(body.date[:10]) + timedelta(days=1)).isoformat()
    bundle, meta, val, _ = ctx()
    dates = [str(d)[:10] for d in bundle["dates"]]
    if nxt not in dates:
        raise HTTPException(400, f"No observation for {nxt}")
    src = val.get("gate", {}).get("forecast_source", "unet")
    planned = _plan(nxt, body.w_risk, src, "bharati", "bharati", body.ship_row, body.ship_col)
    # if already at bharati, next leg toward maitri
    b = _station_xy(meta, "bharati")
    if (body.ship_row, body.ship_col) == b or (abs(body.ship_row - b[0]) + abs(body.ship_col - b[1]) < 3):
        planned = _plan(nxt, body.w_risk, src, "maitri", "maitri", body.ship_row, body.ship_col)
        planned["leg"] = "toward_maitri"
    else:
        planned["leg"] = "toward_bharati"
    return {"date": nxt, "route": planned, "icebergs": iceberg_snapshot(day_offset=1)}


@app.get("/api/icebergs")
def icebergs(day_offset: int = 0):
    return {"badge": "SIMULATED", "bergs": iceberg_snapshot(day_offset)}


@app.get("/api/validation")
def validation():
    p = MODELS_DIR / "validation.json"
    if not p.exists():
        raise HTTPException(404, "Train and evaluate first")
    return json.loads(p.read_text(encoding="utf-8"))


@app.get("/api/hindcast")
def hindcast():
    p = MODELS_DIR / "hindcast.json"
    if not p.exists():
        raise HTTPException(404, "Run hindcast first")
    return json.loads(p.read_text(encoding="utf-8"))


@app.get("/api/land.geojson")
def land_geojson():
    p = PROCESSED_DIR / "land.geojson"
    if not p.exists():
        raise HTTPException(404, "land.geojson missing")
    return json.loads(p.read_text(encoding="utf-8"))


if FRONTEND_DIST.exists():
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="ui")
