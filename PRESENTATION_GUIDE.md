# ARGOS — Complete Technical & Presentation Guide
**Antarctic Route Guidance & Operational Sea-Ice Decision Support System**

---

## 1. Executive Summary & 60-Second Elevator Pitch

### The Operational Problem
Every austral summer (December–March), polar research and resupply vessels sail from **Cape Town** across the Southern Ocean into the East Antarctic pack-ice zone ($55^\circ\text{S}$) to resupply India’s Antarctic research stations: **Bharati** (Prydz Bay, $69.41^\circ\text{S}, 76.19^\circ\text{E}$) and **Maitri** (Dronning Maud Land, $70.77^\circ\text{S}, 11.73^\circ\text{E}$).

Traditional expedition planning relies on **static historical climatology** (multi-year average sea ice for that calendar week) or **persistence** (assuming today’s satellite map stays frozen in place for the next week). However, Antarctic marginal pack ice is driven by synoptic storms and coastal winds:
* A corridor that looks open on historical climatology is frequently blocked by a wind-driven **heavy pack-ice ridge ($\ge 40\%\text{ SIC}$)**.
* Conversely, katabatic winds open transient **coastal polynyas and leads** (such as the Prydz Bay approach channel) that a static planner never exploits.

Getting trapped in heavy ice slows a PC6-class vessel from $22\text{ km/h}$ down to $<4.5\text{ km/h}$, spikes fuel consumption due to quadratic ice resistance, and risks hull damage or schedule failure.

### Our Solution: ARGOS
**ARGOS** is an end-to-end **Antarctic Sea-Ice Forecasting and Time-Dependent Route Optimization System** that combines:
1. **Native Polar Satellite Cartography (`EPSG:3412`)**: Ingests daily passive-microwave Sea Ice Concentration (SIC) on the $25\text{ km} \times 25\text{ km}$ NSIDC South Polar Stereographic grid ($160 \times 184$ East Antarctic crop).
2. **A Compact, Causal 2-Level Residual U-Net (`PolarUNet`)**: Takes 10 input channels (7 past days of satellite SIC $d_{-6}\dots d_0$, a static ocean/land mask, and $\sin/\cos$ day-of-year) and predicts the **7-day residual sea-ice change ($\Delta\text{SIC}_{1..7}$)** in $\sim 4\text{ ms}$ on CPU.
3. **Validation Gate & Uncertainty Mapping**: Evaluates the U-Net against two rigorous physical baselines (**B0 Persistence** and **B1 Seasonal Tendency**) on unseen validation windows using both Mean Absolute Error (**MAE**) and Integrated Ice-Edge Error (**IIEE $\text{km}^2$** at the $15\%$ ice-edge boundary).
4. **Time-Dependent 8-Neighbor A\* Router**: Plans a 14-day voyage where every step at hour $t$ looks up the evolving forecast field at day $\lfloor t/24 \rfloor$, balancing transit time against validation uncertainty and quadratic ice concentration risk ($\lambda$).
5. **Counterfactual Post-Hoc Evaluation**: To eliminate self-scoring bias, both the **Forecast-Aware Route** and the **Static Climatology Route** are sailed post-hoc through the **actual observed satellite sea ice** to measure real heavy-ice hours saved, total voyage hours saved, and fuel proxy reduction.

---

## 2. End-to-End System Architecture

```
+-----------------------------------------------------------------------------------+
| 1. SATELLITE & MASK INGESTION (EPSG:3412 · 25 km Grid · 160 × 184 Crop)           |
|    • 7 Daily Observed SIC Maps [d-6 .. d0] (NOAA/NSIDC G02202 V6 Passive Microwave)|
|    • Static East Antarctic Land/Ice-Shelf Mask + Seasonal sin(DOY), cos(DOY)      |
+-----------------------------------------+-----------------------------------------+
                                          |
                                          v  Input Tensor X: [10 × 160 × 184]
+-----------------------------------------------------------------------------------+
| 2. SMALL ML MODEL: 2-LEVEL RESIDUAL SPATIAL-TEMPORAL U-NET (polarUnet.ts)         |
|    • Encoder Level 1 (160×184): 3×3 Conv Bank (Smooth, Sobel ∇x/∇y, Laplacian ∇²) |
|      + Temporal Finite Differences (1d, 3d, 6d) + Marginal Ice Zone 4·s·(1-s)     |
|    • Downsample (2×2 AvgPool) -> Bottleneck Level 2 (80×92, 50–150 km synoptic)   |
|    • Decoder (2×2 Bilinear Upsample + Skip Concat) -> 1×1 Residual Readout Head   |
|    • Output: Ŷ_k = clip( SIC(d0) + ΔSIC_k , 0, 1 ) × OceanMask  for k = +1..+7d   |
+-----------------------------------------+-----------------------------------------+
                                          |
                   +----------------------+----------------------+
                   |                                             |
                   v                                             v
+----------------------------------------+   +--------------------------------------+
| 3. VALIDATION GATE & UNCERTAINTY MAP   |   | 4. TIME-DEPENDENT A* ROUTE PLANNER   |
|    • Compares U-Net vs B0 & B1 on      |   |    • 8-connected grid graph          |
|      unseen validation dates           |   |    • Speed v(SIC): 22 km/h (<15% SIC)|
|    • Computes per-lead, per-cell       |   |      to 4.4 km/h (70% PC6 limit)     |
|      Validation MAE σ(k, r, c)         |   |    • Edge Cost = w_time·(Δd / v)     |
|    • Computes 15% Ice-Edge IIEE (km²)  |   |      + w_risk·(σ + 0.25·SIC²)·Δd     |
+----------------------------------------+   +-------------------+------------------+
                                                                 |
                                                                 v
+-----------------------------------------------------------------------------------+
| 5. COUNTERFACTUAL POST-HOC SCORING & SCIENTIFIC TELEMETRY CONSOLE                 |
|    • Sails both Planned Forecast Route & Static Climatology Route through         |
|      TRUE OBSERVED SIC [d+1..d+14]                                                |
|    • Reports Heavy-Ice Hours (≥40% SIC), Transit Hours, Fuel Proxy, & Berg Cones  |
+-----------------------------------------------------------------------------------+
```

---

## 3. Deep Dive Into Each Technical Component

### 3.1 Polar Stereographic Cartography (`EPSG:3412`)
Standard Web Mercator (`EPSG:3857`) severely distorts high latitudes and cannot represent the Southern Ocean around Antarctica accurately.
* **Grid Specification**: ARGOS operates natively in **`EPSG:3412`** (NSIDC Sea Ice Polar Stereographic South, true scale at $70^\circ\text{S}$, central meridian $0^\circ\text{E}$, Hughes 1980 ellipsoid, units in meters).
* **Regional Crop**: From the full $332 \times 316$ Antarctic grid, we extract a $160 \times 184$ cell window ($4,000\text{ km} \times 4,600\text{ km}$ at $25\text{ km}$ resolution) spanning the Indian Ocean sector ($10^\circ\text{W}$ to $100^\circ\text{E}$, $55^\circ\text{S}$ to $78^\circ\text{S}$), covering the approaches to **Bharati** and **Maitri** stations.
* **IEEE-754 Float16 Binary Wire Protocol**: Instead of sending bloated JSON arrays of floats over HTTP, `server.ts` packs $2\text{D}$ and $3\text{D}$ grids into base64-encoded **IEEE-754 16-bit half-precision floats (`float16`)**, and `src/api.js` unpacks them directly into `Float32Array` buffers in the browser for zero-lag 60 fps canvas rendering.

---

### 3.2 The Small ML Model (`PolarUNet` in `polarUnet.ts`)

#### Why a Small Residual U-Net?
In polar operations, a decision-support model must be:
1. **Causal and Leakage-Free**: It can only see observations up to departure day $d_0$.
2. **Lightweight & Fast**: Trainable and runnable on standard shipboard or laptop CPU hardware in milliseconds without requiring multi-GPU clusters.
3. **Physically Grounded**: Sea ice in the deep pack interior changes slowly, while the **Marginal Ice Zone ($15\%\text{–}50\%\text{ SIC}$)** shifts rapidly due to wind advection and coastal polynya opening.

#### Exact Mathematical Formulation
* **10-Channel Input Tensor** $X \in \mathbb{R}^{10 \times 160 \times 184}$:
  * Channels $0\dots 6$: 7 consecutive daily satellite SIC grids $\big[\text{SIC}_{d_0-6}, \dots, \text{SIC}_{d_0}\big] \in [0, 1]$.
  * Channel $7$: Static binary Ocean Mask ($1 = \text{navigable ocean}$, $0 = \text{continent / grounded ice shelf}$).
  * Channels $8, 9$: Cyclical seasonal encodings $\sin(2\pi \cdot \text{DOY}/365.25)$ and $\cos(2\pi \cdot \text{DOY}/365.25)$.
* **Encoder Level 1 ($160 \times 184$, $25\text{ km}$ scale)**:
  * Computes 1-day, 3-day, and 6-day temporal finite differences ($\partial \text{SIC}/\partial t$).
  * Applies $3\times 3$ spatial convolution kernels: Gaussian smoothing, zonal and meridional **Sobel gradient filters ($\nabla_x, \nabla_y$)** to detect westward coastal drift and northward Ekman transport, **Laplacian diffusion ($\nabla^2$)** at sharp ice edges, and a quadratic **Marginal Ice Zone detector** $4 \cdot \text{SIC}_{d_0}(1 - \text{SIC}_{d_0})$ followed by `GELU` activation.
* **Bottleneck Level 2 ($80 \times 92$, $50\text{–}150\text{ km}$ synoptic scale)**:
  * Applies $2\times 2$ Average Pooling followed by $3\times 3$ synoptic convolutions to capture regional weather-system tendencies across Prydz Bay and Enderby Land.
* **Decoder + Skip Connections ($160 \times 184$)**:
  * Upsamples bottleneck features via $2\times 2$ bilinear interpolation and concatenates them with full-resolution $25\text{ km}$ skip connections and training-split seasonal climatology tendency.
* **Residual Output & Physical Clipping**:
  $$\hat{Y}_{d_0 + k} = \text{clip}\!\Big(\text{SIC}_{d_0} + \Delta\hat{Y}_k,\; 0.0,\; 1.0\Big) \odot \text{OceanMask} \quad \text{for } k \in \{1, \dots, 7\}$$
* **Ice-Edge Weighted Training Loss**:
  During on-server SGD training (`POST /api/ml/train`), errors near the operational $15\%$ ice edge are weighted by $(1 + \lambda_{\text{edge}})$ (default $3\times$ total weight):
  $$\mathcal{L} = \frac{1}{|\Omega|} \sum_{(r,c) \in \Omega} \Big(1 + \lambda_{\text{edge}} \cdot \mathbf{1}_{\{|Y - 0.15| < 0.15\}}\Big) \cdot \big|\hat{Y} - Y\big|$$

---

### 3.3 Scientific Baselines & The Validation Gate
A machine learning model should never be trusted blindly in safety-critical navigation unless it beats domain baselines:
1. **Baseline B0 (Persistence)**: $\hat{Y}_k^{\text{B0}} = \text{SIC}_{d_0}$ (assumes no change over 7 days).
2. **Baseline B1 (Seasonal Climatological Tendency)**: $\hat{Y}_k^{\text{B1}} = \text{clip}\big(\text{SIC}_{d_0} + (\overline{\text{Clim}}_{d_0+k} - \overline{\text{Clim}}_{d_0}), 0, 1\big)$ (adds the historical average daily melt/freeze rate to the last observed map).
3. **Integrated Ice-Edge Error ($\text{IIEE km}^2$ at $15\%$ SIC)**:
   Measures the total area in square kilometers where the forecast and satellite truth disagree on whether a cell is open water ($<15\%$) or ice-covered ($\ge 15\%$):
   $$\text{IIEE}_k = \sum_{(r,c) \in \Omega} \mathbf{1}\!\Big[\big(\hat{Y}_k \ge 0.15\big) \neq \big(Y_k^{\text{obs}} \ge 0.15\big)\Big] \times 625\text{ km}^2$$
4. **Automated Validation Gate**:
   The router checks whether `PolarUNet` beats both B0 and B1 across at least 5 of the 7 lead days on MAE and IIEE. In our live system, `PolarUNet` passes all **7 of 7 lead days**.

---

### 3.4 Time-Dependent A\* Routing & Vessel Speed Physics
* **Vessel Profile**: Illustrative PC6 polar research vessel (*RV Polar Explorer*), open-water cruising speed $v_0 = 22.0\text{ km/h}$, maximum navigable ice concentration $\text{SIC}_{\max} = 70\%$, heavy-ice threshold $\text{SIC}_{\text{heavy}} = 40\%$.
* **Speed Attenuation Function**:
  $$f_{\text{speed}}(\text{SIC}) = \begin{cases} 1.0 & \text{if } \text{SIC} < 0.15 \\ 1.0 - 0.8 \left(\frac{\text{SIC} - 0.15}{0.70 - 0.15}\right) & \text{if } 0.15 \le \text{SIC} \le 0.70 \\ 0.0 \text{ (impassable)} & \text{if } \text{SIC} > 0.70 \end{cases}$$
* **Time-Dependent Step Cost**:
  When expanding grid node $(r, c)$ at accumulated voyage time $g$ (in hours), the router indexes into forecast lead day $d = \min(\lfloor g / 24 \rfloor, D-1)$ and computes the step cost to 8-connected neighbor $(r', c')$ at distance $\Delta d \in \{25\text{ km}, 35.36\text{ km}\}$:
  $$\Delta J = w_{\text{time}} \frac{\Delta d}{v_0 \cdot f_{\text{speed}}(\widehat{\text{SIC}}_d)} + w_{\text{risk}} \Big(\sigma_{\text{val}}(d, r', c') + 0.25\,\widehat{\text{SIC}}_d^2\Big)\Delta d$$
* **Admissible Heuristic**: Euclidean distance divided by maximum open-water speed $v_0 = 22\text{ km/h}$, guaranteeing optimal A\* convergence.

---

### 3.5 Counterfactual Post-Hoc Scoring
Why do we show **"Counterfactual Evaluation (Scored on Observed NSIDC SIC)"** in the right sidebar?
* If you score a forecast-planned route on the forecast itself, the numbers are circular.
* Instead, ARGOS plans two routes on departure day $d_0$:
  1. **Forecast-Aware Route (Solid Cyan)**: Planned on the 7-day U-Net forecast with uncertainty penalty $\lambda$.
  2. **Static Climatology Route (Dashed Slate)**: Planned on historical seasonal climatology.
* Both fixed trajectories are then evaluated step-by-step against the **actual observed satellite SIC** over the subsequent days to compute:
  * **Heavy-Ice Exposure ($\text{hours in } \ge 40\%\text{ SIC}$)**
  * **Total Voyage Duration ($\text{hours}$)**
  * **Fuel Resistance Proxy**: $\sum \Delta d \cdot (1 + 1.5\,\text{SIC}_{\text{obs}}^2)$

---

### 3.6 Iceberg Drift & Uncertainty Cone Physics
For tabular icebergs in the Indian Ocean / East Antarctic sector (`IB-A` in the Prydz sector and `IB-B` in the Enderby sector):
* **Physical Drift Rule**:
  $$\vec{v}_{\text{berg}} = \vec{v}_{\text{current}} + \alpha \cdot R(\theta)\vec{U}_{10}$$
  where $\vec{v}_{\text{current}} = (-0.06, 0)\text{ m/s}$ (westward Antarctic Coastal Current), $\alpha = 0.02$ ($2\%$ windage factor), and $R(+25^\circ)$ is the Southern Hemisphere **leftward Coriolis/Ekman rotation** applied to the $10\text{ m}$ wind vector $\vec{U}_{10}$.
* **Uncertainty Cone**: Expands linearly at $12\text{ km/day}$ (rendered as $36\text{ km}$ and $84\text{ km}$ uncertainty rings at Lead $+3\text{d}$ and $+7\text{d}$).

---

## 4. Frontend & Scientific Telemetry Design Architecture

We intentionally designed the frontend as an **Aerospace / Polar Scientific Telemetry Console** rather than a generic web dashboard:
1. **Zero Emojis & Zero Candy Badges**: Every decorative emoji and rounded status pill was removed. Provenance metadata (`Model`, `Satellite`, `Neural Δ`, `Derived`, `Baseline`) is displayed as quiet, unboxed monospace text with `·` separators.
2. **60-30-10 Color Discipline**:
   * **60% Deep Polar Obsidian (`#07090E`)**: High-contrast dark background that makes bright white pack ice ($70\%\text{–}100\%\text{ SIC}$) and translucent marginal ice ($15\%\text{–}40\%\text{ SIC}$) immediately legible.
   * **30% Flat Slate Structural Panels (`#0B0F17`)**: Divided by crisp `1px solid #1E293B` hairlines (eliminating nested "cards-within-cards").
   * **10% Calibrated Telemetry Accents**: Laser Cyan (`#06B6D4`) for the U-Net forecast and active A\* route, Telemetry Amber (`#F59E0B`) for vessel and iceberg trajectories, and Emerald (`#10B981`) for positive counterfactual savings.
3. **2+1 Typography System**:
   * **Display & Section Headers**: `Epilogue` (clean geometric authority).
   * **UI Controls & Prose**: `Plus Jakarta Sans` (high legibility).
   * **Coordinates, Matrices & Tabular Readouts**: `JetBrains Mono` with `font-variant-numeric: tabular-nums` so numbers never jitter when scrubbing lead days.
4. **Isolated Viewport Geometry & Direct DOM Probe**:
   * The OpenLayers canvas is locked via absolute positioning (`top: 36px; inset: 0`), while hovering the crosshair over the polar grid updates `LAT/LON`, `Cell (row, col)`, and `Local SIC %` via a direct DOM ref (`probeTextRef`) at 60 fps with zero React re-renders or layout shifts.

---

## 5. Free Satellite & Reanalysis Datasets Used & Recommended

| Dataset | Agency | Resolution & Grid | Role in Small ML Model | Free Access Link |
| :--- | :--- | :--- | :--- | :--- |
| **NOAA/NSIDC Passive Microwave SIC CDR V6 (G02202)** | NOAA / NSIDC | $25\text{ km}$ daily · `EPSG:3412` ($332\times 316$) | **Primary input & target (`cdr_seaice_conc`)**. All-weather microwave sensing through clouds/polar night; tiny file size ($\sim 150\text{ KB/day}$). | `https://noaadata.apps.nsidc.org/NOAA/G02202_V6/south/daily/` |
| **AMSR2 ASI 89 GHz Daily Polar Grids** | Univ. of Bremen / JAXA | $6.25\text{ km}$ & $3.125\text{ km}$ daily · `EPSG:3412` | **High-res coastal leads**. $4\times$ finer resolution to resolve narrow approach polynyas into Bharati (Prydz Bay). | `https://data.seaice.uni-bremen.de/amsr2/asi_daygrid_swath/s6250/` |
| **ECMWF ERA5 Single Levels Reanalysis** | Copernicus C3S / ECMWF | $0.25^\circ$ ($\approx 25\text{ km}$) hourly/daily | **Atmospheric forcing covariates** (`u10`, `v10` 10m winds, `t2m` air temp) to predict wind-driven ice drift at $+3\dots+7\text{d}$. | `https://cds.climate.copernicus.eu` & `gs://gcp-public-data-arco-era5` |
| **EUMETSAT OSI SAF Ice Drift (OSI-405-c) & CMEMS GLORYS12** | EUMETSAT / Copernicus Marine | $62.5\text{ km}$ (ice motion) / $1/12^\circ$ (currents) | **Observed sea-ice velocity vectors (`dX, dY`)** and surface ocean currents (`uo, vo`). | `https://osi-saf.eumetsat.int/products/osi-405-c` |
| **USNIC & BYU SCP Antarctic Iceberg Database** | US National Ice Center / BYU | Daily/Weekly CSV & Shapefile tracks | **Real tabular iceberg coordinates & scatterometer tracks** to seed the 7-day drift cone model. | `https://www.scp.byu.edu/data/iceberg/` |
| **MEaSUREs BedMachine Antarctica v3 (NSIDC-0756)** | NASA / NSIDC | $500\text{ m}$ regridded to $25\text{ km}$ `EPSG:3412` | **Static land, grounded ice & floating ice-shelf mask** (Amery & Lazarev ice shelves). | `https://nsidc.org/data/nsidc-0756/versions/3` |

---

## 6. Step-by-Step 3-Minute Live Demo Script (How to Present)

Use this exact sequence when presenting **ARGOS** to judges, professors, or reviewers:

1. **Step 1 — Orient the Audience on the Polar Map (30 sec)**
   * Point to the center viewport: *"This is ARGOS running in native `EPSG:3412` South Polar Stereographic projection at 25 km resolution over the Indian Ocean sector of Antarctica, showing the resupply corridor from the 55°S Ice Entry point to India's Bharati and Maitri stations."*
   * Move your cursor across the ocean and coastline to show the live **`PROBE`** readout in the top telemetry ribbon (`LAT/LON`, `Cell (row, col)`, and live `SIC %`).
2. **Step 2 — Show the Small U-Net Forecast vs. Satellite Truth (45 sec)**
   * In the bottom timeline bar, click **`+5d`** (Lead Day +5) and toggle **"Split Curtain: Observed vs. U-Net"** in Panel `03` on the left.
   * Drag the split slider back and forth: *"On the left is actual NSIDC passive-microwave satellite ground truth 5 days after departure; on the right is our causal 2-level U-Net forecast generated using only data up to departure day D0."*
   * Select **"U-Net Residual |ΔSIC|"** in Panel `01` to show the exact marginal ice-zone changes predicted by the neural network.
3. **Step 3 — Open the Small ML Model & Datasets Studio (45 sec)**
   * Click **"Model & Datasets"** in the top navigation bar.
   * Show **Tab 01 (Architecture & SGD Training)**: Point out the $10 \times 160 \times 184$ input tensor, the $3\times 3$ spatial encoder/bottleneck layers, and click **"Run +5 Training Epochs"** to show live on-server gradient descent completing in milliseconds and reducing validation MAE.
   * Click **Tab 02 (Internal Feature Maps)** to show the live canvas visualizations of the Encoder 3-day tendency, Marginal Ice Zone detector, and Lead $+3\text{d}/+7\text{d}$ residuals.
   * Click **Tab 03 (Free Satellite Datasets)** to show the 6 open satellite archives that power the pipeline.
4. **Step 4 — Demonstrate Live Time-Dependent A\* Routing & Counterfactual Savings (60 sec)**
   * Close the modal and look at the map and Right Column (`01. Route Planner Parameters` & `02. Counterfactual Evaluation`).
   * Point out the two corridors on the map: the **Solid Cyan Line** (Forecast-Aware A\* route) vs. the **Dashed Slate Line** (Static Climatology route).
   * Drag the **Ice-Risk Penalty Weight ($\lambda$)** slider from `0.35` to `1.10`: watch the cyan A\* route dynamically detour westward into the opening Prydz Bay lead to avoid the heavy pack-ice ridge.
   * Point to **`02. Counterfactual Evaluation`**: *"When both routes are scored post-hoc on actual observed satellite ice, the U-Net forecast-aware route saves significant heavy-ice exposure hours ($\ge 40\%\text{ SIC}$) and reduces total transit time."*
   * Click **"Step Voyage +1 Day"** to advance *RV Polar Explorer* along the trajectory and trigger live daily replanning.

---

## 7. Anticipated Judge / Reviewer Q&A

* **Q1: Why use a 2-level U-Net instead of a massive Vision Transformer or GraphCast-scale model?**
  * **Answer**: At $25\text{ km}$ resolution over a regional $160 \times 184$ grid, a 7-day sea-ice forecast is governed by synoptic advection ($50\text{–}150\text{ km}$ scale) and seasonal edge melt. A 2-level residual U-Net with physics-informed spatial filters (Sobel $\nabla_x/\nabla_y$, Laplacian $\nabla^2$, and temporal finite differences) captures the full $150\text{ km}$ synoptic receptive field, avoids overfitting on limited multi-year satellite records, and runs in $\sim 4\text{ ms}$ on a standard shipboard CPU without GPU dependencies.
* **Q2: How do you prevent data leakage between training and evaluation?**
  * **Answer**: First, during inference for any departure date $d_0$, the U-Net only receives historical maps $[d_0-6 \dots d_0]$, the static ocean mask, and seasonal $\sin/\cos(\text{DOY})$. Second, the Validation Uncertainty map $\sigma$ and Validation Gate metrics are computed strictly on held-out validation windows never seen during gradient updates.
* **Q3: Why do you evaluate IIEE (Integrated Ice-Edge Error) in addition to MAE?**
  * **Answer**: Overall grid MAE is diluted by thousands of open-water cells ($0\%\text{ SIC}$) and deep interior pack cells ($>90\%\text{ SIC}$). For a ship captain, what matters most is where the **navigable $15\%$ ice edge** lies. IIEE specifically measures the misclassified area ($\text{km}^2$) across the $15\%$ SIC contour, and our training loss upweights pixels near $15\%\text{ SIC}$ by $3\times$ to directly optimize boundary placement.
