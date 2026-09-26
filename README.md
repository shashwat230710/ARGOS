# Antarctic Sea-Ice DSS — Demo Plan v2 (Free-to-Build, With a Real ML Model)

**Problem Statement 26059** — AI-Enabled Antarctic Sea-Ice, Iceberg Trajectory, and Navigation Decision Support System (MoES / NCPOR)

> This replaces the uploaded plan's Part 2 and Part 3. It keeps what was good in it (one story, honest labeling, offline-first, buffer days, a named metric before training) and fixes what conflicted with your goals: **show how it looks, show how it tackles the problem, and include a small real ML model on satellite data — all for ₹0.**

---

## 0. TL;DR

**What the demo is:** a hindcast replay of one real voyage window (Cape Town → Bharati → Maitri, Dec 2022–Jan 2023 style scenario) on a polar-stereographic dashboard. A small U-Net trained on 20+ years of satellite sea-ice maps forecasts 7 days ahead; a router plans the voyage on that forecast; icebergs drift with wind and current; and — the part that makes it convincing — **the planned route is scored against what the ice actually did**.

**Three pieces of real evidence the demo produces** (none of them scripted):
1. **Forecast skill:** U-Net vs two baselines (persistence, persistence + seasonal tendency), on years the model never saw.
2. **Route benefit:** forecast-aware route vs "static chart" (climatology) route, both scored on the *observed* ice afterwards (hours in heavy ice, distance, fuel proxy).
3. **Feasibility of the full pipeline:** every stage runs end-to-end on a laptop with free data.

**Cost:** ₹0 (public data, free GPU tiers, open-source libraries, no map-tile license, no hosting bill).
**Time:** 15 working days solo (4–6 h/day) with 2 buffer days; splits cleanly across 3 people; there's a 7-day emergency cut in §10.

---

## 1. Review of the Uploaded Plan — Keep / Change / Add

### 1.1 Keep as-is
| Idea from the uploaded plan | Why it stays |
|---|---|
| One narrative arc instead of a feature tour | Every module has to earn its place in the story |
| Honest about uncertainty; fallback if the model doesn't beat the baseline | Correct instinct — applied more consistently below |
| Offline-first (no network needed on demo day) | Removes the #1 live-demo failure |
| Named skill metric + go/no-go gate before training | Removes subjective decisions under time pressure |
| Buffer days + a mini-rehearsal each week | Realistic |
| Fictional vessel name, illustrative ship spec | Correct — India's resupply ship is a *chartered* ice-class vessel (MV Vasiliy Golovnin in recent seasons), not a research vessel; use a placeholder name |
| Written line between "real" and "simulated" | Kept, but made **visible in the UI** (badges, §12) instead of only an internal memo |

### 1.2 Change (problems found)
| # | Issue in uploaded plan | Fix in v2 |
|---|---|---|
| 1 | **Fast-track (Part 3) removes the ML model** and replaces it with a hand-tuned heuristic. That contradicts your requirement of a small real model on satellite data — and the model is actually cheap here (25 km grid, ~1 M parameters, 15–30 min on a free GPU). | Keep a real model in every timeline, including the 7-day cut. |
| 2 | **"South-pole-centered Mercator" is not possible.** Mercator stretches to infinity at the poles; web maps clip at about ±85°, so Antarctica would be badly distorted. | Use **OpenLayers + proj4** — it handles polar stereographic natively (§8). |
| 3 | **"Resample to EPSG:3031"** is unnecessary work. NSIDC's sea-ice grid is *already* polar stereographic (EPSG:3412, standard parallel 70°S; EPSG:3031 uses 71°S and WGS84). | Keep the native NSIDC grid for the model, the router *and* the map. Zero reprojection; the 25 km cell is also a natural routing cell. |
| 4 | **Basemap tiles + "offline" conflict** (fix C in the uploaded plan), and the proposed fix (pre-render tiles) is more work than needed. | **No tiles at all:** draw land from the dataset's own land mask / Natural Earth polygons as a vector layer. Fully offline, tiny, free. |
| 5 | **ERA5 and CMEMS were on the critical path.** The core sea-ice model needs only one source (NSIDC G02202), which downloads over plain HTTPS. | SIC-only model first; ERA5 winds added as a Day-5 upgrade; CMEMS currents are optional (iceberg only). |
| 6 | **Persistence is a weak single baseline.** At 1–7 days, persistence is hard to beat and easy to "beat" only by luck of window choice. | Two baselines: persistence **and** persistence + seasonal tendency. Year-blocked split; report Dec–Mar (shipping season) separately. |
| 7 | **The demo route flow is scripted** (10 cached routes, `setTimeout` alerts, "D\* Lite result cached"). | Plain A\* on this grid runs in ~0.2 s (tested, §7) → route is **live**; "advance one day" really re-runs the model and re-plans. D\* Lite becomes a roadmap item. |
| 8 | **Route start at Cape Town (34°S) is outside the model domain**, and the uploaded corridor top (50°S) falls outside the NSIDC grid at some longitudes. | Start the routed leg at an "ice-region entry" waypoint (~55°S); show Cape Town → 55°S as a straight open-water segment. |
| 9 | **Doc refers to the "original PDF's" script, checklist and 9-step flow**, which aren't in the upload. | Rebuilt below (§4.3). |
| 10 | **Team/cost/funding sections assume a 4-person, funded build.** | Kept a light version; solo timeline is primary. |
| 11 | "Leeway" drift is a search-and-rescue term for small objects. | Use a wind + current drift rule of thumb, labeled as such (§6). |
| 12 | MC-dropout is the only uncertainty method, with a known silent-failure mode. | Use **empirical error maps** from validation residuals (real, cheap, can't silently be zero). MC-dropout stays optional. |

### 1.3 Add (new in v2)
- **Hindcast counterfactual evaluation** of the route (biggest credibility boost, §7.3).
- **"Model vs reality" swipe** and an in-app validation panel.
- **In-UI provenance badges** (REAL / DERIVED / SIMULATED) on every layer.
- **Static replay mode** so the demo can also be hosted free (GitHub Pages) as a link.
- **Backlog of extra ideas** ranked by value/effort (§11).

---

## 2. Pros & Cons of the Big Decisions

### 2.1 Forecast approach
| Option | Pros | Cons | Verdict |
|---|---|---|---|
| A. Heuristic extension (uploaded fast-track) | 0 training time | Not ML; can't be validated; weak against a jury question "where's the AI?" | ✗ |
| **B. Small U-Net, stacked frames → 7 lead-day outputs** | Simple, fast, real, easy to explain; predicts *change from persistence* so it can't be catastrophically wrong | Smooths the ice edge; modest skill gain at short leads | ✓ **Recommended** |
| C. ConvLSTM / ConvLSTM-U-Net | Matches the long-term architecture in the proposal | Slower to train and tune; more failure modes for a demo | Phase 2 (same inputs/targets, so B upgrades into C) |
| D. Train on Sentinel-1 SAR images directly | Higher resolution, very "satellite image" | ~GB per scene, needs labels, days of preprocessing | ✗ for demo; roadmap |

### 2.2 Map technology
| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **OpenLayers + proj4** | True polar projection, image overlays with custom extents, free, no tiles | Less flashy than deck.gl | ✓ **Recommended** |
| Leaflet + Proj4Leaflet | Very simple | Custom CRS is fiddly; weaker raster/vector performance | Fallback |
| MapLibre GL JS v5 globe | Beautiful 3D globe; it's what your final stack uses | Globe is spherical Mercator-derived — no polar stereographic; overlaying a polar-grid raster correctly needs custom work | Use only for a 5-sec "globe intro" shot if time allows |
| deck.gl + MapLibre | Great for big vector data | Extra complexity; overkill for a 185×160 grid | Phase 2 |

### 2.3 Backend / hosting
| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **FastAPI on localhost** (+ Vite build served as static files) | You know it; live routing; one process; offline | Not reachable by a jury link | ✓ **Primary (demo day)** |
| **Static replay export** (JSON/PNG, hosted on GitHub Pages) | Free shareable link; zero servers | Only precomputed routes/weights | ✓ **Secondary (link + backup)** |
| Cloud VM/API | Real "deployed" story | Costs, cold starts, network risk | ✗ |

### 2.4 Where to train
| Option | Pros | Cons |
|---|---|---|
| **Kaggle notebook (GPU)** | Free GPU quota (weekly limit — check current limits), stable sessions | Needs phone verification; data upload step |
| Google Colab free | Easy | GPU availability varies; sessions time out |
| Local CPU | No setup | ~10× slower; use `base=16` and fewer epochs |

### 2.5 Input data for the model
| Option | Pros | Cons |
|---|---|---|
| **SIC only (Tier 1)** | One source, no accounts | Ignores winds that push ice |
| + ERA5 10 m winds (Tier 2) | Adds "meteorological data" from the problem statement; measurable ablation | CDS queue time; wind rotation gotcha (§5.6) |
| + CMEMS currents (Tier 3, iceberg only) | Adds "oceanographic data" | More setup; keep out of the ML critical path |

---

## 3. What the Demo Looks Like

### 3.1 Screens
1. **Scenario / Landing (10 s):** title, scenario card (dates, route, ship class), "Start" button. Footer: *Prototype — decision-support demo, not for real navigation.*
2. **Main dashboard (the demo lives here):** polar map, layers, timeline, route panel.
3. **Validation drawer:** model vs baselines charts, per-lead MAE/IIEE, a "test years" table.
4. **Route comparison drawer:** static-chart route vs forecast-aware route, scored on observed ice.
5. **About / data & provenance:** what's real vs simulated, dataset citations.

### 3.2 Main dashboard wireframe
```
┌───────────────────────────────────────────────────────────────────────────────────┐
│ ❄ PolarRoute DSS │ Cape Town → Bharati → Maitri │ Date: 15 Jan 2023 │ [REAL DATA] │
├────────────────┬──────────────────────────────────────────────────┬───────────────┤
│ LAYERS         │                                                  │ ROUTE         │
│ ☑ Sea ice (obs)│           Polar-stereographic map                │ Ship: RV Polar│
│ ☑ Forecast     │     (ice raster, ice-edge contour,               │  Explorer(PC6)│
│ ☐ Error vs obs │      icebergs + cones, stations,                 │ ─ ─ ─ ─ ─ ─ ─ │
│ ☑ Uncertainty  │      routes)                                     │ Safety ▮▮▮▯▯  │
│ ☑ Icebergs     │                                                  │ Fuel   ▮▮▯▯▯  │
│ ☑ Routes       │                                                  │ Time   ▮▯▯▯▯  │
│                │                                                  │ ─ ─ ─ ─ ─ ─ ─ │
│ [Obs|Forecast] │                                                  │ Forecast route│
│  ◄── swipe ──► │                                                  │  412 h  9,860 │
│                │                                                  │  km  ice 18 h │
│ Badges:        │                                                  │ Static route  │
│ REAL / DERIVED │                                                  │  431 h ... ice│
│ / SIMULATED    │                                                  │  61 h         │
│                │                                                  │ [Advance day ▶]│
├────────────────┴──────────────────────────────────────────────────┴───────────────┤
│ Timeline: ◄ D-3 D-2 D-1 [D0] +1 +2 +3 +4 +5 +6 +7 ►  ▶ Play    Lead-time skill: ▂▃▄▅ │
└───────────────────────────────────────────────────────────────────────────────────┘
```
*(Numbers above are placeholders — the real ones come out of your hindcast script.)*

### 3.3 Visual style
- Dark navy background, ice-blue → white concentration colormap (open water transparent so the land/ocean shows), thin white ice-edge contour at 15 %.
- Routes: **static-chart route** grey dashed; **forecast-aware route** bright cyan; alternates thin orange. Ship icon animates along the chosen route.
- Uncertainty: hatched or semi-transparent band on cells where expected error is high; icebergs get translucent cones.
- Badges on every layer legend: 🟢 REAL (satellite observation), 🔵 MODEL (trained on real data), 🟠 SIMULATED (scripted for illustration).
- Fonts/colors: any free web font (Inter/IBM Plex); keep contrast high for a projector.

---

## 4. How It Tackles the Problem

### 4.1 Problem statement → module → evidence
| Problem statement asks for | Demo module | What's shown as evidence |
|---|---|---|
| Forecast sea-ice concentration | Small U-Net, 7-day lead | Metrics vs 2 baselines on unseen years; swipe forecast/observed/error |
| Predict iceberg trajectories | Wind + current drift model + growing uncertainty cone | Backtest against one real tracked iceberg (or clearly labeled illustrative points) |
| Safe, fuel-efficient routes for research vessels | Time-dependent A\* on forecast cost grid, safety/fuel/time sliders, vessel classes | Live routing (<1 s) and hindcast scoring of route vs observed ice |
| Using satellite, oceanographic, meteorological data | SIC (satellite), ERA5 winds (meteorological), currents (oceanographic) | Data-source panel; wind ablation chart |

### 4.2 What "satellite images" means here (be ready to explain)
The NOAA/NSIDC CDR (G02202, now Version 5, 25 km polar grid, daily since 1978) is derived from **passive-microwave radiometers** (SMMR, SSM/I, SSMIS, and AMSR-family sensors). It's the standard gridded "image" of ice cover used in polar research and it works through clouds and polar night — which optical imagery cannot. Show one raw-looking daily map as "model input" on screen.
*Optional Tier-2 touch:* display one real Sentinel-1 scene (free from the Copernicus Data Space) as a static "future data source" card, labeled as such.

### 4.3 Demo flow (~6–7 min)
| Step | Time | What you show | What's real |
|---|---|---|---|
| 1. Problem | 0:30 | Static chart route vs reality: routing on climatology walks into ice | Route is real; the "climatology ice" is real averaged data |
| 2. Data → model | 1:00 | Input maps (last 7 days), how the model sees them, what it outputs | Real satellite data, real trained model |
| 3. Forecast + trust | 1:30 | Play 7-day forecast, swipe vs observed, error layer, validation drawer (model vs baselines) | Real, computed on held-out years |
| 4. Icebergs | 0:45 | Drift + cone, backtest number | Real physics-based rule; parameters stated |
| 5. Routing | 1:30 | Sliders → route changes live; static vs forecast-aware comparison scored on observed ice | Fully live |
| 6. Advance day | 0:45 | Click "Advance day": new observation arrives, model re-runs, route updates | Live (model inference + A\*) |
| 7. Close | 0:45 | Provenance table, roadmap slide | — |

---

## 5. The Small ML Model (the core feasibility proof)

### 5.1 Task definition
- **Input:** last **T = 7** daily sea-ice-concentration (SIC) maps + land/ocean mask + sin/cos of day-of-year (+ optional ERA5 wind channels, Tier 2).
- **Output:** SIC for the next **K = 7** days (7 output channels), predicted as **change from the last observed day** → `pred_k = clip(last + delta_k, 0, 1)`.
- **Region:** corridor crop of the NSIDC south grid covering roughly 10°W–90°E, 55°S–78°S. This works out to about **185 × 158 cells** (≈4,600 × 3,950 km); pad/crop to **184 × 160** so the U-Net's three down-samples divide evenly. *(Compute the exact window with `pyproj`; don't hardcode — see §5.3.)*
- Stations in this grid (EPSG:3412): Maitri ≈ (427.5 km, 2058.7 km), Bharati ≈ (2189.1 km, 537.9 km); grid indices before cropping ≈ (175, 91) and (245, 152) — sanity-check by plotting.

### 5.2 Data
| Item | Source | Access |
|---|---|---|
| Sea-ice concentration (daily) | NOAA/NSIDC CDR G02202 V5 (25 km, polar stereographic) | Public HTTPS directory at `noaadata.apps.nsidc.org/NOAA/G02202_V5/`. If a login prompt appears, a free NASA Earthdata account fixes it. |
| Near-real-time extension (optional) | NSIDC G10016 V3 | Same |
| Winds (Tier 2) | ERA5 via Copernicus Climate Data Store | Free account; personal access token in `~/.cdsapirc`; `pip install cdsapi`; accept the dataset licence |
| Currents (Tier 3, iceberg only) | Copernicus Marine (CMEMS) | Free account; `pip install copernicusmarine` |
| Land polygons | Natural Earth (public domain) or the dataset's own `surface_type_mask` | Direct download |

**Storage plan:** don't keep raw files. Loop: download a day → crop → append to one array → delete. 2000–2023 daily crops at 184×160 in float16 are roughly 0.5 GB total. (Raw file sizes are on the order of a MB each; check before bulk downloading.)
**Gotcha:** V5 reorganized variable names/groups. Open one file, print `ds.variables`, and confirm `cdr_seaice_conc` and the land/surface mask before writing the loop. NaN → 0, and keep a separate mask channel.

### 5.3 Preprocessing checklist
1. Read `x`, `y` coordinate arrays from a file (don't assume corners); confirm the 25 km spacing.
2. Compute the crop window from lon/lat corners:
   ```python
   from pyproj import Transformer
   t = Transformer.from_crs("EPSG:4326", "EPSG:3412", always_xy=True)
   # transform a lon/lat lattice over (-10..90E, -55..-78S); take min/max x,y; convert to indices
   ```
3. Stack into `sic[N, H, W]` (float16, 0–1), `dates[N]`, `land[H, W]`.
4. Plot a few days on the crop with land masked. If Antarctica looks mirrored or rotated, stop and fix the axes now.

### 5.4 Split (year-blocked — random splits leak because adjacent days are almost identical)
| Split | Years | Notes |
|---|---|---|
| Train | 2000–2018 (extend back to ~1990 if time) | ~6.9 k daily samples |
| Validation | 2019–2020 | pick epoch/thresholds here only |
| **Test** | **2021–latest available** | Includes the record-low 2023 summer; a hard, honest test. Never tune on it. |

Report two views: all-year, and **Dec–Mar (the actual shipping season)**. **Choose the demo scenario window before looking at test results** and always show the aggregate panel next to it, so the story isn't cherry-picked.

### 5.5 Baselines (fix the bar *before* training — Day 2)
- **B0 – Persistence:** `ŷ_k = x_T`.
- **B1 – Persistence + seasonal tendency:** `ŷ_k = x_T + Δclim(doy, k)`, where `Δclim` is the mean change over `k` days from that day-of-year across training years (smoothed ±7 days). Cheap and much stronger than B0.

### 5.6 Model (untested skeleton — run a shape check first)
```python
import torch, torch.nn as nn, torch.nn.functional as F

def block(i, o):
    return nn.Sequential(nn.Conv2d(i, o, 3, padding=1), nn.BatchNorm2d(o), nn.ReLU(inplace=True),
                         nn.Conv2d(o, o, 3, padding=1), nn.BatchNorm2d(o), nn.ReLU(inplace=True))

class SmallUNet(nn.Module):              # ~1.1 M params at base=24, in_ch=10
    def __init__(self, in_ch, out_ch=7, base=24):
        super().__init__()
        self.e1, self.e2, self.e3 = block(in_ch, base), block(base, 2*base), block(2*base, 4*base)
        self.b  = block(4*base, 8*base)
        self.u3 = nn.ConvTranspose2d(8*base, 4*base, 2, 2); self.d3 = block(8*base, 4*base)
        self.u2 = nn.ConvTranspose2d(4*base, 2*base, 2, 2); self.d2 = block(4*base, 2*base)
        self.u1 = nn.ConvTranspose2d(2*base, base, 2, 2);   self.d1 = block(2*base, base)
        self.head = nn.Conv2d(base, out_ch, 1)
    def forward(self, x):                # H, W must be multiples of 8
        e1 = self.e1(x); e2 = self.e2(F.max_pool2d(e1, 2)); e3 = self.e3(F.max_pool2d(e2, 2))
        b  = self.b(F.max_pool2d(e3, 2))
        d3 = self.d3(torch.cat([self.u3(b),  e3], 1))
        d2 = self.d2(torch.cat([self.u2(d3), e2], 1))
        d1 = self.d1(torch.cat([self.u1(d2), e1], 1))
        return self.head(d1)

# training step
last = x[:, T-1:T]                                   # [B,1,H,W] last observed SIC
pred = (last + model(x)).clamp(0, 1)                 # [B,K,H,W]
edge = ((y > 0.05) & (y < 0.95)).float()
w = ocean * (1 + 4 * edge)                           # emphasize the ice edge; `ocean` = [1,1,H,W] mask
loss = (w * (pred - y).abs()).sum() / w.sum()        # masked, edge-weighted L1

def iiee(pred, obs, ocean, thr=0.15, cell_km2=625.0):  # Integrated Ice-Edge Error (km²) per lead
    return (((pred > thr) != (obs > thr)) & ocean.bool()).sum((-2, -1)) * cell_km2
```
Training recipe: AdamW, lr 1e-3 with cosine decay, batch 16, ~20–25 epochs, mixed precision, fixed seed, early-stop on validation MAE (Dec–Mar). **No flips or rotations as augmentation** (they break geography and drift physics).
Expect roughly 15–30 min on a free GPU; a few hours on CPU (use `base=16`).

**Wind channels (Tier 2):** ERA5 gives east/north components. Rotate them into grid x/y using each cell's longitude (for a 0° central meridian, the rotation angle equals the longitude — verify the sign by plotting a vector field) and resample to the 25 km grid. Wrong rotation gives a model that "trains fine" but learns nonsense. Report the with/without-wind ablation in the validation drawer.

### 5.7 Metrics & go/no-go gate (decide now, write it in the README)
Metrics per lead day 1–7: **MAE (SIC %)**, **RMSE**, **IIEE at 15 % (km²)**, ice-extent error.
**Gate:** the U-Net passes if it beats **both** baselines on MAE in ≥ 4 of 7 lead days *and* IIEE ≤ B1's in ≥ 4 of 7, on the validation Dec–Mar subset. If it only beats B0, present it as "comparable to seasonal-tendency baseline, with lower error near the edge" only if the numbers say so. If it fails, ship B1 as the forecast, labeled honestly ("seasonal-tendency baseline; ML upgrade in progress") — the router, icebergs and UI don't change.
**Expectation-setting:** at 1–7 days, gains over persistence are typically modest and concentrated near the ice edge. Present the real numbers; don't quote a target you haven't measured.

### 5.8 Uncertainty (cheap, real)
For each lead and cell, compute mean absolute error on the validation set (Dec–Mar) → a **per-lead error map**. Display it as the uncertainty layer and feed it to the router's risk term. (MC-dropout is optional; if used, dropout must be explicitly active at inference — `model.eval()` disables it.)

### 5.9 Exports for the app
- For each demo date: `obs_D.png`, `pred_D_lead{1..7}.png`, `err_D_lead{1..7}.png`, plus a float32 `.npy` of predictions for the router. Use a fixed color map; make land/no-data transparent; store the crop extent (in metres) once in `meta.json`.
- `validation.json`: metrics per lead for U-Net, B0, B1 (and the wind ablation).

---

## 6. Iceberg Module (reduced but real)

- **Data:** use BYU/NIC tracked iceberg positions from the data plan for 1–3 large icebergs. If the download isn't quick, use clearly labeled representative starting points (badge: SIMULATED).
- **Drift rule of thumb (labeled as such, not calibrated):** `v_berg = v_current + α · R(θ) · U10`, with α ≈ 0.02 (about 2 % of wind speed) and θ ≈ 20–30° to the **left** of the wind in the Southern Hemisphere. Currents: CMEMS surface currents if you have them (Tier 3), otherwise a constant coastal westward drift in the East Wind Drift band, clearly stated.
- **Uncertainty cone:** radius grows with lead time; set growth from the backtest error rather than guessing.
- **Backtest (a real result):** pick one tracked iceberg over ~30 days; run 7-day predictions from several start dates; report mean position error after 1, 3, 7 days. Whatever the numbers are (probably tens of km or more), show them.
- **"Alert":** when the "Advance day" button reveals a tracked position that deviates from the forecast cone, the toast is real. If you don't have track data, the alert is scripted and badged SIMULATED.

---

## 7. Routing Module (the most interactive, most impressive part)

### 7.1 Design
- **Grid:** the same 25 km cells as the forecast crop; 8-connected moves.
- **Time-dependent cost:** the ship's speed in a cell depends on the **forecast for the day it arrives** (day index = hours elapsed ÷ 24).
- **Vessel classes (illustrative, not POLARIS-certified — SIC alone lacks ice type/thickness):** e.g., open-water ship (SIC < 15 %), "PC6-like" (passable up to ~70 % at reduced speed, speed factor falls linearly from 1.0 at 15 % to 0.2 at 70 %, impassable above).
- **Cost = time + λ · risk:** risk from SIC, distance to the ice edge, the uncertainty map (§5.8) and iceberg cones. Sliders set λ (safety), a fuel weight (fuel proxy ∝ distance × (1 + a·SIC²)), and time weight. Fuel is a proxy, say so.
- **Voyage legs:** Cape Town → 55°S (open-water segment, straight) → Bharati → Maitri → back to the ice edge. Real programme facts: shipping season roughly Nov–Mar; Cape Town→Bharati by ship takes about 10–12 days, Bharati↔Maitri 5–7 days depending on weather and ice (NCPOR expedition notes).

### 7.2 Reference implementation (tested on a synthetic 180×180 grid: ~0.2 s per route in pure Python)
```python
import heapq, math, numpy as np

def speed_factor(sic, max_sic=0.7):
    s = np.where(sic < 0.15, 1.0, 1.0 - 0.8 * (sic - 0.15) / (max_sic - 0.15))
    return np.where(sic > max_sic, 0.0, np.clip(s, 0.2, 1.0))

def astar(forecast, start, goal, cell_km=25.0, v_kmh=22.0, w_time=1.0, w_risk=0.0, risk=None):
    """forecast: [days,H,W] SIC 0..1. Cost = hours (+ optional risk penalty). Returns (path, cost)."""
    D, H, W = forecast.shape
    sf = [speed_factor(forecast[d]) for d in range(D)]
    h = lambda a, b: math.hypot(a[0]-b[0], a[1]-b[1]) * cell_km / v_kmh   # optimistic heuristic
    pq = [(h(start, goal), 0.0, start)]; best = {start: 0.0}; prev = {}
    moves = [(-1,0),(1,0),(0,-1),(0,1),(-1,-1),(-1,1),(1,-1),(1,1)]
    while pq:
        _, g, cur = heapq.heappop(pq)
        if cur == goal:
            path = [cur]
            while cur in prev: cur = prev[cur]; path.append(cur)
            return path[::-1], g
        if g > best.get(cur, 1e18): continue
        day = min(int(g // 24), D - 1)
        for dr, dc in moves:
            nr, nc = cur[0]+dr, cur[1]+dc
            if not (0 <= nr < H and 0 <= nc < W): continue
            v = v_kmh * sf[day][nr, nc]
            if v <= 0: continue
            dist = cell_km * math.hypot(dr, dc)
            step = w_time * dist / v + (w_risk * risk[day][nr, nc] * dist if risk is not None else 0.0)
            ng = g + step
            if ng < best.get((nr, nc), 1e18):
                best[(nr, nc)] = ng; prev[(nr, nc)] = cur
                heapq.heappush(pq, (ng + h((nr, nc), goal), ng, (nr, nc)))
    return None, None
```
Notes: keep the heuristic optimistic (open-water speed) so A\* stays correct; multiply the risk term so its units are comparable with hours; add unit tests (open ocean = straight line; a wall of impassable ice forces a detour; a lead that closes on day 3 changes the route).

### 7.3 Hindcast route evaluation (the demo's headline number)
1. Pick departure dates in the **test years** (fixed in advance).
2. **Static-chart route:** plan with climatological SIC for that day-of-year (mean over training years) — "what a planner without a forecast would do".
3. **Forecast-aware route:** plan with the model's forecasts (re-planned each simulated day from the newest observation).
4. **Score both against the observed ice** as the ship actually "sails": hours spent in cells with SIC > 40 %, cells above the vessel limit encountered (forced detours), total distance, fuel proxy, arrival time.
5. Report the mean over many departures, not just the showcase window, plus the showcase window on screen. Whatever it shows (including "no benefit in stable ice years"), show it — that is what makes the rest credible.

### 7.4 "Advance day" (replaces scripted replanning)
Button → date + 1 → load the new observed map → run one U-Net forward pass (milliseconds on CPU) → regenerate forecasts → re-run A\* from the ship's current position → animate the route change. All of it is live.

---

## 8. Architecture (Demo Build)

```
[offline pipeline: Python]                 [demo runtime: localhost]              [browser]
G02202 (+ERA5) → crop → Zarr/npy           FastAPI (uvicorn)                      Vite + React
   ↓ train (Kaggle) → model.pt   ──────►   /api/scenario                          OpenLayers + proj4
   ↓ export PNG/NPY/JSON                   /api/forecast/{date}?layer=&lead=      land = vector polygons
                                           /api/icebergs?date=                    ice = image overlays
                                           POST /api/route  (A* live)             sliders → POST /api/route
                                           POST /api/advance (model + A*)         charts (Chart.js or D3)
                                           /api/validation                        badges + drawers
                                           StaticFiles → serves the Vite build
```
- **Everything the demo needs is local:** one `uvicorn` process serving API + built frontend. Wi-Fi off must work (test it).
- **Static replay build (free hosted link):** the same frontend reads precomputed JSON/PNG from `/static/` instead of `/api/`, showing precomputed routes for a fixed slider grid; the UI shows a "Replay mode" chip. Host on GitHub Pages / Netlify / Cloudflare Pages.
- **Projection (OpenLayers):**
  ```js
  import proj4 from 'proj4'; import { register } from 'ol/proj/proj4'; import Projection from 'ol/proj/Projection';
  proj4.defs('EPSG:3412', '+proj=stere +lat_0=-90 +lat_ts=-70 +lon_0=0 +x_0=0 +y_0=0 +a=6378273 +b=6356889.449 +units=m +no_defs');
  register(proj4);
  const polar = new Projection({ code: 'EPSG:3412', units: 'm', extent: [-3950000, -3950000, 3950000, 4350000] });
  // ice layers: ImageStatic({ url, imageExtent: [xmin, ymin, xmax, ymax], projection: polar })
  // land/stations/routes: GeoJSON layers read in EPSG:4326 and reprojected by OpenLayers
  ```
  (Verify the extent constants against the `x`,`y` arrays in your file.)
- **Full-project stack (PostGIS, Celery/Redis, deck.gl, ConvLSTM, D\* Lite):** don't build it for the demo. Show it as the "Phase 2 architecture" slide and mention what each piece adds.

---

## 9. Free-Stack & Account Checklist (Day 0, ~2 hours)

| Need | Tool | Cost | Note |
|---|---|---|---|
| Sea-ice data | NSIDC G02202 V5 | ₹0 | Free NASA Earthdata account only if prompted |
| Winds | ERA5 / CDS | ₹0 | Register, create token, accept licence per dataset |
| Currents (optional) | Copernicus Marine | ₹0 | Free registration |
| Iceberg tracks | BYU / NIC | ₹0 | Check the current download page early |
| Training | Kaggle (or Colab) | ₹0 | Phone verification for Kaggle GPU |
| ML | PyTorch, xarray, netCDF4, pyproj, numpy | ₹0 | |
| Backend | FastAPI, uvicorn | ₹0 | |
| Frontend | Vite, React, OpenLayers, proj4, Chart.js/D3 | ₹0 | |
| Land outline | Natural Earth | ₹0 | Public domain |
| Hosting (optional) | GitHub Pages / Netlify | ₹0 | For the static replay only |
| Video backup | OBS Studio | ₹0 | 2-min screen recording |

**Attribution:** cite G02202 (NOAA/NSIDC), ERA5 (Copernicus/ECMWF), CMEMS and BYU/NIC in the About panel and README. It's required and it reads as professional.
**Don't rely on rate limits:** kick off ERA5 requests on Day 2 so they queue while you build the SIC pipeline.

---

## 10. Timelines

### 10.1 Solo, 15 working days (4–6 h/day)
| Day | Task | Done when |
|---|---|---|
| 0 | Accounts, repo, folder layout, README skeleton, choose scenario window (write it down), gate rules (§5.7) | Access confirmed |
| 1 | Download + crop G02202, build `sic` array, plot sanity checks | Crop looks right on a map |
| 2 | Baselines B0/B1, metric code (MAE/RMSE/IIEE), evaluation harness; start ERA5 requests | Baseline numbers exist |
| 3 | U-Net v1 (SIC only): dataset, train on Kaggle | First val numbers |
| 4 | Iterate once or twice (loss weights, epochs); go/no-go check | Pass/fail recorded |
| 5 | Wind channels (Tier 2) + ablation; freeze model; export test forecasts + error maps | `model.pt`, exports, `validation.json` |
| 6 | Router + cost grid + vessel classes + unit tests; climatology vs forecast route; hindcast script | Hindcast table produced |
| 7 | Iceberg drift + backtest + cone; FastAPI endpoints | `curl` returns route + icebergs |
| 8 | Frontend scaffold; **projection spike first** (OpenLayers + EPSG:3412, land polygons, one PNG overlay) | Map shows correctly |
| 9 | Ice layers, time slider, swipe (obs/forecast/error), uncertainty, stations | Forecast playable |
| 10 | Route panel: sliders, vessel switch, comparison cards, ship animation, Advance day | End-to-end live |
| 11 | Validation drawer (charts), badges, About/provenance, styling | UI complete |
| 12 | Integration, Wi-Fi-off test, performance, static replay export | Both modes work |
| 13 | Rehearsal 1 (timed), Q&A prep, fix list | Top bugs fixed |
| 14 | **Buffer** (use for anything slipped; otherwise Tier-2 backlog items) | — |
| 15 | Rehearsal 2, 2-min backup video, freeze | Demo-ready |

Every Friday-equivalent (Days 5, 10, 15) is a checkpoint: run the current build end-to-end even if ugly.

### 10.2 If you're 3 people
- **ML/data:** Days 1–5 (§5), then iceberg module (§6) and hindcast evaluation support.
- **Routing/backend:** Days 2–5 prototype on synthetic data, Days 6–10 real integration (§7, §8).
- **Frontend/design:** Days 1–4 projection spike + layout on mock JSON, then wire to real endpoints as they land.
Shared: Day 12 integration, Days 13–15 rehearsals.

### 10.3 Emergency cut: 7 days
Keep: SIC-only U-Net (Days 1–3), router + hindcast (Day 4), frontend with obs/forecast swipe + route sliders (Days 4–6), rehearsal (Day 7).
Cut first, in this order: wind channels → iceberg backtest (use labeled illustrative points) → validation charts (show a static PNG) → vessel classes (one class) → static replay mode → uncertainty layer.
Never cut: baselines + metrics, the hindcast route comparison, the provenance badges.

---

## 11. Brainstorm — Idea Backlog (value vs effort)

| Tier | Idea | Value | Effort |
|---|---|---|---|
| 1 (must) | Hindcast counterfactual route scoring | Very high | Low–Med |
| 1 | Forecast/observed/error swipe | High | Low |
| 1 | Validation drawer with baselines | High | Low |
| 1 | In-UI provenance badges | High (credibility) | Low |
| 1 | "Advance day" live replanning | High | Low |
| 2 | Wind-channel ablation chart ("meteorological data helps by X") | Med–High | Low (after Day 5) |
| 2 | Safety–fuel–time trade-off plot (Pareto points from slider sweep) | Med | Low |
| 2 | Auto-generated one-page "captain's briefing" (HTML print-to-PDF) | Med–High for logistics story | Low |
| 2 | Three-leg voyage (Cape Town → Bharati → Maitri → back) with leg ETAs | Med | Med |
| 2 | Ice-edge contour animation + "closing lead" highlight | Med | Low |
| 2 | Error-by-region view (where the model is weak) | Med | Low |
| 3 | Real Sentinel-1 scene card ("next data source") | Med | Med |
| 3 | India-specific data (ISRO/MOSDAC scatterometer or ocean products; verify availability and licence) | Med (local relevance) | Med–High |
| 3 | MapLibre globe intro shot | Low (wow) | Low–Med |
| 3 | D\* Lite incremental replanning | Low for demo | Med |
| 3 | Multi-vessel / Arctic (Northern Sea Route) generalization | Roadmap | High |

---

## 12. Honest Labeling (in-UI + one-page table)

Every layer legend carries a badge. Keep this table in the README and the About panel.

| Component | Badge | Reality |
|---|---|---|
| Observed sea-ice maps | 🟢 REAL | NSIDC G02202 passive-microwave SIC |
| Ice forecast | 🔵 MODEL | Small U-Net trained on 2000–2018, validated 2019–2020, tested 2021+; numbers shown on screen |
| Uncertainty layer | 🔵 DERIVED | Validation-set error maps |
| Iceberg drift | 🔵 DERIVED | Rule-of-thumb wind (+ current) drift; parameters stated; backtest shown |
| Iceberg "detection"/alert | 🟢 REAL or 🟠 SIMULATED | Real only if driven by a tracked position; otherwise scripted |
| Routing | 🔵 LIVE | Real A\* on the forecast grid; vessel limits are illustrative |
| Fuel | 🟠 PROXY | Simple function of distance and ice concentration |
| Vessel | 🟠 ILLUSTRATIVE | Fictional ship, PC6-like limits |

Presenter language: "prototype demonstrating the approach on historical data", not "ready for deployment".

---

## 13. Risks (short register)

| Risk | Likelihood | Mitigation |
|---|---|---|
| Model doesn't beat both baselines | Medium | Gate + honest fallback (§5.7) |
| NSIDC V5 file layout differs from expectations | Medium | Inspect one file on Day 1; adapt loader |
| Projection/axis confusion (mirrored map) | Medium | Plot early; check station positions against known coordinates |
| Wind rotation wrong | Medium | Plot vector field; ablation must show sensible effect |
| ERA5 queue slow | Medium | Start Day 2; Tier 2 only |
| Free GPU unavailable | Low–Med | Kaggle + Colab + CPU (`base=16`) |
| A\* too slow on a bigger grid | Low | 0.2 s at 180×180 in pure Python; use `scipy.sparse.csgraph` or Numba if needed |
| Demo laptop/browser issue | Low | Static replay + 2-min screen recording |
| Question you can't answer | Medium | Prep sheet below |

---

## 14. Q&A Prep

| Likely question | Honest answer |
|---|---|
| "Is this live?" | "The routing and day-advance are live. Forecast images for the replay dates were precomputed with the same model to save waiting time." |
| "What's the skill?" | Quote the numbers from the validation drawer, vs both baselines and by lead day. |
| "Why passive microwave and not optical/SAR?" | Works through cloud/polar night, daily basin-wide coverage; SAR is the planned higher-resolution upgrade. |
| "25 km is coarse for a ship." | Yes — strategic (days-ahead) planning grid; tactical navigation needs SAR/high-res and on-board ice pilots. Roadmap covers that. |
| "How do you handle ice thickness?" | Not in this demo (SIC only). Roadmap: thickness products + POLARIS-style risk index. |
| "Does it generalize?" | Tested on unseen years in the Indian-sector corridor only; architecture is region-agnostic but unvalidated elsewhere. |
| "What's needed to make it operational?" | Roadmap: shadow-mode trial alongside a real voyage → live NRT feeds → SAR ingestion → higher-res models → user testing with NCPOR. |

---

## 15. Definition of Done

- [ ] Gate result recorded (pass or honest fallback), metrics visible in-app
- [ ] Baselines B0 and B1 shown next to the model, per lead and Dec–Mar
- [ ] Hindcast route comparison table generated over many test departures
- [ ] Router live, < 1 s on the demo laptop; unit tests pass
- [ ] Advance-day replanning works end to end
- [ ] Map correct (stations at right places), land vector layer, no external tile requests (check the browser network tab)
- [ ] Demo works with Wi-Fi off
- [ ] Badges on every layer; About panel with citations and disclaimer
- [ ] Static replay build deployed; 2-min backup video recorded
- [ ] Two timed rehearsals; Q&A sheet reviewed
