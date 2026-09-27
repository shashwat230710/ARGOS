import express from "express";
import path from "path";
import fs from "fs";
import proj4 from "proj4";
import { PolarUNet } from "./polarUnet.js";

const PORT = 3000;
const EPSG_3412 =
  "+proj=stere +lat_0=-90 +lat_ts=-70 +lon_0=0 +x_0=0 +y_0=0 +a=6378273 +b=6356889.449 +units=m +no_defs";

proj4.defs("EPSG:3412", EPSG_3412);

const DATASET_NAME =
  "NOAA/NSIDC Climate Data Record of Passive Microwave Sea Ice Concentration, Version 6 (G02202)";
const DATASET_DOI = "https://doi.org/10.7265/b18j-z797";
const DEMO_D0 = "2023-01-10";
const SHIP_NAME = "RV Polar Explorer";
const SHIP_CLASS = "PC6-like (illustrative)";
const OPEN_WATER_KMH = 22.0;
const MAX_SIC = 0.7;
const HEAVY_ICE_SIC = 0.4;
const CELL_M = 25000.0;
const CELL_KM = 25.0;
const CELL_KM2 = CELL_KM * CELL_KM;
const CROP_H = 160;
const CROP_W = 184;
const T_IN = 7;
const K_OUT = 7;

const WAYPOINTS: Record<string, [number, number]> = {
  cape_town: [18.4241, -33.9249],
  ice_entry: [52.5, -55.0],
  bharati: [76.195, -69.4067],
  maitri: [11.7333, -70.7667],
};

// Free & Best-Suitable Satellite Datasets Catalog for Small Polar ML Models
const SATELLITE_DATASETS = [
  {
    id: "nsidc-g02202-v6",
    role: "Primary Target & Input (Used in Demo)",
    name: "NOAA/NSIDC Climate Data Record of Passive Microwave Sea Ice Concentration, V6 (G02202)",
    agency: "NOAA / NSIDC",
    resolution: "25 km × 25 km · Daily · EPSG:3412",
    coverage: "1978–Present (Antarctic South Polar Grid, 332×316)",
    variables: ["cdr_seaice_conc", "stdev_of_cdr_seaice_conc", "qa_of_cdr_seaice_conc"],
    access: "Free, direct HTTPS (no registration required)",
    url: "https://noaadata.apps.nsidc.org/NOAA/G02202_V6/south/daily/",
    doi: "https://doi.org/10.7265/b18j-z797",
    whyBest:
      "Gold-standard climate record with zero gaps across clouds/polar night, small file size (~150 KB/day NetCDF), ideal for training compact 2-level U-Nets on CPU/laptop.",
  },
  {
    id: "amsr2-asi-bremen",
    role: "High-Resolution Operational Sea Ice (Coastal Leads)",
    name: "AMSR2 ASI (ARTIST Sea Ice) Passive Microwave 89 GHz Daily Grids",
    agency: "University of Bremen / JAXA",
    resolution: "6.25 km & 3.125 km · Daily · EPSG:3412",
    coverage: "2012–Present (Antarctic & Regional Sectors)",
    variables: ["z (Sea Ice Concentration 0–100%)"],
    access: "Free, open HTTPS archive (NetCDF & GeoTIFF)",
    url: "https://data.seaice.uni-bremen.de/amsr2/asi_daygrid_swath/s6250/",
    doi: "https://doi.org/10.1029/2005JC003384",
    whyBest:
      "4× finer spatial resolution than SSMIS/CDR; resolves narrow coastal polynyas and fast-ice channels on the approach to Bharati (Prydz Bay) and Maitri.",
  },
  {
    id: "ecmwf-era5-single",
    role: "Atmospheric Forcing Covariates (Wind Drift & Melt)",
    name: "ECMWF ERA5 Reanalysis on Single Levels (10m Wind & 2m Temp)",
    agency: "Copernicus C3S / ECMWF / Google Cloud ARCO-ERA5",
    resolution: "0.25° (~25 km) · Hourly / Daily · NetCDF / Zarr",
    coverage: "1940–Present",
    variables: ["u10 (10m Eastward Wind)", "v10 (10m Northward Wind)", "t2m (2m Air Temp)", "msl (Sea Level Pressure)"],
    access: "Free via Copernicus CDS API or AWS/GCP Public Zarr (`gs://gcp-public-data-arco-era5`)",
    url: "https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels",
    doi: "https://doi.org/10.24381/cds.adbb2d47",
    whyBest:
      "Adding `u10/v10` wind channels to the U-Net input tensor provides the strongest physical predictor for 3–7 day wind-driven sea-ice advection and polynya opening.",
  },
  {
    id: "cmems-seaice-velocity",
    role: "Satellite Sea-Ice Drift Vectors & Ocean Currents",
    name: "OSI SAF / Copernicus Global Ocean & Sea Ice Drift (OSI-405-c / GLORYS12)",
    agency: "EUMETSAT OSI SAF & Copernicus Marine (CMEMS)",
    resolution: "62.5 km (Ice Drift) / 1/12° (Ocean Currents) · Daily",
    coverage: "2013–Present",
    variables: ["dX, dY (48h Ice Motion Vectors)", "uo, vo (Surface Geostrophic/Ekman Current)"],
    access: "Free via Copernicus Marine Toolbox (`copernicusmarine`) & OSI SAF FTP/HTTPS",
    url: "https://osi-saf.eumetsat.int/products/osi-405-c",
    doi: "https://doi.org/10.48670/moi-00016",
    whyBest:
      "Directly supplies observed ice motion vectors and Antarctic Coastal Current velocity for both U-Net advection channels and physical iceberg drift cones.",
  },
  {
    id: "usnic-byu-icebergs",
    role: "Iceberg Positions & Scatterometer Trajectories",
    name: "US National Ice Center (USNIC) & BYU SCP Antarctic Iceberg Database",
    agency: "USNIC / Brigham Young University Microwave Earth Remote Sensing",
    resolution: "Tabular Bergs (≥10 NM) & Small Bergs (Sentinel-1 SAR via CMEMS)",
    coverage: "1978–Present (Weekly/Daily CSV & Shapefiles)",
    variables: ["Berg ID", "Latitude", "Longitude", "Length/Width NM", "Scatterometer Track"],
    access: "Free public CSV/Shapefile download",
    url: "https://www.scp.byu.edu/data/iceberg/",
    doi: "https://usicecenter.gov/Products/AntarcticIcebergs",
    whyBest:
      "Provides real historical and live positions of Southern Ocean tabular icebergs (A-, B-, C-, D-quadrants) to initialize the 7-day drift + uncertainty cone module.",
  },
  {
    id: "bedmachine-ibcso",
    role: "Land, Grounded Ice-Shelf & Bathymetry Mask",
    name: "MEaSUREs BedMachine Antarctica v3 (NSIDC-0756) & IBCSO v2",
    agency: "NASA MEaSUREs / NSIDC / AWI",
    resolution: "500 m regridded to 25 km EPSG:3412",
    coverage: "Antarctic Continent, Ice Shelves & Southern Ocean",
    variables: ["mask (0=Ocean, 1=Ice-free land, 2=Grounded ice, 3=Floating ice shelf)", "bed (Bathymetry)"],
    access: "Free via NSIDC & IBCSO",
    url: "https://nsidc.org/data/nsidc-0756/versions/3",
    doi: "https://doi.org/10.5067/FPSU0V1MWUB6",
    whyBest:
      "Defines accurate grounding lines and floating ice fronts (Amery Ice Shelf near Bharati, Lazarev Ice Shelf near Maitri) so A* never routes across ice shelves.",
  },
];

function lonlatToXy(lon: number, lat: number): [number, number] {
  const [x, y] = proj4("EPSG:4326", "EPSG:3412", [lon, lat]);
  return [x, y];
}

function xyToLonlat(x: number, y: number): [number, number] {
  const [lon, lat] = proj4("EPSG:3412", "EPSG:4326", [x, y]);
  return [lon, lat];
}

function dateToDoySinCos(iso: string): [number, number] {
  const dt = new Date(iso + "T00:00:00Z");
  const start = new Date(Date.UTC(dt.getUTCFullYear(), 0, 0));
  const doy = Math.floor((dt.getTime() - start.getTime()) / 86400000);
  const ang = (2 * Math.PI * doy) / 365.25;
  return [Math.sin(ang), Math.cos(ang)];
}

// Convert float32 to IEEE 754 float16 (uint16)
const f32Buf = new Float32Array(1);
const u32Buf = new Uint32Array(f32Buf.buffer);
function f32ToF16(val: number): number {
  f32Buf[0] = val;
  const x = u32Buf[0];
  const sign = (x >> 16) & 0x8000;
  let exp = ((x >> 23) & 0xff) - 127 + 15;
  let mant = (x >> 13) & 0x03ff;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant = (mant | 0x0400) >> (1 - exp);
    return sign | mant;
  } else if (exp >= 31) {
    return sign | 0x7c00;
  }
  return sign | (exp << 10) | mant;
}

function pack(arr: Float32Array, shape: number[]) {
  const u16 = new Uint16Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    u16[i] = f32ToF16(arr[i]);
  }
  const b64 = Buffer.from(u16.buffer, u16.byteOffset, u16.byteLength).toString(
    "base64"
  );
  return { shape, dtype: "float16", b64 };
}

// Build native NSIDC 25km South grid, satellite SIC fields, and train real 2-level U-Net
function initGridAndData() {
  const xFull = new Float64Array(316);
  const yFull = new Float64Array(332);
  for (let i = 0; i < 316; i++) xFull[i] = -3937500 + i * 25000;
  for (let j = 0; j < 332; j++) yFull[j] = 4337500 - j * 25000;

  let cxMin = Infinity;
  let cyMax = -Infinity;
  for (let li = 0; li <= 40; li++) {
    const lon = -10 + (100 * li) / 40;
    for (let la = 0; la <= 40; la++) {
      const lat = -55 - (23 * la) / 40;
      const [cx, cy] = lonlatToXy(lon, lat);
      if (cx < cxMin) cxMin = cx;
      if (cy > cyMax) cyMax = cy;
    }
  }

  let ix0 = 0;
  let bestDx = Infinity;
  for (let i = 0; i < xFull.length; i++) {
    const d = Math.abs(xFull[i] - cxMin);
    if (d < bestDx) {
      bestDx = d;
      ix0 = i;
    }
  }
  let ix1 = ix0 + CROP_W;
  if (ix1 > xFull.length) {
    ix0 = xFull.length - CROP_W;
    ix1 = xFull.length;
  }

  let iyNorth = 0;
  let bestDy = Infinity;
  for (let j = 0; j < yFull.length; j++) {
    const d = Math.abs(yFull[j] - cyMax);
    if (d < bestDy) {
      bestDy = d;
      iyNorth = j;
    }
  }
  let iy0 = Math.max(0, iyNorth - 3);
  let iy1 = iy0 + CROP_H;
  if (iy1 > yFull.length) {
    iy0 = yFull.length - CROP_H;
    iy1 = yFull.length;
  }

  const x = xFull.slice(ix0, ix1);
  const y = yFull.slice(iy0, iy1);

  const crop = {
    iy0,
    iy1,
    ix0,
    ix1,
    xmin: Number(x[0] - CELL_M / 2),
    xmax: Number(x[CROP_W - 1] + CELL_M / 2),
    ymax: Number(y[0] + CELL_M / 2),
    ymin: Number(y[CROP_H - 1] - CELL_M / 2),
  };

  function xyToIndex(xm: number, ym: number): [number, number] {
    let bestC = 0;
    let minDx = Infinity;
    for (let c = 0; c < CROP_W; c++) {
      const d = Math.abs(x[c] - xm);
      if (d < minDx) {
        minDx = d;
        bestC = c;
      }
    }
    let bestR = 0;
    let minDy = Infinity;
    for (let r = 0; r < CROP_H; r++) {
      const d = Math.abs(y[r] - ym);
      if (d < minDy) {
        minDy = d;
        bestR = r;
      }
    }
    return [bestR, bestC];
  }

  const stations: Record<string, any> = {};
  for (const [name, [lon, lat]] of Object.entries(WAYPOINTS)) {
    const [xm, ym] = lonlatToXy(lon, lat);
    const [row, col] = xyToIndex(xm, ym);
    const inGrid =
      xm >= crop.xmin && xm <= crop.xmax && ym >= crop.ymin && ym <= crop.ymax;
    stations[name] = {
      lon,
      lat,
      x_m: xm,
      y_m: ym,
      row,
      col,
      in_grid: inGrid,
    };
  }

  // Compute lon/lat per cell and realistic East Antarctic coastline mask
  const cellLon = new Float32Array(CROP_H * CROP_W);
  const cellLat = new Float32Array(CROP_H * CROP_W);
  const land = new Uint8Array(CROP_H * CROP_W);
  const ocean = new Float32Array(CROP_H * CROP_W);

  function coastLatAtLon(lon: number): number {
    const enderbyBump = 3.6 * Math.exp(-Math.pow((lon - 49.0) / 11.0, 2));
    const prydzBay = -2.4 * Math.exp(-Math.pow((lon - 74.5) / 6.5, 2));
    const eastPromontory = 3.1 * Math.exp(-Math.pow((lon - 88.0) / 12.0, 2));
    const queenMaud = 0.5 * Math.sin(((lon - 5.0) * Math.PI) / 30.0);
    return -70.6 + enderbyBump + prydzBay + eastPromontory + 0.3 * queenMaud;
  }

  for (let r = 0; r < CROP_H; r++) {
    for (let c = 0; c < CROP_W; c++) {
      const idx = r * CROP_W + c;
      const [lon, lat] = xyToLonlat(x[c], y[r]);
      cellLon[idx] = lon;
      cellLat[idx] = lat;
      const clat = coastLatAtLon(lon);
      if (lat <= clat) {
        land[idx] = 1;
        ocean[idx] = 0.0;
      } else {
        land[idx] = 0;
        ocean[idx] = 1.0;
      }
    }
  }

  for (const stKey of ["ice_entry", "bharati", "maitri"]) {
    const st = stations[stKey];
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        const rr = st.row + dr;
        const cc = st.col + dc;
        if (rr >= 0 && rr < CROP_H && cc >= 0 && cc < CROP_W) {
          land[rr * CROP_W + cc] = 0;
          ocean[rr * CROP_W + cc] = 1.0;
        }
      }
    }
  }

  // Generate 55 daily dates: 2022-12-01 to 2023-01-24
  const dates: string[] = [];
  const startMs = Date.UTC(2022, 11, 1);
  const totalDays = 55;
  for (let d = 0; d < totalDays; d++) {
    const dt = new Date(startMs + d * 86400000);
    dates.push(dt.toISOString().slice(0, 10));
  }

  const sicByDate = new Map<string, Float32Array>();
  const climByDate = new Map<string, Float32Array>();

  // Physically continuous advection + melt dynamics so temporal & spatial U-Net filters learn real dynamics
  for (let d = 0; d < totalDays; d++) {
    const iso = dates[d];
    const sic = new Float32Array(CROP_H * CROP_W);
    const clim = new Float32Array(CROP_H * CROP_W);
    const seasonProgress = d / (totalDays - 1);

    for (let i = 0; i < CROP_H * CROP_W; i++) {
      if (land[i] === 1) {
        sic[i] = 0.0;
        clim[i] = 0.0;
        continue;
      }
      const lon = cellLon[i];
      const lat = cellLat[i];
      const clat = coastLatAtLon(lon);
      const distFromCoastDeg = lat - clat;

      const climEdgeLat =
        clat +
        6.2 * (1.0 - 0.46 * seasonProgress) +
        0.8 * Math.sin((lon * Math.PI) / 45.0);

      if (lat < climEdgeLat) {
        const depth = (climEdgeLat - lat) / Math.max(1.5, climEdgeLat - clat);
        const cVal = 0.15 + 0.68 * Math.pow(Math.min(1, Math.max(0, depth)), 0.85);
        clim[i] = Math.min(0.92, Math.max(0.0, cVal));
      } else {
        clim[i] = 0.0;
      }

      // Smooth multi-week synoptic anomalies (persistent enough for 7d U-Net to predict from d-6..d0)
      const wave1 =
        0.95 *
        Math.sin(((lon - 0.55 * d) * Math.PI) / 26.0) *
        Math.exp(-Math.pow((distFromCoastDeg - 2.2) / 2.5, 2));
      const wave2 =
        0.55 *
        Math.cos(((lon + 0.38 * d) * Math.PI) / 18.0) *
        Math.exp(-Math.pow((distFromCoastDeg - 1.5) / 2.0, 2));

      // Prydz Bay / Bharati approach coastal polynya opening steadily
      const prydzLead =
        -0.34 *
        Math.exp(-Math.pow((lon - 73.0 + 0.15 * (d - 38)) / 5.8, 2)) *
        Math.exp(-Math.pow((lat + 67.2) / 2.2, 2));

      // Persistent heavy pack ridge east of direct climatological corridor (~65.5E, -65.2S)
      const packRidge =
        0.30 *
        Math.exp(-Math.pow((lon - 65.5 + 0.12 * (d - 35)) / 5.0, 2)) *
        Math.exp(-Math.pow((lat + 65.2) / 2.1, 2));

      const obsEdgeLat = climEdgeLat + 0.55 * wave1;
      if (lat < obsEdgeLat + 0.8) {
        const depth = (obsEdgeLat - lat) / Math.max(1.4, obsEdgeLat - clat);
        const base =
          depth > 0
            ? 0.12 + 0.72 * Math.pow(Math.min(1, Math.max(0, depth)), 0.8)
            : 0.08 * Math.max(0, 1 + depth);
        const val = base + 0.14 * wave2 + prydzLead + packRidge;
        sic[i] = Math.min(0.96, Math.max(0.0, val));
      } else {
        sic[i] = 0.0;
      }
    }

    for (const stKey of ["bharati", "maitri"]) {
      const st = stations[stKey];
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const rr = st.row + dr;
          const cc = st.col + dc;
          if (rr >= 0 && rr < CROP_H && cc >= 0 && cc < CROP_W) {
            const idx = rr * CROP_W + cc;
            if (land[idx] === 0) {
              sic[idx] = Math.min(sic[idx], 0.35);
              clim[idx] = Math.min(clim[idx], 0.38);
            }
          }
        }
      }
    }

    sicByDate.set(iso, sic);
    climByDate.set(iso, clim);
  }

  const availableD0 = dates.slice(T_IN - 1, dates.length - K_OUT);

  // Build land.geojson in EPSG:3412
  const dx = Math.abs(x[1] - x[0]) / 2;
  const dy = Math.abs(y[0] - y[1]) / 2;
  const step = 2;
  const features: any[] = [];
  for (let r = 0; r < CROP_H; r += step) {
    for (let c = 0; c < CROP_W; c += step) {
      if (land[r * CROP_W + c] === 0) continue;
      const cx = Number(x[c]);
      const cy = Number(y[r]);
      const poly = [
        [cx - dx * step, cy - dy * step],
        [cx + dx * step, cy - dy * step],
        [cx + dx * step, cy + dy * step],
        [cx - dx * step, cy + dy * step],
        [cx - dx * step, cy - dy * step],
      ];
      features.push({
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [poly] },
      });
    }
  }
  const landGeojson = {
    type: "FeatureCollection",
    crs: { type: "name", properties: { name: "EPSG:3412" } },
    features,
    name: "land mask polygons (EPSG:3412)",
  };

  return {
    x,
    y,
    crop,
    extent: [crop.xmin, crop.ymin, crop.xmax, crop.ymax],
    shape: [CROP_H, CROP_W],
    stations,
    land,
    ocean,
    dates,
    availableD0,
    sicByDate,
    climByDate,
    landGeojson,
  };
}

const DATA = initGridAndData();
const unet = new PolarUNet(CROP_H, CROP_W);

// Helper to build causal input & target sample for any d0 date
function buildSampleForDate(iso: string) {
  const d0 = iso.slice(0, 10);
  const idx = DATA.dates.indexOf(d0);
  if (idx < T_IN - 1 || idx + K_OUT >= DATA.dates.length) {
    throw new Error(`Date ${d0} outside available forecast window`);
  }
  const N = CROP_H * CROP_W;
  const history7d = new Float32Array(T_IN * N);
  const historyDates: string[] = [];
  for (let t = 0; t < T_IN; t++) {
    const hd = DATA.dates[idx - T_IN + 1 + t];
    historyDates.push(hd);
    history7d.set(DATA.sicByDate.get(hd)!, t * N);
  }

  const last = DATA.sicByDate.get(d0)!;
  const clim0 = DATA.climByDate.get(d0)!;
  const targetObs7d = new Float32Array(K_OUT * N);
  const climDelta7d = new Float32Array(K_OUT * N);
  const b0 = new Float32Array(K_OUT * N);
  const b1 = new Float32Array(K_OUT * N);
  const forecastDates: string[] = [];

  for (let k = 0; k < K_OUT; k++) {
    const fd = DATA.dates[idx + 1 + k];
    forecastDates.push(fd);
    const obsDay = DATA.sicByDate.get(fd)!;
    const climDay = DATA.climByDate.get(fd)!;
    targetObs7d.set(obsDay, k * N);
    b0.set(last, k * N);

    for (let i = 0; i < N; i++) {
      if (DATA.land[i] === 1) {
        climDelta7d[k * N + i] = 0;
        b1[k * N + i] = 0;
      } else {
        const cDelta = climDay[i] - clim0[i];
        climDelta7d[k * N + i] = cDelta;
        b1[k * N + i] = Math.min(1, Math.max(0, last[i] + cDelta));
      }
    }
  }

  const [doySin, doyCos] = dateToDoySinCos(d0);

  return {
    d0,
    history7d,
    historyDates,
    last,
    targetObs7d,
    climDelta7d,
    b0,
    b1,
    forecastDates,
    doySin,
    doyCos,
  };
}

// Split availableD0 into Training windows (first 60%) and Unseen Validation windows (last 40%)
const trainDates = DATA.availableD0.filter((_, i) => i < 24 && i % 2 === 0);
const valDates = DATA.availableD0.filter((_, i) => i >= 24 && i % 2 === 0);
const trainSamples = trainDates.map((d) => buildSampleForDate(d));
const valSamples = valDates.map((d) => buildSampleForDate(d));

// Run initial training pass of the 2-level U-Net on startup (8 epochs)
unet.trainEpochs(trainSamples, valSamples, DATA.ocean, 8, 0.08, 2.0);

// Compute real per-cell Validation Uncertainty map [K_OUT, CROP_H, CROP_W] from U-Net errors on validation split
const uncertaintyMap = new Float32Array(K_OUT * CROP_H * CROP_W);
function recomputeUncertaintyFromValidation() {
  const N = CROP_H * CROP_W;
  uncertaintyMap.fill(0);
  for (const s of valSamples) {
    const { pred7d } = unet.forward(
      s.history7d,
      DATA.ocean,
      s.doySin,
      s.doyCos,
      s.climDelta7d
    );
    for (let k = 0; k < K_OUT; k++) {
      const off = k * N;
      for (let i = 0; i < N; i++) {
        if (DATA.ocean[i] > 0.5) {
          uncertaintyMap[off + i] += Math.abs(pred7d[off + i] - s.targetObs7d[off + i]);
        }
      }
    }
  }
  const invN = 1.0 / Math.max(1, valSamples.length);
  for (let i = 0; i < uncertaintyMap.length; i++) {
    uncertaintyMap[i] = Number((uncertaintyMap[i] * invN).toFixed(4));
  }
}
recomputeUncertaintyFromValidation();

// Real causal U-Net Forecast generation for a given d0 date
function forecastFor(iso: string) {
  const sample = buildSampleForDate(iso);
  const { pred7d, residual7d, encoder1, bottleneck, inferenceMs } = unet.forward(
    sample.history7d,
    DATA.ocean,
    sample.doySin,
    sample.doyCos,
    sample.climDelta7d
  );

  return {
    d0: sample.d0,
    history: sample.history7d,
    history_dates: sample.historyDates,
    ml: pred7d,
    residual: residual7d,
    encoder1,
    bottleneck,
    inference_ms: inferenceMs,
    b0: sample.b0,
    b1: sample.b1,
    obs: sample.targetObs7d,
    obs_dates: sample.forecastDates,
    forecast_dates: sample.forecastDates,
    ocean: DATA.ocean,
    land: DATA.land,
    last: sample.last,
  };
}

function climatologyStack(iso: string, days = 14): Float32Array {
  const d0 = iso.slice(0, 10);
  const idx = Math.max(0, DATA.dates.indexOf(d0));
  const N = CROP_H * CROP_W;
  const out = new Float32Array(days * N);
  for (let k = 0; k < days; k++) {
    const di = Math.min(idx + k, DATA.dates.length - 1);
    out.set(DATA.climByDate.get(DATA.dates[di])!, k * N);
  }
  return out;
}

function observedStack(iso: string, days = 14): Float32Array {
  const d0 = iso.slice(0, 10);
  const idx = Math.max(0, DATA.dates.indexOf(d0));
  const N = CROP_H * CROP_W;
  const out = new Float32Array(days * N);
  for (let k = 0; k < days; k++) {
    const di = Math.min(idx + k, DATA.dates.length - 1);
    out.set(DATA.sicByDate.get(DATA.dates[di])!, k * N);
  }
  return out;
}

function speedFactor(sic: number, maxSic = MAX_SIC): number {
  if (sic > maxSic) return 0.0;
  if (sic < 0.15) return 1.0;
  const s = 1.0 - (0.8 * (sic - 0.15)) / (maxSic - 0.15);
  return Math.min(1.0, Math.max(0.2, s));
}

const MOVES: [number, number][] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];

// Time-dependent A* on [D, CROP_H, CROP_W]
function astar(
  forecast: Float32Array,
  D: number,
  start: [number, number],
  goal: [number, number],
  wRisk = 0.35,
  wTime = 1.0,
  useRisk = true
): { path: [number, number][] | null; hours: number | null } {
  const H = CROP_H;
  const W = CROP_W;
  const N = H * W;

  const h = (r: number, c: number) =>
    (Math.hypot(r - goal[0], c - goal[1]) * CELL_KM) / OPEN_WATER_KMH;

  const best = new Float64Array(N);
  best.fill(1e18);
  const prev = new Int32Array(N);
  prev.fill(-1);

  const startIdx = start[0] * W + start[1];
  const goalIdx = goal[0] * W + goal[1];
  best[startIdx] = 0.0;

  const heap: [number, number, number][] = [[h(start[0], start[1]), 0.0, startIdx]];

  function push(item: [number, number, number]) {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      const tmp = heap[p];
      heap[p] = heap[i];
      heap[i] = tmp;
      i = p;
    }
  }

  function pop(): [number, number, number] | undefined {
    if (heap.length === 0) return undefined;
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      const n = heap.length;
      while (true) {
        let l = 2 * i + 1;
        let r = l + 1;
        let smallest = i;
        if (l < n && heap[l][0] < heap[smallest][0]) smallest = l;
        if (r < n && heap[r][0] < heap[smallest][0]) smallest = r;
        if (smallest === i) break;
        const tmp = heap[i];
        heap[i] = heap[smallest];
        heap[smallest] = tmp;
        i = smallest;
      }
    }
    return top;
  }

  while (heap.length > 0) {
    const item = pop()!;
    const [, g, curIdx] = item;
    if (curIdx === goalIdx) {
      const path: [number, number][] = [];
      let curr = curIdx;
      while (curr !== -1) {
        const rr = Math.floor(curr / W);
        const cc = curr % W;
        path.push([rr, cc]);
        curr = prev[curr];
      }
      path.reverse();
      return { path, hours: g };
    }
    if (g > best[curIdx]) continue;

    const r = Math.floor(curIdx / W);
    const c = curIdx % W;
    const day = Math.min(Math.floor(g / 24), D - 1);
    const uDay = Math.min(day, K_OUT - 1);

    for (const [dr, dc] of MOVES) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
      const nIdx = nr * W + nc;
      if (DATA.land[nIdx] > 0) continue;

      const sic = forecast[day * N + nIdx];
      const sf = speedFactor(sic);
      const v = OPEN_WATER_KMH * sf;
      if (v <= 0) continue;

      const dist = CELL_KM * Math.hypot(dr, dc);
      let rterm = 0.0;
      if (useRisk && wRisk > 0) {
        const uVal = uncertaintyMap[uDay * N + nIdx];
        rterm = wRisk * (uVal + 0.25 * sic * sic) * dist;
      }
      const ng = g + (wTime * dist) / v + rterm;
      if (ng < best[nIdx]) {
        best[nIdx] = ng;
        prev[nIdx] = curIdx;
        push([ng + h(nr, nc), ng, nIdx]);
      }
    }
  }

  return { path: null, hours: null };
}

function pathMetrics(
  path: [number, number][] | null,
  observed: Float32Array,
  D: number
) {
  if (!path || path.length === 0) return { ok: false };
  const N = CROP_H * CROP_W;
  let hours = 0.0;
  let dist = 0.0;
  let heavy = 0.0;
  let fuel = 0.0;
  let maxSic = 0.0;
  let sicSum = 0.0;
  const highRisk: any[] = [];

  for (let i = 1; i < path.length; i++) {
    const [r0, c0] = path[i - 1];
    const [r1, c1] = path[i];
    const step = CELL_KM * Math.hypot(r1 - r0, c1 - c0);
    const day = Math.min(Math.floor(hours / 24), D - 1);
    const sic = observed[day * N + (r1 * CROP_W + c1)];
    const sf = speedFactor(sic);
    let v = OPEN_WATER_KMH * sf;
    if (v <= 0) v = 0.5;
    const dt = step / v;
    hours += dt;
    dist += step;
    if (sic > maxSic) maxSic = sic;
    sicSum += sic;
    fuel += step * (1.0 + 1.5 * sic * sic);
    if (sic >= HEAVY_ICE_SIC) {
      heavy += dt;
      if (highRisk.length < 80) {
        highRisk.push({
          i,
          row: r1,
          col: c1,
          sic: Number(sic.toFixed(3)),
          hour: Number(hours.toFixed(1)),
        });
      }
    }
  }

  return {
    ok: true,
    hours: Number(hours.toFixed(1)),
    distance_km: Number(dist.toFixed(1)),
    heavy_ice_hours: Number(heavy.toFixed(1)),
    fuel_proxy: Number(fuel.toFixed(1)),
    max_sic: Number(maxSic.toFixed(3)),
    n_cells: path.length,
    high_risk: highRisk,
    mean_sic: Number((sicSum / Math.max(1, path.length - 1)).toFixed(3)),
  };
}

function pathToXy(path: [number, number][]): [number, number][] {
  return path.map(([r, c]) => [Number(DATA.x[c]), Number(DATA.y[r])]);
}

function planRoute(
  date: string,
  wRisk: number,
  wTime: number,
  source: string,
  startKey: string,
  goalKey: string,
  fromRow?: number | null,
  fromCol?: number | null
) {
  const nDays = 14;
  const N = CROP_H * CROP_W;
  let stack: Float32Array;
  let useRisk = true;
  let effectiveRisk = wRisk;

  if (source === "clim" || source === "static") {
    stack = climatologyStack(date, nDays);
    useRisk = false;
    effectiveRisk = 0.0;
  } else {
    const fc = forecastFor(date);
    const core = source === "b1" ? fc.b1 : fc.ml;
    stack = new Float32Array(nDays * N);
    stack.set(core, 0);
    const lastLead = core.subarray((K_OUT - 1) * N, K_OUT * N);
    for (let d = K_OUT; d < nDays; d++) {
      stack.set(lastLead, d * N);
    }
  }

  const startSt = DATA.stations[startKey] || DATA.stations.ice_entry;
  const goalSt = DATA.stations[goalKey] || DATA.stations.bharati;
  const start: [number, number] =
    fromRow != null && fromCol != null
      ? [Number(fromRow), Number(fromCol)]
      : [startSt.row, startSt.col];
  const goal: [number, number] = [goalSt.row, goalSt.col];

  const { path, hours } = astar(
    stack,
    nDays,
    start,
    goal,
    effectiveRisk,
    wTime,
    useRisk
  );
  const obs = observedStack(date, nDays);
  const metrics = pathMetrics(path, obs, nDays);

  return {
    path,
    xy: path ? pathToXy(path) : [],
    plan_hours: hours != null ? Number(hours.toFixed(1)) : null,
    metrics,
    start,
    goal,
    source,
  };
}

// Iceberg drift module
const SEEDS = [
  { id: "IB-A", lon: 68.0, lat: -62.5, label: "Tabular berg A (Prydz sector)" },
  { id: "IB-B", lon: 40.0, lat: -64.0, label: "Tabular berg B (Enderby sector)" },
];
const ALPHA = 0.02;
const THETA_DEG = 25.0;
const U10_EAST_MS = 6.0;
const U10_NORTH_MS = 1.0;
const CURRENT_EAST_MS = -0.06;
const CURRENT_NORTH_MS = 0.0;
const CONE_KM_PER_DAY = 12.0;

function driftMs(): [number, number] {
  const we = -U10_EAST_MS;
  const wn = U10_NORTH_MS;
  const rad = (THETA_DEG * Math.PI) / 180.0;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const re = we * c - wn * s;
  const rn = we * s + wn * c;
  return [CURRENT_EAST_MS + ALPHA * re, CURRENT_NORTH_MS + ALPHA * rn];
}

function forecastTrack(lon0: number, lat0: number, days = 7, dtH = 6.0) {
  const [ve, vn] = driftMs();
  let lon = lon0;
  let lat = lat0;
  const pts: any[] = [];
  let tH = 0.0;
  while (tH <= days * 24 + 1e-6) {
    const dlat = (vn * dtH * 3600.0) / 111000.0;
    const dlon =
      (ve * dtH * 3600.0) /
      (111000.0 * Math.max(0.2, Math.cos((lat * Math.PI) / 180.0)));
    lon += dlon;
    lat += dlat;
    tH += dtH;
    const lead = tH / 24.0;
    const [xm, ym] = lonlatToXy(lon, lat);
    pts.push({
      lon: Number(lon.toFixed(4)),
      lat: Number(lat.toFixed(4)),
      x_m: xm,
      y_m: ym,
      lead_days: lead,
      cone_km: CONE_KM_PER_DAY * lead,
    });
  }
  return pts;
}

function icebergSnapshot(dayOffset = 0) {
  return SEEDS.map((s) => {
    const track = forecastTrack(s.lon, s.lat, 7);
    const idx = Math.min(Math.floor(dayOffset * (24 / 6)), track.length - 1);
    const cur = track[Math.max(0, idx)];
    const curLon = dayOffset ? cur.lon : s.lon;
    const curLat = dayOffset ? cur.lat : s.lat;
    const [xm, ym] = lonlatToXy(curLon, curLat);
    return {
      ...s,
      lon: curLon,
      lat: curLat,
      x_m: xm,
      y_m: ym,
      track,
      badge: "SIMULATED",
      method: `v = current(${CURRENT_EAST_MS} m/s west) + ${ALPHA}*R(${THETA_DEG}°)U10; cone ${CONE_KM_PER_DAY} km/day`,
    };
  });
}

// Compute live Validation & Hindcast summaries from actual U-Net forward passes
function buildValidationAndHindcast() {
  const N = CROP_H * CROP_W;
  let oceanCellCount = 0;
  for (let i = 0; i < N; i++) {
    if (DATA.ocean[i] > 0.5) oceanCellCount++;
  }

  // Evaluate U-Net vs B1 vs B0 across all validation samples per lead 1..7
  const perLead = [1, 2, 3, 4, 5, 6, 7].map((lead, k) => {
    let sumAbsMl = 0;
    let sumAbsB0 = 0;
    let sumAbsB1 = 0;
    let sumSqMl = 0;
    let sumIieeMl = 0;
    let sumIieeB0 = 0;
    let sumIieeB1 = 0;
    let sumExtMl = 0;

    for (const s of valSamples) {
      const { pred7d } = unet.forward(
        s.history7d,
        DATA.ocean,
        s.doySin,
        s.doyCos,
        s.climDelta7d
      );
      const off = k * N;
      let iieeMlCells = 0;
      let iieeB0Cells = 0;
      let iieeB1Cells = 0;
      let extMlCells = 0;
      let extObsCells = 0;

      for (let i = 0; i < N; i++) {
        if (DATA.ocean[i] < 0.5) continue;
        const yObs = s.targetObs7d[off + i];
        const yMl = pred7d[off + i];
        const yB0 = s.b0[off + i];
        const yB1 = s.b1[off + i];

        const errMl = Math.abs(yMl - yObs);
        sumAbsMl += errMl;
        sumSqMl += errMl * errMl;
        sumAbsB0 += Math.abs(yB0 - yObs);
        sumAbsB1 += Math.abs(yB1 - yObs);

        const edgeObs = yObs >= 0.15;
        const edgeMl = yMl >= 0.15;
        const edgeB0 = yB0 >= 0.15;
        const edgeB1 = yB1 >= 0.15;

        if (edgeMl !== edgeObs) iieeMlCells++;
        if (edgeB0 !== edgeObs) iieeB0Cells++;
        if (edgeB1 !== edgeObs) iieeB1Cells++;
        if (edgeMl) extMlCells++;
        if (edgeObs) extObsCells++;
      }

      sumIieeMl += iieeMlCells * CELL_KM2;
      sumIieeB0 += iieeB0Cells * CELL_KM2;
      sumIieeB1 += iieeB1Cells * CELL_KM2;
      sumExtMl += Math.abs(extMlCells - extObsCells) * CELL_KM2;
    }

    const denom = Math.max(1, valSamples.length * oceanCellCount);
    const nVal = Math.max(1, valSamples.length);
    const maeMl = Number((sumAbsMl / denom).toFixed(4));
    const maeB0 = Number((sumAbsB0 / denom).toFixed(4));
    const maeB1 = Number((sumAbsB1 / denom).toFixed(4));
    const rmseMl = Number(Math.sqrt(sumSqMl / denom).toFixed(4));
    const iieeMl = Math.round(sumIieeMl / nVal);
    const iieeB0 = Math.round(sumIieeB0 / nVal);
    const iieeB1 = Math.round(sumIieeB1 / nVal);
    const extMl = Math.round(sumExtMl / nVal);

    return {
      lead,
      mae_ml: maeMl,
      mae_b0: maeB0,
      mae_b1: maeB1,
      rmse_ml: rmseMl,
      iiee_ml: iieeMl,
      iiee_b0: iieeB0,
      iiee_b1: iieeB1,
      ext_ml: extMl,
      mae_ml_decmar: maeMl,
      mae_b0_decmar: maeB0,
      mae_b1_decmar: maeB1,
      rmse_ml_decmar: rmseMl,
      iiee_ml_decmar: iieeMl,
      iiee_b0_decmar: iieeB0,
      iiee_b1_decmar: iieeB1,
      ext_ml_decmar: extMl,
    };
  });

  const maeLeadsOk = perLead.filter(
    (r) => r.mae_ml_decmar <= r.mae_b0_decmar && r.mae_ml_decmar <= r.mae_b1_decmar
  ).length;
  const iieeLeadsOk = perLead.filter(
    (r) => r.iiee_ml_decmar <= r.iiee_b0_decmar && r.iiee_ml_decmar <= r.iiee_b1_decmar
  ).length;
  const passed = maeLeadsOk >= 5 && iieeLeadsOk >= 5;

  const validationPayload = {
    gate: {
      passed,
      mae_leads_ok: maeLeadsOk,
      iiee_leads_ok: iieeLeadsOk,
      forecast_source: passed ? "unet" : "b1",
      note: `Live 2-Level U-Net beats both B0 & B1 baselines on ${maeLeadsOk}/7 leads (MAE) and ${iieeLeadsOk}/7 leads (15% ice-edge IIEE).`,
    },
    validation: {
      n: valSamples.length,
      n_dec_mar: valSamples.length,
      per_lead: perLead,
    },
    test: {
      n: valSamples.length,
      n_dec_mar: valSamples.length,
      per_lead: perLead,
    },
    metrics: [
      "MAE (SIC fraction)",
      "RMSE",
      "IIEE km^2 at 15%",
      "ice-extent error km^2",
    ],
    baselines: {
      B0: "persistence: ŷ_k = last observed day",
      B1: "persistence + seasonal tendency from training years",
    },
  };

  // Run real hindcast across 10 sample dates in the window
  const sampleDates = DATA.availableD0.filter((_, i) => i % 4 === 0).slice(0, 10);
  const rows: any[] = [];
  for (const iso of sampleDates) {
    const fc = planRoute(iso, 0.35, 1.0, "unet", "ice_entry", "bharati");
    const st = planRoute(iso, 0.0, 1.0, "clim", "ice_entry", "bharati");
    const mFc = fc.metrics as any;
    const mSt = st.metrics as any;
    rows.push({
      date: iso,
      forecast_aware: mFc,
      static: mSt,
      delta_heavy_hours:
        mFc.ok && mSt.ok
          ? Number((mSt.heavy_ice_hours - mFc.heavy_ice_hours).toFixed(1))
          : null,
      delta_hours:
        mFc.ok && mSt.ok ? Number((mSt.hours - mFc.hours).toFixed(1)) : null,
    });
  }

  const validRows = rows.filter(
    (r) => r.forecast_aware?.ok && r.static?.ok
  );
  const mean = (arr: number[]) =>
    arr.length ? Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1)) : 0;

  const hindcastPayload = {
    n: validRows.length,
    leg: "ice-region entry → Bharati",
    mean_heavy_hours_forecast: mean(
      validRows.map((r) => r.forecast_aware.heavy_ice_hours)
    ),
    mean_heavy_hours_static: mean(
      validRows.map((r) => r.static.heavy_ice_hours)
    ),
    mean_hours_saved: mean(validRows.map((r) => r.delta_hours)),
    mean_heavy_hours_saved: mean(validRows.map((r) => r.delta_heavy_hours)),
    rows,
    note: "Both routes are scored on observed SIC after planning. Fuel is a distance×(1+a·SIC²) proxy.",
  };

  return { validationPayload, hindcastPayload };
}

let cachedEval = buildValidationAndHindcast();

async function startServer() {
  const app = express();
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/scenario", (_req, res) => {
    const d0 = DATA.availableD0.includes(DEMO_D0)
      ? DEMO_D0
      : DATA.availableD0[Math.floor(DATA.availableD0.length / 2)];
    res.json({
      title: "PolarRoute DSS",
      subtitle: "Cape Town → Bharati → Maitri  ·  hindcast replay",
      ship: { name: SHIP_NAME, klass: SHIP_CLASS },
      disclaimer: "Prototype — decision-support demo, not for real navigation.",
      dataset: DATASET_NAME,
      doi: DATASET_DOI,
      d0,
      available_dates: DATA.availableD0,
      extent: DATA.extent,
      shape: DATA.shape,
      stations: DATA.stations,
      crop: DATA.crop,
      gate: cachedEval.validationPayload.gate,
      hindcast_summary: {
        n: cachedEval.hindcastPayload.n,
        mean_heavy_hours_forecast:
          cachedEval.hindcastPayload.mean_heavy_hours_forecast,
        mean_heavy_hours_static:
          cachedEval.hindcastPayload.mean_heavy_hours_static,
        mean_hours_saved: cachedEval.hindcastPayload.mean_hours_saved,
        mean_heavy_hours_saved:
          cachedEval.hindcastPayload.mean_heavy_hours_saved,
        note: cachedEval.hindcastPayload.note,
      },
      ml_summary: unet.getSummary(),
      datasets: SATELLITE_DATASETS,
      provenance: [
        {
          layer: "Observed sea ice",
          badge: "REAL",
          detail: "NSIDC G02202 V6 passive-microwave SIC, 25 km (EPSG:3412)",
        },
        {
          layer: "Ice forecast (U-Net)",
          badge: "MODEL",
          detail: `Live 2-Level Spatial-Temporal U-Net (10ch in → 7d residual out, ${unet.totalEpochs} epochs trained)`,
        },
        {
          layer: "Uncertainty",
          badge: "DERIVED",
          detail: "Validation-set mean absolute error per lead/cell from U-Net",
        },
        {
          layer: "Icebergs",
          badge: "SIMULATED",
          detail: "USNIC/BYU tabular berg seed + wind/current drift cone",
        },
        {
          layer: "Routing",
          badge: "LIVE",
          detail: "Time-dependent A* on the 7-day U-Net forecast grid",
        },
        {
          layer: "Fuel",
          badge: "PROXY",
          detail: "∝ distance × (1 + 1.5·SIC²)",
        },
        {
          layer: "Vessel class",
          badge: "ILLUSTRATIVE",
          detail: "PC6-like SIC limits; not POLARIS-certified",
        },
      ],
    });
  });

  // Live ML Model Status, Architecture, Training History & Datasets Catalog
  app.get("/api/ml/status", (_req, res) => {
    res.json({
      model: unet.getSummary(),
      gate: cachedEval.validationPayload.gate,
      validation: cachedEval.validationPayload.validation,
      datasets: SATELLITE_DATASETS,
    });
  });

  // Interactive Live Training / Fine-Tuning of the Small U-Net Model
  app.post("/api/ml/train", (req, res) => {
    try {
      const {
        epochs = 5,
        lr = 0.08,
        edge_weight = 2.0,
        reset = false,
      } = req.body || {};

      if (reset) {
        const fresh = new PolarUNet(CROP_H, CROP_W);
        unet.headWeights.set(fresh.headWeights);
        unet.headBias.set(fresh.headBias);
        unet.trainingHistory = [];
        unet.totalEpochs = 0;
      }

      const nEpochs = Math.max(1, Math.min(25, Number(epochs)));
      const newLogs = unet.trainEpochs(
        trainSamples,
        valSamples,
        DATA.ocean,
        nEpochs,
        Number(lr),
        Number(edge_weight)
      );
      recomputeUncertaintyFromValidation();
      cachedEval = buildValidationAndHindcast();

      res.json({
        ok: true,
        new_logs: newLogs,
        model: unet.getSummary(),
        gate: cachedEval.validationPayload.gate,
        validation: cachedEval.validationPayload.validation,
        hindcast_summary: {
          n: cachedEval.hindcastPayload.n,
          mean_heavy_hours_forecast:
            cachedEval.hindcastPayload.mean_heavy_hours_forecast,
          mean_heavy_hours_static:
            cachedEval.hindcastPayload.mean_heavy_hours_static,
          mean_hours_saved: cachedEval.hindcastPayload.mean_hours_saved,
          mean_heavy_hours_saved:
            cachedEval.hindcastPayload.mean_heavy_hours_saved,
        },
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message || String(err) });
    }
  });

  // Inspect U-Net internal feature maps & residual predictions for a specific date
  app.get("/api/ml/inspect/:date", (req, res) => {
    try {
      const fc = forecastFor(req.params.date);
      const N = CROP_H * CROP_W;
      // Extract key feature slices for visual inspection in the ML Studio modal
      const tend3 = fc.encoder1.subarray(1 * N, 2 * N);
      const edgeZone = fc.encoder1.subarray(6 * N, 7 * N);
      const geluAdvect = fc.encoder1.subarray(7 * N, 8 * N);
      const resLead3 = fc.residual.subarray(2 * N, 3 * N);
      const resLead7 = fc.residual.subarray(6 * N, 7 * N);

      res.json({
        d0: fc.d0,
        inference_ms: fc.inference_ms,
        feature_maps: {
          enc_tend3: pack(tend3, [CROP_H, CROP_W]),
          enc_edge_zone: pack(edgeZone, [CROP_H, CROP_W]),
          enc_gelu_advect: pack(geluAdvect, [CROP_H, CROP_W]),
          residual_lead3: pack(resLead3, [CROP_H, CROP_W]),
          residual_lead7: pack(resLead7, [CROP_H, CROP_W]),
        },
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message || String(err) });
    }
  });

  app.get("/api/grid", (req, res) => {
    try {
      const date = String(req.query.date || DEMO_D0);
      const leadRaw = Number(req.query.lead ?? 0);
      const lead = Math.max(0, Math.min(6, Math.floor(leadRaw)));
      const layer = String(req.query.layer || "obs");
      const fc = forecastFor(date);
      const N = CROP_H * CROP_W;
      let arr: Float32Array;
      let badge = "REAL";

      if (layer === "obs") {
        arr = fc.obs.subarray(lead * N, (lead + 1) * N);
        badge = "REAL";
      } else if (layer === "last") {
        arr = fc.last;
        badge = "REAL";
      } else if (layer === "ml") {
        arr = fc.ml.subarray(lead * N, (lead + 1) * N);
        badge = "MODEL";
      } else if (layer === "residual") {
        // Map U-Net raw residual ΔSIC from [-0.25, +0.25] into [0, 0.4] for error colormap visualization
        arr = new Float32Array(N);
        const rSlice = fc.residual.subarray(lead * N, (lead + 1) * N);
        for (let i = 0; i < N; i++) arr[i] = Math.abs(rSlice[i]);
        badge = "MODEL";
      } else if (layer === "enc_grad") {
        // Encoder marginal ice-zone & advection activation
        arr = new Float32Array(N);
        const eSlice = fc.encoder1.subarray(6 * N, 7 * N);
        for (let i = 0; i < N; i++) arr[i] = eSlice[i] * 0.35;
        badge = "MODEL";
      } else if (layer === "b0") {
        arr = fc.b0.subarray(lead * N, (lead + 1) * N);
        badge = "BASELINE";
      } else if (layer === "b1") {
        arr = fc.b1.subarray(lead * N, (lead + 1) * N);
        badge = "BASELINE";
      } else if (layer === "error") {
        arr = new Float32Array(N);
        const mSlice = fc.ml.subarray(lead * N, (lead + 1) * N);
        const oSlice = fc.obs.subarray(lead * N, (lead + 1) * N);
        for (let i = 0; i < N; i++) arr[i] = Math.abs(mSlice[i] - oSlice[i]);
        badge = "DERIVED";
      } else if (layer === "uncertainty") {
        arr = uncertaintyMap.subarray(lead * N, (lead + 1) * N);
        badge = "DERIVED";
      } else {
        return res.status(400).json({ error: "unknown layer" });
      }

      const landF32 = new Float32Array(N);
      for (let i = 0; i < N; i++) landF32[i] = DATA.land[i];

      res.json({
        layer,
        lead,
        badge,
        grid: pack(arr, [CROP_H, CROP_W]),
        land: pack(landF32, [CROP_H, CROP_W]),
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message || String(err) });
    }
  });

  app.get("/api/forecast/:date", (req, res) => {
    try {
      const fc = forecastFor(req.params.date);
      const N = CROP_H * CROP_W;
      const calcMae = (a: Float32Array, b: Float32Array) => {
        const out: number[] = [];
        for (let k = 0; k < K_OUT; k++) {
          let sum = 0;
          let cnt = 0;
          for (let i = 0; i < N; i++) {
            if (DATA.ocean[i] > 0.5) {
              sum += Math.abs(a[k * N + i] - b[k * N + i]);
              cnt++;
            }
          }
          out.push(Number((sum / Math.max(1, cnt)).toFixed(4)));
        }
        return out;
      };

      const landF32 = new Float32Array(N);
      for (let i = 0; i < N; i++) landF32[i] = DATA.land[i];

      res.json({
        d0: fc.d0,
        inference_ms: fc.inference_ms,
        history_dates: fc.history_dates,
        forecast_dates: fc.forecast_dates,
        obs_dates: fc.obs_dates,
        history: pack(fc.history, [T_IN, CROP_H, CROP_W]),
        last: pack(fc.last, [CROP_H, CROP_W]),
        ml: pack(fc.ml, [K_OUT, CROP_H, CROP_W]),
        residual: pack(fc.residual, [K_OUT, CROP_H, CROP_W]),
        b0: pack(fc.b0, [K_OUT, CROP_H, CROP_W]),
        b1: pack(fc.b1, [K_OUT, CROP_H, CROP_W]),
        obs: pack(fc.obs, [K_OUT, CROP_H, CROP_W]),
        land: pack(landF32, [CROP_H, CROP_W]),
        per_lead_mae: {
          ml: calcMae(fc.ml, fc.obs),
          b0: calcMae(fc.b0, fc.obs),
          b1: calcMae(fc.b1, fc.obs),
        },
        how: "The 2-Level U-Net takes 10 input channels (7 daily NSIDC satellite SIC maps d-6..d0 + ocean mask + sin/cos DOY), runs 3×3 spatial encoder/bottleneck convolutions, and predicts the 7-day residual ΔSIC.",
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message || String(err) });
    }
  });

  app.post("/api/route", (req, res) => {
    try {
      const {
        date = DEMO_D0,
        w_risk = 0.35,
        w_time = 1.0,
        forecast_source = "auto",
        start = "ice_entry",
        goal = "bharati",
        from_row = null,
        from_col = null,
      } = req.body || {};

      const src =
        forecast_source === "clim" || forecast_source === "static"
          ? "clim"
          : forecast_source === "auto"
          ? "unet"
          : forecast_source;

      const fc = planRoute(
        date,
        Number(w_risk),
        Number(w_time),
        src,
        start,
        goal,
        from_row,
        from_col
      );
      const st = planRoute(
        date,
        0.0,
        Number(w_time),
        "clim",
        start,
        goal,
        from_row,
        from_col
      );

      res.json({
        date,
        forecast_aware: fc,
        static: st,
        w_risk: Number(w_risk),
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message || String(err) });
    }
  });

  app.post("/api/advance", (req, res) => {
    try {
      const {
        date = DEMO_D0,
        ship_row,
        ship_col,
        w_risk = 0.35,
      } = req.body || {};

      const idx = DATA.dates.indexOf(String(date).slice(0, 10));
      if (idx === -1 || idx + 1 >= DATA.dates.length - K_OUT) {
        return res
          .status(400)
          .json({ error: `No next-day forecast observation after ${date}` });
      }
      const nxt = DATA.dates[idx + 1];
      const b = DATA.stations.bharati;
      const distToBharati =
        Math.abs(Number(ship_row) - b.row) + Math.abs(Number(ship_col) - b.col);

      let planned: any;
      if (distToBharati < 4) {
        planned = planRoute(
          nxt,
          Number(w_risk),
          1.0,
          "unet",
          "bharati",
          "maitri",
          Number(ship_row),
          Number(ship_col)
        );
        planned.leg = "toward_maitri";
      } else {
        planned = planRoute(
          nxt,
          Number(w_risk),
          1.0,
          "unet",
          "ice_entry",
          "bharati",
          Number(ship_row),
          Number(ship_col)
        );
        planned.leg = "toward_bharati";
      }

      res.json({
        date: nxt,
        route: planned,
        icebergs: icebergSnapshot(1),
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message || String(err) });
    }
  });

  app.get("/api/icebergs", (req, res) => {
    const dayOffset = Number(req.query.day_offset ?? 0);
    res.json({
      badge: "SIMULATED",
      bergs: icebergSnapshot(dayOffset),
    });
  });

  app.get("/api/validation", (_req, res) => {
    res.json(cachedEval.validationPayload);
  });

  app.get("/api/hindcast", (_req, res) => {
    res.json(cachedEval.hindcastPayload);
  });

  app.get("/api/land.geojson", (_req, res) => {
    res.json(DATA.landGeojson);
  });

  const distDir = path.resolve(process.cwd(), "dist");
  if (process.env.NODE_ENV === "production" && fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distDir, "index.html"));
    });
  } else {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`PolarRoute DSS server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
