# ARGOS — Antarctic Route Guidance & Operational Sea-Ice Decision Support System

**ARGOS** is an interactive polar navigation, 3D Antarctic terrain/bathymetry visualization, satellite sea-ice forecasting, and time-dependent vessel route-planning prototype for East Antarctica & the Indian Ocean Sector (`10°W–100°E, 55°S–75°S`, native `EPSG:3412` South Polar Stereographic 25 km grid).

---

## 1. How the 3D Interactive Map Works (`src/Map3DView.jsx` & `src/App.jsx`)

ARGOS provides a dual-mode **3D Interactive Terrain & Satellite Map** (powered by **Three.js WebGL**) alongside a **2D Polar Stereographic Chart** (powered by **OpenLayers + proj4**), switchable at any time from the top **Map Control Bar**:

### Clear Visual Distinction of Polar Surfaces
The 3D mesh (`184 × 160` grid cells at 25 km resolution) displaces vertex elevation using a Digital Elevation & Bathymetry Model (`-4,200 m` abyssal ocean floor to `+3,420 m` East Antarctic mountain peaks) and classifies every cell into distinct physical surfaces:

1. **Southern Ocean & Bathymetric Depth (`surface_type = 0`, `< 15% SIC`)**:
   - Rendered with depth-graded abyssal-to-continental-shelf ocean colors and a translucent water plane at sea level (`0 m`).
2. **Dynamic Sea Ice (`15%–40% Marginal Ice` vs. `≥40% Heavy Pack-Ice Ridge`)**:
   - **Marginal Sea Ice (`15%–39% SIC`)**: Cyan-blue consolidated drift ice with animated 7-day sea-ice drift vectors and dashed 15% navigable ice-edge contours.
   - **Heavy Pack Ice (`≥40% SIC`)**: Elevated, ridged bright ice floes and rose-red hazard exclusion contours (`40% SIC`) that severely penalize or block standard polar vessels.
3. **Floating Glacial Ice Shelves (`surface_type = 3`)**:
   - Flat-topped glacial cliff step (`+80 m` to `+120 m` above sea level) with distinct cyan-tinted glacial ice shading for the **Amery Ice Shelf**, **Lazarev Ice Shelf**, **West Ice Shelf**, and **Fimbul Ice Shelf**.
4. **Coastal Bedrock Oases (`surface_type = 1`)**:
   - Exposed ice-free dark gneiss/granite coastal rock at **Larsemann Hills** (Bharati Station), **Schirmacher Oasis** (Maitri Station), **Vestfold Hills** (Davis Station), **Holme Bay** (Mawson), and **East Ongul Island** (Syowa).
5. **3D Mountains & Continental Ice Sheet (`surface_type = 2`)**:
   - Directional slope-shaded 3D relief rising up to `+3,420 m` across the **Prince Charles Mountains (Mt. Menzies, 3,228 m)**, **Wohlthat Mountains (Zwiesel Mtn, 2,970 m)**, **Sør Rondane Mountains (3,425 m)**, **Framnes Mountains**, and **Amery Oasis / Radok Lake**.
6. **Overland Traverses & Station Roads**:
   - Amber-dashed overland tractor/convoy corridors rendered directly over the 3D ice-sheet elevation (including the **India Bay → Maitri Schirmacher Traverse**, **Bharati → Progress-II Larsemann Road**, **Progress → Mirny Inland Tractor Traverse**, and **Mawson → Framnes Mountains Route**).
7. **Interactive 3D Markers & Real-Time Ship Telemetry**:
   - **6 Antarctic Research Stations & Gates**: 3D illuminated station towers (`Bharati`, `Maitri`, `Davis`, `Mawson`, `Syowa`, and `56°S Ice-Entry Gate`).
   - **3D Tabular Icebergs (`D-28`, `B-22A`, `A-74`)**: Scaled 3D flat-topped tabular ice blocks with 5-day historical scatterometer tracks and 7-day Coriolis/current forecast uncertainty cones.
   - **RV Polar Explorer & Optimal A* Corridor**: 3D icebreaker hull with dual expanding sonar beacon rings, completed emerald wake, luminous cyan forward corridor with real-time animated guidance chevrons, naive static climatology route, and amber dynamic course-correction deflection vectors (`CC-1..CC-4`).

### 3D Camera Controls
- **Orbit / Rotate**: Left-click + drag (or click `↺ Rotate` / `Tilt 3D` in the bottom-right 3D control bar).
- **Pan**: Right-click + drag (or `Shift` + Left-click + drag).
- **Zoom**: Mouse scroll wheel (or `+ Zoom` / `− Zoom` buttons).
- **Inspect Any Feature**: Click any station, iceberg, ship, course correction, or label to open the **Feature Telemetry Inspector**.

---

## 2. Satellite & Geographic Data Sources

ARGOS uses **100% open-access, public-domain / CC-BY scientific and satellite datasets** with **zero paid or commercial API keys required**:

1. **Satellite Imagery Basemap (`Satellite` Mode)**:
   - **Primary Open-Access Source**: **NASA Earthdata GIBS (Global Imagery Browse Services)** South Polar Stereographic WMS (`EPSG:3031` / `EPSG:3412` compatible) + **Copernicus Sentinel-2 / NASA MODIS True-Color & Sentinel-1 SAR Composite** synthesized directly over the 3D terrain mesh.
   - **Why selected**: Legally open-access (NASA EOSDIS / ESA Copernicus Open Access Policy), requires no API key or billing account, and works reliably both online and offline inside restricted network environments.
2. **Passive Microwave Sea-Ice Concentration (`NSIDC G02202 V6`)**:
   - Modeled on the **NOAA/NSIDC Climate Data Record of Passive Microwave Sea Ice Concentration, Version 6 (`EPSG:3412`, 25 km grid)**.
3. **3D Antarctic Elevation & Bathymetry (`Terrain DEM` Mode)**:
   - Modeled on **NASA MEaSUREs BedMachine Antarctica v3 / Reference Elevation Model of Antarctica (REMA)** and **IBCSO v2 (International Bathymetric Chart of the Southern Ocean)**.
4. **Tabular Icebergs (`USNIC / BYU`)**:
   - Real-world tracked tabular icebergs (**D-28**, **B-22A**, **A-74**) from the **US National Ice Center (USNIC)** and **BYU Scatterometer Iceberg Tracking Database**.
5. **Stations & Gazetteer (`COMNAP / SCAR`)**:
   - Official coordinates and station metadata from the **Council of Managers of National Antarctic Programs (COMNAP)** and **SCAR Composite Gazetteer of Antarctica**.

---

## 3. Dataset Organization (`/datasets` & `DATASETS.md`)

All datasets used by the application are organized in `/datasets/` and documented in detail in [`DATASETS.md`](./DATASETS.md):

| Dataset File | Description | Used In |
| :--- | :--- | :--- |
| `/datasets/stations_and_waypoints.json` | 6 Antarctic research stations/gates (`Bharati`, `Maitri`, `Davis`, `Mawson`, `Syowa`, `56°S Gate`) + 4 overland station roads/traverses | `server.ts`, `src/App.jsx`, `src/Map3DView.jsx` |
| `/datasets/tabular_icebergs_usnic.json` | USNIC/BYU tabular icebergs (`D-28`, `B-22A`, `A-74`) with dimensions, calving source, and drift speeds | `server.ts`, `src/App.jsx`, `src/Map3DView.jsx` |
| `/datasets/antarctic_geography_dem.json` | Coastline & ice-shelf polygons, 14 geographic landmarks, and 17 3D DEM mountain peaks & bathymetric trenches | `server.ts`, `src/Map3DView.jsx`, `src/App.jsx` |
| `/datasets/nsidc_g02202_sic_config.json` | Native `EPSG:3412` grid bounds, 25 km resolution, and PC6 vessel speed/risk parameters | `server.ts`, `polarUnet.ts`, `src/App.jsx` |
| `/datasets/satellite_catalog.json` | Open-access satellite dataset catalog (NSIDC G02202, OSI SAF, Copernicus Marine, Sentinel-1 SAR, NASA GIBS) | `server.ts`, `src/App.jsx` (Model & Datasets drawer) |

---

## 4. How Destination Selection ("Choose Where I Want to Go") Works

Users can select any custom destination directly on the 3D or 2D map or via the search bar:

1. **Click "Select Destination"**:
   - Click the **`◎ Select Destination`** button in the top Map Control Bar (or **`◎ Choose Destination on Map`** in the right-hand Route Planner panel).
2. **Click Anywhere on the 3D or 2D Map**:
   - Click any ocean point, coastal bay, ice shelf, or inland station on the 3D terrain mesh (raycasted in 3D space) or 2D chart.
3. **3D/2D Destination Pin & Telemetry Card**:
   - A glowing **3D Rose-Magenta Destination Beacon Pin** (and 2D marker) is placed at the clicked point.
   - The **Selected Destination Telemetry Card** displays:
     - **Latitude & Longitude** (`°S, °E/°W`) and grid cell `(row, col)`
     - **Nearest Real-World Feature / Station**
     - **Surface Classification** (`Open Southern Ocean`, `Marginal Sea Ice`, `Heavy Pack Ice`, `Floating Glacial Ice Shelf`, `Coastal Bedrock Oasis`, or `Continental Ice Sheet / Mountain`)
     - **Elevation / Ocean Depth** (`m`) and **Local Sea-Ice Concentration** (`% SIC`)
     - **Distance & ETA** from the ship's current/start location (`km`, `NM`, and estimated hours)
4. **Automatic & Confirmed A* Ship Routing**:
   - Selecting a point automatically stores the destination in application state (`customDestination`) and triggers `/api/route` to compute the optimal **Time-Dependent A* Avoidance Path** to that destination.
   - If the user selects an **inland or ice-shelf point**, the backend automatically snaps the vessel terminus to the nearest navigable coastal anchorage cell and renders a dashed **Overland Traverse Link** from the ship anchorage to the inland pin.
5. **Move or Clear Destination**:
   - Click **`Move Pin`** (or `Move Destination`) to place the pin somewhere else, or click **`× Clear Destination`** to remove the pin and return to the preset station leg.
6. **Search Location & Coordinate Navigator**:
   - Use the **Search input** in the Map Control Bar to search by name (`Bharati`, `Maitri`, `Amery`, `Menzies`, `D-28`) or type coordinates (`-68.5, 72.0`) and click **`Fly To`** or **`Route Here`**.

---

## 5. Environment Variables & How to Run

### Environment Variables
No external or paid API keys are required to run ARGOS. Optional configuration variables are documented in `.env.example`:
- `PORT=3000` (Express + Vite server port)

### Commands
```bash
# 1. Install dependencies
npm install

# 2. Start the full-stack development server on http://localhost:3000
npm run dev

# 3. Build production frontend bundle
npm run build
```
