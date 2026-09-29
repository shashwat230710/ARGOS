# ARGOS Polar Navigation & Sea-Ice DSS — Datasets Documentation (`DATASETS.md`)

All domain datasets used by the **ARGOS** Polar Sea-Ice Forecasting, Iceberg Drift, 3D Topographic Map, and Ship Route Optimization system are organized in the `/datasets` directory.

---

## Summary Table of Active Datasets

| # | Dataset Name | File Path | Primary Role in Application | License / Access |
|---|---|---|---|---|
| 1 | **NOAA/NSIDC Passive Microwave Sea Ice Concentration V6 (G02202)** | `/datasets/nsidc_g02202_sic_config.json` | 25 km Polar Stereographic (`EPSG:3412`) daily sea-ice concentration grids (`160×184`), U-Net 7-day forecasting, and A* ship routing cost fields | Public Domain (NOAA / NSIDC) · `https://doi.org/10.7265/b18j-z797` |
| 2 | **Antarctic Research Stations, Staging Ports, Waypoints & Overland Traverses** | `/datasets/stations_and_waypoints.json` | Real-world coordinates, elevations, agencies, and overland ice-sheet / oasis roads for 7 stations/ports (`Bharati`, `Maitri`, `Davis`, `Mawson`, `Syowa`, `56°S Gate`, `Cape Town`) | CC-BY 4.0 (COMNAP & SCAR Composite Gazetteer of Antarctica) |
| 3 | **USNIC / BYU Scatterometer Tracked Antarctic Tabular Icebergs** | `/datasets/tabular_icebergs_usnic.json` | Real-world tabular icebergs (`D-28`, `B-22A`, `A-74`, `A-76A`) with dimensions, freeboard/draft, calving origin, and wind/current drift forcing | U.S. Government Public Domain (USNIC / BYU SCP) |
| 4 | **East Antarctica Digital Elevation Model (BedMachine v3 / REMA) & Bathymetry (IBCSO v2)** | `/datasets/antarctic_geography_dem.json` | 3D topographic mountain ranges (`Prince Charles Mts`, `Wohlthat Mts`, `Sør Rondane`, `Framnes Mts`, `Grove Mts`), floating ice shelves (`Amery`, `Lazarev`, `West`, `Fimbul`), glaciers, and ocean bathymetry | CC-BY 4.0 / NASA MEaSUREs Open Data (`https://doi.org/10.5067/FPSU0V1MWUB6`) |
| 5 | **Open-Access Polar Satellite & Oceanographic Catalog** | `/datasets/satellite_catalog.json` | Metadata catalog for NASA GIBS (`EPSG:3031/3412` MODIS/VIIRS & Blue Marble), Copernicus Sentinel-2, AMSR2 ASI (`6.25 km`), ECMWF ERA5 (`u10/v10`), and CMEMS / OSI SAF ice motion | Open Access / Public Domain |

---

## Detailed Dataset Specifications

### 1. NOAA/NSIDC Sea Ice Concentration Configuration & Harmonic Grid
* **Dataset Name:** NOAA/NSIDC Climate Data Record of Passive Microwave Sea Ice Concentration, Version 6 (`G02202`)
* **File Path:** `/datasets/nsidc_g02202_sic_config.json`
* **What It Contains:**
  * Projection parameters (`EPSG:3412` NSIDC Sea Ice Polar Stereographic South, standard parallel `70°S`, `25 km × 25 km` cell resolution).
  * Sub-grid crop dimensions (`160 rows × 184 cols`, spanning `10°W–100°E` and `55°S–78°S` across the Indian Ocean / East Antarctica sector).
  * Temporal window (`55` daily snapshots from `2022-12-01` to `2023-01-24`, default departure `D0 = 2023-01-10`).
  * Synoptic physical features (`cooperation_sea_ridge`, `enderby_cosmonaut_ridge`, `prydz_bay_polynya_lead`) and PC6 research vessel speed/resistance parameters (`RV Polar Explorer`, `max_sic = 0.70`, `heavy_ice_sic = 0.40`).
* **Where It Is Used in the Project:**
  * Loaded by `/server.ts` (`initGridAndData()`) to construct the `160 × 184` `EPSG:3412` coordinate arrays, daily observed sea-ice concentration tensors, historical climatology tensors, and 15% / 40% ice-edge contours.
  * Fed into `/polarUnet.ts` (`PolarUNet`) as the 10-channel input tensor (`7` historical daily SIC maps + `ocean_mask` + `sin(DOY)` + `cos(DOY)`) to predict 7-day sea-ice concentration residuals.
  * Used by `/src/Map3DView.jsx` and `/src/App.jsx` to render both the 3D floating sea-ice relief mesh and the 2D polar stereographic raster layer.
* **Important Columns / Features:**
  * `epsg_code`, `proj4_def`, `cell_m` (`25000`), `crop_h` (`160`), `crop_w` (`184`), `t_in` (`7`), `k_out` (`7`), `ship.open_water_kmh` (`22.0`), `ship.max_sic` (`0.70`), `synoptic_features`.
* **Source / License:**
  * Meier, W. N., F. Fetterer, A. K. Windnagel, and J. S. Stewart (2021). *NOAA/NSIDC Climate Data Record of Passive Microwave Sea Ice Concentration, Version 6*. Boulder, Colorado USA. NSIDC. DOI: `https://doi.org/10.7265/b18j-z797` (Public Domain).

---

### 2. Antarctic Research Stations, Staging Ports, Waypoints & Overland Traverses
* **Dataset Name:** COMNAP Antarctic Facilities & SCAR Composite Gazetteer Waypoints and Overland Traverses
* **File Path:** `/datasets/stations_and_waypoints.json`
* **What It Contains:**
  * Exact WGS84 coordinates (`lon`, `lat`), surface elevation (`elevation_m`), operating nation/agency, and operational role for **7 key stations and gates**:
    * `bharati` — Bharati Station, India (`NCPOR`, Larsemann Hills, Prydz Bay, `69.41°S, 76.20°E`, `42 m`)
    * `maitri` — Maitri Station, India (`NCPOR`, Schirmacher Oasis, Dronning Maud Land, `70.77°S, 11.73°E`, `117 m`)
    * `mawson` — Mawson Station, Australia (`AAD`, Holme Bay, `67.60°S, 62.87°E`, `15 m`)
    * `davis` — Davis Station, Australia (`AAD`, Vestfold Hills, `68.58°S, 77.97°E`, `18 m`)
    * `syowa` — Syowa Station, Japan (`NIPR`, East Ongul Island, Lützow-Holm Bay, `69.00°S, 39.58°E`, `29 m`)
    * `ice_entry` — 56°S Pack-Ice Entry Gate (`56.00°S, 52.50°E`, `0 m`)
    * `cape_town` — Cape Town Staging Port, South Africa (`33.92°S, 18.42°E`, `15 m`)
  * **5 Real-World Antarctic Roads & Overland Ice-Sheet Traverses (`roads_and_traverses`)**:
    * `Maitri–Novolazarevskaya Airfield Road & Lazarev Ice Shelf Haul Route`
    * `Larsemann Hills Station Road (Bharati ↔ Progress Airfield ↔ Plateau Route)`
    * `Vestfold Hills–Whoop Whoop Skiway Road (Davis Station)`
    * `Mawson–Framnes Mountains Glaciological Traverse`
    * `Syowa–Mizuho–Dome Fuji Inland Traverse Route`
* **Where It Is Used in the Project:**
  * Loaded by `/server.ts` and exposed via `/api/scenario` and `/api/route`.
  * Rendered in `/src/Map3DView.jsx` as 3D illuminated station beacons, coastal access roads/traverses on the 3D terrain, and searchable locations in the **Destination Selector & Location Search** bar.
  * Rendered in `/src/App.jsx` on the 2D OpenLayers chart and used as origin/destination endpoints for the time-dependent A* ship router.
* **Important Columns / Features:**
  * `waypoints[key]`: `lon`, `lat`, `elevation_m`, `name`, `country`, `agency`, `role`, `kind`.
  * `roads_and_traverses[]`: `id`, `name`, `type`, `surface`, `coordinates` (`[[lon, lat], ...]`).
* **Source / License:**
  * Council of Managers of National Antarctic Programs (COMNAP) Antarctic Facilities List (`https://www.comnap.aq`) & SCAR Composite Gazetteer of Antarctica (CC-BY 4.0).

---

### 3. USNIC / BYU Tracked Antarctic Tabular Icebergs
* **Dataset Name:** US National Ice Center (USNIC) & BYU Scatterometer Antarctic Tabular Iceberg Database
* **File Path:** `/datasets/tabular_icebergs_usnic.json`
* **What It Contains:**
  * Four named giant tabular icebergs tracked in the Indian Ocean / East Antarctica sector (`D-28 "Molar Berg"`, `B-22A Fragment`, `A-74 Sector`, `A-76A Residual`).
  * Physical dimensions (`size_nm`, `length_km`, `width_km`), 3D vertical geometry (`freeboard_m`, `draft_m`), calving ice shelf (`calved_from`), initial coordinates (`lon`, `lat`), and 10 m wind (`u10_e`, `u10_n`) + surface ocean current (`cur_e`, `cur_n`) velocity vectors.
* **Where It Is Used in the Project:**
  * Loaded by `/server.ts` (`driftIcebergs()`) to compute 5-day historical scatterometer tracks, 7-day physics-based Coriolis/Ekman drift trajectories, and growing uncertainty cones (`±12 km` to `±92.5 km`).
  * Used in `/server.ts` (`astar()`) to impose dynamic collision-avoidance cost penalties around tabular iceberg paths.
  * Rendered in `/src/Map3DView.jsx` as extruded 3D flat-topped tabular ice blocks with 3D drift trajectories and uncertainty corridors, and in `/src/App.jsx` on the 2D OpenLayers map.
* **Important Columns / Features:**
  * `id`, `name`, `size_nm`, `length_km`, `width_km`, `freeboard_m`, `draft_m`, `calved_from`, `lon`, `lat`, `u10_e`, `u10_n`, `cur_e`, `cur_n`.
* **Source / License:**
  * US National Ice Center (`https://usicecenter.gov/Products/AntarcticIcebergs`) & Brigham Young University Center for Remote Sensing (`https://www.scp.byu.edu/data/iceberg/`) — U.S. Government Public Domain.

---

### 4. East Antarctica Digital Elevation Model (DEM), Mountain Ranges, Glaciers & Bathymetry
* **Dataset Name:** NASA MEaSUREs BedMachine Antarctica v3 (`NSIDC-0756`), REMA DEM & IBCSO v2 Bathymetry
* **File Path:** `/datasets/antarctic_geography_dem.json`
* **What It Contains:**
  * `landmarks`: 18 real-world Southern Ocean seas, bays, continental regions, floating ice shelves, outlet glaciers (`Lambert Glacier`), and coastal mountain ranges with reference elevations (`-4,150 m` ocean floor to `+3,228 m` mountain summits).
  * `mountains`: 3D topographic Gaussian peak parameters (`lon`, `lat`, `peak_m`, `radius_lon`, `radius_lat`) for the **Prince Charles Mountains (`Mt. Menzies, 3,228 m`)**, **Wohlthat Mountains (`2,970 m`)**, **Sør Rondane Mountains (`3,180 m`)**, **Napier & Scott Mountains (`1,950 m`)**, **Framnes Mountains (`1,490 m`)**, and **Grove Mountains (`2,100 m`)**.
  * `ice_shelves`: Polygon coordinates, freeboard height (`48–65 m`), and ice thickness (`380–550 m`) for the **Amery Ice Shelf**, **Lazarev Ice Shelf**, **West Ice Shelf**, and **Fimbul Ice Shelf**.
* **Where It Is Used in the Project:**
  * Loaded by `/server.ts` to build the `160 × 184` elevation & bathymetry grid (`elevation_m` and `surface_type` per cell: `0 = Ocean`, `1 = Coastal Bedrock Oasis`, `2 = Grounded Ice Sheet / Mountain`, `3 = Floating Ice Shelf`) and `/api/land.geojson`.
  * Used by `/src/Map3DView.jsx` to displace vertices of the 3D terrain mesh, shade ocean depth vs. coastal rock vs. glacial ice shelves vs. snow-capped mountain ranges, and place 3D geographic labels.
  * Used by the **"Choose Where I Want to Go" Destination Inspector** to report the exact elevation/depth, surface classification, and nearest landmark for any user-selected point on the map.
* **Important Columns / Features:**
  * `landmarks[]`: `name`, `lon`, `lat`, `kind` (`ocean | sea | land | shelf | glacier | mountain`), `elevation_m`.
  * `mountains[]`: `id`, `name`, `lon`, `lat`, `peak_m`, `radius_lon`, `radius_lat`.
  * `ice_shelves[]`: `id`, `name`, `freeboard_m`, `thickness_m`, `coordinates`.
* **Source / License:**
  * Morlighem, M. et al. (2022). *MEaSUREs BedMachine Antarctica, Version 3*. Boulder, Colorado USA. NASA National Snow and Ice Data Center Distributed Active Archive Center. DOI: `https://doi.org/10.5067/FPSU0V1MWUB6` (CC-BY 4.0).

---

### 5. Open-Access Polar Satellite & Oceanographic Catalog
* **Dataset Name:** Polar Satellite & Reanalysis Reference Catalog
* **File Path:** `/datasets/satellite_catalog.json`
* **What It Contains:**
  * Provenance, spatial/temporal resolution, variable names, public HTTPS/WMS URLs, and DOIs for all 7 open-access satellite and Earth-observation sources integrated or referenced by ARGOS (including **NASA Earthdata GIBS Polar Stereographic WMS**, **Copernicus Sentinel-2**, **NOAA/NSIDC G02202 V6**, **AMSR2 ASI 6.25 km**, **ECMWF ERA5**, **CMEMS / OSI SAF**, and **BedMachine v3**).
* **Where It Is Used in the Project:**
  * Loaded by `/server.ts` and served via `/api/scenario` and `/api/ml/status` to populate the **Model & Datasets Studio** and **Data Provenance** drawers in the UI.
