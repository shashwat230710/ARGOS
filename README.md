<div align="center">

<img src="https://raw.githubusercontent.com/shashwat230710/ARGOS/main/iceberg_research_transparent_exact(1).svg" alt="ARGOS Iceberg Research Logo" width="190"/>

# ARGOS

### Antarctic Route Guidance & Operational Sea-Ice Decision Support System

**AI/ML-enabled decision support for Antarctic sea-ice forecasting, iceberg trajectory prediction, polar risk assessment, and time-dependent route planning**

<p>
  <a href="https://argosnova.ai.studio/">
    <img src="https://img.shields.io/badge/Live%20Demo-ARGOS-06B6D4?style=for-the-badge&logo=google-chrome&logoColor=white" alt="Live Demo"/>
  </a>
  <a href="https://github.com/shashwat230710/ARGOS">
    <img src="https://img.shields.io/badge/GitHub-Repository-181717?style=for-the-badge&logo=github&logoColor=white" alt="GitHub"/>
  </a>
  <img src="https://img.shields.io/badge/Status-Prototype-F59E0B?style=for-the-badge" alt="Prototype"/>
  <img src="https://img.shields.io/badge/License-Research%20Prototype-64748B?style=for-the-badge" alt="Research Prototype"/>
</p>

</div>

---

## Overview

ARGOS is a browser-based Antarctic navigation decision-support prototype developed around **Problem Statement 26059**:

> **AI-Enabled Antarctic Sea-Ice, Iceberg Trajectory, and Navigation Decision Support System**

The problem statement asks for an AI/ML-enabled platform that can forecast Antarctic sea-ice concentration, predict iceberg trajectories, and identify safer, fuel-efficient routes for research vessels using satellite, oceanographic, and meteorological data.

ARGOS addresses that requirement through one integrated workflow:

**Observed Sea Ice → PolarUNet Forecast → Validation & Uncertainty → Multi-Factor Risk → Time-Dependent A* Routing → Counterfactual Evaluation**

The current implementation is a research and demonstration system. It is intended to show the full decision pipeline and scientific concepts in an interactive interface, not to replace certified navigation systems.

**Problem Statement:** 26059  
**Organization:** Ministry of Earth Sciences (MoES)  
**Department:** National Centre for Polar and Ocean Research (NCPOR)  
**Category:** Software  
**Theme:** Transportation & Logistics  

---

## Quick Links

| Resource | Link |
|---|---|
| Live Application | https://argosnova.ai.studio/ |
| GitHub Repository | https://github.com/shashwat230710/ARGOS |
| Problem Statement | Problem Statement 26059 |
| Dataset Documentation | [`DATASETS.md`](./DATASETS.md) |
| Presentation Guide | [`PRESENTATION_GUIDE.md`](./PRESENTATION_GUIDE.md) |

---

## What ARGOS Does

### 1. Antarctic Sea-Ice Forecasting

ARGOS works on a native **NSIDC South Polar Stereographic grid (`EPSG:3412`)** with a **25 km cell size** over the East Antarctic and Indian Ocean sector used by the prototype.

The forecasting pipeline uses a compact, causal **2-level residual U-Net called `PolarUNet`**.

The model is designed around:

- **7 consecutive daily sea-ice concentration observations**
- **Static ocean/land mask**
- **Cyclical seasonal encoding using sin/cos day-of-year**
- **Spatial filters for smoothing, gradients, diffusion, and marginal ice detection**
- **7-day residual sea-ice prediction**
- **Physical clipping to the valid SIC range**

The project also exposes model inspection views so the user can examine intermediate feature maps and predicted residual fields.

### 2. Validation Against Scientific Baselines

ARGOS does not treat the neural model as a black box.

It compares `PolarUNet` with two explicit baselines:

**B0 Persistence**
```text
Forecast = Last observed SIC field
```

**B1 Seasonal Tendency**
```text
Forecast = Last observed SIC + historical seasonal tendency
```

Validation includes:

- Mean Absolute Error, MAE
- Integrated Ice-Edge Error, IIEE
- Per-lead-day comparison across the 7-day forecast horizon
- A validation gate used by the routing system
- Uncertainty estimates derived from validation behavior

### 3. Time-Dependent A* Route Planning

ARGOS uses an **8-neighbour time-dependent A\* planner**.

Unlike a static shortest-path calculation, the cost of moving through a cell depends on the estimated sea-ice conditions at the time the vessel reaches that cell.

The planner considers:

- Transit time
- Sea-ice concentration
- Vessel ice capability
- Validation uncertainty
- Iceberg hazard fields
- Heavy pack-ice avoidance
- Route risk weighting

The demonstration uses an illustrative **RV Polar Explorer** PC6 profile with an open-water speed of **22 km/h** and a configurable ice-risk penalty.

### 4. Multi-Factor Polar Risk

The application combines four risk components into a unified polar risk field:

| Risk Layer | What it Represents |
|---|---|
| Ice Risk | Sea-ice concentration, estimated ice thickness, and forecast uncertainty |
| Iceberg Risk | Tracked tabular icebergs and their projected uncertainty cones |
| Weather Risk | Wind forcing, coastal katabatic influence, and ice-related weather effects |
| Ocean Risk | Bathymetry, shoals, currents, and local marine conditions |
| Combined Risk | Operational synthesis classified as Safe, Caution, High, or No-Go |

### 5. Iceberg Trajectory Prediction

ARGOS includes tracked tabular iceberg records and a physics-based drift component.

The project includes examples such as:

- `D-28`
- `B-22A`
- `A-74`
- `A-76A`

The drift model uses:

- Surface current forcing
- 10 m wind forcing
- A windage factor
- Southern Hemisphere Coriolis/Ekman rotation
- Expanding uncertainty cones

These hazards can contribute to route penalties and are visualized directly in the map interface.

### 6. Interactive H3 Risk Grid

ARGOS includes an adaptive **Uber H3 hexagonal grid** powered by `h3-js`.

The H3 overlay:

- Adjusts resolution with map/camera zoom
- Aggregates local risk factors
- Displays risk classification per cell
- Provides a clickable inspection view for each H3 cell
- Shows risk, SIC, iceberg proximity, wind, current, and ocean context

### 7. 2D and 3D Antarctic Visualization

The interface combines two map modes:

**2D Polar Chart**
- OpenLayers
- `proj4`
- `EPSG:3412` projection
- Sea-ice fields
- Routes
- Stations
- Iceberg tracks
- Risk overlays
- H3 grid
- Search and destination selection

**3D Antarctic View**
- Three.js WebGL
- Terrain and bathymetry visualization
- Sea-ice relief
- Floating ice shelves
- Mountain ranges
- Research stations
- Tabular icebergs
- Ship position and route telemetry
- Interactive feature inspection

The landing page also provides an interactive visual introduction to the Antarctic navigation problem and ARGOS workflow.

---

## Core Workflow

```text
          SATELLITE / SCIENTIFIC INPUTS
                      |
                      v
        +----------------------------+
        |   Observed Sea-Ice Data    |
        |   25 km EPSG:3412 Grid     |
        +-------------+--------------+
                      |
                      v
        +----------------------------+
        |        PolarUNet           |
        |   7-day Sea-Ice Forecast   |
        +-------------+--------------+
                      |
             +--------+--------+
             |                 |
             v                 v
      Validation Gate    Forecast Uncertainty
             |                 |
             +--------+--------+
                      |
                      v
        +----------------------------+
        |    Multi-Factor Risk       |
        | Ice / Berg / Weather/Ocean  |
        +-------------+--------------+
                      |
                      v
        +----------------------------+
        |    Time-Dependent A*       |
        |   Risk-Aware Route Plan    |
        +-------------+--------------+
                      |
                      v
        +----------------------------+
        | Counterfactual Evaluation  |
        | Forecast Route vs Static   |
        +----------------------------+
```

---

## Key Features

| Feature | Description |
|---|---|
| Forecast-Aware Navigation | Route planning directly uses the evolving sea-ice forecast |
| Time-Dependent A* | Travel cost changes with forecast conditions at arrival time |
| Physics + ML | Compact neural forecasting combined with physical drift/risk logic |
| Uncertainty-Aware Routing | Validation-derived uncertainty contributes to route cost |
| Iceberg Avoidance | Projected iceberg positions and uncertainty cones contribute to hazard cost |
| Multi-Factor Risk | Ice, iceberg, weather, and ocean factors are combined |
| Adaptive H3 Grid | Interactive hexagonal aggregation of local polar risk |
| Counterfactual Evaluation | Planned routes can be scored against later observed sea-ice conditions |
| Destination Selection | User can select a custom destination directly from the map |
| Location Search | Stations, mountains, seas, ice shelves, glaciers, and icebergs are searchable |
| 2D + 3D Visualization | Scientific chart view and interactive Three.js terrain view |
| Model Inspection | Internal U-Net feature maps and residuals can be inspected |
| Live Training Demo | Server-side training endpoint demonstrates additional U-Net epochs |
| Scientific Telemetry | Route progress, heading, speed, SIC, risk, and position are surfaced in the UI |

---

## Data and Scientific Sources

The project organizes its data through the `/datasets` directory and documents the active datasets in [`DATASETS.md`](./DATASETS.md).

### Primary Project Datasets

| Dataset | Role in ARGOS |
|---|---|
| NOAA/NSIDC G02202 V6 | Primary 25 km sea-ice concentration field and forecast target |
| COMNAP / SCAR station references | Research stations, staging points, gates, and traverses |
| USNIC / BYU iceberg records | Tracked tabular iceberg inputs and drift seeds |
| BedMachine / REMA / IBCSO references | Terrain, ice shelves, mountain, and bathymetry context |
| Satellite and reanalysis catalog | Provenance and reference information for open scientific data |

### Referenced Open Scientific Data

The repository catalog also references:

- NOAA/NSIDC Passive Microwave Sea Ice Concentration CDR V6
- NASA Earthdata GIBS
- Copernicus Sentinel-2
- AMSR2 ASI
- ECMWF ERA5
- EUMETSAT OSI SAF
- Copernicus Marine / GLORYS12
- USNIC / BYU iceberg tracking data
- NASA MEaSUREs BedMachine Antarctica
- REMA
- IBCSO

See [`DATASETS.md`](./DATASETS.md) for the project-specific dataset organization, fields, roles, and source references.

---

## Repository Structure

```text
ARGOS/
├── datasets/
│   ├── antarctic_geography_dem.json
│   ├── nsidc_g02202_sic_config.json
│   ├── satellite_catalog.json
│   ├── stations_and_waypoints.json
│   └── tabular_icebergs_usnic.json
│
├── src/
│   ├── App.jsx
│   ├── LandingPage.jsx
│   ├── Map3DView.jsx
│   ├── api.js
│   ├── colormap.js
│   ├── main.jsx
│   ├── polarRiskAndH3.js
│   └── styles.css
│
├── .gitignore
├── DATASETS.md
├── PRESENTATION_GUIDE.md
├── README.md
├── bun.lock
├── index.html
├── metadata.json
├── package.json
├── polarUnet.ts
├── server.ts
└── vite.config.js
```

### Important Files

| File | Purpose |
|---|---|
| `server.ts` | Express backend, grid creation, datasets, forecasting, validation, iceberg logic, route planning, API endpoints |
| `polarUnet.ts` | Compact 2-level residual U-Net implementation and training logic |
| `src/App.jsx` | Main application state, map, route, forecasting, risk, H3, telemetry, and interaction logic |
| `src/Map3DView.jsx` | Three.js 3D Antarctic terrain, map interaction, routes, icebergs, ship, H3 overlay |
| `src/LandingPage.jsx` | ARGOS landing page and interactive project introduction |
| `src/polarRiskAndH3.js` | Vessel presets, risk classification, fuel/safety calculations, multi-factor risk, H3 aggregation |
| `src/api.js` | Client-side API helpers and float16 decoding |
| `src/styles.css` | Scientific telemetry console interface styling |
| `DATASETS.md` | Dataset organization and source documentation |
| `PRESENTATION_GUIDE.md` | Demo and presentation workflow |

---

## API Surface

The backend exposes the following main endpoints:

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/health` | Server health check |
| `GET` | `/api/scenario` | Main scenario configuration, metadata, map/grid information |
| `GET` | `/api/ml/status` | Model summary and validation information |
| `POST` | `/api/ml/train` | Run additional U-Net training epochs |
| `GET` | `/api/ml/inspect/:date` | Inspect model feature maps for a date |
| `GET` | `/api/grid` | Retrieve a selected map/risk grid layer |
| `GET` | `/api/forecast/:date` | Retrieve forecast, observations, baselines, residuals, and contours |
| `POST` | `/api/location-info` | Inspect a selected geographic point |
| `GET` | `/api/search-locations` | Search stations, landmarks, mountains, and icebergs |
| `POST` | `/api/route` | Compute forecast-aware and static routes |
| `POST` | `/api/advance` | Advance the ship state to the next day |
| `GET` | `/api/icebergs` | Retrieve iceberg positions and trajectory information |
| `GET` | `/api/validation` | Retrieve validation payload |
| `GET` | `/api/hindcast` | Retrieve post-hoc evaluation summary |
| `GET` | `/api/land.geojson` | Retrieve Antarctic land and ice-shelf GeoJSON |

---

## Vessel Profiles

The client contains configurable vessel presets for route and safety calculations:

| Profile | Class | Open-Water Speed | Max SIC | Max Ice Thickness |
|---|---:|---:|---:|---:|
| RV Polar Explorer | PC6 | 22 km/h | 70% | 1.2 m |
| SA Agulhas II Class | PC5 | 24 km/h | 80% | 1.5 m |
| Polar Heavy Icebreaker | PC3 | 26 km/h | 92% | 2.5 m |
| MV Antarctic Resupply | FSICR 1A | 19 km/h | 50% | 0.8 m |

These are application profiles used by the prototype's routing and risk calculations.

---

## Route Evaluation

ARGOS includes a counterfactual evaluation concept to avoid scoring a route only against the same prediction field used to plan it.

The system can compare:

**Forecast-Aware Route**
- Planned using the U-Net forecast
- Includes uncertainty-aware and iceberg-aware costs

**Static Route**
- Planned using the static climatological field
- Acts as the comparison path

The subsequent path evaluation can use observed sea-ice fields to derive metrics such as:

- Voyage duration
- Heavy-ice exposure
- Distance
- Fuel resistance proxy
- Route deviations
- Risk exposure

This creates a clearer separation between **planning inputs** and **post-hoc observed conditions**.

---

## Performance and Data Transport

ARGOS uses a lightweight client/server data path designed for large polar raster fields.

Large numeric grids are packed server-side into:

```text
IEEE-754 float16
        |
        v
Base64 payload
        |
        v
Browser Float32Array
```

This reduces JSON overhead while preserving a practical representation for browser-side visualization.

The frontend uses direct buffer-based rendering for large map fields and telemetry readouts.

---

## UI Design

ARGOS intentionally uses a scientific operations-console visual language rather than a conventional dashboard.

The interface emphasizes:

- Deep polar dark background
- Flat structural panels
- Cyan forecast and active-route telemetry
- Amber vessel and hazard signals
- Emerald positive evaluation metrics
- `Epilogue` for display text
- `Plus Jakarta Sans` for interface text
- `JetBrains Mono` for scientific telemetry and coordinates
- Minimal decorative UI
- 2D and 3D map synchronization

The goal is to keep scientific information visually clear while maintaining a research-navigation aesthetic.

---

## Installation

### Requirements

- Node.js
- npm

The project uses:

- React 18
- React DOM 18
- Express 4
- Three.js
- OpenLayers
- proj4
- h3-js
- Vite 5
- TypeScript
- tsx

### Install

```bash
npm install
```

### Start Development Server

```bash
npm run dev
```

The development server runs the application on:

```text
http://localhost:3000
```

### Build Frontend

```bash
npm run build
```

### Start Production Server

```bash
npm run start
```

### Preview Vite Build

```bash
npm run preview
```

---

## Environment

The current repository is structured so the core demo can run without paid third-party API keys.

The backend binds to port `3000` in the current project configuration.

The repository `.gitignore` excludes common local and generated files such as:

```text
node_modules/
.env
*.nc
dist/
.venv/
__pycache__/
```

---

## Demonstration Flow

A simple project walkthrough is:

### Step 1: Open the Antarctic Console

Start from the ARGOS landing page and enter the navigation console.

### Step 2: Inspect Sea Ice

Switch between observed sea ice, forecast fields, residual fields, and uncertainty.

### Step 3: Inspect the Model

Open the model/dataset tools to inspect the compact U-Net architecture, training history, and feature maps.

### Step 4: Configure Routing

Adjust the time/risk weighting and select a station or custom destination.

### Step 5: Compare Routes

Observe the forecast-aware route together with the static comparison route.

### Step 6: Inspect Polar Risks

Enable the multi-factor risk visualization and adaptive H3 grid.

### Step 7: Inspect Icebergs

View tracked tabular bergs, projected motion, and uncertainty cones.

### Step 8: Evaluate the Voyage

Use the route and counterfactual evaluation panels to inspect route duration, heavy-ice exposure, fuel proxy, and risk information.

A more detailed presentation sequence is available in [`PRESENTATION_GUIDE.md`](./PRESENTATION_GUIDE.md).

---

## Limitations

ARGOS is a **research prototype and decision-support demonstration**.

Important limitations include:

- Several fields are generated or modeled specifically for the prototype
- The current sea-ice demonstration dataset is bounded to the included temporal window
- Iceberg motion is represented by a compact physics-based prototype model
- Some environmental fields are derived rather than directly ingested at operational resolution
- The platform is not certified for real-world vessel navigation
- The illustrative vessel profiles are not substitutes for certified ship performance data

Use the project as a research, visualization, and engineering prototype.

---

## Research and Engineering Highlights

ARGOS brings together several ideas into a single workflow:

**Forecast-to-Route Integration**  
Sea-ice prediction is connected directly to route generation.

**Time-Aware A* Routing**  
Path cost changes as the vessel moves through forecast time.

**Physics + ML Ice Prediction**  
A compact residual U-Net is combined with domain-informed operations.

**Uncertainty-Aware Navigation**  
Validation behavior is converted into a spatially varying routing penalty.

**Explainable Route Selection**  
Route behavior is exposed through telemetry, risk layers, hazards, and route comparisons.

**Multi-Objective Route Optimisation**  
Transit time and environmental risk are jointly considered.

**Counterfactual Voyage Evaluation**  
The route planner is separated from later observed conditions for post-hoc assessment.

**Interactive Polar Visualization**  
2D, 3D, telemetry, H3 cells, stations, icebergs, and route data are available in one interface.

---

## Citation

If you use ARGOS in a report, demonstration, paper, or presentation, cite the project repository and the underlying datasets documented in [`DATASETS.md`](./DATASETS.md).

```text
ARGOS
Antarctic Route Guidance & Operational Sea-Ice Decision Support System
GitHub: https://github.com/shashwat230710/ARGOS
Live Demo: https://argosnova.ai.studio/
```

---

## Team

Developed for **Smart India Hackathon 2026**.

| Team Member | GitHub | LinkedIn |
|---|---|---|
| **Avanish Mishra** | [![GitHub](https://img.shields.io/badge/GitHub-181717?style=flat-square&logo=github&logoColor=white)](https://github.com/calsify) | [![LinkedIn](https://img.shields.io/badge/LinkedIn-0077B5?style=flat-square&logo=linkedin&logoColor=white)](https://linkedin.com/in/avanish-mishra-0ff1c1al/) |
| **Gyanendra Dubey** | [![GitHub](https://img.shields.io/badge/GitHub-181717?style=flat-square&logo=github&logoColor=white)](https://github.com/Gyanendra999) | [![LinkedIn](https://img.shields.io/badge/LinkedIn-0077B5?style=flat-square&logo=linkedin&logoColor=white)](https://www.linkedin.com/in/gyanendradubey08/) |
| **Mobashshir Ahsan** | [![GitHub](https://img.shields.io/badge/GitHub-181717?style=flat-square&logo=github&logoColor=white)](https://github.com/Mobasheera) | [![LinkedIn](https://img.shields.io/badge/LinkedIn-0077B5?style=flat-square&logo=linkedin&logoColor=white)](https://linkedin.com/in/mobashshir-ahsan/) |
| **Nikhil Kanojiya** | [![GitHub](https://img.shields.io/badge/GitHub-181717?style=flat-square&logo=github&logoColor=white)](https://github.com/404) | [![LinkedIn](https://img.shields.io/badge/LinkedIn-0077B5?style=flat-square&logo=linkedin&logoColor=white)](https://www.linkedin.com/in/nikhilkanojiya/) |
| **Shashwat Shukla** | [![GitHub](https://img.shields.io/badge/GitHub-181717?style=flat-square&logo=github&logoColor=white)](https://github.com/shashwat230710) | [![LinkedIn](https://img.shields.io/badge/LinkedIn-0077B5?style=flat-square&logo=linkedin&logoColor=white)](https://linkedin.com/in/shashwat-shukla23/) |
| **Sonal Devendra** | [![GitHub](https://img.shields.io/badge/GitHub-181717?style=flat-square&logo=github&logoColor=white)](https://github.com/404) | [![LinkedIn](https://img.shields.io/badge/LinkedIn-0077B5?style=flat-square&logo=linkedin&logoColor=white)](https://www.linkedin.com/in/sonal-devendra-30aa862b8/) |

---

<div align="center">

**ARGOS**  
*Antarctic navigation intelligence for safer, more informed voyage planning.*

</div>
