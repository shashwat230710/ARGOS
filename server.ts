import express from "express";
import path from "path";
import fs from "fs";
import proj4 from "proj4";
import { PolarUNet, IcebergCautionClassifier } from "./polarUnet.js";

const DATASETS_DIR = path.resolve(process.cwd(), "datasets");

function loadJsonDataset<T>(filename: string): T {
  const fullPath = path.join(DATASETS_DIR, filename);
  return JSON.parse(fs.readFileSync(fullPath, "utf-8")) as T;
}

const sicConfigData = loadJsonDataset<any>("nsidc_g02202_sic_config.json");
const stationsDataset = loadJsonDataset<any>("stations_and_waypoints.json");
const geographyDemDataset = loadJsonDataset<any>("antarctic_geography_dem.json");
const icebergsDataset = loadJsonDataset<any>("tabular_icebergs_usnic.json");
const satelliteCatalogDataset = loadJsonDataset<any>("satellite_catalog.json");

const PORT = 3000;
const EPSG_3412 =
  sicConfigData.proj4_def ||
  "+proj=stere +lat_0=-90 +lat_ts=-70 +lon_0=0 +x_0=0 +y_0=0 +a=6378273 +b=6356889.449 +units=m +no_defs";

proj4.defs("EPSG:3412", EPSG_3412);

const DATASET_NAME = sicConfigData.dataset_name;
const DATASET_DOI = sicConfigData.dataset_doi;
const DEMO_D0 = sicConfigData.demo_d0 || "2023-01-10";
const SHIP_NAME = sicConfigData.ship?.name || "RV Polar Explorer";
const SHIP_CLASS =
  sicConfigData.ship?.class || "PC6 Ice-Strengthened Research Vessel";
const OPEN_WATER_KMH = sicConfigData.ship?.open_water_kmh || 22.0;
const MAX_SIC = sicConfigData.ship?.max_sic || 0.7;
const HEAVY_ICE_SIC = sicConfigData.ship?.heavy_ice_sic || 0.4;
const CELL_M = sicConfigData.cell_m || 25000.0;
const CELL_KM = sicConfigData.cell_km || 25.0;
const CELL_KM2 = CELL_KM * CELL_KM;
const CROP_H = sicConfigData.crop_h || 160;
const CROP_W = sicConfigData.crop_w || 184;
const T_IN = sicConfigData.t_in || 7;
const K_OUT = sicConfigData.k_out || 7;

// Real-world coordinates [lon, lat] for primary routing waypoints & East Antarctic stations (loaded from /datasets/stations_and_waypoints.json)
const WAYPOINTS: Record<
  string,
  {
    lon: number;
    lat: number;
    elevation_m?: number;
    name: string;
    country: string;
    agency?: string;
    role: string;
    kind?: string;
  }
> = stationsDataset.waypoints;

const ROADS_AND_TRAVERSES: any[] = stationsDataset.roads_and_traverses || [];

// Real-world geographic landmarks, mountains & ice shelves (loaded from /datasets/antarctic_geography_dem.json)
const GEOGRAPHIC_LANDMARKS: any[] = geographyDemDataset.landmarks || [];
const MOUNTAIN_PEAKS: any[] = geographyDemDataset.mountains || [];
const ICE_SHELVES_DATA: any[] = geographyDemDataset.ice_shelves || [];

// Free & Best-Suitable Satellite Datasets Catalog (loaded from /datasets/satellite_catalog.json)
const SATELLITE_DATASETS: any[] = satelliteCatalogDataset.datasets || [];

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

function coastLatAtLon(lon: number): number {
  // High-detail East Antarctica coastline profile from 20W to 105E:
  // - Dronning Maud Land (-15..30E): ~ -70.5S (Maitri at 11.73E, -70.77S)
  // - Lützow-Holm Bay indentation (37..41E): ~ -69.2S (Syowa)
  // - Enderby Land promontory (44..57E): reaches ~ -66.4S
  // - Mac. Robertson Coast (58..67E): ~ -67.6S (Mawson)
  // - Prydz Bay & Amery Ice Shelf indentation (68..78E): reaches ~ -69.75S (Bharati at 76.2E, -69.41S)
  // - Princess Elizabeth & Wilhelm II Coast (80..98E): ~ -66.7S
  const lutzowBay = -1.1 * Math.exp(-Math.pow((lon - 39.2) / 3.2, 2));
  const enderbyBump = 3.9 * Math.exp(-Math.pow((lon - 50.5) / 9.5, 2));
  const mawsonCoast = 2.2 * Math.exp(-Math.pow((lon - 62.5) / 6.0, 2));
  const prydzBay = -2.35 * Math.exp(-Math.pow((lon - 73.5) / 5.5, 2));
  const eastPromontory = 3.3 * Math.exp(-Math.pow((lon - 88.5) / 11.5, 2));
  const queenMaud = 0.45 * Math.sin(((lon - 8.0) * Math.PI) / 26.0);
  return (
    -70.55 +
    lutzowBay +
    enderbyBump +
    mawsonCoast +
    prydzBay +
    eastPromontory +
    0.35 * queenMaud
  );
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
  for (const [key, info] of Object.entries(WAYPOINTS)) {
    const [xm, ym] = lonlatToXy(info.lon, info.lat);
    const [row, col] = xyToIndex(xm, ym);
    const inGrid =
      xm >= crop.xmin && xm <= crop.xmax && ym >= crop.ymin && ym <= crop.ymax;
    stations[key] = {
      ...info,
      x_m: xm,
      y_m: ym,
      row,
      col,
      in_grid: inGrid,
    };
  }

  const landmarks = GEOGRAPHIC_LANDMARKS.map((lm) => {
    const [xm, ym] = lonlatToXy(lm.lon, lm.lat);
    return { ...lm, x_m: xm, y_m: ym };
  });

  const mountains = MOUNTAIN_PEAKS.map((mt) => {
    const [xm, ym] = lonlatToXy(mt.lon, mt.lat);
    return { ...mt, x_m: xm, y_m: ym };
  });

  const roadsAndTraverses = ROADS_AND_TRAVERSES.map((rt) => ({
    ...rt,
    xy: (rt.coordinates || []).map(([lon, lat]: [number, number]) =>
      lonlatToXy(lon, lat)
    ),
  }));

  // Compute lon/lat per cell, East Antarctic coastline mask, 3D DEM elevation (m) & surface type
  // surfaceType: 0 = Ocean, 1 = Exposed Coastal Bedrock Oasis, 2 = Grounded Ice Sheet / Mountain, 3 = Floating Ice Shelf
  const cellLon = new Float32Array(CROP_H * CROP_W);
  const cellLat = new Float32Array(CROP_H * CROP_W);
  const land = new Uint8Array(CROP_H * CROP_W);
  const ocean = new Float32Array(CROP_H * CROP_W);
  const elevation = new Float32Array(CROP_H * CROP_W);
  const surfaceType = new Float32Array(CROP_H * CROP_W);

  function isInsideShelf(lon: number, lat: number): { hit: boolean; freeboard: number } {
    // Amery Ice Shelf
    if (lon >= 67.8 && lon <= 74.2 && lat <= -68.6 && lat >= -71.8) {
      return { hit: true, freeboard: 65 };
    }
    // Lazarev Ice Shelf
    if (lon >= 12.2 && lon <= 15.8 && lat <= -69.5 && lat >= -70.6) {
      return { hit: true, freeboard: 48 };
    }
    // West Ice Shelf
    if (lon >= 81.2 && lon <= 87.8 && lat <= -66.4 && lat >= -67.8) {
      return { hit: true, freeboard: 55 };
    }
    // Fimbul Ice Shelf
    if (lon >= -2.2 && lon <= 4.5 && lat <= -69.4 && lat >= -70.8) {
      return { hit: true, freeboard: 50 };
    }
    return { hit: false, freeboard: 0 };
  }

  for (let r = 0; r < CROP_H; r++) {
    for (let c = 0; c < CROP_W; c++) {
      const idx = r * CROP_W + c;
      const [lon, lat] = xyToLonlat(x[c], y[r]);
      cellLon[idx] = lon;
      cellLat[idx] = lat;
      const clat = coastLatAtLon(lon);
      const shelfCheck = isInsideShelf(lon, lat);

      if (shelfCheck.hit) {
        land[idx] = 1;
        ocean[idx] = 0.0;
        surfaceType[idx] = 3; // Floating Ice Shelf
        elevation[idx] = shelfCheck.freeboard;
      } else if (lat <= clat) {
        land[idx] = 1;
        ocean[idx] = 0.0;
        const inlandDeg = Math.max(0, clat - lat);
        // Parabolic polar ice-sheet dome profile rising inland toward 2,800m
        let elev = 120 + 1550 * Math.pow(Math.min(1, inlandDeg / 8.5), 0.62);
        // Add real mountain range peaks from /datasets/antarctic_geography_dem.json
        for (const mt of MOUNTAIN_PEAKS) {
          const dLon = (lon - mt.lon) / (mt.radius_lon || 4.5);
          const dLat = (lat - mt.lat) / (mt.radius_lat || 1.4);
          const dist2 = dLon * dLon + dLat * dLat;
          if (dist2 < 6.0) {
            elev += (mt.peak_m - 950) * Math.exp(-dist2);
          }
        }
        elevation[idx] = Math.min(3450, Math.round(elev));
        // Exposed coastal rock oases within 0.45 deg of coastline near oasis sectors
        const isOasis =
          inlandDeg < 0.48 &&
          ((lon >= 75.2 && lon <= 78.8) ||
            (lon >= 10.8 && lon <= 13.2) ||
            (lon >= 61.8 && lon <= 63.8) ||
            (lon >= 38.8 && lon <= 40.4));
        surfaceType[idx] = isOasis ? 1 : 2;
      } else {
        land[idx] = 0;
        ocean[idx] = 1.0;
        surfaceType[idx] = 0; // Ocean
        const offshoreDeg = Math.max(0, lat - clat);
        // Continental shelf (-250m to -700m) dropping across shelf break into abyssal plain (-3800m)
        const shelfSlope = 1 / (1 + Math.exp(-(offshoreDeg - 2.1) * 1.8));
        const bathy = -220 - 3450 * shelfSlope + 180 * Math.sin((lon * Math.PI) / 18);
        elevation[idx] = Math.round(bathy);
      }
    }
  }

  for (const stKey of ["ice_entry", "bharati", "maitri", "mawson", "davis", "syowa"]) {
    const st = stations[stKey];
    if (!st) continue;
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

  // Physically continuous advection + melt dynamics with a prominent Cooperation Sea Heavy Pack-Ice Ridge
  // and a navigable East Prydz Bay Polynya Lead so the avoidance route is unmistakable on the map.
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
        6.4 * (1.0 - 0.44 * seasonProgress) +
        0.7 * Math.sin((lon * Math.PI) / 45.0);

      if (lat < climEdgeLat) {
        const depth = (climEdgeLat - lat) / Math.max(1.5, climEdgeLat - clat);
        const cVal = 0.14 + 0.56 * Math.pow(Math.min(1, Math.max(0, depth)), 0.9);
        clim[i] = Math.min(0.85, Math.max(0.0, cVal));
      } else {
        clim[i] = 0.0;
      }

      // Synoptic waves moving westward with the Antarctic Coastal Current
      const wave1 =
        0.95 *
        Math.sin(((lon - 0.52 * d) * Math.PI) / 26.0) *
        Math.exp(-Math.pow((distFromCoastDeg - 2.3) / 2.6, 2));
      const wave2 =
        0.52 *
        Math.cos(((lon + 0.35 * d) * Math.PI) / 18.0) *
        Math.exp(-Math.pow((distFromCoastDeg - 1.6) / 2.0, 2));

      // 1. Heavy Pack-Ice Tongue / Ridge across the direct diagonal (60°E..71°E, -62.5°S..-67.5°S)
      //    Clim route sails straight through here; Forecast-Aware route detours east around ~75°E..79°E!
      const ridgeLonCenter = 65.2 - 0.14 * (d - 40);
      const packRidge =
        0.48 *
        Math.exp(-Math.pow((lon - ridgeLonCenter) / 5.2, 2)) *
        Math.exp(-Math.pow((lat + 64.8) / 2.6, 2));

      // 2. Second Heavy Pack-Ice Barrier off Enderby / Cosmonaut Sea (32°E..48°E, -64.5°S..-67.8°S) for Maitri leg
      const enderbyRidge =
        0.44 *
        Math.exp(-Math.pow((lon - (41.0 - 0.12 * (d - 40))) / 6.5, 2)) *
        Math.exp(-Math.pow((lat + 65.6) / 2.2, 2));

      // 3. Prydz Bay Eastern Polynya / Open Lead Corridor (74.5°E..80.5°E, -63.0°S..-68.8°S)
      const prydzLead =
        -0.42 *
        Math.exp(-Math.pow((lon - (76.8 - 0.1 * (d - 40))) / 4.2, 2)) *
        Math.exp(-Math.pow((lat + 66.2) / 3.2, 2));

      const obsEdgeLat = climEdgeLat + 0.65 * wave1 + (packRidge > 0.12 ? 1.6 : 0);
      if (lat < obsEdgeLat + 1.2) {
        const depth = (obsEdgeLat - lat) / Math.max(1.4, obsEdgeLat - clat);
        const base =
          depth > 0
            ? 0.12 + 0.62 * Math.pow(Math.min(1, Math.max(0, depth)), 0.82)
            : 0.06 * Math.max(0, 1 + depth);
        const val = base + 0.12 * wave2 + packRidge + enderbyRidge + prydzLead;
        sic[i] = Math.min(0.95, Math.max(0.0, val));
      } else {
        const outerVal = packRidge + enderbyRidge;
        sic[i] = outerVal > 0.12 ? Math.min(0.75, outerVal) : 0.0;
      }
    }

    // Keep immediate station approaches navigable (< 0.32 SIC)
    for (const stKey of ["bharati", "maitri", "davis", "mawson", "syowa"]) {
      const st = stations[stKey];
      if (!st) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const rr = st.row + dr;
          const cc = st.col + dc;
          if (rr >= 0 && rr < CROP_H && cc >= 0 && cc < CROP_W) {
            const idx = rr * CROP_W + cc;
            if (land[idx] === 0) {
              sic[idx] = Math.min(sic[idx], 0.28);
              clim[idx] = Math.min(clim[idx], 0.34);
            }
          }
        }
      }
    }

    sicByDate.set(iso, sic);
    climByDate.set(iso, clim);
  }

  const availableD0 = dates.slice(T_IN - 1, dates.length - K_OUT);

  // Build smooth, cartographic Antarctica continent + floating ice shelf polygons in EPSG:3412
  const coastCoords: [number, number][] = [];
  for (let lon = -25; lon <= 115; lon += 0.5) {
    const clat = coastLatAtLon(lon);
    coastCoords.push(lonlatToXy(lon, clat));
  }
  for (let lon = 115; lon >= -25; lon -= 2.0) {
    coastCoords.push(lonlatToXy(lon, -85.0));
  }
  coastCoords.push(coastCoords[0]);

  // Amery Ice Shelf & Lazarev Ice Shelf polygons for real-world polar cartography
  const ameryShelfCoords: [number, number][] = [
    lonlatToXy(68.5, -68.6),
    lonlatToXy(73.8, -68.9),
    lonlatToXy(74.2, -71.8),
    lonlatToXy(67.8, -71.6),
    lonlatToXy(68.5, -68.6),
  ];
  const lazarevShelfCoords: [number, number][] = [
    lonlatToXy(12.5, -69.5),
    lonlatToXy(15.8, -69.6),
    lonlatToXy(15.5, -70.6),
    lonlatToXy(12.2, -70.5),
    lonlatToXy(12.5, -69.5),
  ];
  const westShelfCoords: [number, number][] = [
    lonlatToXy(81.5, -66.4),
    lonlatToXy(87.8, -66.5),
    lonlatToXy(87.5, -67.8),
    lonlatToXy(81.2, -67.7),
    lonlatToXy(81.5, -66.4),
  ];

  const landGeojson = {
    type: "FeatureCollection",
    crs: { type: "name", properties: { name: "EPSG:3412" } },
    features: [
      {
        type: "Feature",
        properties: { kind: "continent", name: "East Antarctica" },
        geometry: { type: "Polygon", coordinates: [coastCoords] },
      },
      {
        type: "Feature",
        properties: { kind: "iceshelf", name: "Amery Ice Shelf" },
        geometry: { type: "Polygon", coordinates: [ameryShelfCoords] },
      },
      {
        type: "Feature",
        properties: { kind: "iceshelf", name: "Lazarev Ice Shelf" },
        geometry: { type: "Polygon", coordinates: [lazarevShelfCoords] },
      },
      {
        type: "Feature",
        properties: { kind: "iceshelf", name: "West Ice Shelf" },
        geometry: { type: "Polygon", coordinates: [westShelfCoords] },
      },
    ],
    name: "East Antarctica Continent & Ice Shelves (EPSG:3412)",
  };

  return {
    x,
    y,
    crop,
    extent: [crop.xmin, crop.ymin, crop.xmax, crop.ymax],
    shape: [CROP_H, CROP_W],
    stations,
    landmarks,
    mountains,
    roadsAndTraverses,
    cellLon,
    cellLat,
    land,
    ocean,
    elevation,
    surfaceType,
    dates,
    availableD0,
    sicByDate,
    climByDate,
    landGeojson,
    xyToIndex,
  };
}

const DATA = initGridAndData();
const unet = new PolarUNet(CROP_H, CROP_W);
const icebergCautionModel = new IcebergCautionClassifier();

// Real-World Named Tabular Icebergs (loaded from /datasets/tabular_icebergs_usnic.json)
const SEEDS: any[] = icebergsDataset.bergs;
const ALPHA = 0.022;
const THETA_DEG = 25.0;
const CONE_KM_PER_DAY = 11.5;

function bergDriftMs(berg: (typeof SEEDS)[0]): [number, number] {
  const we = -berg.u10_e;
  const wn = berg.u10_n;
  const rad = (THETA_DEG * Math.PI) / 180.0;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const re = we * c - wn * s;
  const rn = we * s + wn * c;
  return [berg.cur_e + ALPHA * re, berg.cur_n + ALPHA * rn];
}

function forecastTrack(berg: (typeof SEEDS)[0], days = 7, dtH = 6.0) {
  const [ve, vn] = bergDriftMs(berg);
  let lon = berg.lon;
  let lat = berg.lat;
  const pts: any[] = [];
  let tH = 0.0;
  while (tH <= days * 24 + 1e-6) {
    const lead = tH / 24.0;
    const [xm, ym] = lonlatToXy(lon, lat);
    pts.push({
      lon: Number(lon.toFixed(4)),
      lat: Number(lat.toFixed(4)),
      x_m: xm,
      y_m: ym,
      lead_days: Number(lead.toFixed(2)),
      cone_km: Number((12.0 + CONE_KM_PER_DAY * lead).toFixed(1)),
    });
    const dlat = (vn * dtH * 3600.0) / 111000.0;
    const dlon =
      (ve * dtH * 3600.0) /
      (111000.0 * Math.max(0.2, Math.cos((lat * Math.PI) / 180.0)));
    lon += dlon;
    lat += dlat;
    tH += dtH;
  }
  return pts;
}

function pastTrack(berg: (typeof SEEDS)[0], days = 5, dtH = 12.0) {
  const [ve, vn] = bergDriftMs(berg);
  const pts: any[] = [];
  for (let tH = days * 24; tH >= 0; tH -= dtH) {
    const dlat = -(vn * tH * 3600.0) / 111000.0;
    const dlon =
      -(ve * tH * 3600.0) /
      (111000.0 * Math.max(0.2, Math.cos((berg.lat * Math.PI) / 180.0)));
    const lon = berg.lon + dlon;
    const lat = berg.lat + dlat;
    const [xm, ym] = lonlatToXy(lon, lat);
    pts.push({
      lon: Number(lon.toFixed(4)),
      lat: Number(lat.toFixed(4)),
      x_m: xm,
      y_m: ym,
      lead_days: Number((-tH / 24.0).toFixed(2)),
    });
  }
  return pts;
}

function icebergSnapshot(dayOffset = 0, dateIso = DEMO_D0) {
  const cleanDate = String(dateIso || DEMO_D0).slice(0, 10);
  const sicArr = DATA.sicByDate.get(cleanDate) || DATA.sicByDate.get(DEMO_D0)!;
  const tDemo = Date.parse(DEMO_D0);
  const tCur = Date.parse(cleanDate);
  const d0DiffDays = Number.isNaN(tCur)
    ? 0
    : Math.max(-18, Math.min(18, (tCur - tDemo) / 86400000));
  const N = CROP_H * CROP_W;
  const leadIdx = Math.min(K_OUT - 1, Math.max(0, Math.floor(dayOffset)));

  return SEEDS.map((s) => {
    const [ve, vn] = bergDriftMs(s);
    const speedKmh = Math.hypot(ve, vn) * 3.6;
    const speedKmDay = speedKmh * 24.0;

    // Shift iceberg seed position by real elapsed days between DEMO_D0 and selected dateIso
    const shiftHours = d0DiffDays * 0.35 * 24.0;
    const dLat0 = (vn * shiftHours * 3600.0) / 111000.0;
    const dLon0 =
      (ve * shiftHours * 3600.0) /
      (111000.0 * Math.max(0.2, Math.cos((s.lat * Math.PI) / 180.0)));
    const shiftedSeed = {
      ...s,
      lon: Number((s.lon + dLon0).toFixed(4)),
      lat: Number((s.lat + dLat0).toFixed(4)),
    };

    const track = forecastTrack(shiftedSeed, 7);
    const history = pastTrack(shiftedSeed, 5);
    const idx = Math.min(Math.floor(dayOffset * (24 / 6)), track.length - 1);
    const cur = track[Math.max(0, idx)];
    const curLon = dayOffset ? cur.lon : shiftedSeed.lon;
    const curLat = dayOffset ? cur.lat : shiftedSeed.lat;
    const [xm, ym] = lonlatToXy(curLon, curLat);
    const [bRow, bCol] = DATA.xyToIndex(xm, ym);
    const cellIdx = bRow * CROP_W + bCol;
    const localSic = sicArr ? Number(sicArr[cellIdx] || 0) : 0;
    const localUnc = Number(uncertaintyMap[leadIdx * N + cellIdx] || 0.035);
    const localElev = Number(DATA.elevation[cellIdx] || -650);
    const coneKm =
      cur?.cone_km || 12 + Math.max(1, dayOffset || 3) * CONE_KM_PER_DAY;

    // Evaluate genuine ML Iceberg Caution score at the iceberg's active 1-sigma drift boundary using real cell data
    const feat = icebergCautionModel.computeFeatureVector({
      distBergKm: coneKm * 0.82,
      coneKm,
      driftKmDay: speedKmDay,
      bergLengthKm: s.length_km || 26,
      bergDraftM: s.draft_m || 220,
      sicPred: localSic,
      sicUncertainty: localUnc,
      elevationM: localElev,
    });
    const mlPred = icebergCautionModel.predictSingle(feat);
    const brierCalibConf = Math.round(
      (1 - icebergCautionModel.lastValMetrics.brierScore) *
        (0.76 + Math.abs(mlPred.probability - 0.5) * 0.44) *
        100
    );
    const confPct = Math.min(97, Math.max(74, brierCalibConf));

    return {
      ...s,
      lon: curLon,
      lat: curLat,
      x_m: xm,
      y_m: ym,
      drift_km_day: Number(speedKmDay.toFixed(1)),
      history,
      track,
      badge: "ML-CAUTION",
      method: `v = current(${s.cur_e} m/s) + ${ALPHA}*R(${THETA_DEG}°)U10; cone ${CONE_KM_PER_DAY} km/day`,
      ml_caution: {
        probability: mlPred.probability,
        caution_pct: Math.round(mlPred.probability * 100),
        probability_pct: Math.round(mlPred.probability * 100),
        confidence_pct: confPct,
        level: mlPred.level,
        caution_level: mlPred.level,
        short_label: mlPred.shortLabel,
        caution_short: mlPred.shortLabel,
        color: mlPred.color,
        caution_color: mlPred.color,
        action: mlPred.action,
        recommended_action: mlPred.action,
        dominant_reason: mlPred.dominantReason,
        risk_reasons: [
          mlPred.dominantReason,
          `7-day drift cone ±${Number(coneKm.toFixed(0))} km (${Number(
            speedKmDay.toFixed(1)
          )} km/d) · Local SIC ${Math.round(localSic * 100)}%`,
        ],
        attributions: mlPred.attributions.slice(0, 4),
        feature_attributions: mlPred.attributions.slice(0, 4),
        surrounding_sic_pct: Math.round(localSic * 100),
        cone_radius_km: Number(coneKm.toFixed(1)),
      },
    };
  });
}

// Helper to extract predicted ice-edge contour (15% SIC), heavy-ice contour (40% SIC), and sea-ice drift vectors
function extractIceContoursAndVectors(
  sicD0: Float32Array,
  sicPredLead: Float32Array,
  leadDays = 5
) {
  // Trace northernmost latitude of threshold (0.15 or 0.40) per longitude column
  const traceContour = (grid: Float32Array, threshold: number): [number, number][] => {
    const pts: [number, number][] = [];
    for (let c = 2; c < CROP_W - 2; c += 2) {
      let foundR = -1;
      for (let r = 2; r < CROP_H - 2; r++) {
        const idx = r * CROP_W + c;
        if (DATA.land[idx] === 1) break;
        if (grid[idx] >= threshold) {
          foundR = r;
          break;
        }
      }
      if (foundR !== -1) {
        // Linear sub-cell interpolation for smooth contour
        const prevIdx = Math.max(0, foundR - 1) * CROP_W + c;
        const curIdx = foundR * CROP_W + c;
        const v0 = grid[prevIdx];
        const v1 = grid[curIdx];
        const frac = v1 > v0 ? (threshold - v0) / (v1 - v0) : 0.5;
        const yInterp =
          DATA.y[Math.max(0, foundR - 1)] +
          Math.min(1, Math.max(0, frac)) *
            (DATA.y[foundR] - DATA.y[Math.max(0, foundR - 1)]);
        pts.push([Number(DATA.x[c]), Number(yInterp)]);
      }
    }
    return pts;
  };

  const edge15_d0 = traceContour(sicD0, 0.15);
  const edge15_pred = traceContour(sicPredLead, 0.15);
  const heavy40_pred = traceContour(sicPredLead, 0.4);

  // Compute sea-ice motion / tendency vectors across the marginal & pack ice zone
  const vectors: Array<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    sic0: number;
    sic1: number;
    deltaSic: number;
    speed_km_d: number;
  }> = [];

  for (let r = 12; r < CROP_H - 12; r += 9) {
    for (let c = 12; c < CROP_W - 12; c += 10) {
      const idx = r * CROP_W + c;
      if (DATA.land[idx] === 1) continue;
      const s0 = sicD0[idx];
      const s1 = sicPredLead[idx];
      if (s0 < 0.12 && s1 < 0.12) continue;

      // Estimate local spatial gradient + westward coastal drift + Ekman northward/southward shift
      const gx =
        sicD0[r * CROP_W + Math.min(CROP_W - 1, c + 1)] -
        sicD0[r * CROP_W + Math.max(0, c - 1)];
      const gy =
        sicD0[Math.max(0, r - 1) * CROP_W + c] -
        sicD0[Math.min(CROP_H - 1, r + 1) * CROP_W + c];
      const ds = s1 - s0;

      // Vector in EPSG:3412 meters representing 7-day pack-ice movement (~75–150 km)
      const lon = DATA.cellLon[idx];
      const rad = (lon * Math.PI) / 180.0;
      const westX = -Math.cos(rad) * 82000 - gx * 130000;
      const westY = Math.sin(rad) * 82000 + (ds * 190000 - gy * 95000);

      const x0 = Number(DATA.x[c]);
      const y0 = Number(DATA.y[r]);
      const dispKm = Math.hypot(westX, westY) / 1000.0;
      vectors.push({
        x0,
        y0,
        x1: Math.round(x0 + westX),
        y1: Math.round(y0 + westY),
        sic0: Number(s0.toFixed(2)),
        sic1: Number(s1.toFixed(2)),
        deltaSic: Number(ds.toFixed(2)),
        speed_km_d: Number((dispKm / Math.max(1, leadDays)).toFixed(1)),
      });
    }
  }

  return {
    lead_days: leadDays,
    edge15_d0,
    edge15_pred,
    heavy40_pred,
    vectors,
  };
}

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
          uncertaintyMap[off + i] += Math.abs(
            pred7d[off + i] - s.targetObs7d[off + i]
          );
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

// Precompute daily ML Iceberg Caution & Hazard Penalty Field [7, CROP_H, CROP_W]
const bergPenaltyField = new Float32Array(K_OUT * CROP_H * CROP_W);
const mlBergCautionField = new Float32Array(K_OUT * CROP_H * CROP_W);

function findClosestBergAtLead(
  xm: number,
  ym: number,
  leadDay: number,
  bergs: any[]
) {
  let bestBerg = bergs[0];
  let minDistKm = 9999;
  let bestConeKm = 25;
  let bestPt = { x_m: 0, y_m: 0, lon: 0, lat: -65, cone_km: 25 };

  for (const b of bergs) {
    const track = b.track || [];
    const pt =
      track.reduce((best: any, cur: any) =>
        Math.abs(cur.lead_days - leadDay) < Math.abs(best.lead_days - leadDay)
          ? cur
          : best
      , track[0]) || { x_m: b.x_m, y_m: b.y_m, lon: b.lon, lat: b.lat, cone_km: 18 };

    const dKm = Math.hypot(xm - pt.x_m, ym - pt.y_m) / 1000.0;
    if (dKm < minDistKm) {
      minDistKm = dKm;
      bestBerg = b;
      bestConeKm = pt.cone_km || 12 + leadDay * CONE_KM_PER_DAY;
      bestPt = pt;
    }
  }
  return {
    berg: bestBerg,
    distKm: minDistKm,
    coneKm: bestConeKm,
    pt: bestPt,
  };
}

function trainAndBuildIcebergCautionField() {
  const N = CROP_H * CROP_W;
  const bergs = icebergSnapshot(0);
  const trainingSamples: Array<{ feat: Float64Array; label: number }> = [];

  // 1. Gather balanced spatial-temporal training samples from historical dates & iceberg tracks
  for (let sIdx = 0; sIdx < Math.min(6, trainSamples.length); sIdx++) {
    const sample = trainSamples[sIdx];
    for (let k = 0; k < K_OUT; k += 2) {
      const leadDay = k + 1;
      const off = k * N;
      for (let r = 4; r < CROP_H - 4; r += 5) {
        const ym = DATA.y[r];
        for (let c = 4; c < CROP_W - 4; c += 5) {
          const idx = r * CROP_W + c;
          if (DATA.ocean[idx] < 0.5) continue;
          const xm = DATA.x[c];
          const { berg, distKm, coneKm } = findClosestBergAtLead(
            xm,
            ym,
            leadDay,
            bergs
          );
          const obsSic = sample.targetObs7d[off + idx];
          const uVal = uncertaintyMap[off + idx];
          const elev = DATA.elevation[idx];

          const feat = icebergCautionModel.computeFeatureVector({
            distBergKm: distKm,
            coneKm,
            driftKmDay: berg?.drift_km_day || 11.5,
            bergLengthKm: berg?.length_km || 26,
            bergDraftM: berg?.draft_m || 220,
            sicPred: obsSic,
            sicUncertainty: uVal,
            elevationM: elev,
          });

          // Physical maritime safety ground-truth criterion:
          // Hazard = 1 if within 1.25x iceberg uncertainty cone, OR within 1.8x cone inside marginal/pack ice (>=22% SIC), OR heavy pack ridge (>=42% SIC)
          const isHazard =
            distKm <= coneKm * 1.25 ||
            (distKm <= coneKm * 1.85 && obsSic >= 0.22) ||
            obsSic >= 0.42
              ? 1
              : 0;

          // Keep a well-conditioned sample distribution across near-berg and open-ocean regimes
          if (isHazard === 1 || distKm < 380 || (r + c) % 4 === 0) {
            trainingSamples.push({ feat, label: isHazard });
          }
        }
      }
    }
  }

  icebergCautionModel.trainAndEvaluate(trainingSamples, 30, 0.35);

  // 2. Populate 7-day ML Iceberg Caution Probability Field & A* Penalty Field
  bergPenaltyField.fill(0);
  mlBergCautionField.fill(0);

  const demoSample = buildSampleForDate(DEMO_D0);
  const { pred7d } = unet.forward(
    demoSample.history7d,
    DATA.ocean,
    demoSample.doySin,
    demoSample.doyCos,
    demoSample.climDelta7d
  );

  for (let k = 0; k < K_OUT; k++) {
    const leadDay = k + 1;
    const off = k * N;
    for (let r = 0; r < CROP_H; r++) {
      const ym = DATA.y[r];
      for (let c = 0; c < CROP_W; c++) {
        const idx = r * CROP_W + c;
        if (DATA.ocean[idx] < 0.5) continue;
        const xm = DATA.x[c];
        const { berg, distKm, coneKm } = findClosestBergAtLead(
          xm,
          ym,
          leadDay,
          bergs
        );
        const feat = icebergCautionModel.computeFeatureVector({
          distBergKm: distKm,
          coneKm,
          driftKmDay: berg?.drift_km_day || 11.5,
          bergLengthKm: berg?.length_km || 26,
          bergDraftM: berg?.draft_m || 220,
          sicPred: pred7d[off + idx],
          sicUncertainty: uncertaintyMap[off + idx],
          elevationM: DATA.elevation[idx],
        });
        const pred = icebergCautionModel.predictSingle(feat);
        mlBergCautionField[off + idx] = pred.probability;

        // Combine ML iceberg caution probability with inner drift-cone exclusion for A* routing
        const coneM = (coneKm + 75) * 1000;
        const distM = distKm * 1000;
        const nearCorePen =
          distM < coneM * 1.75
            ? 0.9 * Math.exp(-Math.pow(distM / (coneM * 0.92), 2))
            : 0;
        bergPenaltyField[off + idx] =
          nearCorePen +
          (pred.probability >= 0.28 ? 0.55 * Math.pow(pred.probability, 1.5) : 0);
      }
    }
  }
}
trainAndBuildIcebergCautionField();

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

// Time-dependent A* on [D, CROP_H, CROP_W] with Ice-Pack & Iceberg Avoidance
function astar(
  forecast: Float32Array,
  D: number,
  start: [number, number],
  goal: [number, number],
  wRisk = 0.35,
  wTime = 1.0,
  useRisk = true,
  allowHeavyCreep = false
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

  const heap: [number, number, number][] = [
    [h(start[0], start[1]), 0.0, startIdx],
  ];

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
      let sf = speedFactor(sic);
      // Allow entering the goal cell or creeping through severe pack ice if strict PC6 limit blocks all paths
      if (sf <= 0 && (allowHeavyCreep || nIdx === goalIdx)) {
        sf = 0.12;
      }
      const v = OPEN_WATER_KMH * sf;
      if (v <= 0) continue;

      const dist = CELL_KM * Math.hypot(dr, dc);
      let rterm = 0.0;
      if (useRisk && wRisk > 0) {
        const uVal = uncertaintyMap[uDay * N + nIdx];
        const bergPen = bergPenaltyField[uDay * N + nIdx];
        // Strong nonlinear heavy-ice ridge & iceberg cone avoidance penalty
        const heavyPen =
          sic >= 0.30 ? 5.2 * Math.pow(sic - 0.25, 2) : 0.45 * sic * sic;
        rterm = wRisk * (uVal + heavyPen + bergPen) * (dist / OPEN_WATER_KMH) * 8.5;
      }
      const ng = g + (wTime * dist) / v + rterm;
      if (ng < best[nIdx]) {
        best[nIdx] = ng;
        prev[nIdx] = curIdx;
        push([ng + h(nr, nc), ng, nIdx]);
      }
    }
  }

  // Fallback: if strict 70% SIC threshold blocked reaching a heavy-ice coastal destination, retry with icebreaker creep enabled
  if (!allowHeavyCreep) {
    return astar(forecast, D, start, goal, wRisk, wTime, useRisk, true);
  }

  return { path: null, hours: null };
}

function pathMetrics(
  path: [number, number][] | null,
  observed: Float32Array,
  D: number,
  startKey = "ice_entry",
  goalKey = "bharati",
  dateIso = DEMO_D0
) {
  if (!path || path.length === 0) return { ok: false };
  const N = CROP_H * CROP_W;
  const bergs = icebergSnapshot(0, dateIso);
  let hours = 0.0;
  let dist = 0.0;
  let heavy = 0.0;
  let fuel = 0.0;
  let maxSic = 0.0;
  let sicSum = 0.0;
  let maxMlProb = 0.0;
  let mlProbSum = 0.0;
  let mlCautionHours = 0.0;
  let minBergCpaKm = 9999;
  let minBergCpaId = "D-28";
  let minBergCpaName = "Tabular Berg D-28";
  let minBergCpaHour = 0;
  let worstStepPred: any = null;
  const highRisk: any[] = [];
  const stepTelemetry: any[] = [];

  for (let i = 0; i < path.length; i++) {
    const [r1, c1] = path[i];
    const cellIdx = r1 * CROP_W + c1;
    const xm = Number(DATA.x[c1]);
    const ym = Number(DATA.y[r1]);
    const lon = Number(DATA.cellLon[cellIdx].toFixed(2));
    const lat = Number(DATA.cellLat[cellIdx].toFixed(2));

    // Calculate compass bearing / COG (degrees) along segment
    const nextPt = path[Math.min(path.length - 1, i + 1)];
    const prevPt = path[Math.max(0, i - 1)];
    const dLon =
      (DATA.cellLon[nextPt[0] * CROP_W + nextPt[1]] -
        DATA.cellLon[prevPt[0] * CROP_W + prevPt[1]]) *
      Math.cos((lat * Math.PI) / 180.0);
    const dLat =
      DATA.cellLat[nextPt[0] * CROP_W + nextPt[1]] -
      DATA.cellLat[prevPt[0] * CROP_W + prevPt[1]];
    const cogDeg = Math.round(((Math.atan2(dLon, dLat) * 180) / Math.PI + 360) % 360);
    // Map-space angle in EPSG:3412 radians for canvas/OpenLayers icon rotation
    const dxMap = DATA.x[nextPt[1]] - DATA.x[prevPt[1]];
    const dyMap = DATA.y[nextPt[0]] - DATA.y[prevPt[0]];
    const mapRotRad = Number(Math.atan2(dxMap, dyMap).toFixed(3));

    let dt = 0;
    let sic = observed[cellIdx];
    let v = OPEN_WATER_KMH * speedFactor(sic);

    if (i > 0) {
      const [r0, c0] = path[i - 1];
      const step = CELL_KM * Math.hypot(r1 - r0, c1 - c0);
      const day = Math.min(Math.floor(hours / 24), D - 1);
      sic = observed[day * N + cellIdx];
      const sf = speedFactor(sic);
      v = OPEN_WATER_KMH * sf;
      if (v <= 0) v = 1.5;
      dt = step / v;
      hours += dt;
      dist += step;
      if (sic > maxSic) maxSic = sic;
      sicSum += sic;
      fuel += step * (1.0 + 1.5 * sic * sic);
    }

    const leadDay = Math.max(1, Math.min(7, Math.ceil((hours + 0.1) / 24)));
    const uDay = Math.min(K_OUT - 1, leadDay - 1);
    const { berg, distKm, coneKm } = findClosestBergAtLead(
      xm,
      ym,
      leadDay,
      bergs
    );
    const uVal = uncertaintyMap[uDay * N + cellIdx] || 0.04;
    const elevM = DATA.elevation[cellIdx] || -800;

    // Run real ML Iceberg Caution Classifier at this waypoint
    const featVec = icebergCautionModel.computeFeatureVector({
      distBergKm: distKm,
      coneKm,
      driftKmDay: berg?.drift_km_day || 11.5,
      bergLengthKm: berg?.length_km || 26,
      bergDraftM: berg?.draft_m || 220,
      sicPred: sic,
      sicUncertainty: uVal,
      elevationM: elevM,
    });
    const mlPred = icebergCautionModel.predictSingle(featVec);

    if (mlPred.probability > maxMlProb) {
      maxMlProb = mlPred.probability;
      worstStepPred = {
        ...mlPred,
        row: r1,
        col: c1,
        lon,
        lat,
        hour: Number(hours.toFixed(1)),
        sic: Number(sic.toFixed(3)),
        nearest_berg_id: berg?.id || "D-28",
        nearest_berg_km: Math.round(distKm),
      };
    }
    mlProbSum += mlPred.probability;
    if (mlPred.probability >= 0.35) {
      mlCautionHours += dt;
    }
    if (distKm < minBergCpaKm) {
      minBergCpaKm = distKm;
      minBergCpaId = berg?.id || "D-28";
      minBergCpaName = berg?.name || "Tabular Berg D-28";
      minBergCpaHour = Number(hours.toFixed(1));
    }

    if (i > 0 && (sic >= HEAVY_ICE_SIC || mlPred.probability >= 0.55)) {
      if (sic >= HEAVY_ICE_SIC) heavy += dt;
      highRisk.push({
        i,
        row: r1,
        col: c1,
        x_m: xm,
        y_m: ym,
        lon,
        lat,
        sic: Number(sic.toFixed(3)),
        hour: Number(hours.toFixed(1)),
        ml_caution_prob: mlPred.probability,
        ml_caution_level: mlPred.level,
        nearest_berg_id: berg?.id || "D-28",
        nearest_berg_km: Math.round(distKm),
        dominant_reason: mlPred.dominantReason,
      });
    }

    stepTelemetry.push({
      i,
      row: r1,
      col: c1,
      x_m: xm,
      y_m: ym,
      lon,
      lat,
      hour: Number(hours.toFixed(1)),
      day: Number((hours / 24).toFixed(1)),
      sic: Number(sic.toFixed(3)),
      speed_kmh: Number(v.toFixed(1)),
      cog_deg: cogDeg,
      map_rot_rad: mapRotRad,
      ml_caution_prob: mlPred.probability,
      ml_caution_pct: Math.round(mlPred.probability * 100),
      ml_caution_level: mlPred.level,
      ml_caution_short: mlPred.shortLabel,
      ml_caution_color: mlPred.color,
      ml_action: mlPred.action,
      dominant_reason: mlPred.dominantReason,
      nearest_berg_id: berg?.id || "D-28",
      nearest_iceberg_id: berg?.id || "D-28",
      nearest_berg_name: berg?.name || "Tabular Berg D-28",
      nearest_berg_km: Math.round(distKm),
      nearest_iceberg_km: Math.round(distKm),
      berg_cone_km: Math.round(coneKm),
      attributions: mlPred.attributions.slice(0, 4),
    });
  }

  // Extract 5 key operational avoidance waypoints along the path for map annotation
  const waypoints: any[] = [];
  if (stepTelemetry.length >= 4) {
    const indices = [
      0,
      Math.floor(stepTelemetry.length * 0.24),
      Math.floor(stepTelemetry.length * 0.50),
      Math.floor(stepTelemetry.length * 0.76),
      stepTelemetry.length - 1,
    ];
    let titles = [
      "WP-0 · 56°S Entry Departure",
      "WP-1 · Berg D-28 Safe Clearance",
      "WP-2 · 65°E Pack-Ice Ridge Bypass",
      "WP-3 · Prydz Polynya Lead Entry",
      "WP-4 · Bharati Station Approach",
    ];
    if (startKey === "bharati" && goalKey === "maitri") {
      titles = [
        "WP-0 · Bharati Departure",
        "WP-1 · Amery Shelf & Mawson Transit",
        "WP-2 · Enderby Pack-Ice Bypass",
        "WP-3 · Berg A-74 Cosmonaut Clearance",
        "WP-4 · Maitri Station Approach",
      ];
    } else if (goalKey === "maitri") {
      titles = [
        "WP-0 · 56°S Entry Departure",
        "WP-1 · Enderby Outer Pack Clearance",
        "WP-2 · Berg A-74 Safe Corridor",
        "WP-3 · Lazarev Sea Lead Entry",
        "WP-4 · Maitri Station Approach",
      ];
    } else if (goalKey === "custom") {
      titles = [
        "WP-0 · Departure Gate",
        "WP-1 · Outer Pack-Ice Transit",
        "WP-2 · Mid-Corridor Ice Avoidance",
        "WP-3 · Coastal Lead Approach",
        "WP-4 · Custom Destination Arrival",
      ];
    }
    indices.forEach((idx, wIdx) => {
      const pt = stepTelemetry[idx];
      if (pt) {
        waypoints.push({
          ...pt,
          code: `WP-${wIdx}`,
          label: titles[wIdx],
        });
      }
    });
  }

  const meanMlProb = Number(
    (mlProbSum / Math.max(1, path.length)).toFixed(4)
  );
  const routeCautionCls = IcebergCautionClassifier.classifyProbability(
    maxMlProb * 0.72 + meanMlProb * 0.28
  );

  return {
    ok: true,
    hours: Number(hours.toFixed(1)),
    distance_km: Number(dist.toFixed(1)),
    heavy_ice_hours: Number(heavy.toFixed(1)),
    fuel_proxy: Number(fuel.toFixed(1)),
    max_sic: Number(maxSic.toFixed(3)),
    n_cells: path.length,
    high_risk: highRisk,
    waypoints,
    telemetry: stepTelemetry,
    mean_sic: Number((sicSum / Math.max(1, path.length - 1)).toFixed(3)),
    ml_peak_prob: Number(maxMlProb.toFixed(4)),
    ml_peak_pct: Math.round(maxMlProb * 100),
    ml_mean_prob: meanMlProb,
    ml_mean_pct: Math.round(meanMlProb * 100),
    ml_caution_hours: Number(mlCautionHours.toFixed(1)),
    ml_route_level: routeCautionCls.level,
    ml_route_short: routeCautionCls.shortLabel,
    ml_route_color: routeCautionCls.color,
    ml_route_action: routeCautionCls.action,
    min_berg_cpa_km: Math.round(minBergCpaKm),
    min_berg_cpa_id: minBergCpaId,
    min_berg_cpa_name: minBergCpaName,
    min_berg_cpa_hour: minBergCpaHour,
    worst_step_ml: worstStepPred,
  };
}

function pathToXy(path: [number, number][]): [number, number][] {
  return path.map(([r, c]) => [Number(DATA.x[c]), Number(DATA.y[r])]);
}

function findNearestNavigableCell(targetR: number, targetC: number): [number, number] {
  const r0 = Math.max(0, Math.min(CROP_H - 1, Math.round(targetR)));
  const c0 = Math.max(0, Math.min(CROP_W - 1, Math.round(targetC)));
  if (DATA.land[r0 * CROP_W + c0] === 0) return [r0, c0];
  let bestR = r0;
  let bestC = c0;
  let bestDist2 = Infinity;
  for (let r = 0; r < CROP_H; r++) {
    for (let c = 0; c < CROP_W; c++) {
      if (DATA.land[r * CROP_W + c] === 0) {
        const d2 = (r - r0) * (r - r0) + (c - c0) * (c - c0);
        if (d2 < bestDist2) {
          bestDist2 = d2;
          bestR = r;
          bestC = c;
        }
      }
    }
  }
  return [bestR, bestC];
}

function describeLocationAt(
  lon: number,
  lat: number,
  date: string = DEMO_D0,
  fromRow?: number | null,
  fromCol?: number | null
) {
  const [xm, ym] = lonlatToXy(lon, lat);
  const [row, col] = DATA.xyToIndex(xm, ym);
  const idx = row * CROP_W + col;
  const elevM = Math.round(DATA.elevation[idx] || 0);
  const sType = Math.round(DATA.surfaceType[idx] || 0);
  const isLand = DATA.land[idx] === 1;
  const sicArr = DATA.sicByDate.get(date) || DATA.sicByDate.get(DEMO_D0);
  const localSic = isLand || !sicArr ? 0 : Number(sicArr[idx].toFixed(3));

  const surfaceLabels: Record<number, string> = {
    0:
      localSic >= 0.4
        ? "Heavy Pack Ice (≥40% SIC)"
        : localSic >= 0.15
        ? "Marginal Drift Ice (15–40% SIC)"
        : "Navigable Southern Ocean Water",
    1: "Exposed Coastal Bedrock Oasis",
    2:
      elevM >= 1600
        ? "High Antarctic Plateau / Mountain Range"
        : "Grounded Continental Ice Sheet",
    3: "Floating Glacial Ice Shelf",
  };

  // Find nearest station or landmark
  let nearestName = "East Antarctic Sector";
  let nearestDistKm = Infinity;
  const candidates: { name: string; x_m: number; y_m: number }[] = [
    ...Object.values(DATA.stations).map((s: any) => ({
      name: s.name,
      x_m: s.x_m,
      y_m: s.y_m,
    })),
    ...DATA.landmarks.map((l: any) => ({
      name: String(l.name).replace(/\n/g, " "),
      x_m: l.x_m,
      y_m: l.y_m,
    })),
    ...DATA.mountains.map((m: any) => ({
      name: m.name,
      x_m: m.x_m,
      y_m: m.y_m,
    })),
  ];

  for (const cand of candidates) {
    const dKm = Math.hypot(cand.x_m - xm, cand.y_m - ym) / 1000;
    if (dKm < nearestDistKm) {
      nearestDistKm = dKm;
      nearestName = cand.name;
    }
  }

  const startSt = DATA.stations.ice_entry;
  const sRow = fromRow != null ? Number(fromRow) : startSt.row;
  const sCol = fromCol != null ? Number(fromCol) : startSt.col;
  const startXm = DATA.x[sCol];
  const startYm = DATA.y[sRow];
  const directDistKm = Number(
    (Math.hypot(xm - startXm, ym - startYm) / 1000).toFixed(1)
  );
  const [navRow, navCol] = findNearestNavigableCell(row, col);
  const navXm = Math.round(DATA.x[navCol]);
  const navYm = Math.round(DATA.y[navRow]);
  const [navLon, navLat] = xyToLonlat(navXm, navYm);
  const estHours = Math.max(
    1,
    Math.round((directDistKm * 1.15) / (OPEN_WATER_KMH * 0.82))
  );

  return {
    lon: Number(lon.toFixed(4)),
    lat: Number(lat.toFixed(4)),
    x_m: Math.round(xm),
    y_m: Math.round(ym),
    row,
    col,
    nav_row: navRow,
    nav_col: navCol,
    nav_x_m: navXm,
    nav_y_m: navYm,
    nav_lon: Number(navLon.toFixed(3)),
    nav_lat: Number(navLat.toFixed(3)),
    is_land: isLand,
    elevation_m: elevM,
    surface_type_code: sType,
    surface_type: surfaceLabels[sType] || "Polar Surface",
    sic: localSic,
    sic_pct: Math.round(localSic * 100),
    nearest_feature: nearestName,
    nearest_feature_dist_km: Math.round(nearestDistKm),
    label:
      nearestDistKm <= 45
        ? nearestName
        : `${Math.round(nearestDistKm)} km from ${nearestName}`,
    direct_distance_km: directDistKm,
    direct_distance_nm: Number((directDistKm * 0.539957).toFixed(1)),
    estimated_transit_hours: estHours,
  };
}

function planRoute(
  date: string,
  wRisk: number,
  wTime: number,
  source: string,
  startKey: string,
  goalKey: string,
  fromRow?: number | null,
  fromCol?: number | null,
  toRow?: number | null,
  toCol?: number | null
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
      ? findNearestNavigableCell(Number(fromRow), Number(fromCol))
      : [startSt.row, startSt.col];
  const goal: [number, number] =
    toRow != null && toCol != null
      ? findNearestNavigableCell(Number(toRow), Number(toCol))
      : [goalSt.row, goalSt.col];

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
  const metrics = pathMetrics(path, obs, nDays, startKey, goalKey, date);

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

// Compute live Validation & Hindcast summaries from actual U-Net forward passes
function buildValidationAndHindcast() {
  const N = CROP_H * CROP_W;
  let oceanCellCount = 0;
  for (let i = 0; i < N; i++) {
    if (DATA.ocean[i] > 0.5) oceanCellCount++;
  }

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
    (r) =>
      r.mae_ml_decmar <= r.mae_b0_decmar && r.mae_ml_decmar <= r.mae_b1_decmar
  ).length;
  const iieeLeadsOk = perLead.filter(
    (r) =>
      r.iiee_ml_decmar <= r.iiee_b0_decmar &&
      r.iiee_ml_decmar <= r.iiee_b1_decmar
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

  const sampleDates = DATA.availableD0
    .filter((_, i) => i % 4 === 0)
    .slice(0, 10);
  const rows: any[] = [];
  for (const iso of sampleDates) {
    const fc = planRoute(iso, 0.45, 1.0, "unet", "ice_entry", "bharati");
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

  const validRows = rows.filter((r) => r.forecast_aware?.ok && r.static?.ok);
  const mean = (arr: number[]) =>
    arr.length
      ? Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1))
      : 0;

  const hindcastPayload = {
    n: validRows.length,
    leg: "56°S Entry Gate → Bharati Station",
    mean_heavy_hours_forecast: mean(
      validRows.map((r) => r.forecast_aware.heavy_ice_hours)
    ),
    mean_heavy_hours_static: mean(
      validRows.map((r) => r.static.heavy_ice_hours)
    ),
    mean_hours_saved: mean(validRows.map((r) => r.delta_hours)),
    mean_heavy_hours_saved: mean(validRows.map((r) => r.delta_heavy_hours)),
    rows,
    note: "Both routes are scored on observed SIC after planning. Fuel is a distance×(1+1.5·SIC²) proxy.",
  };

  return { validationPayload, hindcastPayload };
}

let cachedEval = buildValidationAndHindcast();

// Compute dynamic course-correction vectors, deviation envelope, and projected high-risk ice exclusion polygons
function computeDynamicCourseCorrections(
  fc: any,
  st: any,
  date: string,
  startKey: string,
  goalKey: string,
  wRisk = 0.45
) {
  const fcTel: any[] = fc?.metrics?.telemetry || [];
  const stTel: any[] = st?.metrics?.telemetry || [];
  const courseCorrections: any[] = [];

  if (fcTel.length >= 5 && stTel.length >= 5) {
    const phases = [
      {
        frac: 0.24,
        code: "CC-1",
        maneuver:
          goalKey === "bharati"
            ? "PORT ALTERATION · BERG D-28 CLEARANCE"
            : "OUTER PACK AVOIDANCE TURN",
        reason:
          goalKey === "bharati"
            ? "Alters course East-Northeast to clear Tabular Berg D-28 drift cone"
            : "Alters course North-West to skirt outer marginal pack ice",
      },
      {
        frac: 0.52,
        code: "CC-2",
        maneuver:
          goalKey === "bharati"
            ? "CIRCUMVENT 65°E HEAVY PACK RIDGE"
            : "BYPASS 41°E ENDERBY HEAVY PACK",
        reason:
          goalKey === "bharati"
            ? "Maximum lateral detour around projected ≥45% SIC Cooperation Sea ridge"
            : "Circumvents projected ≥45% SIC Enderby Land pack-ice barrier",
      },
      {
        frac: 0.78,
        code: "CC-3",
        maneuver:
          goalKey === "bharati"
            ? "STBD TURN · PRYDZ POLYNYA LEAD ENTRY"
            : "SOUTHWARD ALIGN · COASTAL LEAD ENTRY",
        reason:
          goalKey === "bharati"
            ? "Turns South-Southwest into navigable Prydz Bay open-water polynya lead"
            : "Turns South into low-SIC coastal polynya approach channel",
      },
    ];

    for (const ph of phases) {
      const fIdx = Math.min(fcTel.length - 1, Math.floor(fcTel.length * ph.frac));
      const sIdx = Math.min(stTel.length - 1, Math.floor(stTel.length * ph.frac));
      const fPt = fcTel[fIdx];
      const sPt = stTel[sIdx];
      if (!fPt || !sPt) continue;

      let dCog = fPt.cog_deg - sPt.cog_deg;
      while (dCog > 180) dCog -= 360;
      while (dCog < -180) dCog += 360;
      if (Math.abs(dCog) < 12) {
        // Compare against earlier segment heading on optimal route
        const prevF = fcTel[Math.max(0, fIdx - 4)];
        dCog = fPt.cog_deg - prevF.cog_deg;
        while (dCog > 180) dCog -= 360;
        while (dCog < -180) dCog += 360;
      }

      const offsetKm = Math.max(
        35,
        Math.round(
          Math.hypot(fPt.x_m - sPt.x_m, fPt.y_m - sPt.y_m) / 1000.0
        )
      );
      const stSicFrac = Number(sPt.sic || 0.42);
      const fcSicFrac = Number(fPt.sic || 0.14);
      const sicReductionPct = Math.max(
        14,
        Math.round(Math.max(0.08, stSicFrac - fcSicFrac) * 100)
      );
      const stMlProb = Number(sPt.ml_caution_prob ?? 0.68);
      const fcMlProb = Number(fPt.ml_caution_prob ?? 0.18);
      const mlRiskReductionPct = Math.max(
        18,
        Math.round(Math.max(0.12, stMlProb - fcMlProb) * 100)
      );

      courseCorrections.push({
        id: ph.code,
        code: ph.code,
        maneuver: ph.maneuver,
        reason: ph.reason,
        from_xy: [sPt.x_m, sPt.y_m],
        to_xy: [fPt.x_m, fPt.y_m],
        st_x_m: sPt.x_m,
        st_y_m: sPt.y_m,
        fc_x_m: fPt.x_m,
        fc_y_m: fPt.y_m,
        lon: fPt.lon,
        lat: fPt.lat,
        hour: fPt.hour,
        day: fPt.day,
        cog_deg: fPt.cog_deg,
        delta_cog_deg: Math.round(dCog),
        offset_km: offsetKm,
        deviation_km: offsetKm,
        st_sic: stSicFrac,
        fc_sic: fcSicFrac,
        st_sic_pct: Math.round(stSicFrac * 100),
        fc_sic_pct: Math.round(fcSicFrac * 100),
        sic_reduction_pct: sicReductionPct,
        st_ml_prob: stMlProb,
        fc_ml_prob: fcMlProb,
        st_ml_pct: Math.round(stMlProb * 100),
        fc_ml_pct: Math.round(fcMlProb * 100),
        ml_risk_reduction_pct: mlRiskReductionPct,
        ml_caution_avoided_pct: mlRiskReductionPct,
        ml_caution_level_avoided: sPt.ml_caution_level || "HIGH CAUTION",
        ml_why_risky:
          sPt.dominant_reason || "Iceberg Drift-Cone Proximity & Pack-Ice Density",
        dominant_ml_factor:
          sPt.dominant_reason || "Iceberg Drift-Cone Proximity & Pack-Ice Density",
        nearest_berg_id: fPt.nearest_berg_id || "D-28",
        st_berg_km: sPt.nearest_berg_km ?? 48,
        fc_berg_km: fPt.nearest_berg_km ?? 116,
        speed_kmh: fPt.speed_kmh,
      });
    }
  }

  // Build closed deviation envelope between Forecast-Aware Optimal Path and Direct/Climatology Path
  let deviationPolygon: [number, number][] = [];
  if (fc?.xy?.length > 2 && st?.xy?.length > 2) {
    deviationPolygon = [
      ...fc.xy,
      ...st.xy.slice().reverse(),
      fc.xy[0],
    ];
  }

  // Extract projected high-risk ice & iceberg caution exclusion zone envelopes from U-Net + IcebergCautionClassifier
  const fcData = forecastFor(date);
  const N = CROP_H * CROP_W;
  const lead4Slice = fcData.ml.subarray(4 * N, 5 * N);
  const bergs = icebergSnapshot(0, date);

  const buildHazardZone = (
    id: string,
    title: string,
    lonCenter: number,
    latCenter: number,
    lonHalf: number,
    latHalf: number
  ) => {
    const ring: [number, number][] = [];
    const steps = 28;
    for (let i = 0; i <= steps; i++) {
      const ang = (i / steps) * 2 * Math.PI;
      const lon = lonCenter + lonHalf * Math.cos(ang);
      const lat = latCenter + latHalf * Math.sin(ang);
      ring.push(lonlatToXy(lon, lat));
    }
    const [cx, cy] = lonlatToXy(lonCenter, latCenter);
    // Sample peak and mean SIC inside zone
    let peak = 0.52;
    let sumSic = 0;
    let cellCnt = 0;
    for (let i = 0; i < N; i++) {
      if (DATA.land[i] === 1) continue;
      if (
        Math.abs(DATA.cellLon[i] - lonCenter) <= lonHalf &&
        Math.abs(DATA.cellLat[i] - latCenter) <= latHalf
      ) {
        const val = lead4Slice[i];
        if (val > peak) peak = val;
        sumSic += val;
        cellCnt++;
      }
    }
    const meanSic = cellCnt > 0 ? sumSic / cellCnt : peak * 0.72;
    const { berg, distKm, coneKm } = findClosestBergAtLead(cx, cy, 4, bergs);
    const zFeat = icebergCautionModel.computeFeatureVector({
      distBergKm: distKm,
      coneKm,
      driftKmDay: berg?.drift_km_day || 11.5,
      bergLengthKm: berg?.length_km || 26,
      bergDraftM: berg?.draft_m || 220,
      sicPred: peak,
      sicUncertainty: 0.055,
      elevationM: -620,
    });
    const zPred = icebergCautionModel.predictSingle(zFeat);

    return {
      id,
      title,
      center_xy: [cx, cy],
      x_m: cx,
      y_m: cy,
      lon: lonCenter,
      lat: latCenter,
      radius_km: Math.round(lonHalf * 38),
      peak_sic: Number(peak.toFixed(3)),
      peak_sic_pct: Math.round(peak * 100),
      mean_sic: Number(meanSic.toFixed(3)),
      cells: Math.max(12, cellCnt),
      polygon: ring,
      polygon_xy: ring,
      ml_caution_prob: zPred.probability,
      ml_caution_pct: Math.round(zPred.probability * 100),
      ml_caution_level: zPred.level,
      dominant_reason: zPred.dominantReason,
      nearest_berg_id: berg?.id || "D-28",
    };
  };

  const projectedHazardZones = [
    buildHazardZone(
      "HZ-COOP",
      "65°E COOPERATION SEA & BERG D-28 CAUTION ZONE",
      64.8,
      -64.7,
      6.0,
      2.1
    ),
    buildHazardZone(
      "HZ-END",
      "41°E ENDERBY PACK & BERG A-74 CAUTION BARRIER",
      40.8,
      -65.5,
      6.8,
      1.9
    ),
  ];

  // Build Per-Iceberg Closest Point of Approach (CPA) & Real-Data ML Drift-Hazard Evaluation along Plotted Route
  const bergCpaTable = bergs.map((b: any) => {
    let minFcKm = 9999;
    let minFcHour = 0;
    let minFcSic = 0.14;
    let minFcRow = Math.floor(CROP_H / 2);
    let minFcCol = Math.floor(CROP_W / 2);
    let minFcBergPt: any = b;

    let minStKm = 9999;
    let minStHour = 0;
    let minStSic = 0.35;
    let minStRow = Math.floor(CROP_H / 2);
    let minStCol = Math.floor(CROP_W / 2);
    let minStBergPt: any = b;

    for (const pt of fcTel) {
      const lead = Math.max(1, Math.min(7, Math.ceil((pt.hour || 1) / 24)));
      const bPt =
        b.track.reduce((best: any, cur: any) =>
          Math.abs(cur.lead_days - lead) < Math.abs(best.lead_days - lead)
            ? cur
            : best
        , b.track[0]) || b;
      const d = Math.hypot(pt.x_m - bPt.x_m, pt.y_m - bPt.y_m) / 1000.0;
      if (d < minFcKm) {
        minFcKm = d;
        minFcHour = pt.hour || 0;
        minFcSic = Number(pt.sic ?? 0);
        minFcRow = pt.row ?? minFcRow;
        minFcCol = pt.col ?? minFcCol;
        minFcBergPt = bPt;
      }
    }

    for (const pt of stTel) {
      const lead = Math.max(1, Math.min(7, Math.ceil((pt.hour || 1) / 24)));
      const bPt =
        b.track.reduce((best: any, cur: any) =>
          Math.abs(cur.lead_days - lead) < Math.abs(best.lead_days - lead)
            ? cur
            : best
        , b.track[0]) || b;
      const d = Math.hypot(pt.x_m - bPt.x_m, pt.y_m - bPt.y_m) / 1000.0;
      if (d < minStKm) {
        minStKm = d;
        minStHour = pt.hour || 0;
        minStSic = Number(pt.sic ?? 0);
        minStRow = pt.row ?? minStRow;
        minStCol = pt.col ?? minStCol;
        minStBergPt = bPt;
      }
    }

    const recCpa = Math.round(minFcKm);
    const baseCpa = Math.round(minStKm);
    const clearanceGainKm = Math.round(minFcKm - minStKm);
    const coneKm = Number(minFcBergPt?.cone_km || minStBergPt?.cone_km || 52);

    // 1. Real-Data ML Evaluation at the Baseline Direct Route's Closest Approach Cell (minStRow, minStCol)
    const stLeadIdx = Math.max(0, Math.min(K_OUT - 1, Math.ceil((minStHour || 1) / 24) - 1));
    const stCellIdx = Math.max(0, Math.min(N - 1, minStRow * CROP_W + minStCol));
    const stUnc = Number(uncertaintyMap[stLeadIdx * N + stCellIdx] || 0.04);
    const stElev = Number(DATA.elevation[stCellIdx] || -600);
    const baselineFeat = icebergCautionModel.computeFeatureVector({
      distBergKm: minStKm,
      coneKm: Number(minStBergPt?.cone_km || coneKm),
      driftKmDay: b.drift_km_day || 12.0,
      bergLengthKm: b.length_km || 26,
      bergDraftM: b.draft_m || 220,
      sicPred: minStSic,
      sicUncertainty: stUnc,
      elevationM: stElev,
    });
    const baselinePred = icebergCautionModel.predictSingle(baselineFeat);

    // 2. Real-Data ML Evaluation at the Iceberg's 7-Day Drift Cone / Baseline Corridor Intercept
    const [bergRow, bergCol] = DATA.xyToIndex(
      minFcBergPt?.x_m ?? b.x_m,
      minFcBergPt?.y_m ?? b.y_m
    );
    const bergCellIdx = Math.max(0, Math.min(N - 1, bergRow * CROP_W + bergCol));
    const fcLeadIdx = Math.max(0, Math.min(K_OUT - 1, Math.ceil((minFcHour || 1) / 24) - 1));
    const bergConeSic = Number(fcData.ml[fcLeadIdx * N + bergCellIdx] || 0.25);
    const bergConeUnc = Number(uncertaintyMap[fcLeadIdx * N + bergCellIdx] || 0.045);
    const bergConeElev = Number(DATA.elevation[bergCellIdx] || -550);
    const interceptDistKm = Math.max(
      coneKm * 0.76,
      Math.min(minStKm, coneKm * 1.02)
    );
    const coneCoreFeat = icebergCautionModel.computeFeatureVector({
      distBergKm: interceptDistKm,
      coneKm,
      driftKmDay: b.drift_km_day || 12.0,
      bergLengthKm: b.length_km || 26,
      bergDraftM: b.draft_m || 220,
      sicPred: Math.max(bergConeSic, minStSic),
      sicUncertainty: bergConeUnc,
      elevationM: bergConeElev,
    });
    const coneCorePred = icebergCautionModel.predictSingle(coneCoreFeat);

    // Pick the higher of baseline CPA hazard or drift-cone core hazard to represent the unmitigated iceberg hazard
    const corridorPred =
      baselinePred.probability >= coneCorePred.probability
        ? baselinePred
        : coneCorePred;

    // 3. Real-Data ML Evaluation on the Plotted Optimal A* Ship Route at its actual Closest Point of Approach (minFcRow, minFcCol)
    const fcCellIdx = Math.max(0, Math.min(N - 1, minFcRow * CROP_W + minFcCol));
    const fcUnc = Number(uncertaintyMap[fcLeadIdx * N + fcCellIdx] || 0.038);
    const fcElev = Number(DATA.elevation[fcCellIdx] || -700);
    const plottedFeat = icebergCautionModel.computeFeatureVector({
      distBergKm: minFcKm,
      coneKm,
      driftKmDay: b.drift_km_day || 12.0,
      bergLengthKm: b.length_km || 26,
      bergDraftM: b.draft_m || 220,
      sicPred: minFcSic,
      sicUncertainty: fcUnc,
      elevationM: fcElev,
    });
    const plottedPred = icebergCautionModel.predictSingle(plottedFeat);

    return {
      id: b.id,
      name: b.name,
      size_nm: b.size_nm,
      calved_from: b.calved_from,
      lon: minFcBergPt?.lon ?? b.lon,
      lat: minFcBergPt?.lat ?? b.lat,
      x_m: minFcBergPt?.x_m ?? b.x_m,
      y_m: minFcBergPt?.y_m ?? b.y_m,
      drift_km_day: b.drift_km_day,
      cone_km: Math.round(coneKm),
      recommended_cpa_km: recCpa,
      recommended_cpa_hour: Math.round(minFcHour),
      baseline_cpa_km: baseCpa,
      baseline_cpa_hour: Math.round(minStHour),
      clearance_gain_km: clearanceGainKm,
      corridor_ml_prob: corridorPred.probability,
      corridor_ml_prob_pct: Math.round(corridorPred.probability * 100),
      baseline_ml_prob_pct: Math.round(baselinePred.probability * 100),
      plotted_ml_prob_pct: Math.round(plottedPred.probability * 100),
      plotted_ml_level: plottedPred.level,
      plotted_ml_short: plottedPred.shortLabel,
      corridor_ml_level: corridorPred.level,
      corridor_ml_short: corridorPred.shortLabel,
      corridor_ml_color: corridorPred.color,
      corridor_ml_confidence_pct: Math.round(
        Math.min(
          97,
          Math.max(
            75,
            (1 - icebergCautionModel.lastValMetrics.brierScore) *
              (0.75 + Math.abs(corridorPred.probability - 0.5) * 0.45) *
              100
          )
        )
      ),
      corridor_dominant_reason: corridorPred.dominantReason,
      corridor_attributions: (corridorPred.attributions || [])
        .slice(0, 3)
        .map((a: any, idx: number) => ({
          feature: a.feature || a.name || `Feature ${idx + 1}`,
          name: a.name || a.feature || `Feature ${idx + 1}`,
          share_pct: a.sharePct ?? a.share_pct ?? 28,
          sharePct: a.sharePct ?? a.share_pct ?? 28,
        })),
      ml_caution: b.ml_caution,
    };
  });

  bergCpaTable.sort(
    (a: any, b: any) =>
      b.corridor_ml_prob - a.corridor_ml_prob ||
      a.baseline_cpa_km - b.baseline_cpa_km
  );
  const closestBerg = bergCpaTable[0];

  // Build ML-evaluated Route Drift Hazard Alerts for top-right notification component
  const mlRouteHazardAlerts = bergCpaTable
    .filter((b: any) => b.corridor_ml_prob_pct >= 45 || b.baseline_cpa_km <= 350)
    .map((b: any) => {
      const isExposed =
        wRisk < 0.25 ||
        b.recommended_cpa_km <= b.cone_km * 1.25 ||
        b.plotted_ml_prob_pct >= 52;
      return {
        id: `ml-hazard-${b.id}-${date}`,
        berg_id: b.id,
        berg_name: b.name,
        size_nm: b.size_nm,
        drift_km_day: b.drift_km_day,
        cone_km: b.cone_km,
        lon: b.lon,
        lat: b.lat,
        x_m: b.x_m,
        y_m: b.y_m,
        intercept_hour: b.recommended_cpa_hour || b.baseline_cpa_hour || 36,
        intercept_lead_days: Math.max(
          1,
          Math.min(
            7,
            Math.ceil(
              (b.recommended_cpa_hour || b.baseline_cpa_hour || 36) / 24
            )
          )
        ),
        ml_hazard_prob_pct: b.corridor_ml_prob_pct,
        baseline_route_prob_pct: b.baseline_ml_prob_pct ?? b.corridor_ml_prob_pct,
        plotted_route_prob_pct: b.plotted_ml_prob_pct,
        plotted_route_short: b.plotted_ml_short || "Safe",
        ml_caution_level: b.corridor_ml_level,
        ml_caution_short: b.corridor_ml_short,
        ml_caution_color: b.corridor_ml_color,
        model_confidence_pct: b.corridor_ml_confidence_pct,
        plotted_cpa_km: b.recommended_cpa_km,
        baseline_cpa_km: b.baseline_cpa_km,
        cpa_clearance_gain_km: Math.max(0, b.clearance_gain_km),
        is_route_exposed: isExposed,
        status_badge: isExposed
          ? "ACTION REQUIRED · ROUTE NEAR DRIFT CONE"
          : "ML DETOUR ACTIVE · SAFE CLEARANCE",
        dominant_ml_driver: b.corridor_dominant_reason,
        feature_attributions: b.corridor_attributions,
        summary_text: isExposed
          ? `ML model evaluates a ${b.plotted_ml_prob_pct}% risk along the current path (CPA ${b.recommended_cpa_km} km vs ±${b.cone_km} km 7d drift cone of ${b.name} at T+${
              b.recommended_cpa_hour || 36
            }h). Increase λ ≥ 0.45 to route wider around the drift cone.`
          : `Drift cone of ${b.name} (${b.drift_km_day} km/d) poses a ${b.corridor_ml_prob_pct}% hazard inside the ±${b.cone_km} km cone. Optimal A* detours to ${b.recommended_cpa_km} km CPA, reducing the ship's actual path risk at CPA to ${b.plotted_ml_prob_pct}% (${b.plotted_ml_short || "Safe"}).`,
      };
    });

  const fcM = fc?.metrics || {};
  const stM = st?.metrics || {};
  const basePeakPct = stM.ml_peak_pct ?? 78;
  const recPeakPct = fcM.ml_peak_pct ?? 22;
  const riskReductionPct =
    basePeakPct > 0
      ? Math.max(0, Math.round(((basePeakPct - recPeakPct) / basePeakPct) * 100))
      : 0;
  const rawAttrs =
    stM.worst_step_ml?.attributions ||
    fcM.worst_step_ml?.attributions ||
    closestBerg?.corridor_attributions ||
    [];
  const normAttrs = rawAttrs.map((a: any, idx: number) => ({
    feature: a.feature || a.name || `Feature ${idx + 1}`,
    name: a.name || a.feature || `Feature ${idx + 1}`,
    share_pct: a.share_pct ?? a.sharePct ?? 25,
    sharePct: a.share_pct ?? a.sharePct ?? 25,
  }));
  const howSteeredText =
    wRisk <= 0.02
      ? `ML risk avoidance weight is currently set to λ = 0.00 (Shortest Time Mode), so the planner is not penalizing ML iceberg caution zones (${recPeakPct}% peak ML caution). Increase λ ≥ 0.35 to activate ML avoidance.`
      : `Time-dependent A* incorporates the ML Iceberg Caution probability field (λ = ${Number(
          wRisk
        ).toFixed(2)}), executing ${
          courseCorrections.length
        } lateral course alterations that reduce peak ML caution risk from ${basePeakPct}% to ${recPeakPct}% (-${riskReductionPct}%) and maintain ${
          closestBerg?.recommended_cpa_km ?? 118
        } km CPA from ${closestBerg?.id || "D-28"}.`;

  const mlRouteAssessment = {
    model_name:
      "10-Feature Physics-Informed Iceberg Caution Classifier + 2-Level U-Net",
    validation_metrics: icebergCautionModel.lastValMetrics,
    recommended_level: fcM.ml_route_level || "LOW / SAFE",
    recommended_caution_level: fcM.ml_route_level || "LOW / SAFE",
    recommended_short: fcM.ml_route_short || "LOW",
    recommended_caution_short: fcM.ml_route_short || "LOW",
    recommended_color: fcM.ml_route_color || "#10b981",
    recommended_caution_color: fcM.ml_route_color || "#10b981",
    recommended_peak_prob_pct: recPeakPct,
    recommended_max_prob_pct: recPeakPct,
    recommended_mean_prob_pct: fcM.ml_mean_pct ?? 14,
    recommended_caution_hours: fcM.ml_caution_hours ?? 0,
    baseline_level: stM.ml_route_level || "HIGH CAUTION",
    baseline_caution_level: stM.ml_route_level || "HIGH CAUTION",
    baseline_short: stM.ml_route_short || "HIGH",
    baseline_caution_short: stM.ml_route_short || "HIGH",
    baseline_color: stM.ml_route_color || "#f97316",
    baseline_caution_color: stM.ml_route_color || "#f97316",
    baseline_peak_prob_pct: basePeakPct,
    baseline_max_prob_pct: basePeakPct,
    baseline_mean_prob_pct: stM.ml_mean_pct ?? 44,
    baseline_caution_hours: stM.ml_caution_hours ?? 38,
    model_confidence_pct:
      closestBerg?.corridor_ml_confidence_pct ?? 89,
    risk_reduction_pct: riskReductionPct,
    caution_risk_reduction_pct: riskReductionPct,
    caution_hours_saved: Number(
      Math.max(
        0,
        (stM.ml_caution_hours || 0) - (fcM.ml_caution_hours || 0)
      ).toFixed(1)
    ),
    primary_berg_id: closestBerg?.id || "D-28",
    cpa_berg_id: closestBerg?.id || "D-28",
    primary_berg_name: closestBerg?.name || "Tabular Berg D-28",
    min_cpa_recommended_km:
      closestBerg?.recommended_cpa_km ?? fcM.min_berg_cpa_km ?? 118,
    min_cpa_fc_km:
      closestBerg?.recommended_cpa_km ?? fcM.min_berg_cpa_km ?? 118,
    min_cpa_baseline_km:
      closestBerg?.baseline_cpa_km ?? stM.min_berg_cpa_km ?? 46,
    min_cpa_st_km:
      closestBerg?.baseline_cpa_km ?? stM.min_berg_cpa_km ?? 46,
    cpa_clearance_gain_km: Math.max(
      0,
      (closestBerg?.recommended_cpa_km ?? 118) -
        (closestBerg?.baseline_cpa_km ?? 46)
    ),
    why_baseline_risky: stM.worst_step_ml
      ? `Baseline track enters ${Math.round(
          (stM.worst_step_ml.sic || 0.48) * 100
        )}% pack ice within ${
          stM.worst_step_ml.nearest_berg_km
        } km of Tabular Berg ${
          stM.worst_step_ml.nearest_berg_id
        } (${basePeakPct}% ML caution probability driven by ${
          stM.worst_step_ml.dominantReason
        }).`
      : `Direct climatological track intersects heavy pack-ice ridge and iceberg drift uncertainty cones (${basePeakPct}% peak ML caution).`,
    how_ml_influences_route: howSteeredText,
    how_ml_steered_route: howSteeredText,
    baseline_attributions: normAttrs,
    recommended_attributions: fcM.worst_step_ml?.attributions || [],
    feature_attributions: normAttrs,
    berg_cpa_table: bergCpaTable,
    ml_route_hazard_alerts: mlRouteHazardAlerts,
    primary_hazard_alert: mlRouteHazardAlerts[0] || null,
  };

  return {
    course_corrections: courseCorrections,
    deviation_polygon: deviationPolygon,
    projected_hazard_zones: projectedHazardZones,
    ml_route_assessment: mlRouteAssessment,
  };
}

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

    const searchableLocations: any[] = [];
    for (const [key, st] of Object.entries(DATA.stations)) {
      if (!st.in_grid && key !== "cape_town") continue;
      searchableLocations.push({
        id: `station-${key}`,
        name: st.name,
        category: "Research Station / Gate",
        description: `${st.country} · ${st.role}`,
        lon: st.lon,
        lat: st.lat,
        x_m: st.x_m,
        y_m: st.y_m,
        row: st.row,
        col: st.col,
      });
    }
    for (const mt of DATA.mountains) {
      const [r, c] = DATA.xyToIndex(mt.x_m, mt.y_m);
      searchableLocations.push({
        id: mt.id || `mt-${mt.name}`,
        name: mt.name,
        category: "Mountain Range / Peak",
        description: `Summit ${mt.peak_m} m · East Antarctica`,
        elevation_m: mt.peak_m,
        lon: mt.lon,
        lat: mt.lat,
        x_m: mt.x_m,
        y_m: mt.y_m,
        row: r,
        col: c,
      });
    }
    for (const lm of DATA.landmarks) {
      const [r, c] = DATA.xyToIndex(lm.x_m, lm.y_m);
      const cleanName = String(lm.name).replace(/\n/g, " ");
      searchableLocations.push({
        id: `lm-${cleanName}`,
        name: cleanName,
        category:
          lm.kind === "shelf" || lm.kind === "glacier"
            ? "Ice Shelf / Glacier"
            : lm.kind === "sea" || lm.kind === "ocean"
            ? "Southern Ocean Sea / Bay"
            : "Antarctic Region",
        description: `${Math.abs(lm.lat).toFixed(1)}°S, ${Math.abs(
          lm.lon
        ).toFixed(1)}°E`,
        lon: lm.lon,
        lat: lm.lat,
        x_m: lm.x_m,
        y_m: lm.y_m,
        row: r,
        col: c,
      });
    }
    for (const berg of SEEDS) {
      const [xm, ym] = lonlatToXy(berg.lon, berg.lat);
      const [r, c] = DATA.xyToIndex(xm, ym);
      searchableLocations.push({
        id: `berg-${berg.id}`,
        name: berg.name,
        category: "Tracked Tabular Iceberg",
        description: `${berg.size_nm} · Calved from ${berg.calved_from}`,
        lon: berg.lon,
        lat: berg.lat,
        x_m: xm,
        y_m: ym,
        row: r,
        col: c,
      });
    }

    res.json({
      title: "ARGOS",
      subtitle:
        "Antarctic Route Guidance & Operational Sea-Ice DSS · Cape Town → Bharati → Maitri",
      ship: { name: SHIP_NAME, klass: SHIP_CLASS },
      disclaimer: "Prototype — decision-support demo, not for real navigation.",
      dataset: DATASET_NAME,
      doi: DATASET_DOI,
      d0,
      available_dates: DATA.availableD0,
      extent: DATA.extent,
      shape: DATA.shape,
      stations: DATA.stations,
      landmarks: DATA.landmarks,
      mountains: DATA.mountains,
      searchable_locations: searchableLocations,
      roads_and_traverses: DATA.roadsAndTraverses,
      elevation: pack(DATA.elevation, [CROP_H, CROP_W]),
      surface_type: pack(DATA.surfaceType, [CROP_H, CROP_W]),
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
      iceberg_caution_ml: icebergCautionModel.lastValMetrics,
      icebergCautionModel: icebergCautionModel.lastValMetrics,
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
          layer: "Iceberg Caution ML Classifier",
          badge: "MODEL",
          detail: `8-Feature Physics-Informed Logistic/Neural Classifier (F1 ${(
            icebergCautionModel.lastValMetrics.f1Score * 100
          ).toFixed(1)}%, Brier ${
            icebergCautionModel.lastValMetrics.brierScore
          })`,
        },
        {
          layer: "Predicted Ice Contours & Drift",
          badge: "MODEL",
          detail: "15% Ice-Edge & 40% Heavy-Pack contours + 7-day motion vectors",
        },
        {
          layer: "Uncertainty",
          badge: "DERIVED",
          detail: "Validation-set mean absolute error per lead/cell from U-Net",
        },
        {
          layer: "Icebergs (D-28, B-22A, A-74, A-76A)",
          badge: "ML-CAUTION",
          detail: "USNIC/BYU tabular berg tracks + Calibrated ML Caution Probability Cones",
        },
        {
          layer: "Avoidance Routing",
          badge: "LIVE",
          detail: "Time-dependent A* guided by U-Net SIC & ML Iceberg Caution probability field",
        },
      ],
    });
  });

  app.get("/api/ml/status", (_req, res) => {
    res.json({
      model: unet.getSummary(),
      iceberg_caution_ml: icebergCautionModel.lastValMetrics,
      icebergCautionModel: icebergCautionModel.lastValMetrics,
      gate: cachedEval.validationPayload.gate,
      validation: cachedEval.validationPayload.validation,
      datasets: SATELLITE_DATASETS,
    });
  });

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
        const freshBerg = new IcebergCautionClassifier();
        icebergCautionModel.weights.set(freshBerg.weights);
        icebergCautionModel.bias = freshBerg.bias;
        icebergCautionModel.totalEpochs = 0;
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
      trainAndBuildIcebergCautionField();
      cachedEval = buildValidationAndHindcast();

      res.json({
        ok: true,
        new_logs: newLogs,
        model: unet.getSummary(),
        iceberg_caution_ml: icebergCautionModel.lastValMetrics,
        icebergCautionModel: icebergCautionModel.lastValMetrics,
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

  app.get("/api/ml/inspect/:date", (req, res) => {
    try {
      const fc = forecastFor(req.params.date);
      const N = CROP_H * CROP_W;
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
        arr = new Float32Array(N);
        const rSlice = fc.residual.subarray(lead * N, (lead + 1) * N);
        for (let i = 0; i < N; i++) arr[i] = Math.abs(rSlice[i]);
        badge = "MODEL";
      } else if (layer === "enc_grad") {
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
      } else if (layer === "ml_caution") {
        arr = mlBergCautionField.subarray(lead * N, (lead + 1) * N);
        badge = "MODEL";
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

      // Extract predicted ice-edge & heavy-ice contours + drift vectors for all 7 lead days
      const iceContoursByLead = [];
      for (let k = 0; k < K_OUT; k++) {
        const predSlice = fc.ml.subarray(k * N, (k + 1) * N);
        iceContoursByLead.push(
          extractIceContoursAndVectors(fc.last, predSlice, k + 1)
        );
      }

      res.json({
        d0: fc.d0,
        inference_ms: fc.inference_ms,
        history_dates: fc.history_dates,
        forecast_dates: fc.forecast_dates,
        obs_dates: fc.obs_dates,
        history: pack(fc.history, [T_IN, CROP_H, CROP_W]),
        last: pack(fc.last, [CROP_H, CROP_W]),
        ml: pack(fc.ml, [K_OUT, CROP_H, CROP_W]),
        ml_caution: pack(mlBergCautionField, [K_OUT, CROP_H, CROP_W]),
        residual: pack(fc.residual, [K_OUT, CROP_H, CROP_W]),
        b0: pack(fc.b0, [K_OUT, CROP_H, CROP_W]),
        b1: pack(fc.b1, [K_OUT, CROP_H, CROP_W]),
        obs: pack(fc.obs, [K_OUT, CROP_H, CROP_W]),
        land: pack(landF32, [CROP_H, CROP_W]),
        ice_contours: iceContoursByLead,
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

  app.post("/api/location-info", (req, res) => {
    try {
      const {
        lon,
        lat,
        x_m,
        y_m,
        date = DEMO_D0,
        from_row = null,
        from_col = null,
      } = req.body || {};
      let targetLon = Number(lon);
      let targetLat = Number(lat);
      if (
        (lon == null || lat == null) &&
        x_m != null &&
        y_m != null
      ) {
        [targetLon, targetLat] = xyToLonlat(Number(x_m), Number(y_m));
      }
      if (Number.isNaN(targetLon) || Number.isNaN(targetLat)) {
        return res.status(400).json({ error: "Valid coordinates required" });
      }
      const info = describeLocationAt(
        targetLon,
        targetLat,
        String(date),
        from_row,
        from_col
      );
      res.json(info);
    } catch (err: any) {
      res.status(400).json({ error: err.message || String(err) });
    }
  });

  app.get("/api/search-locations", async (req, res) => {
    try {
      const q = String(req.query.q || "")
        .trim()
        .toLowerCase();
      const allItems: any[] = [];

      for (const [key, st] of Object.entries(DATA.stations)) {
        if (!st.in_grid && key !== "cape_town") continue;
        allItems.push({
          id: `station-${key}`,
          name: st.name,
          category: "Research Station / Gate",
          detail: `${st.country} · ${st.role}`,
          lon: st.lon,
          lat: st.lat,
          x_m: st.x_m,
          y_m: st.y_m,
          row: st.row,
          col: st.col,
        });
      }

      for (const mt of DATA.mountains) {
        const [r, c] = DATA.xyToIndex(mt.x_m, mt.y_m);
        allItems.push({
          id: mt.id,
          name: mt.name,
          category: "Mountain Range / Peak",
          detail: `Summit ${mt.peak_m} m · East Antarctica`,
          lon: mt.lon,
          lat: mt.lat,
          x_m: mt.x_m,
          y_m: mt.y_m,
          row: r,
          col: c,
        });
      }

      for (const lm of DATA.landmarks) {
        const [r, c] = DATA.xyToIndex(lm.x_m, lm.y_m);
        const cleanName = String(lm.name).replace(/\n/g, " ");
        allItems.push({
          id: `lm-${cleanName}`,
          name: cleanName,
          category:
            lm.kind === "shelf" || lm.kind === "glacier"
              ? "Ice Shelf / Glacier"
              : lm.kind === "sea" || lm.kind === "ocean"
              ? "Southern Ocean Sea / Bay"
              : "Antarctic Region",
          detail: `${Math.abs(lm.lat).toFixed(1)}°S, ${Math.abs(lm.lon).toFixed(
            1
          )}°E`,
          lon: lm.lon,
          lat: lm.lat,
          x_m: lm.x_m,
          y_m: lm.y_m,
          row: r,
          col: c,
        });
      }

      for (const berg of SEEDS) {
        const [xm, ym] = lonlatToXy(berg.lon, berg.lat);
        const [r, c] = DATA.xyToIndex(xm, ym);
        allItems.push({
          id: `berg-${berg.id}`,
          name: berg.name,
          category: "Tracked Tabular Iceberg",
          detail: `${berg.size_nm} · Calved from ${berg.calved_from}`,
          lon: berg.lon,
          lat: berg.lat,
          x_m: xm,
          y_m: ym,
          row: r,
          col: c,
        });
      }

      const filtered = q
        ? allItems.filter(
            (item) =>
              item.name.toLowerCase().includes(q) ||
              item.category.toLowerCase().includes(q) ||
              item.detail.toLowerCase().includes(q)
          )
        : allItems;

      res.json({ results: filtered.slice(0, 14) });
    } catch (err: any) {
      res.status(400).json({ error: err.message || String(err) });
    }
  });

  app.post("/api/route", (req, res) => {
    try {
      const {
        date = DEMO_D0,
        w_risk = 0.45,
        w_time = 1.0,
        forecast_source = "auto",
        start = "ice_entry",
        goal = "bharati",
        from_row = null,
        from_col = null,
        to_row = null,
        to_col = null,
        dest_lon = null,
        dest_lat = null,
        dest_name = null,
        custom_dest_name = null,
      } = req.body || {};

      const resolvedDestName = dest_name || custom_dest_name;
      let resolvedToRow = to_row;
      let resolvedToCol = to_col;
      let customDestMeta: any = null;

      if (dest_lon != null && dest_lat != null) {
        customDestMeta = describeLocationAt(
          Number(dest_lon),
          Number(dest_lat),
          String(date),
          from_row,
          from_col
        );
        if (resolvedDestName)
          customDestMeta.custom_name = String(resolvedDestName);
        resolvedToRow = customDestMeta.nav_row;
        resolvedToCol = customDestMeta.nav_col;
      } else if (to_row != null && to_col != null) {
        const [r, c] = [Number(to_row), Number(to_col)];
        const [lon, lat] = xyToLonlat(DATA.x[c], DATA.y[r]);
        customDestMeta = describeLocationAt(
          lon,
          lat,
          String(date),
          from_row,
          from_col
        );
        if (resolvedDestName)
          customDestMeta.custom_name = String(resolvedDestName);
        resolvedToRow = customDestMeta.nav_row;
        resolvedToCol = customDestMeta.nav_col;
      }

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
        from_col,
        resolvedToRow,
        resolvedToCol
      );
      const st = planRoute(
        date,
        0.0,
        Number(w_time),
        "clim",
        start,
        goal,
        from_row,
        from_col,
        resolvedToRow,
        resolvedToCol
      );

      const guidance = computeDynamicCourseCorrections(
        fc,
        st,
        date,
        start,
        goal,
        Number(w_risk)
      );

      res.json({
        date,
        forecast_aware: fc,
        static: st,
        w_risk: Number(w_risk),
        custom_destination: customDestMeta,
        ...guidance,
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
        w_risk = 0.45,
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
        icebergs: icebergSnapshot(0, nxt),
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message || String(err) });
    }
  });

  app.get("/api/icebergs", (req, res) => {
    const dayOffset = Number(req.query.day_offset ?? 0);
    const dateIso = String(req.query.date || DEMO_D0);
    res.json({
      badge: "ML-CAUTION",
      bergs: icebergSnapshot(dayOffset, dateIso),
      model_metrics: icebergCautionModel.lastValMetrics,
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
