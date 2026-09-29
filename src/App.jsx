import React, { useEffect, useRef, useState, useMemo } from "react";
import "ol/ol.css";
import Map from "ol/Map";
import View from "ol/View";
import ImageLayer from "ol/layer/Image";
import VectorLayer from "ol/layer/Vector";
import ImageStatic from "ol/source/ImageStatic";
import VectorSource from "ol/source/Vector";
import GeoJSON from "ol/format/GeoJSON";
import Feature from "ol/Feature";
import LineString from "ol/geom/LineString";
import Point from "ol/geom/Point";
import Polygon from "ol/geom/Polygon";
import { Style, Stroke, Fill, Circle as CircleStyle, Text as TextStyle } from "ol/style";
import proj4 from "proj4";
import { register } from "ol/proj/proj4";
import Projection from "ol/proj/Projection";

import { getJSON, unpack, sliceLead } from "./api.js";
import { paintGrid } from "./colormap.js";
import Map3DView from "./Map3DView.jsx";
import LandingPage from "./LandingPage.jsx";

const EPSG_3412 =
  "+proj=stere +lat_0=-90 +lat_ts=-70 +lon_0=0 +x_0=0 +y_0=0 +a=6378273 +b=6356889.449 +units=m +no_defs";
proj4.defs("EPSG:3412", EPSG_3412);
register(proj4);

function FeatureMapCanvas({ gridPack, landPack, mode = "error", title, subtitle }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    if (!canvasRef.current || !gridPack) return;
    const g = unpack(gridPack);
    const l = landPack ? unpack(landPack) : null;
    if (mode === "normalized") {
      const norm = new Float32Array(g.data.length);
      let maxAbs = 1e-5;
      for (let i = 0; i < g.data.length; i++) {
        const v = Math.abs(g.data[i]);
        if (v > maxAbs) maxAbs = v;
      }
      for (let i = 0; i < g.data.length; i++) {
        norm[i] = (Math.abs(g.data[i]) / maxAbs) * 0.35;
      }
      paintGrid(canvasRef.current, { data: norm, shape: g.shape }, "error", l);
    } else {
      paintGrid(canvasRef.current, g, mode, l);
    }
  }, [gridPack, landPack, mode]);

  return (
    <div className="dss-fmap-card">
      <div className="dss-fmap-head">
        <strong>{title}</strong>
        <span>{subtitle}</span>
      </div>
      <canvas ref={canvasRef} className="dss-fmap-canvas" />
    </div>
  );
}

// Live Ship-Centered Tactical Ice & Avoidance Radar Scope (220 km × 220 km around RV Polar Explorer)
function ShipBridgeScope({
  shipTel,
  fcPath,
  stPath,
  activeSlice,
  extent,
  shape,
}) {
  const radarCanvasRef = useRef(null);

  useEffect(() => {
    const canvas = radarCanvasRef.current;
    if (!canvas || !shipTel || !extent || !shape) return;
    const W_PX = 142;
    const H_PX = 142;
    canvas.width = W_PX;
    canvas.height = H_PX;
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = "#060d18";
    ctx.fillRect(0, 0, W_PX, H_PX);

    const [xmin, ymin, xmax, ymax] = extent;
    const [H, W] = shape;
    const sx = shipTel.x_m;
    const sy = shipTel.y_m;
    const halfSpan = 125000; // ±125 km tactical radar window

    function mapToPx(xm, ym) {
      const px = ((xm - (sx - halfSpan)) / (2 * halfSpan)) * W_PX;
      const py = (((sy + halfSpan) - ym) / (2 * halfSpan)) * H_PX;
      return [px, py];
    }

    // 1. Paint local 25 km sea-ice cells & highlight high-risk ≥40% cells
    const sicData = activeSlice?.slice?.data;
    const landData = activeSlice?.land?.data;
    const cellW = (xmax - xmin) / W;
    const cellH = (ymax - ymin) / H;

    if (sicData) {
      for (let r = 0; r < H; r++) {
        const cy = ymax - (r + 0.5) * cellH;
        if (Math.abs(cy - sy) > halfSpan + cellH) continue;
        for (let c = 0; c < W; c++) {
          const cx = xmin + (c + 0.5) * cellW;
          if (Math.abs(cx - sx) > halfSpan + cellW) continue;
          const idx = r * W + c;
          const [px, py] = mapToPx(cx - cellW / 2, cy + cellH / 2);
          const pw = (cellW / (2 * halfSpan)) * W_PX + 0.6;
          const ph = (cellH / (2 * halfSpan)) * H_PX + 0.6;

          if (landData && landData[idx] > 0.5) {
            ctx.fillStyle = "#1e293b";
            ctx.fillRect(px, py, pw, ph);
            continue;
          }
          const sic = sicData[idx] || 0;
          if (sic >= 0.38) {
            const alpha = Math.min(0.92, 0.35 + sic * 0.65);
            ctx.fillStyle = `rgba(244, 63, 94, ${alpha.toFixed(2)})`;
            ctx.fillRect(px, py, pw, ph);
            ctx.strokeStyle = "rgba(253, 164, 175, 0.55)";
            ctx.lineWidth = 0.7;
            ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);
          } else if (sic >= 0.12) {
            const alpha = Math.min(0.82, 0.20 + sic * 0.75);
            ctx.fillStyle = `rgba(56, 189, 248, ${alpha.toFixed(2)})`;
            ctx.fillRect(px, py, pw, ph);
          }
        }
      }
    }

    // 2. Draw Naive Climatology Path in local radar scope (dashed rose)
    if (stPath?.length > 1) {
      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = "rgba(251, 113, 133, 0.80)";
      ctx.lineWidth = 1.5;
      stPath.forEach(([xm, ym], i) => {
        const [px, py] = mapToPx(xm, ym);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
      ctx.restore();
    }

    // 3. Draw Optimal Avoidance Path (Wake = Emerald, Forward Path = Cyan)
    if (fcPath?.length > 1) {
      const splitIdx = Math.max(0, Math.min(fcPath.length - 1, shipTel.idx || 0));
      if (splitIdx > 0) {
        ctx.beginPath();
        ctx.strokeStyle = "#10b981";
        ctx.lineWidth = 2.0;
        for (let i = 0; i <= splitIdx; i++) {
          const [px, py] = mapToPx(fcPath[i][0], fcPath[i][1]);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.strokeStyle = "#22d3ee";
      ctx.lineWidth = 2.5;
      for (let i = splitIdx; i < fcPath.length; i++) {
        const [px, py] = mapToPx(fcPath[i][0], fcPath[i][1]);
        if (i === splitIdx) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }

    // 4. Concentric Radar Range Rings (50 km, 100 km) & Crosshair
    const cx = W_PX / 2;
    const cy = H_PX / 2;
    ctx.strokeStyle = "rgba(148, 163, 184, 0.26)";
    ctx.lineWidth = 0.85;
    for (const rMeters of [50000, 100000]) {
      const rPx = (rMeters / (2 * halfSpan)) * W_PX;
      ctx.beginPath();
      ctx.arc(cx, cy, rPx, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, H_PX);
    ctx.moveTo(0, cy);
    ctx.lineTo(W_PX, cy);
    ctx.stroke();

    // 5. Ship Heading Vector & Oriented Vessel Hull at Center
    const dx = (shipTel.next_x_m ?? sx) - sx;
    const dy = (shipTel.next_y_m ?? sy - 1000) - sy;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = -dy / len; // canvas Y is inverted relative to EPSG:3412 Y

    ctx.beginPath();
    ctx.strokeStyle = "#fde047";
    ctx.lineWidth = 1.8;
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + ux * 36, cy + uy * 36);
    ctx.stroke();

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(Math.atan2(ux, -uy));
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(5.5, 2);
    ctx.lineTo(4.5, 8);
    ctx.lineTo(-4.5, 8);
    ctx.lineTo(-5.5, 2);
    ctx.closePath();
    ctx.fillStyle = "#f59e0b";
    ctx.fill();
    ctx.strokeStyle = "#fef3c7";
    ctx.lineWidth = 1.3;
    ctx.stroke();
    ctx.restore();

    // Scale label
    ctx.fillStyle = "rgba(148, 163, 184, 0.85)";
    ctx.font = "500 9px 'JetBrains Mono', monospace";
    ctx.fillText("50 / 100 km RING", 5, H_PX - 5);
  }, [shipTel, fcPath, stPath, activeSlice, extent, shape]);

  return <canvas ref={radarCanvasRef} className="dss-bridge-scope-canvas" />;
}

export default function App() {
  const [scenario, setScenario] = useState(null);
  const [date, setDate] = useState("2023-01-10");
  const [forecast, setForecast] = useState(null);
  const [uncertaintyGrid, setUncertaintyGrid] = useState(null);
  const [extraGrid, setExtraGrid] = useState(null);
  const [routeData, setRouteData] = useState(null);
  const [icebergs, setIcebergs] = useState([]);
  const [validation, setValidation] = useState(null);
  const [hindcast, setHindcast] = useState(null);

  // Small ML Model state & inspection
  const [mlStatus, setMlStatus] = useState(null);
  const [mlInspect, setMlInspect] = useState(null);
  const [mlTab, setMlTab] = useState("architecture"); // architecture | features | datasets
  const [guideTab, setGuideTab] = useState("overview"); // overview | layers | model | routing
  const [trainLr, setTrainLr] = useState(0.08);
  const [trainEdgeWeight, setTrainEdgeWeight] = useState(2.0);
  const [isTraining, setIsTraining] = useState(false);

  // Layer & Timeline controls
  const [activeLayer, setActiveLayer] = useState("ml"); // obs | ml | residual | enc_grad | b1 | b0 | error | uncertainty
  const [swipeEnabled, setSwipeEnabled] = useState(false);
  const [swipeSplit, setSwipeSplit] = useState(50);
  const [timelineStep, setTimelineStep] = useState(1); // -6..0 = history days, 1..7 = forecast lead days
  const [isPlaying, setIsPlaying] = useState(false);

  // Overlay toggles & Ship Tracking state (Default: ONLY the 5 requested layers checked)
  const [showIceContours, setShowIceContours] = useState(true);
  const [showIceVectors, setShowIceVectors] = useState(true);
  const [showIcebergs, setShowIcebergs] = useState(true);
  const [showRoutes, setShowRoutes] = useState(true);
  const [showCourseCorrections, setShowCourseCorrections] = useState(false);
  const [showStations, setShowStations] = useState(true);
  const [showGraticule, setShowGraticule] = useState(false);
  const [showRoads, setShowRoads] = useState(false);
  const [selectedTarget, setSelectedTarget] = useState(null);
  const [shipStepIdx, setShipStepIdx] = useState(null);
  const [autoFollowShip, setAutoFollowShip] = useState(false);
  const [showShipBridge, setShowShipBridge] = useState(false);

  // Collapsible Left & Right Side Panels + Interactive Landing Page state
  const [leftPanelOpen, setLeftPanelOpen] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [showLanding, setShowLanding] = useState(true);

  // 3D Globe / Map, Satellite/Terrain Basemap, Legend, Search & Destination State
  const [viewMode, setViewMode] = useState("3d"); // "3d" | "2d"
  const [globeMode, setGlobeMode] = useState(true); // Interactive 3D Polar Globe enabled by default
  const [basemapStyle, setBasemapStyle] = useState("satellite"); // "satellite" | "terrain" | "scientific"
  const [verticalExaggeration, setVerticalExaggeration] = useState(1.25);
  const [showMapLegend, setShowMapLegend] = useState(false);
  const [elevationGrid, setElevationGrid] = useState(null);
  const [surfaceTypeGrid, setSurfaceTypeGrid] = useState(null);
  const [activeSliceState, setActiveSliceState] = useState(null);

  // "Choose Where I Want to Go" (Select Destination) state
  const [isSelectingDestination, setIsSelectingDestination] = useState(false);
  const [selectedDestination, setSelectedDestination] = useState(null); // candidate or active destination info
  const [customDestination, setCustomDestination] = useState(null); // confirmed destination stored for A* routing
  const [loadingDestInfo, setLoadingDestInfo] = useState(false);

  // Search Location state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [showSearchDropdown, setShowSearchDropdown] = useState(false);

  // Routing parameters (Default: Bharati Station to Maitri Station)
  const [leg, setLeg] = useState("bharati->maitri");
  const [forecastSource, setForecastSource] = useState("auto");
  const [wRisk, setWRisk] = useState(0.45);
  const [wTime, setWTime] = useState(1.0);
  const [shipPos, setShipPos] = useState(null);
  const [loadingRoute, setLoadingRoute] = useState(false);

  // Active drawer: null | "guide" | "ml" | "validation" | "hindcast" | "about"
  const [drawer, setDrawer] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);

  const mapContainerRef = useRef(null);
  const map3DRef = useRef(null);
  const probeTextRef = useRef(null);
  const mapRef = useRef(null);
  const isSelectingDestRef = useRef(false);
  const handlePickDestinationRef = useRef(null);
  const rasterLayerRef = useRef(null);
  const landLayerRef = useRef(null);
  const graticuleSourceRef = useRef(new VectorSource());
  const iceDynamicsSourceRef = useRef(new VectorSource());
  const routeSourceRef = useRef(new VectorSource());
  const pulseSourceRef = useRef(new VectorSource());
  const icebergSourceRef = useRef(new VectorSource());
  const stationSourceRef = useRef(new VectorSource());
  const activeSliceRef = useRef(null);

  // 1. Load initial scenario, ML status, validation, hindcast, icebergs
  useEffect(() => {
    async function boot() {
      try {
        const sc = await getJSON("/api/scenario");
        setScenario(sc);
        setDate(sc.d0);
        if (sc.elevation) setElevationGrid(unpack(sc.elevation));
        if (sc.surface_type) setSurfaceTypeGrid(unpack(sc.surface_type));

        const [bergsRes, valRes, hcRes, mlRes] = await Promise.all([
          getJSON("/api/icebergs?day_offset=0"),
          getJSON("/api/validation").catch(() => null),
          getJSON("/api/hindcast").catch(() => null),
          getJSON("/api/ml/status").catch(() => null),
        ]);
        if (bergsRes?.bergs) setIcebergs(bergsRes.bergs);
        if (valRes) setValidation(valRes);
        if (hcRes) setHindcast(hcRes);
        if (mlRes) setMlStatus(mlRes);
      } catch (err) {
        setErrorMsg(err.message || "Failed to load scenario");
      }
    }
    boot();
  }, []);

  // 2. Initialize OpenLayers polar-stereographic map once scenario is loaded
  useEffect(() => {
    if (!scenario || !mapContainerRef.current || mapRef.current) return;

    const extent = scenario.extent;
    const polarProj = new Projection({
      code: "EPSG:3412",
      units: "m",
      extent: [-3950000, -3950000, 3950000, 4350000],
    });

    const rasterLayer = new ImageLayer({
      opacity: 0.94,
    });
    rasterLayerRef.current = rasterLayer;

    const landSource = new VectorSource({
      url: "/api/land.geojson",
      format: new GeoJSON({
        dataProjection: "EPSG:3412",
        featureProjection: "EPSG:3412",
      }),
    });
    const landLayer = new VectorLayer({
      source: landSource,
      style: (feature) => {
        const kind = feature.get("kind");
        if (kind === "iceshelf") {
          return new Style({
            fill: new Fill({ color: "rgba(56, 189, 248, 0.16)" }),
            stroke: new Stroke({
              color: "rgba(125, 211, 252, 0.65)",
              width: 1.4,
              lineDash: [5, 3],
            }),
          });
        }
        return new Style({
          fill: new Fill({ color: "rgba(17, 24, 39, 0.96)" }),
          stroke: new Stroke({ color: "rgba(148, 163, 184, 0.65)", width: 1.4 }),
        });
      },
    });
    landLayerRef.current = landLayer;

    const graticuleLayer = new VectorLayer({
      source: graticuleSourceRef.current,
    });

    const iceDynamicsLayer = new VectorLayer({
      source: iceDynamicsSourceRef.current,
    });

    const icebergLayer = new VectorLayer({
      source: icebergSourceRef.current,
    });

    const routeLayer = new VectorLayer({
      source: routeSourceRef.current,
    });

    const pulseLayer = new VectorLayer({
      source: pulseSourceRef.current,
    });

    const stationLayer = new VectorLayer({
      source: stationSourceRef.current,
    });

    const center = [
      (extent[0] + extent[2]) / 2,
      (extent[1] + extent[3]) / 2,
    ];

    const map = new Map({
      target: mapContainerRef.current,
      layers: [
        rasterLayer,
        landLayer,
        graticuleLayer,
        iceDynamicsLayer,
        icebergLayer,
        routeLayer,
        pulseLayer,
        stationLayer,
      ],
      view: new View({
        projection: polarProj,
        center,
        extent,
        constrainOnlyCenter: false,
        enableRotation: false,
        zoom: 2,
        minZoom: 1,
        maxZoom: 7,
      }),
    });

    map.getView().fit(extent, { padding: [20, 20, 20, 20] });

    // Crosshair telemetry probe on pointer move (direct DOM update to avoid layout/state jitter)
    map.on("pointermove", (evt) => {
      if (evt.dragging || !probeTextRef.current) return;
      const [xm, ym] = evt.coordinate;
      const [xmin, ymin, xmax, ymax] = extent;
      if (xm < xmin || xm > xmax || ym < ymin || ym > ymax) {
        probeTextRef.current.textContent =
          "Hover polar grid for coordinates & local SIC";
        return;
      }
      const [lon, lat] = proj4("EPSG:3412", "EPSG:4326", [xm, ym]);
      const [H, W] = scenario.shape;
      const col = Math.max(
        0,
        Math.min(W - 1, Math.floor(((xm - xmin) / (xmax - xmin)) * W))
      );
      const row = Math.max(
        0,
        Math.min(H - 1, Math.floor(((ymax - ym) / (ymax - ymin)) * H))
      );
      let val = null;
      let isLand = false;
      const cur = activeSliceRef.current;
      if (cur && cur.slice && cur.land) {
        const idx = row * W + col;
        isLand = cur.land.data[idx] > 0.5;
        val = cur.slice.data[idx];
      }
      const latStr = `${Math.abs(lat).toFixed(2)}°S`;
      const lonStr = `${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`;
      const cellStr = `Cell (${String(row).padStart(3, " ")}, ${String(col).padStart(3, " ")})`;
      const sicStr = isLand
        ? "Land / Shelf"
        : val != null
        ? `${(val * 100).toFixed(1)}% SIC`
        : "—";
      probeTextRef.current.textContent = `${latStr}, ${lonStr} · ${cellStr} · ${sicStr}`;
    });

    // Click to select destination directly on the map or inspect any interactive feature
    map.on("singleclick", (evt) => {
      if (isSelectingDestRef.current && handlePickDestinationRef.current) {
        const [xm, ym] = evt.coordinate;
        const [lon, lat] = proj4("EPSG:3412", "EPSG:4326", [xm, ym]);
        handlePickDestinationRef.current({ lon, lat, x_m: xm, y_m: ym, autoRoute: true });
        return;
      }
      let hit = null;
      map.forEachFeatureAtPixel(
        evt.pixel,
        (feat) => {
          const info = feat.get("inspect");
          if (info && !hit) {
            hit = info;
          }
        },
        { hitTolerance: 8 }
      );
      if (hit) {
        setSelectedTarget(hit);
      } else if (handlePickDestinationRef.current) {
        const [xm, ym] = evt.coordinate;
        if (
          xm >= extent[0] &&
          xm <= extent[2] &&
          ym >= extent[1] &&
          ym <= extent[3]
        ) {
          const [lon, lat] = proj4("EPSG:3412", "EPSG:4326", [xm, ym]);
          handlePickDestinationRef.current({
            lon,
            lat,
            x_m: xm,
            y_m: ym,
            autoRoute: true,
          });
        }
      }
    });

    mapRef.current = map;
  }, [scenario]);

  // Keep OpenLayers 2D map sized properly when toggling between 3D and 2D or hiding/showing side panels
  useEffect(() => {
    if (mapRef.current) {
      const t = setTimeout(() => {
        mapRef.current?.updateSize();
      }, 60);
      return () => clearTimeout(t);
    }
  }, [viewMode, leftPanelOpen, rightPanelOpen, showLanding]);

  // 2b. Render Real-World Polar Stereographic Graticule (Lat/Lon Grid) & Geographic Landmarks
  useEffect(() => {
    const src = graticuleSourceRef.current;
    src.clear();
    if (!scenario || !showGraticule) return;

    // Latitude parallels: 55°S, 60°S, 65°S, 66.56°S (Antarctic Circle), 70°S, 75°S
    const lats = [
      { lat: -55, label: "55°S", special: false },
      { lat: -60, label: "60°S ANTARCTIC TREATY", special: true },
      { lat: -65, label: "65°S", special: false },
      { lat: -66.56, label: "66°33′S ANTARCTIC CIRCLE", special: true },
      { lat: -70, label: "70°S", special: false },
    ];

    for (const item of lats) {
      const coords = [];
      for (let lon = -15; lon <= 105; lon += 1.5) {
        coords.push(proj4("EPSG:4326", "EPSG:3412", [lon, item.lat]));
      }
      const lineFeat = new Feature({
        geometry: new LineString(coords),
      });
      lineFeat.setStyle(
        new Style({
          stroke: new Stroke({
            color: item.special
              ? "rgba(56, 189, 248, 0.28)"
              : "rgba(148, 163, 184, 0.16)",
            width: item.special ? 1.1 : 0.8,
            lineDash: item.special ? [6, 4] : [2, 4],
          }),
        })
      );
      src.addFeature(lineFeat);

      // Place latitude label near 28°E
      const labelPt = proj4("EPSG:4326", "EPSG:3412", [28.0, item.lat]);
      const lblFeat = new Feature({
        geometry: new Point(labelPt),
      });
      lblFeat.setStyle(
        new Style({
          text: new TextStyle({
            text: item.label,
            font: "500 9px 'JetBrains Mono', monospace",
            fill: new Fill({
              color: item.special
                ? "rgba(125, 211, 252, 0.72)"
                : "rgba(148, 163, 184, 0.5)",
            }),
            stroke: new Stroke({ color: "rgba(7, 9, 14, 0.85)", width: 2.5 }),
            offsetY: -6,
          }),
        })
      );
      src.addFeature(lblFeat);
    }

    // Longitude meridians: 0°, 20°E, 40°E, 60°E, 80°E, 100°E
    const lons = [0, 20, 40, 60, 80, 100];
    for (const lon of lons) {
      const coords = [];
      for (let lat = -54; lat >= -75; lat -= 1.0) {
        coords.push(proj4("EPSG:4326", "EPSG:3412", [lon, lat]));
      }
      const mFeat = new Feature({
        geometry: new LineString(coords),
      });
      mFeat.setStyle(
        new Style({
          stroke: new Stroke({
            color: "rgba(148, 163, 184, 0.16)",
            width: 0.8,
            lineDash: [2, 4],
          }),
        })
      );
      src.addFeature(mFeat);

      const topPt = proj4("EPSG:4326", "EPSG:3412", [lon, -56.5]);
      const mLbl = new Feature({
        geometry: new Point(topPt),
      });
      mLbl.setStyle(
        new Style({
          text: new TextStyle({
            text: lon === 0 ? "0° PRIME" : `${lon}°E`,
            font: "500 9px 'JetBrains Mono', monospace",
            fill: new Fill({ color: "rgba(148, 163, 184, 0.55)" }),
            stroke: new Stroke({ color: "rgba(7, 9, 14, 0.85)", width: 2.5 }),
          }),
        })
      );
      src.addFeature(mLbl);
    }

    // Real-World Geographic Landmarks (Seas, Bays, Ice Shelves, Antarctic Regions)
    const landmarks = scenario.landmarks || [];
    for (const lm of landmarks) {
      const [xm, ym] =
        lm.x_m != null && lm.y_m != null
          ? [lm.x_m, lm.y_m]
          : proj4("EPSG:4326", "EPSG:3412", [lm.lon, lm.lat]);
      const feat = new Feature({
        geometry: new Point([xm, ym]),
      });
      const isOceanOrSea = lm.kind === "ocean" || lm.kind === "sea";
      const isShelf = lm.kind === "shelf";
      feat.setStyle(
        new Style({
          text: new TextStyle({
            text: lm.name,
            font:
              lm.kind === "ocean"
                ? "600 11px 'Epilogue', sans-serif"
                : isOceanOrSea
                ? "600 9.5px 'JetBrains Mono', monospace"
                : "600 9.5px 'Epilogue', sans-serif",
            fill: new Fill({
              color: isShelf
                ? "rgba(125, 211, 252, 0.8)"
                : isOceanOrSea
                ? "rgba(148, 163, 184, 0.62)"
                : "rgba(148, 163, 184, 0.58)",
            }),
            stroke: new Stroke({ color: "rgba(7, 9, 14, 0.88)", width: 3 }),
          }),
        })
      );
      src.addFeature(feat);
    }
  }, [scenario, showGraticule]);

  // 3. Load forecast, uncertainty, and ML feature inspection whenever `date` or `mlStatus.model.totalEpochs` changes
  useEffect(() => {
    if (!scenario || !date) return;
    let cancelled = false;
    async function fetchForecast() {
      try {
        const [fcRaw, uncRaw, inspRaw] = await Promise.all([
          getJSON(`/api/forecast/${date}`),
          getJSON(
            `/api/grid?date=${date}&lead=${Math.max(
              0,
              timelineStep - 1
            )}&layer=uncertainty`
          ),
          getJSON(`/api/ml/inspect/${date}`).catch(() => null),
        ]);
        if (cancelled) return;
        const unpacked = {
          ...fcRaw,
          rawLandPack: fcRaw.land,
          history: unpack(fcRaw.history),
          last: unpack(fcRaw.last),
          ml: unpack(fcRaw.ml),
          residual: fcRaw.residual ? unpack(fcRaw.residual) : null,
          b0: unpack(fcRaw.b0),
          b1: unpack(fcRaw.b1),
          obs: unpack(fcRaw.obs),
          land: unpack(fcRaw.land),
        };
        setForecast(unpacked);
        if (uncRaw?.grid) {
          setUncertaintyGrid(unpack(uncRaw.grid));
        }
        if (inspRaw) {
          setMlInspect(inspRaw);
        }
      } catch (err) {
        if (!cancelled) setErrorMsg(err.message);
      }
    }
    fetchForecast();
    return () => {
      cancelled = true;
    };
  }, [scenario, date, mlStatus?.model?.totalEpochs]);

  // Update uncertainty or extra layer slice if user scrubs lead day
  useEffect(() => {
    if (!scenario || !date) return;
    if (
      activeLayer !== "uncertainty" &&
      activeLayer !== "residual" &&
      activeLayer !== "enc_grad"
    )
      return;
    const lead = Math.max(0, Math.min(6, timelineStep - 1));
    getJSON(`/api/grid?date=${date}&lead=${lead}&layer=${activeLayer}`)
      .then((res) => {
        if (res?.grid) {
          if (activeLayer === "uncertainty") {
            setUncertaintyGrid(unpack(res.grid));
          } else {
            setExtraGrid(unpack(res.grid));
          }
        }
      })
      .catch(() => {});
  }, [scenario, date, timelineStep, activeLayer, mlStatus?.model?.totalEpochs]);

  // 4. Plan route whenever date, leg, customDestination, forecastSource, wRisk, wTime, or model epochs change
  useEffect(() => {
    if (!scenario || !date) return;
    let cancelled = false;
    const [startKey, goalKey] = leg.split("->");
    setLoadingRoute(true);
    getJSON("/api/route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date,
        w_risk: wRisk,
        w_time: wTime,
        forecast_source: forecastSource,
        start: startKey,
        goal: customDestination ? "custom" : goalKey,
        from_row: shipPos ? shipPos.row : null,
        from_col: shipPos ? shipPos.col : null,
        to_row: customDestination ? customDestination.row : null,
        to_col: customDestination ? customDestination.col : null,
        custom_dest_name: customDestination
          ? customDestination.custom_name ||
            customDestination.nearest_feature ||
            "Selected Destination"
          : null,
      }),
    })
      .then((res) => {
        if (!cancelled) {
          setRouteData(res);
          setLoadingRoute(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setErrorMsg(err.message);
          setLoadingRoute(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    scenario,
    date,
    leg,
    customDestination,
    forecastSource,
    wRisk,
    wTime,
    mlStatus?.model?.totalEpochs,
  ]);

  // 5. Play animation timer for timeline
  useEffect(() => {
    if (!isPlaying) return;
    const id = setInterval(() => {
      setTimelineStep((prev) => {
        if (prev >= 7) return -6;
        return prev + 1;
      });
    }, 650);
    return () => clearInterval(id);
  }, [isPlaying]);

  // 6. Paint raster canvas & update OpenLayers ImageStatic layer
  useEffect(() => {
    if (!scenario || !forecast || !rasterLayerRef.current) return;

    const lead = Math.max(0, Math.min(6, timelineStep - 1));
    const histIdx = Math.max(0, Math.min(6, timelineStep + 6));
    const [H, W] = scenario.shape;

    function getSliceForLayer(layerName) {
      if (
        timelineStep <= 0 &&
        layerName !== "uncertainty" &&
        layerName !== "residual" &&
        layerName !== "enc_grad"
      ) {
        return { slice: sliceLead(forecast.history, histIdx), mode: "sic" };
      }
      if (layerName === "obs") {
        return { slice: sliceLead(forecast.obs, lead), mode: "sic" };
      }
      if (layerName === "ml") {
        return { slice: sliceLead(forecast.ml, lead), mode: "sic" };
      }
      if (layerName === "b1") {
        return { slice: sliceLead(forecast.b1, lead), mode: "sic" };
      }
      if (layerName === "b0") {
        return { slice: sliceLead(forecast.b0, lead), mode: "sic" };
      }
      if (layerName === "error") {
        const m = sliceLead(forecast.ml, lead);
        const o = sliceLead(forecast.obs, lead);
        const diff = new Float32Array(m.data.length);
        for (let i = 0; i < diff.length; i++) {
          diff[i] = Math.abs(m.data[i] - o.data[i]);
        }
        return { slice: { data: diff, shape: [H, W] }, mode: "error" };
      }
      if (layerName === "residual" && forecast.residual) {
        const r = sliceLead(forecast.residual, lead);
        const absR = new Float32Array(r.data.length);
        for (let i = 0; i < absR.length; i++) absR[i] = Math.abs(r.data[i]) * 1.5;
        return { slice: { data: absR, shape: [H, W] }, mode: "error" };
      }
      if (layerName === "enc_grad" && extraGrid) {
        return { slice: extraGrid, mode: "error" };
      }
      if (layerName === "uncertainty" && uncertaintyGrid) {
        return { slice: uncertaintyGrid, mode: "error" };
      }
      return { slice: sliceLead(forecast.ml, lead), mode: "sic" };
    }

    const { slice, mode } = getSliceForLayer(activeLayer);
    activeSliceRef.current = { slice, mode, land: forecast.land };
    setActiveSliceState({ slice, mode, land: forecast.land });

    const canvas = document.createElement("canvas");
    if (!swipeEnabled) {
      paintGrid(canvas, slice, mode, forecast.land);
    } else {
      const obsCanvas = document.createElement("canvas");
      const mlCanvas = document.createElement("canvas");
      const obsSlice =
        timelineStep <= 0
          ? sliceLead(forecast.history, histIdx)
          : sliceLead(forecast.obs, lead);
      const mlSlice =
        timelineStep <= 0
          ? sliceLead(forecast.history, histIdx)
          : sliceLead(forecast.ml, lead);
      paintGrid(obsCanvas, obsSlice, "sic", forecast.land);
      paintGrid(mlCanvas, mlSlice, "sic", forecast.land);

      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext("2d");
      const splitX = Math.round((swipeSplit / 100) * W);
      ctx.drawImage(obsCanvas, 0, 0);
      if (splitX < W) {
        ctx.drawImage(
          mlCanvas,
          splitX,
          0,
          W - splitX,
          H,
          splitX,
          0,
          W - splitX,
          H
        );
      }
      ctx.fillStyle = "#06b6d4";
      ctx.fillRect(Math.max(0, splitX - 1), 0, 1.5, H);
    }

    const url = canvas.toDataURL();
    const polarProj = mapRef.current?.getView().getProjection();
    rasterLayerRef.current.setSource(
      new ImageStatic({
        url,
        imageExtent: scenario.extent,
        projection: polarProj,
        interpolate: false,
      })
    );
  }, [
    scenario,
    forecast,
    uncertaintyGrid,
    extraGrid,
    activeLayer,
    timelineStep,
    swipeEnabled,
    swipeSplit,
  ]);

  // 6b. Update Predicted Sea-Ice Contours (15% Edge, 40% Heavy Pack) & Sea-Ice Drift Vectors Layer
  useEffect(() => {
    const src = iceDynamicsSourceRef.current;
    src.clear();
    if (!forecast?.ice_contours?.length) return;

    const leadIdx = Math.max(0, Math.min(6, timelineStep <= 0 ? 4 : timelineStep - 1));
    const contourObj = forecast.ice_contours[leadIdx] || forecast.ice_contours[4];
    if (!contourObj) return;

    if (showIceContours) {
      // 1. Observed D0 15% Ice-Edge Reference Contour
      if (contourObj.edge15_d0?.length > 2) {
        const d0EdgeFeat = new Feature({
          geometry: new LineString(contourObj.edge15_d0),
        });
        d0EdgeFeat.setStyle(
          new Style({
            stroke: new Stroke({
              color: "rgba(226, 232, 240, 0.55)",
              width: 1.4,
              lineDash: [3, 4],
            }),
          })
        );
        src.addFeature(d0EdgeFeat);
      }

      // 2. U-Net Predicted 15% Navigable Ice-Edge Contour at Lead +kd
      if (contourObj.edge15_pred?.length > 2) {
        const predEdgeFeat = new Feature({
          geometry: new LineString(contourObj.edge15_pred),
        });
        predEdgeFeat.setStyle(
          new Style({
            stroke: new Stroke({
              color: "rgba(56, 189, 248, 0.92)",
              width: 2.0,
              lineDash: [8, 4],
            }),
          })
        );
        src.addFeature(predEdgeFeat);

        const midIdx = Math.floor(contourObj.edge15_pred.length * 0.35);
        if (contourObj.edge15_pred[midIdx]) {
          const lblFeat = new Feature({
            geometry: new Point(contourObj.edge15_pred[midIdx]),
          });
          lblFeat.setStyle(
            new Style({
              text: new TextStyle({
                text: `PREDICTED 15% ICE EDGE (+${contourObj.lead_days}D)`,
                font: "600 9.5px 'JetBrains Mono', monospace",
                fill: new Fill({ color: "#7dd3fc" }),
                stroke: new Stroke({ color: "#07090e", width: 3 }),
                offsetY: -9,
              }),
            })
          );
          src.addFeature(lblFeat);
        }
      }

      // 3. U-Net Predicted 40% Heavy Pack-Ice Hazard Boundary at Lead +kd
      if (contourObj.heavy40_pred?.length > 2) {
        const heavyFeat = new Feature({
          geometry: new LineString(contourObj.heavy40_pred),
        });
        heavyFeat.setStyle(
          new Style({
            stroke: new Stroke({
              color: "rgba(244, 63, 94, 0.88)",
              width: 2.2,
              lineDash: [6, 3],
            }),
          })
        );
        src.addFeature(heavyFeat);

        const hIdx = Math.floor(contourObj.heavy40_pred.length * 0.62);
        if (contourObj.heavy40_pred[hIdx]) {
          const hLbl = new Feature({
            geometry: new Point(contourObj.heavy40_pred[hIdx]),
          });
          hLbl.setStyle(
            new Style({
              text: new TextStyle({
                text: `PREDICTED ≥40% HEAVY PACK BOUNDARY (+${contourObj.lead_days}D)`,
                font: "600 9.5px 'JetBrains Mono', monospace",
                fill: new Fill({ color: "#fda4af" }),
                stroke: new Stroke({ color: "#07090e", width: 3 }),
                offsetY: 11,
              }),
            })
          );
          src.addFeature(hLbl);
        }
      }
    }

    // 4. Predicted Sea-Ice Drift Velocity Vectors (Arrows across Marginal & Pack Ice Zone)
    if (showIceVectors && contourObj.vectors?.length) {
      for (const vec of contourObj.vectors) {
        const dx = vec.x1 - vec.x0;
        const dy = vec.y1 - vec.y0;
        const len = Math.hypot(dx, dy);
        if (len < 5000) continue;

        const ux = dx / len;
        const uy = dy / len;
        const headLen = Math.min(22000, len * 0.32);
        const wingX1 = vec.x1 - ux * headLen - uy * (headLen * 0.48);
        const wingY1 = vec.y1 - uy * headLen + ux * (headLen * 0.48);
        const wingX2 = vec.x1 - ux * headLen + uy * (headLen * 0.48);
        const wingY2 = vec.y1 - uy * headLen - ux * (headLen * 0.48);

        const shaftFeat = new Feature({
          geometry: new LineString([
            [vec.x0, vec.y0],
            [vec.x1, vec.y1],
          ]),
        });
        const headFeat = new Feature({
          geometry: new LineString([
            [wingX1, wingY1],
            [vec.x1, vec.y1],
            [wingX2, wingY2],
          ]),
        });

        const isExpanding = vec.deltaSic > 0.03;
        const vecColor = isExpanding
          ? "rgba(251, 191, 36, 0.72)"
          : "rgba(125, 211, 252, 0.68)";

        const vStyle = new Style({
          stroke: new Stroke({
            color: vecColor,
            width: 1.35,
          }),
        });
        shaftFeat.setStyle(vStyle);
        headFeat.setStyle(vStyle);
        src.addFeature(shaftFeat);
        src.addFeature(headFeat);
      }
    }
  }, [forecast, timelineStep, showIceContours, showIceVectors]);

  // 7. Update Real-World Antarctic Research Stations & Waypoint Gates Layer
  useEffect(() => {
    const src = stationSourceRef.current;
    src.clear();
    if (!scenario || !showStations) return;

    const stationConfigs = [
      {
        key: "ice_entry",
        title: "56°S PACK-ICE ENTRY GATE",
        sub: "56.00°S, 52.50°E · Indian Sector Gate",
        primary: true,
        color: "#06b6d4",
      },
      {
        key: "bharati",
        title: "BHARATI STATION (INDIA · NCPOR)",
        sub: "69.41°S, 76.19°E · Larsemann Hills, Prydz Bay",
        primary: true,
        color: "#f43f5e",
      },
      {
        key: "maitri",
        title: "MAITRI STATION (INDIA · NCPOR)",
        sub: "70.77°S, 11.73°E · Schirmacher Oasis",
        primary: true,
        color: "#f43f5e",
      },
      {
        key: "davis",
        title: "DAVIS (AUS · AAD)",
        sub: "68.58°S, 77.97°E · Vestfold Hills",
        primary: false,
        color: "#10b981",
      },
      {
        key: "mawson",
        title: "MAWSON (AUS · AAD)",
        sub: "67.60°S, 62.87°E · Holme Bay",
        primary: false,
        color: "#10b981",
      },
      {
        key: "syowa",
        title: "SYOWA (JPN · NIPR)",
        sub: "69.00°S, 39.58°E · Lützow-Holm Bay",
        primary: false,
        color: "#10b981",
      },
    ];

    for (const cfg of stationConfigs) {
      const st = scenario.stations?.[cfg.key];
      if (!st || !st.in_grid) continue;
      const feat = new Feature({
        geometry: new Point([st.x_m, st.y_m]),
        name: cfg.title,
        inspect: {
          kind: "Antarctic Research Station / Gate",
          title: st.name || cfg.title,
          subtitle: `${st.country} · ${Math.abs(st.lat).toFixed(2)}°S, ${Math.abs(
            st.lon
          ).toFixed(2)}°E`,
          metrics: [
            { label: "Operational Role", value: st.role },
            { label: "Grid Cell (Row, Col)", value: `(${st.row}, ${st.col})` },
            { label: "Projection", value: "EPSG:3412 South Polar" },
          ],
        },
      });
      feat.setStyle(
        new Style({
          image: new CircleStyle({
            radius: cfg.primary ? 6 : 4.5,
            fill: new Fill({ color: cfg.color }),
            stroke: new Stroke({ color: "#f8fafc", width: cfg.primary ? 2 : 1.5 }),
          }),
          text: new TextStyle({
            text: cfg.primary ? `${cfg.title}\n${cfg.sub}` : cfg.title,
            offsetY: cfg.primary ? -18 : -12,
            font: cfg.primary
              ? "600 10px 'JetBrains Mono', monospace"
              : "500 9.5px 'JetBrains Mono', monospace",
            fill: new Fill({
              color: cfg.primary ? "#f8fafc" : "#cbd5e1",
            }),
            stroke: new Stroke({ color: "#07090e", width: 3.2 }),
          }),
        })
      );
      src.addFeature(feat);
    }

    // Also render Overland Traverses / Station Roads in 2D when showRoads is active
    if (showRoads && scenario.traverses?.length) {
      for (const tr of scenario.traverses) {
        if (!tr.coords_xy || tr.coords_xy.length < 2) continue;
        const trFeat = new Feature({
          geometry: new LineString(tr.coords_xy),
          inspect: {
            kind: "Antarctic Overland Ice-Sheet Traverse / Road",
            title: tr.name,
            subtitle: `${tr.surface} · Distance ${tr.distance_km} km`,
            metrics: [
              { label: "Route Type", value: tr.surface },
              { label: "Length", value: `${tr.distance_km} km` },
              { label: "Notes", value: tr.description },
            ],
          },
        });
        trFeat.setStyle(
          new Style({
            stroke: new Stroke({
              color: "rgba(251, 191, 36, 0.85)",
              width: 2.2,
              lineDash: [5, 4],
            }),
          })
        );
        src.addFeature(trFeat);
      }
    }

    // Render User-Selected Destination Pin on 2D Chart as well
    if (selectedDestination) {
      const destInspect = {
        kind: "Selected Custom Destination",
        title:
          selectedDestination.custom_name ||
          selectedDestination.nearest_feature ||
          "Selected Map Destination",
        subtitle: `${Math.abs(selectedDestination.lat).toFixed(
          3
        )}°S, ${Math.abs(selectedDestination.lon).toFixed(3)}°${
          selectedDestination.lon >= 0 ? "E" : "W"
        }`,
        metrics: [
          {
            label: "Surface Classification",
            value: selectedDestination.surface_type || "Polar Surface",
          },
          {
            label: "Elevation / Ocean Depth",
            value: `${selectedDestination.elevation_m >= 0 ? "+" : ""}${
              selectedDestination.elevation_m ?? 0
            } m`,
          },
          {
            label: "Local Sea-Ice Concentration",
            value: selectedDestination.is_land
              ? "Land / Ice Shelf"
              : `${selectedDestination.sic_pct ?? 0}% SIC`,
          },
          {
            label: "Distance from Ship / Start",
            value: `${selectedDestination.direct_distance_km ?? "—"} km (${
              selectedDestination.direct_distance_nm ?? "—"
            } NM)`,
          },
        ],
      };

      const dPin = new Feature({
        geometry: new Point([selectedDestination.x_m, selectedDestination.y_m]),
        inspect: destInspect,
      });
      dPin.setStyle(
        new Style({
          image: new CircleStyle({
            radius: 7.5,
            fill: new Fill({ color: "#ec4899" }),
            stroke: new Stroke({ color: "#fdf2f8", width: 2.5 }),
          }),
          text: new TextStyle({
            text: `DESTINATION PIN: ${
              selectedDestination.custom_name ||
              selectedDestination.nearest_feature ||
              "SELECTED POINT"
            }\n${Math.abs(selectedDestination.lat).toFixed(2)}°S, ${Math.abs(
              selectedDestination.lon
            ).toFixed(2)}°E (${selectedDestination.direct_distance_km ?? "—"} km)`,
            offsetY: -22,
            font: "600 10px 'JetBrains Mono', monospace",
            fill: new Fill({ color: "#fbcfe8" }),
            stroke: new Stroke({ color: "#07090e", width: 3.4 }),
          }),
        })
      );
      src.addFeature(dPin);

      // If destination is inland, draw dashed overland link from coastal ship anchorage to destination pin on 2D chart
      if (
        selectedDestination.is_land &&
        selectedDestination.nav_x_m != null &&
        selectedDestination.nav_y_m != null
      ) {
        const linkFeat = new Feature({
          geometry: new LineString([
            [selectedDestination.nav_x_m, selectedDestination.nav_y_m],
            [selectedDestination.x_m, selectedDestination.y_m],
          ]),
        });
        linkFeat.setStyle(
          new Style({
            stroke: new Stroke({
              color: "#f43f5e",
              width: 2.2,
              lineDash: [5, 4],
            }),
          })
        );
        src.addFeature(linkFeat);
      }
    }
  }, [scenario, showStations, showRoads, selectedDestination]);

  // Compute active ship step index and live ship telemetry
  const activeShipIdx = useMemo(() => {
    const fcXy = routeData?.forecast_aware?.xy;
    if (!fcXy || fcXy.length < 2) return 0;
    if (shipStepIdx !== null) {
      return Math.max(0, Math.min(fcXy.length - 1, shipStepIdx));
    }
    const leadDay = Math.max(0, timelineStep);
    return Math.min(
      fcXy.length - 1,
      Math.max(0, Math.floor((leadDay / 7) * (fcXy.length - 1)))
    );
  }, [routeData, shipStepIdx, timelineStep]);

  const activeShipTelemetry = useMemo(() => {
    const fcXy = routeData?.forecast_aware?.xy;
    const fcStepTel =
      routeData?.forecast_aware?.metrics?.telemetry ||
      routeData?.forecast_aware?.metrics?.step_telemetry ||
      [];
    if (!fcXy || fcXy.length < 2) return null;
    const idx = Math.max(0, Math.min(fcXy.length - 1, activeShipIdx));
    const coord = fcXy[idx];
    const nextCoord = fcXy[Math.min(fcXy.length - 1, idx + 1)] || coord;
    const rawTel = fcStepTel[idx] || {};
    const [lon, lat] =
      rawTel.lon != null && rawTel.lat != null
        ? [rawTel.lon, rawTel.lat]
        : proj4("EPSG:3412", "EPSG:4326", coord);
    return {
      idx,
      totalSteps: fcXy.length,
      progressPct: Math.round((idx / Math.max(1, fcXy.length - 1)) * 100),
      x_m: coord[0],
      y_m: coord[1],
      next_x_m: nextCoord[0],
      next_y_m: nextCoord[1],
      row: rawTel.row ?? shipPos?.row ?? 0,
      col: rawTel.col ?? shipPos?.col ?? 0,
      lon,
      lat,
      hour: rawTel.hour ?? Math.round(idx * 2.1),
      sic: rawTel.sic ?? 0.08,
      speed_kmh: rawTel.speed_kmh ?? 22.5,
      cog_deg: rawTel.cog_deg ?? 165,
    };
  }, [routeData, activeShipIdx, shipPos]);

  // "Choose Where I Want to Go" — Pick Destination on 3D or 2D Map or from Search
  async function handlePickDestinationPoint({
    lon,
    lat,
    x_m,
    y_m,
    custom_name = null,
    autoRoute = true,
  }) {
    try {
      setLoadingDestInfo(true);
      const startKey = leg.split("->")[0] || "ice_entry";
      const info = await getJSON("/api/location-info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lon,
          lat,
          x_m,
          y_m,
          date,
          lead: Math.max(0, Math.min(6, timelineStep - 1)),
          start_key: startKey,
          from_row: activeShipTelemetry?.row ?? shipPos?.row ?? null,
          from_col: activeShipTelemetry?.col ?? shipPos?.col ?? null,
        }),
      });
      const enriched = {
        ...info,
        custom_name: custom_name || info.nearest_feature,
        updatedAt: Date.now(),
      };
      setSelectedDestination(enriched);
      setIsSelectingDestination(false);
      if (autoRoute) {
        setShowRoutes(true);
        setCustomDestination(enriched);
        setShipStepIdx(null);
      }
    } catch (err) {
      setErrorMsg(err.message || "Failed to inspect selected destination");
    } finally {
      setLoadingDestInfo(false);
    }
  }

  function handleActivateRouteToDestination(destObj = selectedDestination) {
    if (!destObj) return;
    const nextDest = {
      ...destObj,
      updatedAt: Date.now(),
    };
    setSelectedDestination(nextDest);
    setCustomDestination(nextDest);
    setShowRoutes(true);
    setIsSelectingDestination(false);
    setShipStepIdx(null);
    handleFocusMapCoord(destObj.x_m, destObj.y_m, false);
  }

  useEffect(() => {
    isSelectingDestRef.current = isSelectingDestination;
    handlePickDestinationRef.current = handlePickDestinationPoint;
  });

  function handleClearDestination() {
    setSelectedDestination(null);
    setCustomDestination(null);
    setIsSelectingDestination(false);
    setShipStepIdx(null);
  }

  // Search Location by name, station, mountain, ice shelf, or "lat, lon" coordinates
  function handleSearchInput(val) {
    setSearchQuery(val);
    const q = val.trim();
    if (!q) {
      setSearchResults(scenario?.searchable_locations?.slice(0, 8) || []);
      return;
    }

    // Check if user entered coordinates e.g. "-68.5, 75.2" or "68.5S 75.2E"
    const coordMatch = q.match(
      /^(-?\d+(?:\.\d+)?)\s*°?\s*([NSns])?\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*°?\s*([EWew])?$/
    );
    const list = [];
    if (coordMatch) {
      let latNum = parseFloat(coordMatch[1]);
      const ns = (coordMatch[2] || "S").toUpperCase();
      if (ns === "S" && latNum > 0) latNum = -latNum;
      let lonNum = parseFloat(coordMatch[3]);
      const ew = (coordMatch[4] || "E").toUpperCase();
      if (ew === "W" && lonNum > 0) lonNum = -lonNum;
      const [xm, ym] = proj4("EPSG:4326", "EPSG:3412", [lonNum, latNum]);
      list.push({
        id: `coord-${latNum}-${lonNum}`,
        name: `Coordinates ${Math.abs(latNum).toFixed(2)}°S, ${Math.abs(
          lonNum
        ).toFixed(2)}°${lonNum >= 0 ? "E" : "W"}`,
        category: "Custom Lat/Lon Coordinate",
        lat: latNum,
        lon: lonNum,
        x_m: xm,
        y_m: ym,
        description: "Direct geographic coordinate inside polar stereographic sector",
      });
    }

    const catalog = scenario?.searchable_locations || [];
    const ql = q.toLowerCase();
    for (const item of catalog) {
      if (
        item.name.toLowerCase().includes(ql) ||
        item.category.toLowerCase().includes(ql) ||
        (item.description && item.description.toLowerCase().includes(ql))
      ) {
        list.push(item);
      }
    }
    setSearchResults(list.slice(0, 10));
  }

  function handleFocusMapCoord(xm, ym, closeUp = false) {
    setAutoFollowShip(false);
    if (viewMode === "3d" && map3DRef.current) {
      map3DRef.current.focusMapCoord(xm, ym, closeUp);
    }
    if (mapRef.current) {
      mapRef.current.getView().animate({
        center: [xm, ym],
        zoom: closeUp ? 4.4 : 3.4,
        duration: 420,
      });
    }
  }

  // Camera sector & ship focus helpers (works across both 3D Map and 2D Chart)
  function handleFocusMapSector(sector) {
    if (!scenario) return;
    setAutoFollowShip(false);
    if (sector === "full") {
      if (viewMode === "3d" && map3DRef.current) {
        map3DRef.current.resetView();
      }
      if (mapRef.current) {
        mapRef.current
          .getView()
          .fit(scenario.extent, { padding: [20, 20, 20, 20], duration: 420 });
      }
    } else if (sector === "prydz") {
      const bharati = scenario.stations?.bharati;
      const center = bharati
        ? [bharati.x_m, bharati.y_m + 200000]
        : [2200000, 900000];
      handleFocusMapCoord(center[0], center[1], false);
    } else if (sector === "maitri") {
      const maitri = scenario.stations?.maitri;
      const center = maitri
        ? [maitri.x_m + 200000, maitri.y_m + 200000]
        : [800000, 2100000];
      handleFocusMapCoord(center[0], center[1], false);
    } else if (sector === "ship" && activeShipTelemetry) {
      handleFocusMapCoord(
        activeShipTelemetry.x_m,
        activeShipTelemetry.y_m,
        true
      );
    }
  }

  function handleZoomToShip(closeUp = true) {
    if (!activeShipTelemetry) return;
    if (viewMode === "3d" && map3DRef.current) {
      map3DRef.current.focusMapCoord(
        activeShipTelemetry.x_m,
        activeShipTelemetry.y_m,
        closeUp
      );
    }
    if (mapRef.current) {
      const view = mapRef.current.getView();
      view.animate({
        center: [activeShipTelemetry.x_m, activeShipTelemetry.y_m],
        zoom: closeUp ? 4.7 : 3.6,
        duration: 450,
      });
    }
  }

  // Keep camera centered on ship when Auto-Follow Ship is enabled (3D + 2D)
  useEffect(() => {
    if (!autoFollowShip || !activeShipTelemetry) return;
    if (viewMode === "3d" && map3DRef.current) {
      map3DRef.current.focusMapCoord(
        activeShipTelemetry.x_m,
        activeShipTelemetry.y_m,
        false
      );
    }
    if (mapRef.current) {
      mapRef.current.getView().animate({
        center: [activeShipTelemetry.x_m, activeShipTelemetry.y_m],
        duration: 240,
      });
    }
  }, [autoFollowShip, activeShipTelemetry, viewMode]);

  // 8. Update Calculated Ship Avoidance Path, Dynamic Course Corrections, High-Risk Ice Exclusion Zones & Ship Marker
  useEffect(() => {
    const src = routeSourceRef.current;
    src.clear();
    if (!routeData || !showRoutes) return;

    const stXy = routeData.static?.xy;
    const stMetrics = routeData.static?.metrics;
    const fcXy = routeData.forecast_aware?.xy;
    const fcMetrics = routeData.forecast_aware?.metrics;
    const fcTelemetry = fcMetrics?.telemetry || [];
    const courseCorrections = routeData.course_corrections || [];
    const hazardZones = routeData.projected_hazard_zones || [];
    const deviationPoly = routeData.deviation_polygon;

    // 0. Avoidance Deviation Envelope (shaded region between naive path and optimal path)
    if (showCourseCorrections && deviationPoly && deviationPoly.length > 4) {
      const envFeat = new Feature({
        geometry: new Polygon([deviationPoly]),
      });
      envFeat.setStyle(
        new Style({
          fill: new Fill({ color: "rgba(6, 182, 212, 0.10)" }),
          stroke: new Stroke({
            color: "rgba(34, 211, 238, 0.28)",
            width: 1.0,
            lineDash: [4, 4],
          }),
        })
      );
      src.addFeature(envFeat);
    }

    // 0b. Projected High-Risk Ice Exclusion Zones (polygons circumvented by optimal route)
    if (showCourseCorrections && hazardZones.length > 0) {
      for (const hz of hazardZones) {
        if (!hz.polygon_xy || hz.polygon_xy.length < 4) continue;
        const hzInspect = {
          kind: "Projected High-Risk Pack-Ice Zone",
          title: `${hz.id} · Circumvented Ice Hazard`,
          subtitle: `${Math.abs(hz.lat).toFixed(2)}°S, ${Math.abs(
            hz.lon
          ).toFixed(2)}°E · Radius ${hz.radius_km} km`,
          metrics: [
            {
              label: "Projected Peak SIC",
              value: `${Math.round(hz.peak_sic * 100)}% SIC (Severe Hull Resistance)`,
            },
            {
              label: "Mean Zone Concentration",
              value: `${Math.round(hz.mean_sic * 100)}% SIC (${hz.cells} cells)`,
            },
            {
              label: "Navigation Action",
              value: "Dynamic A* Course Alteration Applied",
            },
          ],
        };
        const hzPolyFeat = new Feature({
          geometry: new Polygon([hz.polygon_xy]),
          inspect: hzInspect,
        });
        hzPolyFeat.setStyle(
          new Style({
            fill: new Fill({ color: "rgba(244, 63, 94, 0.22)" }),
            stroke: new Stroke({
              color: "rgba(251, 113, 133, 0.90)",
              width: 1.8,
              lineDash: [6, 3],
            }),
          })
        );
        src.addFeature(hzPolyFeat);

        const hzLblFeat = new Feature({
          geometry: new Point([hz.x_m, hz.y_m]),
          inspect: hzInspect,
        });
        hzLblFeat.setStyle(
          new Style({
            text: new TextStyle({
              text: `HIGH-RISK ICE ${hz.id} (${Math.round(hz.peak_sic * 100)}% SIC)`,
              font: "600 8.5px 'JetBrains Mono', monospace",
              fill: new Fill({ color: "#fda4af" }),
              stroke: new Stroke({ color: "#07090e", width: 3 }),
            }),
          })
        );
        src.addFeature(hzLblFeat);
      }
    }

    // A. Naive Static Climatology Route (Planned without synoptic U-Net forecast)
    if (stXy && stXy.length > 1) {
      const stFeat = new Feature({
        geometry: new LineString(stXy),
        inspect: {
          kind: "Naive Baseline Corridor",
          title: "Static Historical Climatology Route",
          subtitle: `Ignores synoptic pack-ice ridge & tabular iceberg drift`,
          metrics: [
            {
              label: "Heavy-Ice Exposure (≥40% SIC)",
              value: `${stMetrics?.heavy_ice_hours ?? "—"} hours`,
            },
            {
              label: "Total Transit Duration",
              value: `${stMetrics?.hours ?? "—"} hours`,
            },
            {
              label: "Peak Observed SIC Encountered",
              value: stMetrics?.max_sic
                ? `${Math.round(stMetrics.max_sic * 100)}% SIC`
                : "—",
            },
          ],
        },
      });
      stFeat.setStyle(
        new Style({
          stroke: new Stroke({
            color: "rgba(148, 163, 184, 0.82)",
            width: 2.25,
            lineDash: [7, 5],
          }),
        })
      );
      src.addFeature(stFeat);

      // Highlight High-Risk Heavy Pack-Ice Segments (≥40% SIC) along the Naive Climatology Route
      const highRiskPts = stMetrics?.high_risk || [];
      if (highRiskPts.length > 0) {
        const riskCoords = highRiskPts.map((pt) => [pt.x_m, pt.y_m]);
        if (riskCoords.length > 1) {
          const hazardLine = new Feature({
            geometry: new LineString(riskCoords),
          });
          hazardLine.setStyle(
            new Style({
              stroke: new Stroke({
                color: "rgba(244, 63, 94, 0.95)",
                width: 4.2,
              }),
            })
          );
          src.addFeature(hazardLine);
        }

        // Place a clear hazard callout marker in the middle of the pack-ice trap
        const worstPt = highRiskPts.reduce(
          (best, cur) => (cur.sic > best.sic ? cur : best),
          highRiskPts[0]
        );
        const trapFeat = new Feature({
          geometry: new Point([worstPt.x_m, worstPt.y_m]),
          inspect: {
            kind: "Pack-Ice Hazard Zone (Naive Route)",
            title: `Climatology Route Encounters ${Math.round(
              worstPt.sic * 100
            )}% Pack Ice`,
            subtitle: `${Math.abs(worstPt.lat).toFixed(2)}°S, ${Math.abs(
              worstPt.lon
            ).toFixed(2)}°E · T+${worstPt.hour}h`,
            metrics: [
              {
                label: "Local Observed SIC",
                value: `${Math.round(worstPt.sic * 100)}% (Heavy Pack Ridge)`,
              },
              {
                label: "Heavy-Ice Penalty",
                value: `${stMetrics.heavy_ice_hours} h in ≥40% SIC`,
              },
              {
                label: "ARGOS Action",
                value: "Calculated U-Net route detours clear of this ridge",
              },
            ],
          },
        });
        trapFeat.setStyle(
          new Style({
            image: new CircleStyle({
              radius: 5.5,
              fill: new Fill({ color: "#f43f5e" }),
              stroke: new Stroke({ color: "#fff1f2", width: 1.75 }),
            }),
            text: new TextStyle({
              text: `CLIMATOLOGY TRAP · ${Math.round(worstPt.sic * 100)}% PACK ICE`,
              offsetY: -13,
              font: "600 9.5px 'JetBrains Mono', monospace",
              fill: new Fill({ color: "#fda4af" }),
              stroke: new Stroke({ color: "#07090e", width: 3.2 }),
            }),
          })
        );
        src.addFeature(trapFeat);
      }
    }

    // B. Calculated Optimal Ship Navigation Path (split into Completed Wake + Forward Active Corridor)
    if (fcXy && fcXy.length > 1) {
      // Outer safety corridor halo along full optimal route
      const fcCaseFeat = new Feature({
        geometry: new LineString(fcXy),
      });
      fcCaseFeat.setStyle(
        new Style({
          stroke: new Stroke({
            color: "rgba(6, 182, 212, 0.22)",
            width: 9.5,
          }),
        })
      );
      src.addFeature(fcCaseFeat);

      const splitIdx = Math.max(0, Math.min(fcXy.length - 1, activeShipIdx));
      const wakeCoords = fcXy.slice(0, splitIdx + 1);
      const forwardCoords = fcXy.slice(splitIdx);

      // Completed vessel wake behind ship
      if (wakeCoords.length > 1) {
        const wakeFeat = new Feature({
          geometry: new LineString(wakeCoords),
        });
        wakeFeat.setStyle(
          new Style({
            stroke: new Stroke({
              color: "rgba(16, 185, 129, 0.88)",
              width: 2.8,
              lineDash: [4, 3],
            }),
          })
        );
        src.addFeature(wakeFeat);
      }

      // Active forward optimal navigation path ahead of ship
      if (forwardCoords.length > 1) {
        const fcFeat = new Feature({
          geometry: new LineString(forwardCoords),
          inspect: {
            kind: "Calculated Ship Avoidance Path",
            title: "U-Net Forecast-Aware A* Corridor",
            subtitle: `Time-dependent 8-neighbor optimal avoidance path (λ = ${wRisk.toFixed(
              2
            )})`,
            metrics: [
              {
                label: "Heavy-Ice Exposure (≥40% SIC)",
                value: `${fcMetrics?.heavy_ice_hours ?? 0} hours`,
              },
              {
                label: "Total Transit Duration",
                value: `${fcMetrics?.hours ?? "—"} hours`,
              },
              {
                label: "Track Distance",
                value: `${fcMetrics?.distance_km ?? "—"} km`,
              },
            ],
          },
        });
        fcFeat.setStyle(
          new Style({
            stroke: new Stroke({
              color: "#22d3ee",
              width: 3.4,
            }),
          })
        );
        src.addFeature(fcFeat);
      }

      // C. Dynamic Course-Correction Vectors & Maneuver Callouts (circumventing high-risk ice zones)
      if (showCourseCorrections && courseCorrections.length > 0) {
        for (const cc of courseCorrections) {
          const ccInspect = {
            kind: "Dynamic Course Correction Maneuver",
            title: `${cc.id}: ${cc.maneuver}`,
            subtitle: `${Math.abs(cc.lat).toFixed(2)}°S, ${Math.abs(
              cc.lon
            ).toFixed(2)}°E · Voyage T+${cc.hour}h`,
            metrics: [
              {
                label: "Hazard Circumvented",
                value: `${cc.reason} (+${cc.deviation_km} km lateral offset)`,
              },
              {
                label: "Sea-Ice Exposure Reduction",
                value: `${Math.round(cc.st_sic * 100)}% SIC → ${Math.round(
                  cc.fc_sic * 100
                )}% SIC (-${cc.sic_reduction_pct}%)`,
              },
              {
                label: "New Optimal Heading",
                value: `COG ${cc.cog_deg}° True`,
              },
            ],
          };

          if (cc.deviation_km >= 18) {
            const vecFeat = new Feature({
              geometry: new LineString([
                [cc.st_x_m, cc.st_y_m],
                [cc.fc_x_m, cc.fc_y_m],
              ]),
              inspect: ccInspect,
            });
            vecFeat.setStyle(
              new Style({
                stroke: new Stroke({
                  color: "rgba(251, 191, 36, 0.85)",
                  width: 1.9,
                  lineDash: [4, 3],
                }),
              })
            );
            src.addFeature(vecFeat);

            const dx = cc.fc_x_m - cc.st_x_m;
            const dy = cc.fc_y_m - cc.st_y_m;
            const len = Math.hypot(dx, dy) || 1;
            const ux = dx / len;
            const uy = dy / len;
            const ah = 24000;
            const headFeat = new Feature({
              geometry: new LineString([
                [
                  cc.fc_x_m - ux * ah - uy * (ah * 0.5),
                  cc.fc_y_m - uy * ah + ux * (ah * 0.5),
                ],
                [cc.fc_x_m, cc.fc_y_m],
                [
                  cc.fc_x_m - ux * ah + uy * (ah * 0.5),
                  cc.fc_y_m - uy * ah - ux * (ah * 0.5),
                ],
              ]),
              inspect: ccInspect,
            });
            headFeat.setStyle(
              new Style({
                stroke: new Stroke({
                  color: "#fbbf24",
                  width: 2.2,
                }),
              })
            );
            src.addFeature(headFeat);
          }

          const ccNodeFeat = new Feature({
            geometry: new Point([cc.fc_x_m, cc.fc_y_m]),
            inspect: ccInspect,
          });
          ccNodeFeat.setStyle(
            new Style({
              image: new CircleStyle({
                radius: 5.8,
                fill: new Fill({ color: "#07090e" }),
                stroke: new Stroke({ color: "#fbbf24", width: 2.4 }),
              }),
              text: new TextStyle({
                text: `${cc.id} ${cc.maneuver}\n-${cc.sic_reduction_pct}% ICE RISK · COG ${cc.cog_deg}°`,
                offsetY: -18,
                font: "600 8.5px 'JetBrains Mono', monospace",
                fill: new Fill({ color: "#fde68a" }),
                stroke: new Stroke({ color: "#07090e", width: 3.2 }),
              }),
            })
          );
          src.addFeature(ccNodeFeat);
        }
      }

      // D. Plot Annotated Avoidance Waypoints (WP-1, WP-2, WP-3) along the calculated route
      const waypoints = fcMetrics?.waypoints || [];
      for (const wp of waypoints) {
        if (wp.code === "WP-0" || wp.code === "WP-4") continue;
        const wpFeat = new Feature({
          geometry: new Point([wp.x_m, wp.y_m]),
          inspect: {
            kind: "Calculated Avoidance Waypoint",
            title: wp.label,
            subtitle: `${Math.abs(wp.lat).toFixed(2)}°S, ${Math.abs(
              wp.lon
            ).toFixed(2)}°E · ETA T+${wp.hour}h (Day +${wp.day}d)`,
            metrics: [
              { label: "Course Over Ground (COG)", value: `${wp.cog_deg}° True` },
              { label: "Vessel Speed", value: `${wp.speed_kmh} km/h` },
              {
                label: "Local Sea-Ice Concentration",
                value: `${(wp.sic * 100).toFixed(1)}% SIC`,
              },
            ],
          },
        });
        wpFeat.setStyle(
          new Style({
            image: new CircleStyle({
              radius: 4.2,
              fill: new Fill({ color: "#083344" }),
              stroke: new Stroke({ color: "#22d3ee", width: 2 }),
            }),
            text: new TextStyle({
              text: `${wp.label}\nT+${Math.round(wp.hour)}h · ${Math.round(
                wp.sic * 100
              )}% SIC`,
              offsetY: 16,
              font: "600 8.5px 'JetBrains Mono', monospace",
              fill: new Fill({ color: "#a5f3fc" }),
              stroke: new Stroke({ color: "#07090e", width: 3 }),
            }),
          })
        );
        src.addFeature(wpFeat);
      }

      // E. High-Visibility Oriented Vessel Hull Marker + Target Lock Crosshair + Heading Vector (RV POLAR EXPLORER)
      const idx = Math.max(0, Math.min(fcXy.length - 1, activeShipIdx));
      const shipCoord = fcXy[idx] || fcXy[0];
      const nextCoord = fcXy[Math.min(fcXy.length - 1, idx + 1)] || shipCoord;
      const prevCoord = fcXy[Math.max(0, idx - 1)] || shipCoord;
      const tel = fcTelemetry[idx] || {
        lon: 52.5,
        lat: -56.0,
        hour: 0,
        sic: 0,
        speed_kmh: 22.0,
        cog_deg: 145,
      };

      const dxShip = nextCoord[0] - prevCoord[0];
      const dyShip = nextCoord[1] - prevCoord[1];
      const lenShip = Math.hypot(dxShip, dyShip) || 1;
      const ux = dxShip / lenShip;
      const uy = dyShip / lenShip;
      const px = -uy;
      const py = ux;

      // 1. Ship Radar / Safety Surveillance Ring (50 km radius)
      const radarRing = [];
      const radarR = 50000;
      for (let a = 0; a <= 32; a++) {
        const ang = (a / 32) * 2 * Math.PI;
        radarRing.push([
          shipCoord[0] + radarR * Math.cos(ang),
          shipCoord[1] + radarR * Math.sin(ang),
        ]);
      }
      const radarFeat = new Feature({
        geometry: new Polygon([radarRing]),
      });
      radarFeat.setStyle(
        new Style({
          fill: new Fill({ color: "rgba(245, 158, 11, 0.10)" }),
          stroke: new Stroke({
            color: "rgba(251, 191, 36, 0.65)",
            width: 1.4,
            lineDash: [4, 4],
          }),
        })
      );
      src.addFeature(radarFeat);

      // 1b. Target Lock Crosshair Ticks around Ship Location
      const crossInner = 54000;
      const crossOuter = 82000;
      for (const [cxDir, cyDir] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const tickFeat = new Feature({
          geometry: new LineString([
            [shipCoord[0] + cxDir * crossInner, shipCoord[1] + cyDir * crossInner],
            [shipCoord[0] + cxDir * crossOuter, shipCoord[1] + cyDir * crossOuter],
          ]),
        });
        tickFeat.setStyle(
          new Style({
            stroke: new Stroke({
              color: "rgba(253, 224, 71, 0.90)",
              width: 2.0,
            }),
          })
        );
        src.addFeature(tickFeat);
      }

      // 2. Ship Velocity / Heading Leader Line
      const leaderFeat = new Feature({
        geometry: new LineString([
          shipCoord,
          [shipCoord[0] + ux * 105000, shipCoord[1] + uy * 105000],
        ]),
      });
      leaderFeat.setStyle(
        new Style({
          stroke: new Stroke({
            color: "#fde047",
            width: 2.2,
            lineDash: [5, 3],
          }),
        })
      );
      src.addFeature(leaderFeat);

      // 3. Oriented Icebreaker Ship Hull Polygon (Bow pointed along course heading)
      const hullLen = 46000;
      const hullBeam = 18500;
      const bow = [
        shipCoord[0] + ux * hullLen,
        shipCoord[1] + uy * hullLen,
      ];
      const stbdMid = [
        shipCoord[0] + ux * (hullLen * 0.15) + px * hullBeam,
        shipCoord[1] + uy * (hullLen * 0.15) + py * hullBeam,
      ];
      const stbdStern = [
        shipCoord[0] - ux * (hullLen * 0.75) + px * (hullBeam * 0.85),
        shipCoord[1] - uy * (hullLen * 0.75) + py * (hullBeam * 0.85),
      ];
      const portStern = [
        shipCoord[0] - ux * (hullLen * 0.75) - px * (hullBeam * 0.85),
        shipCoord[1] - uy * (hullLen * 0.75) - py * (hullBeam * 0.85),
      ];
      const portMid = [
        shipCoord[0] + ux * (hullLen * 0.15) - px * hullBeam,
        shipCoord[1] + uy * (hullLen * 0.15) - py * hullBeam,
      ];

      const hullFeat = new Feature({
        geometry: new Polygon([[bow, stbdMid, stbdStern, portStern, portMid, bow]]),
        inspect: {
          kind: "PC6 Ice-Strengthened Research Vessel",
          title: scenario?.ship?.name || "RV Polar Explorer",
          subtitle: `${Math.abs(tel.lat).toFixed(2)}°S, ${Math.abs(
            tel.lon
          ).toFixed(2)}°E · Voyage T+${Math.round(tel.hour)}h`,
          metrics: [
            {
              label: "Course & Speed",
              value: `COG ${tel.cog_deg}° · ${tel.speed_kmh} km/h`,
            },
            {
              label: "Local Sea-Ice Concentration",
              value: `${(tel.sic * 100).toFixed(1)}% SIC (Limit 70%)`,
            },
            {
              label: "Active Guidance",
              value: "Following U-Net A* Avoidance Corridor",
            },
          ],
        },
      });
      hullFeat.setStyle(
        new Style({
          fill: new Fill({ color: "#f59e0b" }),
          stroke: new Stroke({ color: "#07090e", width: 2.4 }),
        })
      );
      src.addFeature(hullFeat);

      const shipLabelFeat = new Feature({
        geometry: new Point(shipCoord),
        inspect: hullFeat.get("inspect"),
      });
      shipLabelFeat.setStyle(
        new Style({
          image: new CircleStyle({
            radius: 3.5,
            fill: new Fill({ color: "#fef3c7" }),
          }),
          text: new TextStyle({
            text: `SHIP: RV POLAR EXPLORER [${Math.abs(tel.lat).toFixed(1)}°S, ${Math.abs(
              tel.lon
            ).toFixed(1)}°E]\nCOG ${tel.cog_deg}° · ${tel.speed_kmh} km/h · ${Math.round(
              tel.sic * 100
            )}% SIC`,
            offsetY: -26,
            font: "600 10px 'JetBrains Mono', monospace",
            fill: new Fill({ color: "#fde047" }),
            stroke: new Stroke({ color: "#07090e", width: 3.6 }),
          }),
        })
      );
      src.addFeature(shipLabelFeat);
    }
  }, [
    routeData,
    showRoutes,
    showCourseCorrections,
    activeShipIdx,
    scenario,
    wRisk,
  ]);

  // 8b. Real-Time Animated Optimal Path Flow Indicator & Expanding Ship Location Sonar Beacon
  useEffect(() => {
    const src = pulseSourceRef.current;
    if (!routeData?.forecast_aware?.xy || !showRoutes) {
      src.clear();
      return;
    }

    let phase = 0;
    const timer = setInterval(() => {
      phase = (phase + 0.045) % 1;
      src.clear();

      const fcXy = routeData.forecast_aware.xy;
      if (!fcXy || fcXy.length < 2) return;

      const shipIdx = Math.max(0, Math.min(fcXy.length - 1, activeShipIdx));
      const shipCoord = fcXy[shipIdx];

      // 1. Dual Expanding Sonar Beacon Rings around Ship Location
      for (let ringIdx = 0; ringIdx < 2; ringIdx++) {
        const ringPhase = (phase + ringIdx * 0.5) % 1;
        const radius = 24000 + ringPhase * 92000;
        const alpha = Math.max(0.05, (1 - ringPhase) * 0.75);
        const pts = [];
        for (let a = 0; a <= 32; a++) {
          const ang = (a / 32) * 2 * Math.PI;
          pts.push([
            shipCoord[0] + radius * Math.cos(ang),
            shipCoord[1] + radius * Math.sin(ang),
          ]);
        }
        const ringFeat = new Feature({
          geometry: new Polygon([pts]),
        });
        ringFeat.setStyle(
          new Style({
            stroke: new Stroke({
              color: `rgba(250, 204, 21, ${alpha.toFixed(2)})`,
              width: 2.0 - ringPhase * 0.8,
            }),
          })
        );
        src.addFeature(ringFeat);
      }

      // 2. Real-Time Animated Guidance Chevrons Streaming Along Forward Optimal Navigation Path
      const forwardCoords = fcXy.slice(shipIdx);
      if (forwardCoords.length > 2) {
        const stride = 6;
        const offset = Math.floor(phase * stride);
        for (
          let i = Math.max(1, offset);
          i < forwardCoords.length - 1;
          i += stride
        ) {
          const [x0, y0] = forwardCoords[i - 1];
          const [x1, y1] = forwardCoords[i];
          const dx = x1 - x0;
          const dy = y1 - y0;
          const len = Math.hypot(dx, dy);
          if (len < 1000) continue;
          const ux = dx / len;
          const uy = dy / len;
          const wing = 21000;
          const chevCoords = [
            [x1 - ux * wing - uy * (wing * 0.58), y1 - uy * wing + ux * (wing * 0.58)],
            [x1, y1],
            [x1 - ux * wing + uy * (wing * 0.58), y1 - uy * wing - ux * (wing * 0.58)],
          ];
          const chevFeat = new Feature({
            geometry: new LineString(chevCoords),
          });
          chevFeat.setStyle(
            new Style({
              stroke: new Stroke({
                color: "rgba(165, 243, 252, 0.95)",
                width: 2.5,
              }),
            })
          );
          src.addFeature(chevFeat);
        }
      }
    }, 65);

    return () => clearInterval(timer);
  }, [routeData, showRoutes, activeShipIdx]);

  // 9. Update Real-World Tabular Icebergs, Past Scatterometer Tracks, 7-Day Predicted Paths & Swept Cones
  useEffect(() => {
    const src = icebergSourceRef.current;
    src.clear();
    if (!showIcebergs || !icebergs?.length) return;

    for (const berg of icebergs) {
      const track = berg.track || [];
      const history = berg.history || [];

      // 1. 5-Day Past Scatterometer Observed Track (D-5..D0)
      if (history.length > 1) {
        const histCoords = history.map((pt) => [pt.x_m, pt.y_m]);
        const histFeat = new Feature({
          geometry: new LineString(histCoords),
        });
        histFeat.setStyle(
          new Style({
            stroke: new Stroke({
              color: "rgba(148, 163, 184, 0.65)",
              width: 1.5,
              lineDash: [2, 4],
            }),
          })
        );
        src.addFeature(histFeat);
      }

      // 2. 7-Day Swept Uncertainty Corridor Envelope Polygon + Forecast Track
      const coords = track.map((pt) => {
        if (pt.x_m != null && pt.y_m != null) return [pt.x_m, pt.y_m];
        return proj4("EPSG:4326", "EPSG:3412", [pt.lon, pt.lat]);
      });

      if (coords.length > 1) {
        // Build swept cone corridor envelope from left/right normals along track
        const leftEdge = [];
        const rightEdge = [];
        for (let i = 0; i < track.length; i++) {
          const [cx, cy] = coords[i];
          const [nx, ny] =
            i < track.length - 1 ? coords[i + 1] : coords[i];
          const [px, py] = i > 0 ? coords[i - 1] : coords[i];
          const dx = nx - px;
          const dy = ny - py;
          const len = Math.hypot(dx, dy) || 1;
          const normX = -dy / len;
          const normY = dx / len;
          const rM = (track[i].cone_km || 15) * 1000;
          leftEdge.push([cx + normX * rM, cy + normY * rM]);
          rightEdge.push([cx - normX * rM, cy - normY * rM]);
        }
        const corridorRing = [...leftEdge, ...rightEdge.reverse(), leftEdge[0]];
        const corridorFeat = new Feature({
          geometry: new Polygon([corridorRing]),
        });
        corridorFeat.setStyle(
          new Style({
            fill: new Fill({ color: "rgba(245, 158, 11, 0.09)" }),
            stroke: new Stroke({
              color: "rgba(245, 158, 11, 0.32)",
              width: 1.0,
              lineDash: [3, 3],
            }),
          })
        );
        src.addFeature(corridorFeat);

        const lineFeat = new Feature({
          geometry: new LineString(coords),
        });
        lineFeat.setStyle(
          new Style({
            stroke: new Stroke({
              color: "#f59e0b",
              width: 2.0,
              lineDash: [5, 4],
            }),
          })
        );
        src.addFeature(lineFeat);
      }

      // 3. +3d and +7d Uncertainty Cones & Daily Forecast Tick Markers
      for (const pt of track) {
        if (
          Math.abs(pt.lead_days - 3) < 0.01 ||
          Math.abs(pt.lead_days - 7) < 0.01
        ) {
          const [cx, cy] = [pt.x_m, pt.y_m];
          const rMeters = (pt.cone_km || 20) * 1000;
          const ring = [];
          for (let a = 0; a <= 28; a++) {
            const ang = (a / 28) * 2 * Math.PI;
            ring.push([
              cx + rMeters * Math.cos(ang),
              cy + rMeters * Math.sin(ang),
            ]);
          }
          const coneFeat = new Feature({
            geometry: new Polygon([ring]),
          });
          coneFeat.setStyle(
            new Style({
              fill: new Fill({ color: "rgba(245, 158, 11, 0.12)" }),
              stroke: new Stroke({
                color: "rgba(251, 191, 36, 0.55)",
                width: 1.2,
              }),
            })
          );
          src.addFeature(coneFeat);

          const tickLbl = new Feature({
            geometry: new Point([cx, cy + rMeters]),
          });
          tickLbl.setStyle(
            new Style({
              text: new TextStyle({
                text: `${berg.id} +${Math.round(pt.lead_days)}d (±${Math.round(
                  pt.cone_km
                )}km)`,
                font: "500 8.5px 'JetBrains Mono', monospace",
                fill: new Fill({ color: "rgba(253, 230, 138, 0.88)" }),
                stroke: new Stroke({ color: "#07090e", width: 2.5 }),
                offsetY: -5,
              }),
            })
          );
          src.addFeature(tickLbl);
        }
      }

      // 4. Active Tabular Iceberg Position at current `timelineStep` (moves along history or forecast track!)
      let activePt = { x_m: berg.x_m, y_m: berg.y_m, lon: berg.lon, lat: berg.lat };
      if (timelineStep < 0 && history.length) {
        const targetLead = Math.max(-5, timelineStep);
        const found = history.reduce((best, cur) =>
          Math.abs(cur.lead_days - targetLead) <
          Math.abs(best.lead_days - targetLead)
            ? cur
            : best
        );
        if (found) activePt = found;
      } else if (timelineStep > 0 && track.length) {
        const found = track.reduce((best, cur) =>
          Math.abs(cur.lead_days - timelineStep) <
          Math.abs(best.lead_days - timelineStep)
            ? cur
            : best
        );
        if (found) activePt = found;
      }

      const [bx, by] = [activePt.x_m, activePt.y_m];
      // Render realistic Tabular Iceberg Polygon Footprint (scaled visible block on chart)
      const halfL = ((berg.length_km || 26) * 900);
      const halfW = ((berg.width_km || 15) * 900);
      const rot = 0.45;
      const cR = Math.cos(rot);
      const sR = Math.sin(rot);
      const corners = [
        [-halfL, -halfW * 0.8],
        [halfL * 0.9, -halfW],
        [halfL, halfW * 0.7],
        [-halfL * 0.85, halfW],
        [-halfL, -halfW * 0.8],
      ].map(([dx, dy]) => [
        bx + dx * cR - dy * sR,
        by + dx * sR + dy * cR,
      ]);

      const inspectPayload = {
        kind: "USNIC / BYU Tracked Tabular Iceberg",
        title: berg.name || `Tabular Berg ${berg.id}`,
        subtitle: `${Math.abs(activePt.lat).toFixed(2)}°S, ${Math.abs(
          activePt.lon
        ).toFixed(2)}°E · Dimensions ${berg.size_nm || "15×9 NM"}`,
        metrics: [
          {
            label: "Origin / Calving Sector",
            value: berg.calved_from || "East Antarctic Ice Shelf",
          },
          {
            label: "Predicted Drift Speed",
            value: `${berg.drift_km_day || 11.4} km/day (Coriolis + Coastal Current)`,
          },
          {
            label: "7-Day Uncertainty Radius",
            value: `±${Math.round(12 + 11.5 * 7)} km hazard cone`,
          },
        ],
      };

      const polyFeat = new Feature({
        geometry: new Polygon([corners]),
        inspect: inspectPayload,
      });
      polyFeat.setStyle(
        new Style({
          fill: new Fill({ color: "rgba(224, 242, 254, 0.92)" }),
          stroke: new Stroke({ color: "#f59e0b", width: 2.0 }),
        })
      );
      src.addFeature(polyFeat);

      const bergFeat = new Feature({
        geometry: new Point([bx, by]),
        inspect: inspectPayload,
      });
      bergFeat.setStyle(
        new Style({
          text: new TextStyle({
            text: `BERG ${berg.id} (${berg.size_nm || "TABULAR"})`,
            offsetY: -15,
            font: "600 9.5px 'JetBrains Mono', monospace",
            fill: new Fill({ color: "#fcd34d" }),
            stroke: new Stroke({ color: "#07090e", width: 3.2 }),
          }),
        })
      );
      src.addFeature(bergFeat);
    }
  }, [icebergs, showIcebergs, timelineStep]);

  // Handler: Train / Fine-Tune the Small U-Net Model live
  async function handleTrainModel(epochs = 5, reset = false) {
    try {
      setIsTraining(true);
      const res = await getJSON("/api/ml/train", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          epochs,
          lr: trainLr,
          edge_weight: trainEdgeWeight,
          reset,
        }),
      });
      setMlStatus((prev) => ({
        ...prev,
        model: res.model,
        gate: res.gate,
        validation: res.validation,
      }));
      setValidation((prev) =>
        prev
          ? {
              ...prev,
              gate: res.gate,
              validation: res.validation,
            }
          : prev
      );
      if (res.hindcast_summary) {
        setScenario((prev) =>
          prev
            ? {
                ...prev,
                gate: res.gate,
                hindcast_summary: {
                  ...prev.hindcast_summary,
                  ...res.hindcast_summary,
                },
              }
            : prev
        );
      }
    } catch (err) {
      setErrorMsg(err.message);
    } finally {
      setIsTraining(false);
    }
  }

  // Handler: Advance 1 day along planned route
  async function handleAdvanceDay() {
    if (!routeData?.forecast_aware?.path?.length) return;
    const path = routeData.forecast_aware.path;
    const stepIdx = Math.min(path.length - 1, 8);
    const [nextRow, nextCol] = path[stepIdx];
    try {
      setLoadingRoute(true);
      const res = await getJSON("/api/advance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date,
          ship_row: nextRow,
          ship_col: nextCol,
          w_risk: wRisk,
        }),
      });
      setShipPos({ row: nextRow, col: nextCol });
      setDate(res.date);
      if (res.icebergs) setIcebergs(res.icebergs);
    } catch (err) {
      setErrorMsg(err.message);
    } finally {
      setLoadingRoute(false);
    }
  }

  function handleResetVoyage() {
    setShipPos(null);
    if (scenario?.d0) setDate(scenario.d0);
    setTimelineStep(1);
  }

  const fcMetrics = routeData?.forecast_aware?.metrics;
  const stMetrics = routeData?.static?.metrics;

  const currentTimelineLabel = useMemo(() => {
    if (!forecast) return "";
    if (timelineStep <= 0) {
      const idx = Math.max(0, Math.min(6, timelineStep + 6));
      const d = forecast.history_dates?.[idx] || date;
      return timelineStep === 0
        ? `D0 · ${d} · Observed Input`
        : `D${timelineStep} · ${d} · Observed Input`;
    }
    const idx = Math.max(0, Math.min(6, timelineStep - 1));
    const d = forecast.forecast_dates?.[idx] || "";
    return `Lead +${timelineStep}d · ${d}`;
  }, [forecast, timelineStep, date]);

  const modelSummary = mlStatus?.model || scenario?.ml_summary;
  const datasetsList = mlStatus?.datasets || scenario?.datasets || [];

  // Export active A* route waypoints as CSV manifest
  function handleExportWaypointsCsv() {
    const wps = fcMetrics?.waypoints || [];
    if (!wps.length) return;
    const header = "Code,Label,Latitude_S,Longitude_E,ETA_Hours,COG_Deg,Speed_kmh,Forecast_SIC_Pct\n";
    const rows = wps
      .map(
        (w) =>
          `${w.code},"${w.label}",${Math.abs(w.lat).toFixed(3)},${w.lon.toFixed(
            3
          )},${Math.round(w.hour)},${w.cog_deg},${w.speed_kmh},${Math.round(
            w.sic * 100
          )}`
      )
      .join("\n");
    const blob = new Blob([header + rows], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `argos_route_manifest_${date}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <>
      {showLanding && (
        <LandingPage
          scenario={scenario}
          routeData={routeData}
          validation={validation}
          hindcast={hindcast}
          leg={leg}
          setLeg={setLeg}
          wRisk={wRisk}
          setWRisk={setWRisk}
          wTime={wTime}
          setWTime={setWTime}
          onEnterConsole={(opts) => {
            setShowLanding(false);
            if (opts?.enableSelectDestination) {
              setIsSelectingDestination(true);
            }
          }}
          onLaunchStationDestination={({ lon, lat, name, legPreset }) => {
            setShowLanding(false);
            if (legPreset) setLeg(legPreset);
            const [xm, ym] = proj4("EPSG:4326", "EPSG:3412", [lon, lat]);
            handleFocusMapCoord(xm, ym, true);
            handlePickDestinationPoint({
              lon,
              lat,
              x_m: xm,
              y_m: ym,
              custom_name: name,
              autoRoute: true,
            });
          }}
          onOpenDrawer={(d) => setDrawer(d)}
        />
      )}
      <div className="dss-shell">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="dss-header">
        {/* Zone 1: Single-element Brand Wordmark */}
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            setDrawer(null);
          }}
          className="dss-wordmark"
        >
          {scenario?.title || "ARGOS"}
        </a>

        {/* Zone 2: Clean single-line text navigation links */}
        <nav className="dss-topnav" aria-label="Workspace Views">
          <button
            type="button"
            className={`dss-navlink ${showLanding ? "active" : ""}`}
            onClick={() => setShowLanding(true)}
          >
            Mission Overview
          </button>
          <button
            type="button"
            className={`dss-navlink ${drawer === "ml" ? "active" : ""}`}
            onClick={() => setDrawer(drawer === "ml" ? null : "ml")}
          >
            Model &amp; Datasets
          </button>
          <button
            type="button"
            className={`dss-navlink ${drawer === "validation" ? "active" : ""}`}
            onClick={() =>
              setDrawer(drawer === "validation" ? null : "validation")
            }
          >
            Validation Skill
          </button>
          <button
            type="button"
            className={`dss-navlink ${drawer === "hindcast" ? "active" : ""}`}
            onClick={() => setDrawer(drawer === "hindcast" ? null : "hindcast")}
          >
            Hindcast Evaluation
          </button>
          <button
            type="button"
            className={`dss-navlink ${drawer === "about" ? "active" : ""}`}
            onClick={() => setDrawer(drawer === "about" ? null : "about")}
          >
            Provenance
          </button>
        </nav>

        {/* Zone 3: Primary Actions (Departure Selector + System Guide) */}
        <div className="dss-header-actions">
          <label className="dss-field-inline">
            <span>D0</span>
            <select
              value={date}
              onChange={(e) => {
                setShipPos(null);
                setDate(e.target.value);
              }}
            >
              {(scenario?.available_dates || [date]).map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            className={`dss-guide-trigger ${drawer === "guide" ? "active" : ""}`}
            onClick={() => setDrawer(drawer === "guide" ? null : "guide")}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <span>System Guide</span>
          </button>
        </div>
      </header>

      {errorMsg && (
        <div className="dss-toast-error">
          <span>{errorMsg}</span>
          <button type="button" onClick={() => setErrorMsg(null)}>
            Dismiss
          </button>
        </div>
      )}

      {/* Main 3-Column Split Scientific Console with Collapsible Left & Right Panels */}
      <main
        className={`dss-main ${!leftPanelOpen ? "left-collapsed" : ""} ${
          !rightPanelOpen ? "right-collapsed" : ""
        }`}
      >
        {/* Left Control & Parameter Column */}
        <aside
          className={`dss-sidebar dss-left ${
            !leftPanelOpen ? "is-collapsed" : ""
          }`}
          aria-hidden={!leftPanelOpen}
        >
          <div className="dss-sidebar-top">
            <span>Map Layers</span>
            <button
              type="button"
              className="dss-hide-panel-btn"
              onClick={() => setLeftPanelOpen(false)}
              title="Hide left panel to expand map"
            >
              ‹ Hide Panel
            </button>
          </div>

          <section className="dss-panel">
            <div className="dss-panel-head">
              <h2>Sea-Ice Field</h2>
            </div>

            <div className="dss-layer-list">
              {[
                {
                  id: "ml",
                  label: "Predicted Sea Ice (U-Net)",
                },
                {
                  id: "obs",
                  label: "Observed Sea Ice (NSIDC)",
                },
                {
                  id: "residual",
                  label: "U-Net Residual |ΔSIC|",
                },
                {
                  id: "error",
                  label: "Absolute Error |ML − Obs|",
                },
                {
                  id: "uncertainty",
                  label: "Validation Uncertainty σ",
                },
              ].map((item) => (
                <label
                  key={item.id}
                  className={`dss-radio-row ${
                    activeLayer === item.id && !swipeEnabled ? "selected" : ""
                  }`}
                >
                  <input
                    type="radio"
                    name="layer"
                    checked={activeLayer === item.id}
                    onChange={() => {
                      setSwipeEnabled(false);
                      setActiveLayer(item.id);
                    }}
                  />
                  <span className="dss-radio-label">{item.label}</span>
                </label>
              ))}
            </div>
          </section>

          {/* Chart Layers & Ice Prediction Checkboxes */}
          <section className="dss-panel">
            <div className="dss-panel-head">
              <h2>Active Map Layers</h2>
            </div>

            <label className="dss-check-row">
              <input
                type="checkbox"
                checked={showIceContours}
                onChange={(e) => setShowIceContours(e.target.checked)}
              />
              <span>Predicted 15% &amp; 40% Ice Contours</span>
            </label>

            <label className="dss-check-row">
              <input
                type="checkbox"
                checked={showIceVectors}
                onChange={(e) => setShowIceVectors(e.target.checked)}
              />
              <span>Predicted Sea Ice</span>
            </label>

            <label className="dss-check-row">
              <input
                type="checkbox"
                checked={showRoutes}
                onChange={(e) => setShowRoutes(e.target.checked)}
              />
              <span>Optimal Path &amp; Real-Time Flow</span>
            </label>

            <label className="dss-check-row">
              <input
                type="checkbox"
                checked={showIcebergs}
                onChange={(e) => setShowIcebergs(e.target.checked)}
              />
              <span>Tabular Bergs (D-28, B-22A, A-74)</span>
            </label>

            <label className="dss-check-row">
              <input
                type="checkbox"
                checked={showStations}
                onChange={(e) => setShowStations(e.target.checked)}
              />
              <span>Antarctic Stations</span>
            </label>

            <label className="dss-check-row">
              <input
                type="checkbox"
                checked={swipeEnabled}
                onChange={(e) => setSwipeEnabled(e.target.checked)}
              />
              <span>Split Curtain: Observed vs. U-Net</span>
            </label>

            {swipeEnabled && (
              <div className="dss-slider-block">
                <input
                  type="range"
                  min={5}
                  max={95}
                  value={swipeSplit}
                  onChange={(e) => setSwipeSplit(Number(e.target.value))}
                />
              </div>
            )}

            <label className="dss-check-row">
              <input
                type="checkbox"
                checked={showCourseCorrections}
                onChange={(e) => setShowCourseCorrections(e.target.checked)}
              />
              <span>Dynamic Course Corrections</span>
            </label>

            <label className="dss-check-row">
              <input
                type="checkbox"
                checked={showGraticule}
                onChange={(e) => setShowGraticule(e.target.checked)}
              />
              <span>Polar Graticule &amp; Landmarks</span>
            </label>

            <label className="dss-check-row">
              <input
                type="checkbox"
                checked={showRoads}
                onChange={(e) => setShowRoads(e.target.checked)}
              />
              <span>Overland Traverses &amp; Station Roads</span>
            </label>
          </section>

          {/* Compact Sea-Ice Scale */}
          <section className="dss-panel dss-panel-last">
            <div className="dss-panel-head">
              <h2>Sea-Ice Concentration</h2>
              <button
                type="button"
                className="dss-inline-help"
                onClick={() => setShowMapLegend(!showMapLegend)}
              >
                {showMapLegend ? "Hide Key" : "Map Key"}
              </button>
            </div>
            <div className="dss-colorbar-group">
              <div className="dss-colorbar-sic" />
              <div className="dss-colorbar-ticks">
                <span>0%</span>
                <span>15%</span>
                <span>40%</span>
                <span>70%</span>
              </div>
            </div>
          </section>
        </aside>

        {/* Center Polar Map Viewport (3D Interactive Polar Globe / Terrain + 2D Chart) */}
        <section className="dss-map-wrap">
          {/* Left Side Panel Hide/Show Handle */}
          <button
            type="button"
            className={`dss-side-handle dss-side-handle-left ${
              !leftPanelOpen ? "collapsed" : ""
            }`}
            onClick={() => setLeftPanelOpen(!leftPanelOpen)}
            aria-label={leftPanelOpen ? "Hide left panel" : "Show left panel"}
            title={leftPanelOpen ? "Hide left panel" : "Show left panel"}
          >
            <span className="dss-handle-chevron">
              {leftPanelOpen ? "‹" : "›"}
            </span>
            <span className="dss-handle-text">
              {leftPanelOpen ? "Hide" : "Layers"}
            </span>
          </button>

          {/* Right Side Panel Hide/Show Handle */}
          <button
            type="button"
            className={`dss-side-handle dss-side-handle-right ${
              !rightPanelOpen ? "collapsed" : ""
            }`}
            onClick={() => setRightPanelOpen(!rightPanelOpen)}
            aria-label={rightPanelOpen ? "Hide right panel" : "Show right panel"}
            title={
              rightPanelOpen
                ? "Hide right panel"
                : "Show right panel"
            }
          >
            <span className="dss-handle-text">
              {rightPanelOpen ? "Hide" : "Route"}
            </span>
            <span className="dss-handle-chevron">
              {rightPanelOpen ? "›" : "‹"}
            </span>
          </button>

          {/* Primary Map Control Panel: 3D Globe / 3D Sector / 2D Chart, Satellite/Terrain View, Search & Fullscreen Toggle */}
          <div className="dss-map-control-bar">
            {/* 1. 3D Globe / 3D Terrain / 2D Chart Toggle */}
            <div className="dss-ctrl-group" role="group" aria-label="3D Globe or 2D Map Mode">
              <button
                type="button"
                className={`dss-ctrl-btn ${
                  viewMode === "3d" && globeMode ? "active" : ""
                }`}
                onClick={() => {
                  setViewMode("3d");
                  setGlobeMode(true);
                }}
                title="Interactive 3D Polar Globe with Antarctic curvature & orbital context"
              >
                3D Globe
              </button>
              <button
                type="button"
                className={`dss-ctrl-btn ${
                  viewMode === "3d" && !globeMode ? "active" : ""
                }`}
                onClick={() => {
                  setViewMode("3d");
                  setGlobeMode(false);
                }}
                title="Planar 3D Sector DEM Terrain Block"
              >
                3D Terrain
              </button>
              <button
                type="button"
                className={`dss-ctrl-btn ${viewMode === "2d" ? "active" : ""}`}
                onClick={() => setViewMode("2d")}
                title="2D EPSG:3412 South Polar Stereographic Chart"
              >
                2D Chart
              </button>
            </div>

            {/* 2. Satellite / Terrain DEM / Scientific View Selector */}
            <div className="dss-ctrl-group" role="group" aria-label="Satellite or Terrain Imagery Mode">
              <button
                type="button"
                className={`dss-ctrl-btn ${
                  basemapStyle === "satellite" ? "active" : ""
                }`}
                onClick={() => setBasemapStyle("satellite")}
                title="Sentinel-2 / NASA MODIS & GIBS True-Color Satellite View"
              >
                Satellite
              </button>
              <button
                type="button"
                className={`dss-ctrl-btn ${
                  basemapStyle === "terrain" ? "active" : ""
                }`}
                onClick={() => setBasemapStyle("terrain")}
                title="BedMachine v3 / REMA 3D Hypsometric Elevation & IBCSO Bathymetry"
              >
                Terrain DEM
              </button>
              <button
                type="button"
                className={`dss-ctrl-btn ${
                  basemapStyle === "scientific" ? "active" : ""
                }`}
                onClick={() => setBasemapStyle("scientific")}
                title="High-Contrast Scientific NSIDC Sea-Ice Concentration Raster"
              >
                Scientific SIC
              </button>
            </div>

            {/* 3. Location Search & Navigation Input */}
            <div className="dss-search-wrap">
              <input
                type="text"
                className="dss-search-input"
                placeholder="Search station, mountain, shelf, berg or lat,lon..."
                value={searchQuery}
                onFocus={() => {
                  if (!searchResults.length) {
                    setSearchResults(
                      scenario?.searchable_locations?.slice(0, 8) || []
                    );
                  }
                  setShowSearchDropdown(true);
                }}
                onChange={(e) => {
                  handleSearchInput(e.target.value);
                  setShowSearchDropdown(true);
                }}
              />
              {searchQuery && (
                <button
                  type="button"
                  className="dss-search-clear"
                  onClick={() => {
                    setSearchQuery("");
                    setSearchResults(
                      scenario?.searchable_locations?.slice(0, 8) || []
                    );
                  }}
                  aria-label="Clear search"
                >
                  ×
                </button>
              )}

              {showSearchDropdown && searchResults.length > 0 && (
                <div className="dss-search-dropdown">
                  <div className="dss-search-drop-head">
                    <span>ANTARCTIC GAZETTEER &amp; COORDINATE NAVIGATOR</span>
                    <button
                      type="button"
                      onClick={() => setShowSearchDropdown(false)}
                    >
                      Close
                    </button>
                  </div>
                  {searchResults.map((item) => (
                    <div key={item.id} className="dss-search-item">
                      <div
                        className="dss-search-item-main"
                        onClick={() => {
                          handleFocusMapCoord(item.x_m, item.y_m, true);
                          setShowSearchDropdown(false);
                        }}
                      >
                        <strong>{item.name}</strong>
                        <span>
                          {item.category} · {Math.abs(item.lat).toFixed(2)}°S,{" "}
                          {Math.abs(item.lon).toFixed(2)}°
                          {item.lon >= 0 ? "E" : "W"}
                          {item.elevation_m
                            ? ` · +${item.elevation_m}m`
                            : ""}
                        </span>
                      </div>
                      <div className="dss-search-item-actions">
                        <button
                          type="button"
                          onClick={() => {
                            handleFocusMapCoord(item.x_m, item.y_m, true);
                            setShowSearchDropdown(false);
                          }}
                        >
                          Fly To
                        </button>
                        <button
                          type="button"
                          className="route-btn"
                          onClick={() => {
                            handleFocusMapCoord(item.x_m, item.y_m, false);
                            handlePickDestinationPoint({
                              lon: item.lon,
                              lat: item.lat,
                              x_m: item.x_m,
                              y_m: item.y_m,
                              custom_name: item.name,
                              autoRoute: true,
                            });
                            setShowSearchDropdown(false);
                          }}
                        >
                          Route Here
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 4. Quick Camera & Fullscreen Map Controls */}
            <div className="dss-ctrl-group">
              <button
                type="button"
                className="dss-ctrl-btn"
                onClick={() => handleZoomToShip(true)}
                title="Zoom to RV Polar Explorer"
              >
                Ship
              </button>
              <button
                type="button"
                className={`dss-ctrl-btn ${showMapLegend ? "active" : ""}`}
                onClick={() => setShowMapLegend(!showMapLegend)}
                title="Toggle Map Legend"
              >
                Legend
              </button>
              <button
                type="button"
                className={`dss-ctrl-btn ${
                  !leftPanelOpen && !rightPanelOpen ? "active" : ""
                }`}
                onClick={() => {
                  if (leftPanelOpen || rightPanelOpen) {
                    setLeftPanelOpen(false);
                    setRightPanelOpen(false);
                  } else {
                    setLeftPanelOpen(true);
                    setRightPanelOpen(true);
                  }
                }}
                title="Hide or restore both side panels for fullscreen map view"
              >
                {!leftPanelOpen && !rightPanelOpen
                  ? "Show Panels"
                  : "Fullscreen"}
              </button>
            </div>
          </div>

          {/* Active "Select Destination" Mode Banner */}
          {isSelectingDestination && (
            <div className="dss-dest-mode-banner">
              <span>
                Click anywhere on the map to place your destination pin.
              </span>
              <button
                type="button"
                onClick={() => setIsSelectingDestination(false)}
              >
                Cancel
              </button>
            </div>
          )}

          {/* 3D Interactive Polar Globe & Satellite Map vs. 2D OpenLayers Polar Chart */}
          {viewMode === "3d" && (
            <Map3DView
              ref={map3DRef}
              scenario={scenario}
              forecast={forecast}
              activeSlice={activeSliceState || activeSliceRef.current}
              elevationSlice={elevationGrid}
              surfaceTypeSlice={surfaceTypeGrid}
              timelineStep={timelineStep}
              basemapStyle={basemapStyle}
              globeMode={globeMode}
              onToggleGlobeMode={() => setGlobeMode((g) => !g)}
              verticalExaggeration={verticalExaggeration}
              showIceContours={showIceContours}
              showIceVectors={showIceVectors}
              showRoutes={showRoutes}
              showCourseCorrections={showCourseCorrections}
              showIcebergs={showIcebergs}
              showStations={showStations}
              showGraticule={showGraticule}
              showRoads={showRoads}
              routeData={routeData}
              icebergs={icebergs}
              activeShipTelemetry={activeShipTelemetry}
              selectedDestination={selectedDestination}
              isSelectingDestination={isSelectingDestination}
              onToggleSelectDestination={() =>
                setIsSelectingDestination((s) => !s)
              }
              onSelectDestinationPoint={(pt) =>
                handlePickDestinationPoint({ ...pt, autoRoute: true })
              }
              onClearDestination={handleClearDestination}
              onInspectFeature={(info) => setSelectedTarget(info)}
              probeTextRef={probeTextRef}
            />
          )}

          <div
            ref={mapContainerRef}
            className="dss-map"
            style={{
              display: viewMode === "2d" ? "block" : "none",
            }}
          />

          {/* 2D Chart On-Map Destination Controls when in 2D mode */}
          {viewMode === "2d" && (
            <div className="dss-map2d-dest-bar">
              <button
                type="button"
                className={`dss-onmap-dest-btn ${
                  isSelectingDestination ? "active" : ""
                }`}
                onClick={() => setIsSelectingDestination((s) => !s)}
              >
                {isSelectingDestination
                  ? "Click Map to Place Pin..."
                  : selectedDestination
                  ? "Move Destination Pin"
                  : "Choose Destination"}
              </button>
              {selectedDestination && (
                <button type="button" onClick={handleClearDestination}>
                  Clear Pin
                </button>
              )}
            </div>
          )}

          {/* "Choose Where I Want to Go" — Selected Destination Telemetry & Route Confirmation Card */}
          {selectedDestination && (
            <div className="dss-dest-card">
              <div className="dss-dest-card-head">
                <div>
                  <span className="dss-dest-badge">
                    SELECTED DESTINATION PIN{" "}
                    {loadingDestInfo ? "(UPDATING...)" : ""}
                  </span>
                  <h3>
                    {selectedDestination.custom_name ||
                      selectedDestination.nearest_feature ||
                      "Custom Polar Coordinates"}
                  </h3>
                  <p className="mono">
                    Lat {Math.abs(selectedDestination.lat).toFixed(3)}°S, Lon{" "}
                    {Math.abs(selectedDestination.lon).toFixed(3)}°
                    {selectedDestination.lon >= 0 ? "E" : "W"} · Grid Cell (
                    {selectedDestination.row}, {selectedDestination.col})
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleClearDestination}
                  aria-label="Clear selected destination"
                  title="Remove destination pin"
                >
                  ×
                </button>
              </div>

              <div className="dss-dest-grid">
                <div>
                  <span>SURFACE TYPE</span>
                  <strong>{selectedDestination.surface_type}</strong>
                </div>
                <div>
                  <span>ELEVATION / DEPTH</span>
                  <strong className="mono">
                    {selectedDestination.elevation_m >= 0 ? "+" : ""}
                    {selectedDestination.elevation_m} m
                  </strong>
                </div>
                <div>
                  <span>LOCAL SEA ICE</span>
                  <strong
                    className={`mono ${
                      selectedDestination.sic_pct >= 40
                        ? "warn-text"
                        : "cyan-text"
                    }`}
                  >
                    {selectedDestination.is_land
                      ? "Land / Shelf"
                      : `${selectedDestination.sic_pct}% SIC`}
                  </strong>
                </div>
                <div>
                  <span>DISTANCE &amp; ETA</span>
                  <strong className="mono">
                    {selectedDestination.direct_distance_km} km (
                    {selectedDestination.direct_distance_nm} NM) · ~
                    {selectedDestination.estimated_transit_hours}h
                  </strong>
                </div>
              </div>

              {selectedDestination.is_land && (
                <p className="dss-dest-note">
                  Inland / Ice-Shelf target: A* routes ship to nearest navigable
                  coastal anchorage ({Math.abs(selectedDestination.nav_lat).toFixed(
                    2
                  )}
                  °S, {Math.abs(selectedDestination.nav_lon).toFixed(2)}°E) +
                  overland traverse link.
                </p>
              )}

              <div className="dss-dest-actions">
                <button
                  type="button"
                  className="dss-btn-primary dss-dest-primary-btn"
                  disabled={loadingRoute || loadingDestInfo}
                  onClick={() =>
                    handleActivateRouteToDestination(selectedDestination)
                  }
                >
                  {loadingRoute
                    ? "Computing Optimal A* Route..."
                    : customDestination &&
                      customDestination.row === selectedDestination.row &&
                      customDestination.col === selectedDestination.col
                    ? `Route Active (${
                        fcMetrics?.distance_km ?? selectedDestination.direct_distance_km
                      } km · ${fcMetrics?.hours ?? selectedDestination.estimated_transit_hours}h) — Focus`
                    : "Use This Location (Route Ship Here)"}
                </button>
                <div className="dss-dest-sub-actions">
                  <button
                    type="button"
                    className={`dss-btn-secondary ${
                      isSelectingDestination ? "selecting" : ""
                    }`}
                    onClick={() =>
                      setIsSelectingDestination(!isSelectingDestination)
                    }
                  >
                    {isSelectingDestination ? "Click Map..." : "Move Pin"}
                  </button>
                  <button
                    type="button"
                    className="dss-btn-secondary"
                    onClick={() =>
                      handleFocusMapCoord(
                        selectedDestination.x_m,
                        selectedDestination.y_m,
                        true
                      )
                    }
                  >
                    Zoom To Pin
                  </button>
                  <button
                    type="button"
                    className="dss-btn-secondary"
                    onClick={handleClearDestination}
                  >
                    Clear Pin
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Understandable On-Map Visual Legend Card Explaining Every Surface, Feature & Route Element */}
          {showMapLegend && (
            <div className="dss-map-legend-overlay">
              <div className="dss-ml-head">
                <strong>3D / 2D POLAR MAP VISUAL LEGEND</strong>
                <button
                  type="button"
                  onClick={() => setShowMapLegend(false)}
                  aria-label="Close legend"
                >
                  ×
                </button>
              </div>
              <div className="dss-ml-cols">
                <div className="dss-ml-col">
                  <span className="dss-ml-sub">SURFACE &amp; TERRAIN</span>
                  <div className="dss-ml-item">
                    <span className="swatch-box ocean" /> Southern Ocean &amp; Bathymetry
                  </div>
                  <div className="dss-ml-item">
                    <span className="swatch-box marginal-ice" /> Marginal Sea Ice (15–40% SIC)
                  </div>
                  <div className="dss-ml-item">
                    <span className="swatch-box pack-ice" /> Heavy Pack Ice Ridge (≥40% SIC)
                  </div>
                  <div className="dss-ml-item">
                    <span className="swatch-box shelf" /> Floating Glacial Ice Shelf
                  </div>
                  <div className="dss-ml-item">
                    <span className="swatch-box rock" /> Coastal Bedrock Oasis (Land)
                  </div>
                  <div className="dss-ml-item">
                    <span className="swatch-box mountain" /> 3D Mountains &amp; Ice Plateau
                  </div>
                </div>
                <div className="dss-ml-col">
                  <span className="dss-ml-sub">NAVIGATION &amp; MARKERS</span>
                  <div className="dss-ml-item">
                    <span className="swatch-dot ship" /> RV Polar Explorer (Live Ship)
                  </div>
                  <div className="dss-ml-item">
                    <span className="swatch-line optimal" /> Optimal A* Path + Flow Chevrons
                  </div>
                  <div className="dss-ml-item">
                    <span className="swatch-line cc" /> Course Correction (CC) &amp; Hazard
                  </div>
                  <div className="dss-ml-item">
                    <span className="swatch-dot station" /> Research Station (Bharati, Maitri)
                  </div>
                  <div className="dss-ml-item">
                    <span className="swatch-dot berg" /> 3D Tabular Iceberg + 7d Cone
                  </div>
                  <div className="dss-ml-item">
                    <span className="swatch-dot dest" /> Selected Destination Pin + Road
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Live Ship Location & Tactical Local Ice Radar HUD */}
          {showShipBridge && activeShipTelemetry && (
            <div className="dss-ship-bridge-hud">
              <div className="dss-sb-head">
                <div>
                  <span className="dss-sb-tag">
                    LIVE VESSEL LOCATION &amp; TACTICAL RADAR
                  </span>
                  <h3>
                    {scenario?.ship?.name || "RV Polar Explorer"}{" "}
                    <span className="mono">
                      ({Math.abs(activeShipTelemetry.lat).toFixed(2)}°S,{" "}
                      {Math.abs(activeShipTelemetry.lon).toFixed(2)}°E)
                    </span>
                  </h3>
                </div>
                <div className="dss-sb-actions">
                  <button
                    type="button"
                    onClick={() => handleZoomToShip(true)}
                    title="Center and zoom map onto ship"
                  >
                    Center Map
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowShipBridge(false)}
                    aria-label="Minimize ship radar HUD"
                  >
                    ×
                  </button>
                </div>
              </div>

              <div className="dss-sb-body">
                <ShipBridgeScope
                  shipTel={activeShipTelemetry}
                  fcPath={routeData?.forecast_aware?.xy}
                  stPath={routeData?.static?.xy}
                  activeSlice={activeSliceRef.current}
                  extent={scenario?.extent}
                  shape={scenario?.shape}
                />

                <div className="dss-sb-readout">
                  <div className="dss-sb-grid">
                    <div>
                      <span>GEOGRAPHIC POS</span>
                      <strong className="mono">
                        {Math.abs(activeShipTelemetry.lat).toFixed(2)}°S,{" "}
                        {Math.abs(activeShipTelemetry.lon).toFixed(2)}°E
                      </strong>
                    </div>
                    <div>
                      <span>HEADING / SPEED</span>
                      <strong className="mono">
                        COG {activeShipTelemetry.cog_deg}° ·{" "}
                        {activeShipTelemetry.speed_kmh} km/h
                      </strong>
                    </div>
                    <div>
                      <span>LOCAL ICE (SIC)</span>
                      <strong
                        className={`mono ${
                          activeShipTelemetry.sic >= 0.35
                            ? "warn-text"
                            : "cyan-text"
                        }`}
                      >
                        {(activeShipTelemetry.sic * 100).toFixed(1)}% SIC
                      </strong>
                    </div>
                    <div>
                      <span>VOYAGE ELAPSED</span>
                      <strong className="mono">
                        T+{Math.round(activeShipTelemetry.hour)}h (
                        {activeShipTelemetry.progressPct}%)
                      </strong>
                    </div>
                  </div>

                  {/* Interactive Ship Location Scrubber along Optimal Path */}
                  <div className="dss-sb-scrubber">
                    <div className="dss-sb-scrub-head">
                      <span>Scrub Ship Position Along Optimal Path</span>
                      {shipStepIdx !== null && (
                        <button
                          type="button"
                          onClick={() => setShipStepIdx(null)}
                        >
                          Sync to Timeline
                        </button>
                      )}
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={Math.max(1, activeShipTelemetry.totalSteps - 1)}
                      value={activeShipTelemetry.idx}
                      onChange={(e) =>
                        setShipStepIdx(Number(e.target.value))
                      }
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Interactive Click-to-Inspect Feature Telemetry Card */}
          {selectedTarget && (
            <div className="dss-map-inspect-card">
              <div className="dss-inspect-head">
                <div>
                  <span className="dss-inspect-kind">{selectedTarget.kind}</span>
                  <h3>{selectedTarget.title}</h3>
                  <p>{selectedTarget.subtitle}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedTarget(null)}
                  aria-label="Close target inspector"
                >
                  ×
                </button>
              </div>
              <div className="dss-inspect-metrics">
                {selectedTarget.metrics?.map((m, i) => (
                  <div key={i} className="dss-inspect-row">
                    <span>{m.label}</span>
                    <strong className="mono">{m.value}</strong>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* Right Telemetry & Routing Evaluation Column */}
        <aside
          className={`dss-sidebar dss-right ${
            !rightPanelOpen ? "is-collapsed" : ""
          }`}
          aria-hidden={!rightPanelOpen}
        >
          <div className="dss-sidebar-top">
            <span>Route Planner</span>
            <button
              type="button"
              className="dss-hide-panel-btn"
              onClick={() => setRightPanelOpen(false)}
              title="Hide right panel to expand map"
            >
              Hide Panel ›
            </button>
          </div>

          <section className="dss-panel">
            <label className="dss-field">
              <span>Active Route Destination</span>
              <select
                value={leg}
                onChange={(e) => {
                  setShipPos(null);
                  setCustomDestination(null);
                  setSelectedDestination(null);
                  setLeg(e.target.value);
                }}
              >
                <option value="bharati->maitri">
                  Bharati Station to Maitri Station
                </option>
                <option value="ice_entry->bharati">
                  Ice Entry (56°S, 52.5°E) to Bharati Station
                </option>
                <option value="ice_entry->maitri">
                  Ice Entry (56°S, 52.5°E) to Maitri Station
                </option>
              </select>
            </label>

            {/* On-Map Custom Destination Controls */}
            <div className="dss-dest-planner-box">
              {customDestination ? (
                <div className="dss-dest-active-pill">
                  <div>
                    <span className="dss-dest-pill-tag">CUSTOM DESTINATION</span>
                    <strong>
                      {customDestination.custom_name ||
                        customDestination.nearest_feature}
                    </strong>
                    <span className="mono">
                      {Math.abs(customDestination.lat).toFixed(2)}°S,{" "}
                      {Math.abs(customDestination.lon).toFixed(2)}°
                      {customDestination.lon >= 0 ? "E" : "W"}
                    </span>
                  </div>
                  <div className="dss-dest-pill-btns">
                    <button
                      type="button"
                      className={isSelectingDestination ? "active" : ""}
                      onClick={() =>
                        setIsSelectingDestination(!isSelectingDestination)
                      }
                    >
                      {isSelectingDestination ? "Click Map..." : "Move Pin"}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        handleFocusMapCoord(
                          customDestination.x_m,
                          customDestination.y_m,
                          true
                        )
                      }
                    >
                      Zoom
                    </button>
                    <button type="button" onClick={handleClearDestination}>
                      Clear
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className={`dss-btn-secondary dss-btn-full ${
                    isSelectingDestination ? "selecting" : ""
                  }`}
                  onClick={() =>
                    setIsSelectingDestination(!isSelectingDestination)
                  }
                >
                  {isSelectingDestination
                    ? "Click anywhere on Map..."
                    : "Choose Destination on Map"}
                </button>
              )}
            </div>

            <div className="dss-slider-block">
              <div className="dss-slider-title">
                <span>Ice-Risk Weight (λ)</span>
                <strong className="mono">{wRisk.toFixed(2)}</strong>
              </div>
              <input
                type="range"
                min={0}
                max={1.5}
                step={0.05}
                value={wRisk}
                onChange={(e) => setWRisk(Number(e.target.value))}
              />
            </div>

            <div className="dss-action-row">
              <button
                type="button"
                className="dss-btn-primary"
                onClick={handleAdvanceDay}
                disabled={loadingRoute}
              >
                {loadingRoute ? "Replanning..." : "Step Voyage +1 Day"}
              </button>
              {shipPos && (
                <button
                  type="button"
                  className="dss-btn-secondary"
                  onClick={handleResetVoyage}
                >
                  Reset
                </button>
              )}
            </div>
          </section>

          {/* Compact Route Metrics Summary */}
          <section className="dss-panel dss-panel-last">
            <div className="dss-panel-head">
              <h2>Route Summary</h2>
            </div>

            {fcMetrics?.ok && stMetrics?.ok ? (
              <>
                <div className="dss-metric-grid dss-metric-highlight">
                  <div className="dss-metric-cell">
                    <span className="dss-metric-label">Heavy-Ice Saved</span>
                    <div
                      className={`dss-metric-val ${
                        stMetrics.heavy_ice_hours - fcMetrics.heavy_ice_hours >= 0
                          ? "pos"
                          : "neg"
                      }`}
                    >
                      {stMetrics.heavy_ice_hours - fcMetrics.heavy_ice_hours >= 0
                        ? "+"
                        : ""}
                      {(
                        stMetrics.heavy_ice_hours - fcMetrics.heavy_ice_hours
                      ).toFixed(1)}
                      <small>h</small>
                    </div>
                  </div>
                  <div className="dss-metric-cell">
                    <span className="dss-metric-label">Time Saved</span>
                    <div
                      className={`dss-metric-val ${
                        stMetrics.hours - fcMetrics.hours >= 0 ? "pos" : "neg"
                      }`}
                    >
                      {stMetrics.hours - fcMetrics.hours >= 0 ? "+" : ""}
                      {(stMetrics.hours - fcMetrics.hours).toFixed(1)}
                      <small>h</small>
                    </div>
                  </div>
                </div>

                <div className="dss-route-comparison-table">
                  <div className="dss-rc-header">
                    <span>Metric</span>
                    <span className="cyan-text">Optimal A*</span>
                    <span className="muted-text">Baseline</span>
                  </div>
                  <div className="dss-rc-row">
                    <span>Duration</span>
                    <strong className="mono">{fcMetrics.hours} h</strong>
                    <span className="mono">{stMetrics.hours} h</span>
                  </div>
                  <div className="dss-rc-row">
                    <span>Distance</span>
                    <strong className="mono">{fcMetrics.distance_km} km</strong>
                    <span className="mono">{stMetrics.distance_km} km</span>
                  </div>
                  <div className="dss-rc-row">
                    <span>Heavy Ice</span>
                    <strong className="mono accent">
                      {fcMetrics.heavy_ice_hours} h
                    </strong>
                    <span className="mono">{stMetrics.heavy_ice_hours} h</span>
                  </div>
                </div>
              </>
            ) : (
              <p className="dss-meta-line">Computing route...</p>
            )}
          </section>
        </aside>
      </main>

      {/* Bottom Time-Series & Lead-Day Skill Tray */}
      <footer className="dss-Timeline">
        <div className="dss-timeline-controls">
          <button
            type="button"
            className="dss-play-btn"
            onClick={() => setIsPlaying(!isPlaying)}
          >
            {isPlaying ? "Pause" : "Play Sequence"}
          </button>
          <div className="dss-step-pills" role="group" aria-label="Timeline Day Selector">
            {[-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7].map((st) => (
              <button
                type="button"
                key={st}
                className={`dss-step-pill ${
                  timelineStep === st ? "active" : ""
                } ${st <= 0 ? "hist" : "fut"}`}
                onClick={() => {
                  setIsPlaying(false);
                  setTimelineStep(st);
                }}
              >
                {st === 0 ? "D0" : st < 0 ? `D${st}` : `+${st}d`}
              </button>
            ))}
          </div>
        </div>

        {forecast?.per_lead_mae && (
          <div className="dss-skill-mini">
            <span className="dss-skill-caption">
              Lead +1..7d MAE (Cyan: U-Net · Slate: B1)
            </span>
            <div className="dss-skill-bars">
              {forecast.per_lead_mae.ml.map((mVal, i) => {
                const b1Val = forecast.per_lead_mae.b1[i];
                return (
                  <div
                    key={i}
                    className={`dss-skill-col ${
                      timelineStep === i + 1 ? "current" : ""
                    }`}
                    title={`Lead +${i + 1}d: U-Net MAE ${(mVal * 100).toFixed(
                      2
                    )}% vs B1 ${(b1Val * 100).toFixed(2)}%`}
                  >
                    <div className="bar-pair">
                      <div
                        className="bar-ml"
                        style={{ height: `${Math.min(100, mVal * 1200)}%` }}
                      />
                      <div
                        className="bar-b1"
                        style={{ height: `${Math.min(100, b1Val * 1200)}%` }}
                      />
                    </div>
                    <small>+{i + 1}d</small>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </footer>

      {/* Modal / Drawer Overlay */}
      {drawer && (
        <div className="dss-drawer-backdrop" onClick={() => setDrawer(null)}>
          <div
            className="dss-drawer-modal dss-drawer-wide"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="dss-drawer-top">
              <h2>
                {drawer === "guide" &&
                  "System Operational Guide & Interactive Walkthrough"}
                {drawer === "ml" &&
                  "Small ML Model Studio (2-Level Polar U-Net) & Free Satellite Datasets"}
                {drawer === "validation" &&
                  "Model Validation & Baseline Comparison (Unseen Windows)"}
                {drawer === "hindcast" &&
                  "Counterfactual Hindcast Route Evaluation"}
                {drawer === "about" && "Data Provenance, Citations & Disclaimer"}
              </h2>
              <button type="button" onClick={() => setDrawer(null)}>
                Close [Esc]
              </button>
            </div>

            {/* Interactive System Guide & Help Modal */}
            {drawer === "guide" && (
              <div className="dss-drawer-body">
                <div className="dss-subtabs">
                  <button
                    type="button"
                    className={guideTab === "overview" ? "active" : ""}
                    onClick={() => setGuideTab("overview")}
                  >
                    01. Mission &amp; Interactive Tour
                  </button>
                  <button
                    type="button"
                    className={guideTab === "layers" ? "active" : ""}
                    onClick={() => setGuideTab("layers")}
                  >
                    02. Polar Map &amp; Raster Layers
                  </button>
                  <button
                    type="button"
                    className={guideTab === "model" ? "active" : ""}
                    onClick={() => setGuideTab("model")}
                  >
                    03. How the Small U-Net Works
                  </button>
                  <button
                    type="button"
                    className={guideTab === "routing" ? "active" : ""}
                    onClick={() => setGuideTab("routing")}
                  >
                    04. Live A* &amp; Counterfactual Scoring
                  </button>
                  <button
                    type="button"
                    className={guideTab === "pitch" ? "active" : ""}
                    onClick={() => setGuideTab("pitch")}
                  >
                    05. Presentation Script &amp; Q&amp;A
                  </button>
                </div>

                {guideTab === "overview" && (
                  <div className="dss-guide-grid">
                    <div className="dss-guide-col">
                      <h3>What is ARGOS?</h3>
                      <p className="dss-drawer-lead">
                        <strong>ARGOS (Antarctic Route Guidance &amp; Operational Sea-Ice DSS)</strong> is an Antarctic sea-ice
                        forecasting and vessel route-planning decision support
                        prototype designed for resupply missions to Indian
                        Antarctic research stations (<strong>Bharati</strong> in
                        Prydz Bay at 69.41°S, 76.19°E and{" "}
                        <strong>Maitri</strong> at 70.77°S, 11.73°E).
                      </p>
                      <p className="dss-drawer-lead">
                        Instead of routing ships across static historical
                        climatology, the system ingests{" "}
                        <strong>7 days of passive-microwave satellite Sea Ice Concentration (SIC)</strong>{" "}
                        on a native 25 km South Polar Stereographic grid (
                        <code>EPSG:3412</code>), runs a{" "}
                        <strong>2-Level Residual Spatial-Temporal U-Net</strong>{" "}
                        to predict the next 7 days of pack-ice evolution, and
                        computes an optimal time-dependent <strong>A* corridor</strong>{" "}
                        that avoids emerging heavy-ice ridges.
                      </p>

                      <div className="dss-guide-callout">
                        <h4>Three-Column Console Layout</h4>
                        <ul>
                          <li>
                            <strong>Left Column (Controls &amp; ML Engine):</strong>{" "}
                            Switch between satellite observations, U-Net
                            predictions, neural residuals, and error layers, or
                            trigger live on-server SGD training epochs.
                          </li>
                          <li>
                            <strong>Center Viewport (EPSG:3412 Polar Stage):</strong>{" "}
                            Interactive polar-stereographic map with live cursor
                            coordinate/SIC probe, station markers, iceberg drift
                            cones, and planned trajectories.
                          </li>
                          <li>
                            <strong>Right Column (A* Planner &amp; Scoring):</strong>{" "}
                            Adjust ice-risk penalty (<code>λ</code>), step the
                            vessel forward day-by-day, and compare the U-Net
                            route against static climatology on real observed
                            sea ice.
                          </li>
                        </ul>
                      </div>
                    </div>

                    <div className="dss-guide-col">
                      <h3>Interactive 5-Step Demo Walkthrough</h3>
                      <p className="dss-drawer-lead">
                        Click any action below to jump directly to that feature
                        in the workspace:
                      </p>
                      <div className="dss-walkthrough-list">
                        <div className="dss-walk-item">
                          <div>
                            <strong>1. Compare Observed vs. U-Net Forecast</strong>
                            <span>
                              Enable the split-screen curtain on Lead +5d to
                              compare satellite ground truth against the U-Net
                              prediction.
                            </span>
                          </div>
                          <button
                            type="button"
                            className="dss-btn-secondary"
                            onClick={() => {
                              setTimelineStep(5);
                              setSwipeEnabled(true);
                              setSwipeSplit(50);
                              setDrawer(null);
                            }}
                          >
                            Activate Swipe
                          </button>
                        </div>

                        <div className="dss-walk-item">
                          <div>
                            <strong>2. Inspect Raw Neural Residual |ΔSIC|</strong>
                            <span>
                              Visualize the exact 7-day sea-ice change predicted
                              by the U-Net readout head along the marginal ice
                              zone.
                            </span>
                          </div>
                          <button
                            type="button"
                            className="dss-btn-secondary"
                            onClick={() => {
                              setSwipeEnabled(false);
                              setTimelineStep(4);
                              setActiveLayer("residual");
                              setDrawer(null);
                            }}
                          >
                            View Residual
                          </button>
                        </div>

                        <div className="dss-walk-item">
                          <div>
                            <strong>3. Train the Small U-Net Live (+5 Epochs)</strong>
                            <span>
                              Open the ML Studio to run on-server gradient
                              descent and inspect internal 3×3 convolutional
                              feature maps.
                            </span>
                          </div>
                          <button
                            type="button"
                            className="dss-btn-secondary"
                            onClick={() => {
                              setMlTab("architecture");
                              setDrawer("ml");
                            }}
                          >
                            Open ML Studio
                          </button>
                        </div>

                        <div className="dss-walk-item">
                          <div>
                            <strong>4. Test High Ice-Risk Aversion (λ = 1.10)</strong>
                            <span>
                              Increase the safety weight λ so the A* router
                              detours around Prydz Bay pack-ice ridges.
                            </span>
                          </div>
                          <button
                            type="button"
                            className="dss-btn-secondary"
                            onClick={() => {
                              setSwipeEnabled(false);
                              setActiveLayer("ml");
                              setWRisk(1.1);
                              setDrawer(null);
                            }}
                          >
                            Set λ = 1.10
                          </button>
                        </div>

                        <div className="dss-walk-item">
                          <div>
                            <strong>5. Browse Free Satellite Datasets</strong>
                            <span>
                              View the 6 free satellite &amp; reanalysis
                              archives (NSIDC, AMSR2, ERA5, CMEMS, USNIC) used
                              for polar ML.
                            </span>
                          </div>
                          <button
                            type="button"
                            className="dss-btn-secondary"
                            onClick={() => {
                              setMlTab("datasets");
                              setDrawer("ml");
                            }}
                          >
                            View Datasets
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {guideTab === "layers" && (
                  <div className="dss-drawer-section">
                    <p className="dss-drawer-lead">
                      Every map layer is projected onto the native{" "}
                      <strong>NSIDC 25 km South Polar Stereographic grid (EPSG:3412)</strong>{" "}
                      cropped to the Indian Ocean / East Antarctic sector (
                      <code>160 × 184</code> cells covering 10°W–100°E,
                      55°S–78°S).
                    </p>
                    <table className="dss-table">
                      <thead>
                        <tr>
                          <th>Layer Name</th>
                          <th>Category</th>
                          <th>What It Shows &amp; How to Interpret</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td className="highlight">U-Net 7-Day Forecast</td>
                          <td>Model Output</td>
                          <td>
                            Predicted Sea Ice Concentration (0–100%) for lead
                            days +1d to +7d produced by the 2-level residual
                            U-Net from causal inputs (D-6..D0).
                          </td>
                        </tr>
                        <tr>
                          <td className="highlight">Observed Sea Ice (NSIDC)</td>
                          <td>Satellite Truth</td>
                          <td>
                            Daily passive-microwave sea-ice concentration (NOAA/NSIDC
                            G02202 V6). Used as input for D-6..D0 and as ground
                            truth for scoring +1d..+7d.
                          </td>
                        </tr>
                        <tr>
                          <td className="highlight">U-Net Residual |ΔSIC|</td>
                          <td>Neural Activation</td>
                          <td>
                            Magnitude of the raw neural change{" "}
                            <code>|Ŷ_k − SIC(D0)|</code> before clipping.
                            Highlights where the U-Net predicts active melt,
                            polynya opening, or wind-driven pack advance.
                          </td>
                        </tr>
                        <tr>
                          <td className="highlight">U-Net Encoder Ice-Edge</td>
                          <td>Feature Map</td>
                          <td>
                            Channel 6 of Encoder Level 1:{" "}
                            <code>4 · SIC · (1 − SIC)</code>, which peaks along
                            the dynamic 50% marginal ice zone where routing
                            decisions are most sensitive.
                          </td>
                        </tr>
                        <tr>
                          <td className="highlight">Seasonal Tendency (B1)</td>
                          <td>Baseline</td>
                          <td>
                            Climatological baseline that adds the historical
                            average daily melt/freeze tendency to the last
                            observed day: <code>SIC(D0) + (Clim_k − Clim_0)</code>.
                          </td>
                        </tr>
                        <tr>
                          <td className="highlight">Persistence (B0)</td>
                          <td>Baseline</td>
                          <td>
                            Zero-change baseline assuming sea ice remains frozen
                            in its D0 state for the next 7 days:{" "}
                            <code>Ŷ_k = SIC(D0)</code>.
                          </td>
                        </tr>
                        <tr>
                          <td className="highlight">Absolute Error |ML − Obs|</td>
                          <td>Verification</td>
                          <td>
                            Cell-by-cell absolute discrepancy between the U-Net
                            forecast and actual satellite observation at the
                            selected lead day.
                          </td>
                        </tr>
                        <tr>
                          <td className="highlight">Validation Uncertainty σ</td>
                          <td>Risk Weighting</td>
                          <td>
                            Historical per-cell, per-lead Mean Absolute Error on
                            the validation split. Fed directly into the A* cost
                            function to penalize uncertain ice-edge zones.
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}

                {guideTab === "model" && (
                  <div className="dss-drawer-section">
                    <h3>Compact 2-Level Spatial-Temporal U-Net Architecture</h3>
                    <p className="dss-drawer-lead">
                      Because daily Antarctic sea-ice changes slowly in the
                      interior pack but rapidly along coastal polynyas and the
                      15% ice edge, training a network to predict raw SIC wastes
                      capacity. Instead, <strong>PolarUNet</strong> is
                      formulated as a <strong>residual forecaster</strong>:
                    </p>
                    <div className="dss-guide-callout">
                      <code>
                        Ŷ(d0 + k) = clip( SIC(d0) + U-Net(X_d0)_k , 0.0, 1.0 ) ×
                        OceanMask
                      </code>
                    </div>
                    <table className="dss-table">
                      <thead>
                        <tr>
                          <th>Component</th>
                          <th>Specification</th>
                          <th>Purpose</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td className="highlight">Input Tensor (10ch)</td>
                          <td>
                            <code>[10, 160, 184]</code>
                          </td>
                          <td>
                            7 daily SIC maps (D-6..D0) + 1 static ocean mask + 2
                            cyclical season channels (<code>sin/cos DOY</code>).
                          </td>
                        </tr>
                        <tr>
                          <td className="highlight">Encoder Level 1</td>
                          <td>
                            <code>3×3 Conv + GELU → [8, 160, 184]</code>
                          </td>
                          <td>
                            Extracts 1d/3d/6d temporal tendencies, Sobel{" "}
                            <code>∇x/∇y</code> drift gradients, and Laplacian{" "}
                            <code>∇²</code> edge diffusion at 25 km resolution.
                          </td>
                        </tr>
                        <tr>
                          <td className="highlight">Bottleneck Level 2</td>
                          <td>
                            <code>2×2 AvgPool → 3×3 Conv → [6, 80, 92]</code>
                          </td>
                          <td>
                            Captures 50 km–150 km synoptic wind-driven wave and
                            coastal lead patterns across Prydz Bay and Enderby
                            Land.
                          </td>
                        </tr>
                        <tr>
                          <td className="highlight">Decoder + Skip</td>
                          <td>
                            <code>2×2 Bilinear Upsample + Skip Concat</code>
                          </td>
                          <td>
                            Combines sharp 25 km coastal boundaries from the
                            input/encoder with broad synoptic tendencies from
                            the bottleneck.
                          </td>
                        </tr>
                        <tr>
                          <td className="highlight">Ice-Edge Loss</td>
                          <td>
                            <code>
                              L = Ocean · (1 + 2·1_[|y−0.15|&lt;0.15]) · |ŷ − y|
                            </code>
                          </td>
                          <td>
                            Upweights errors near the 15% ice-edge contour by
                            3× so the model prioritizes navigable boundary
                            accuracy (minimizing IIEE km²).
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}

                {guideTab === "routing" && (
                  <div className="dss-drawer-section">
                    <h3>Time-Dependent A* &amp; Counterfactual Scoring</h3>
                    <p className="dss-drawer-lead">
                      As the vessel moves across the 8-connected 25 km grid, the
                      ice field evolves with elapsed voyage time{" "}
                      <code>t (hours)</code>. At step day{" "}
                      <code>k = floor(t / 24)</code>, vessel speed{" "}
                      <code>v(SIC)</code> drops linearly from{" "}
                      <strong>22 km/h</strong> in open water ({"<15% SIC"}) down
                      to <strong>4.4 km/h</strong> at the PC6 operational limit
                      (<strong>70% SIC</strong>), and cells above 70% SIC are
                      impassable.
                    </p>
                    <div className="dss-guide-callout">
                      <h4>Why Counterfactual Scoring Matters</h4>
                      <p>
                        A route planner can look artificially good if evaluated
                        on its own forecast. To guarantee a fair scientific
                        benchmark:
                      </p>
                      <ol>
                        <li>
                          <strong>Route A (Forecast-Aware Cyan Line)</strong> is
                          planned using only the 7-day U-Net forecast and
                          validation uncertainty map available on departure day{" "}
                          <code>D0</code>.
                        </li>
                        <li>
                          <strong>Route B (Static Climatology Dashed Line)</strong>{" "}
                          is planned using historical seasonal climatology.
                        </li>
                        <li>
                          <strong>Post-Hoc Scoring:</strong> Both fixed paths
                          are then sailed through the{" "}
                          <strong>true observed NSIDC satellite sea-ice fields</strong>{" "}
                          of days D+1..D+14 to measure actual transit hours,
                          heavy-ice exposure (hours spent in ≥40% SIC), and fuel
                          resistance proxy.
                        </li>
                      </ol>
                    </div>
                  </div>
                )}

                {guideTab === "pitch" && (
                  <div className="dss-guide-grid">
                    <div className="dss-guide-col">
                      <h3>3-Minute Live Presentation Script</h3>
                      <p className="dss-drawer-lead">
                        Complete documentation is saved in{" "}
                        <code>/PRESENTATION_GUIDE.md</code>. Follow this 4-part
                        flow when presenting live:
                      </p>
                      <div className="dss-guide-callout">
                        <h4>1. The Operational Problem (30 sec)</h4>
                        <p>
                          Resupply vessels sailing to India&apos;s{" "}
                          <strong>Bharati</strong> and <strong>Maitri</strong>{" "}
                          stations cross dynamic East Antarctic pack ice. Static
                          climatology misses wind-driven heavy pack ridges (≥40%
                          SIC) and transient coastal polynyas.{" "}
                          <strong>ARGOS</strong> combines passive-microwave
                          satellite sea ice, a causal 2-level residual U-Net,
                          and time-dependent A* routing on a native 25 km{" "}
                          <code>EPSG:3412</code> polar grid.
                        </p>
                      </div>
                      <div className="dss-guide-callout">
                        <h4>2. Satellite Input → Small U-Net Forecast (45 sec)</h4>
                        <p>
                          Select <strong>+5d</strong> in the timeline and enable
                          the <strong>Split Curtain</strong>. Explain that the
                          U-Net takes 10 channels (7 days of NSIDC satellite SIC{" "}
                          <code>D-6..D0</code> + ocean mask +{" "}
                          <code>sin/cos DOY</code>) and predicts the 7-day
                          residual change <code>ΔSIC</code> in ~4 ms on CPU.
                        </p>
                      </div>
                      <div className="dss-guide-callout">
                        <h4>3. Validation Gate &amp; Live SGD Training (45 sec)</h4>
                        <p>
                          Open <strong>Model &amp; Datasets</strong>. Show that
                          the U-Net beats both Persistence (B0) and Seasonal
                          Tendency (B1) across all 7 leads on MAE and 15%
                          ice-edge IIEE (km²). Click{" "}
                          <strong>Run +5 Training Epochs</strong> to demonstrate
                          live gradient descent and inspect internal 3×3
                          convolutional feature maps.
                        </p>
                      </div>
                      <div className="dss-guide-callout">
                        <h4>4. Live A* Routing &amp; Counterfactual Proof (60 sec)</h4>
                        <p>
                          Adjust <strong>Ice-Risk Penalty (λ)</strong> on the
                          right panel and click <strong>Step Voyage +1 Day</strong>.
                          Highlight <strong>02. Counterfactual Evaluation</strong>:
                          when both routes are scored on true observed satellite
                          ice after planning, the forecast-aware route saves
                          heavy-ice exposure hours and total transit time.
                        </p>
                      </div>
                    </div>

                    <div className="dss-guide-col">
                      <h3>Anticipated Judge &amp; Reviewer Q&amp;A</h3>
                      <div className="dss-guide-callout">
                        <h4>
                          Q: Why a compact 2-level U-Net instead of a huge
                          Vision Transformer?
                        </h4>
                        <p>
                          At 25 km resolution over a regional 160×184 polar
                          grid, 7-day pack-ice evolution is governed by 50–150 km
                          synoptic wind advection and marginal edge melt. A
                          2-level residual U-Net with Sobel gradient (∇x, ∇y)
                          and Laplacian diffusion filters captures the exact
                          physical receptive field, avoids overfitting on
                          multi-year satellite archives, and runs in ~4 ms on
                          shipboard CPU hardware.
                        </p>
                      </div>
                      <div className="dss-guide-callout">
                        <h4>
                          Q: Why measure IIEE (Integrated Ice-Edge Error) alongside MAE?
                        </h4>
                        <p>
                          Grid-wide MAE is diluted by open ocean (0% SIC) and
                          interior pack ice. For polar navigation, accuracy at
                          the <strong>15% ice-edge boundary</strong> determines
                          where a ship enters pack ice. IIEE measures the exact
                          misclassified area (km²) at the 15% contour, and our
                          loss function upweights pixels near 15% SIC by 3×.
                        </p>
                      </div>
                      <div className="dss-guide-callout">
                        <h4>
                          Q: How do you ensure the route comparison is scientifically fair?
                        </h4>
                        <p>
                          Neither route is scored on its own planning assumption.
                          Both the U-Net route and the Static Climatology route
                          are locked at departure day D0 and then evaluated
                          post-hoc against the actual observed NSIDC satellite
                          sea-ice fields of days D+1..D+14.
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Small ML Model & Datasets Studio */}
            {drawer === "ml" && (
              <div className="dss-drawer-body">
                <div className="dss-subtabs">
                  <button
                    type="button"
                    className={mlTab === "architecture" ? "active" : ""}
                    onClick={() => setMlTab("architecture")}
                  >
                    01. Live U-Net Architecture &amp; SGD Training
                  </button>
                  <button
                    type="button"
                    className={mlTab === "features" ? "active" : ""}
                    onClick={() => setMlTab("features")}
                  >
                    02. Internal Feature Maps &amp; Residual Inspector ({date})
                  </button>
                  <button
                    type="button"
                    className={mlTab === "datasets" ? "active" : ""}
                    onClick={() => setMlTab("datasets")}
                  >
                    03. Free Satellite Datasets Catalog ({datasetsList.length})
                  </button>
                </div>

                {mlTab === "architecture" && modelSummary && (
                  <div className="dss-ml-grid">
                    <div className="dss-ml-col">
                      <h3>{modelSummary.architecture}</h3>
                      <p className="dss-drawer-lead">
                        Predicts 7-day Sea Ice Concentration residuals{" "}
                        <code>ΔSIC(d+1..d+7)</code> from 7 daily NSIDC
                        passive-microwave satellite maps + static ocean mask +
                        seasonal encoding:
                        <br />
                        <code>
                          Ŷ_k = clip(SIC(d0) + U-Net(X)_k, 0, 1) × ocean_mask
                        </code>
                      </p>

                      <table className="dss-table">
                        <thead>
                          <tr>
                            <th>Stage</th>
                            <th>Operation</th>
                            <th>Tensor Shape</th>
                          </tr>
                        </thead>
                        <tbody>
                          {modelSummary.layers?.map((ly, i) => (
                            <tr key={i}>
                              <td className="highlight">{ly.name}</td>
                              <td>{ly.op}</td>
                              <td>
                                <code>{ly.shape}</code>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>

                      <div className="dss-train-controls-box">
                        <h4>Interactive On-Server SGD Optimization</h4>
                        <div className="dss-train-sliders">
                          <label>
                            <span>Learning Rate: {trainLr.toFixed(2)}</span>
                            <input
                              type="range"
                              min={0.01}
                              max={0.2}
                              step={0.01}
                              value={trainLr}
                              onChange={(e) =>
                                setTrainLr(Number(e.target.value))
                              }
                            />
                          </label>
                          <label>
                            <span>
                              15% Ice-Edge Loss Weight:{" "}
                              {trainEdgeWeight.toFixed(1)}×
                            </span>
                            <input
                              type="range"
                              min={0.0}
                              max={5.0}
                              step={0.5}
                              value={trainEdgeWeight}
                              onChange={(e) =>
                                setTrainEdgeWeight(Number(e.target.value))
                              }
                            />
                          </label>
                        </div>
                        <div className="dss-action-row">
                          <button
                            type="button"
                            className="dss-btn-primary"
                            onClick={() => handleTrainModel(5, false)}
                            disabled={isTraining}
                          >
                            {isTraining
                              ? "Running SGD..."
                              : "Run +5 Training Epochs"}
                          </button>
                          <button
                            type="button"
                            className="dss-btn-secondary"
                            onClick={() => handleTrainModel(1, true)}
                            disabled={isTraining}
                          >
                            Reset Weights &amp; Train 1 Epoch
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="dss-ml-col">
                      <h3>
                        Training Telemetry ({modelSummary.totalEpochs} Epochs
                        Completed)
                      </h3>
                      <p className="dss-drawer-lead">
                        Loss function:{" "}
                        <code>
                          L = ocean_mask · (1 + λ_edge · 1_[|y - 0.15| &lt;
                          0.15]) · |ŷ - y|
                        </code>
                      </p>
                      <div className="dss-log-scroll">
                        <table className="dss-table">
                          <thead>
                            <tr>
                              <th>Epoch</th>
                              <th>Train MAE</th>
                              <th>Val MAE (U-Net)</th>
                              <th>Val MAE (B1)</th>
                              <th>Val MAE (B0)</th>
                              <th>Ice-Edge IIEE</th>
                              <th>Step Time</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(modelSummary.trainingHistory || [])
                              .slice()
                              .reverse()
                              .map((log) => (
                                <tr key={log.epoch}>
                                  <td>#{log.epoch}</td>
                                  <td>{(log.trainMae * 100).toFixed(2)}%</td>
                                  <td className="highlight">
                                    {(log.valMae * 100).toFixed(2)}%
                                  </td>
                                  <td>{(log.b1ValMae * 100).toFixed(2)}%</td>
                                  <td>{(log.b0ValMae * 100).toFixed(2)}%</td>
                                  <td>
                                    {log.edgeIieeKm2.toLocaleString()} km²
                                  </td>
                                  <td>{log.durationMs} ms</td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                )}

                {mlTab === "features" && (
                  <div className="dss-fmap-section">
                    <p className="dss-drawer-lead">
                      Live intermediate feature maps extracted from the{" "}
                      <strong>PolarUNet</strong> forward pass for departure{" "}
                      <strong>{date}</strong> (forward latency:{" "}
                      <strong>{mlInspect?.inference_ms ?? 4.1} ms</strong>):
                    </p>
                    {mlInspect?.feature_maps && forecast?.rawLandPack ? (
                      <div className="dss-fmap-grid">
                        <FeatureMapCanvas
                          gridPack={mlInspect.feature_maps.enc_tend3}
                          landPack={forecast.rawLandPack}
                          mode="normalized"
                          title="Encoder Ch1: 3×3 Smoothed 3-Day Tendency"
                          subtitle="Captures synoptic polynya opening & pack drift"
                        />
                        <FeatureMapCanvas
                          gridPack={mlInspect.feature_maps.enc_edge_zone}
                          landPack={forecast.rawLandPack}
                          mode="normalized"
                          title="Encoder Ch6: Marginal Ice Zone Detector"
                          subtitle="4 · SIC(d0) · (1 − SIC(d0)) peaks at 50% pack boundary"
                        />
                        <FeatureMapCanvas
                          gridPack={mlInspect.feature_maps.enc_gelu_advect}
                          landPack={forecast.rawLandPack}
                          mode="normalized"
                          title="Encoder Ch7: GELU Advection + Gradient"
                          subtitle="Non-linear combination of Sobel ∇x, ∇y & tendency"
                        />
                        <FeatureMapCanvas
                          gridPack={mlInspect.feature_maps.residual_lead3}
                          landPack={forecast.rawLandPack}
                          mode="normalized"
                          title="Readout Head: Predicted |ΔSIC| at Lead +3d"
                          subtitle="Raw residual added to SIC(d0) before [0,1] clip"
                        />
                        <FeatureMapCanvas
                          gridPack={mlInspect.feature_maps.residual_lead7}
                          landPack={forecast.rawLandPack}
                          mode="normalized"
                          title="Readout Head: Predicted |ΔSIC| at Lead +7d"
                          subtitle="7-day cumulative melt & wind-drift correction"
                        />
                      </div>
                    ) : (
                      <p>Loading feature maps...</p>
                    )}
                  </div>
                )}

                {mlTab === "datasets" && (
                  <div className="dss-datasets-list">
                    <p className="dss-drawer-lead">
                      Below are the{" "}
                      <strong>
                        free, publicly accessible satellite and reanalysis
                        datasets
                      </strong>{" "}
                      best suited to train and operate this compact polar
                      sea-ice &amp; routing ML model:
                    </p>
                    <div className="dss-dataset-cards">
                      {datasetsList.map((ds) => (
                        <div key={ds.id} className="dss-ds-card">
                          <div className="dss-ds-top">
                            <span className="dss-ds-role">{ds.role}</span>
                            <span aria-hidden="true">·</span>
                            <span className="dss-ds-agency">{ds.agency}</span>
                          </div>
                          <h3>{ds.name}</h3>
                          <div className="dss-ds-meta">
                            <div>
                              <strong>Resolution &amp; Grid:</strong>{" "}
                              {ds.resolution}
                            </div>
                            <div>
                              <strong>Coverage:</strong> {ds.coverage}
                            </div>
                            <div>
                              <strong>Key Variables:</strong>{" "}
                              <code>{ds.variables.join(", ")}</code>
                            </div>
                            <div>
                              <strong>Free Access:</strong> {ds.access}
                            </div>
                          </div>
                          <p className="dss-ds-why">
                            <strong>Why Best Suitable:</strong> {ds.whyBest}
                          </p>
                          <div className="dss-ds-links">
                            <a
                              href={ds.url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Open Data Archive ↗
                            </a>
                            <a
                              href={ds.doi}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Reference / DOI ↗
                            </a>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {drawer === "validation" && validation && (
              <div className="dss-drawer-body">
                <p className="dss-drawer-lead">{validation.gate?.note}</p>
                <table className="dss-table">
                  <thead>
                    <tr>
                      <th>Lead Day</th>
                      <th>U-Net MAE (Dec–Mar)</th>
                      <th>B1 Seasonal MAE</th>
                      <th>B0 Persistence MAE</th>
                      <th>U-Net IIEE (km²)</th>
                      <th>B1 IIEE (km²)</th>
                      <th>B0 IIEE (km²)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {validation.validation?.per_lead?.map((r) => (
                      <tr key={r.lead}>
                        <td>+{r.lead}d</td>
                        <td className="highlight">
                          {(r.mae_ml_decmar * 100).toFixed(2)}%
                        </td>
                        <td>{(r.mae_b1_decmar * 100).toFixed(2)}%</td>
                        <td>{(r.mae_b0_decmar * 100).toFixed(2)}%</td>
                        <td className="highlight">
                          {r.iiee_ml_decmar.toLocaleString()}
                        </td>
                        <td>{r.iiee_b1_decmar.toLocaleString()}</td>
                        <td>{r.iiee_b0_decmar.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {drawer === "hindcast" && hindcast && (
              <div className="dss-drawer-body">
                <p className="dss-drawer-lead">{hindcast.note}</p>
                <table className="dss-table">
                  <thead>
                    <tr>
                      <th>Departure Date</th>
                      <th>Forecast Route Hours</th>
                      <th>Static Route Hours</th>
                      <th>Forecast Heavy Ice (h)</th>
                      <th>Static Heavy Ice (h)</th>
                      <th>Heavy-Ice Saved (h)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hindcast.rows?.map((r) => (
                      <tr key={r.date}>
                        <td>{r.date}</td>
                        <td>{r.forecast_aware?.hours} h</td>
                        <td>{r.static?.hours} h</td>
                        <td className="highlight">
                          {r.forecast_aware?.heavy_ice_hours} h
                        </td>
                        <td>{r.static?.heavy_ice_hours} h</td>
                        <td
                          className={
                            r.delta_heavy_hours >= 0 ? "pos" : "neg"
                          }
                        >
                          {r.delta_heavy_hours >= 0
                            ? `+${r.delta_heavy_hours}`
                            : r.delta_heavy_hours}{" "}
                          h
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {drawer === "about" && scenario && (
              <div className="dss-drawer-body">
                <p className="dss-drawer-lead">
                  <strong>Primary Satellite Record:</strong> {scenario.dataset}{" "}
                  (
                  <a href={scenario.doi} target="_blank" rel="noreferrer">
                    {scenario.doi}
                  </a>
                  )
                </p>
                <table className="dss-table">
                  <thead>
                    <tr>
                      <th>Subsystem</th>
                      <th>Category</th>
                      <th>Implementation &amp; Provenance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scenario.provenance?.map((p, idx) => (
                      <tr key={idx}>
                        <td className="highlight">{p.layer}</td>
                        <td className="mono">{p.badge}</td>
                        <td>{p.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="dss-disclaimer-box">{scenario.disclaimer}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
    </>
  );
}
