"""Hindcast: static-climatology route vs forecast-aware route, scored on observed ice."""

from __future__ import annotations

import json

import numpy as np

from polarroute.config import MODELS_DIR, PROCESSED_DIR, T_IN
from polarroute.dataset import consecutive_indices, load_processed
from polarroute.forecast import climatology_stack, forecast_for, observed_stack
from polarroute.grid import load_meta
from polarroute.route import astar, path_metrics, path_to_xy


def _pts(meta):
    e = meta["stations"]["ice_entry"]
    b = meta["stations"]["bharati"]
    m = meta["stations"]["maitri"]
    start = (int(e["row"]), int(e["col"]))
    bharati = (int(b["row"]), int(b["col"]))
    maitri = (int(m["row"]), int(m["col"]))
    return start, bharati, maitri


def plan_leg(sic_days, start, goal, land, risk=None, w_risk=0.35):
    path, hours = astar(sic_days, start, goal, w_risk=w_risk, risk=risk, land=land)
    return path, hours


def _uncertainty(n_days, H, W):
    p = PROCESSED_DIR / "uncertainty.npy"
    if not p.exists():
        return None
    u = np.load(p)
    if u.shape[0] < n_days:
        last = u[-1]
        u = np.concatenate([u, np.repeat(last[None], n_days - u.shape[0], 0)], 0)
    return u[:n_days]


def score_voyage(path, obs, land):
    if path is None:
        return {"ok": False}
    return path_metrics(path, obs)


def run_one(iso: str, land, start, goal, w_risk=0.35) -> dict:
    fc = forecast_for(iso)
    # Use ML 7-day forecast, then persist last lead for remaining voyage days
    ml = fc["ml"]
    extra = np.repeat(ml[-1:], 10, 0)
    fc_days = np.concatenate([ml, extra], 0)
    clim = climatology_stack(iso, days=fc_days.shape[0])
    obs = observed_stack(iso, days=fc_days.shape[0])
    risk = _uncertainty(fc_days.shape[0], *land.shape)
    p_fc, _ = plan_leg(fc_days, start, goal, land, risk=risk, w_risk=w_risk)
    p_st, _ = plan_leg(clim, start, goal, land, risk=None, w_risk=0.0)
    m_fc = score_voyage(p_fc, obs, land)
    m_st = score_voyage(p_st, obs, land)
    return {
        "date": iso,
        "forecast_aware": m_fc,
        "static": m_st,
        "path_fc": p_fc,
        "path_st": p_st,
        "delta_heavy_hours": (m_st.get("heavy_ice_hours", 0) - m_fc.get("heavy_ice_hours", 0))
        if m_fc.get("ok") and m_st.get("ok")
        else None,
        "delta_hours": (m_st.get("hours", 0) - m_fc.get("hours", 0))
        if m_fc.get("ok") and m_st.get("ok")
        else None,
    }


def candidate_dates(dates, splits, max_n=12) -> list[str]:
    out = []
    for i in range(T_IN - 1, len(dates) - 8):
        if str(splits[i]) != "test":
            continue
        if not consecutive_indices(dates, i - T_IN + 1, T_IN + 7):
            continue
        month = int(str(dates[i])[5:7])
        if month not in (12, 1):
            continue
        out.append(str(dates[i])[:10])
    # subsample
    if len(out) > max_n:
        idx = np.linspace(0, len(out) - 1, max_n).astype(int)
        out = [out[j] for j in idx]
    return out


def run() -> dict:
    bundle = load_processed()
    meta = load_meta()
    start, bharati, maitri = _pts(meta)
    land = bundle["land"]
    dates = candidate_dates(bundle["dates"], bundle["splits"])
    rows = []
    for iso in dates:
        try:
            rec = run_one(iso, land, start, bharati)
        except Exception as exc:
            rec = {"date": iso, "error": str(exc)}
        rec_out = {k: v for k, v in rec.items() if k not in ("path_fc", "path_st")}
        rows.append(rec_out)
    heavy_fc = [r["forecast_aware"]["heavy_ice_hours"] for r in rows if r.get("forecast_aware", {}).get("ok")]
    heavy_st = [r["static"]["heavy_ice_hours"] for r in rows if r.get("static", {}).get("ok")]
    summary = {
        "n": len(rows),
        "leg": "ice-region entry → Bharati",
        "mean_heavy_hours_forecast": float(np.mean(heavy_fc)) if heavy_fc else None,
        "mean_heavy_hours_static": float(np.mean(heavy_st)) if heavy_st else None,
        "mean_hours_saved": float(np.mean([r["delta_hours"] for r in rows if r.get("delta_hours") is not None]))
        if rows
        else None,
        "mean_heavy_hours_saved": float(
            np.mean([r["delta_heavy_hours"] for r in rows if r.get("delta_heavy_hours") is not None])
        )
        if rows
        else None,
        "rows": rows,
        "note": "Both routes are scored on observed SIC after planning. Fuel is a distance×(1+a·SIC²) proxy.",
    }
    (MODELS_DIR / "hindcast.json").write_text(json.dumps(summary, indent=2, default=float), encoding="utf-8")
    print("hindcast n=", summary["n"], "heavy saved=", summary["mean_heavy_hours_saved"])
    return summary


if __name__ == "__main__":
    run()
