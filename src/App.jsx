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

  // Overlay toggles
  const [showIceContours, setShowIceContours] = useState(true);
  const [showIceVectors, setShowIceVectors] = useState(true);
  const [showIcebergs, setShowIcebergs] = useState(true);
  const [showRoutes, setShowRoutes] = useState(true);
  const [showStations, setShowStations] = useState(true);
  const [showGraticule, setShowGraticule] = useState(true);
  const [selectedTarget, setSelectedTarget] = useState(null);

  // Routing parameters
  const [leg, setLeg] = useState("ice_entry->bharati");
  const [forecastSource, setForecastSource] = useState("auto");
  const [wRisk, setWRisk] = useState(0.45);
  const [wTime, setWTime] = useState(1.0);
  const [shipPos, setShipPos] = useState(null);
  const [loadingRoute, setLoadingRoute] = useState(false);

  // Active drawer: null | "guide" | "ml" | "validation" | "hindcast" | "about"
  const [drawer, setDrawer] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);

  const mapContainerRef = useRef(null);
  const probeTextRef = useRef(null);
  const mapRef = useRef(null);
  const rasterLayerRef = useRef(null);
  const landLayerRef = useRef(null);
  const graticuleSourceRef = useRef(new VectorSource());
  const iceDynamicsSourceRef = useRef(new VectorSource());
  const routeSourceRef = useRef(new VectorSource());
  const icebergSourceRef = useRef(new VectorSource());
  const stationSourceRef = useRef(new VectorSource());
  const activeSliceRef = useRef(null);

  // Helper: Zoom / Pan map camera to real-world Antarctic sector presets
  function handleFocusMapSector(sector) {
    if (!mapRef.current || !scenario) return;
    const view = mapRef.current.getView();
    if (sector === "full") {
      view.fit(scenario.extent, { padding: [20, 20, 20, 20], duration: 350 });
      return;
    }
    if (sector === "prydz") {
      const [x1, y1] = proj4("EPSG:4326", "EPSG:3412", [56.0, -60.0]);
      const [x2, y2] = proj4("EPSG:4326", "EPSG:3412", [84.0, -71.5]);
      const ext = [
        Math.min(x1, x2),
        Math.min(y1, y2),
        Math.max(x1, x2),
        Math.max(y1, y2),
      ];
      view.fit(ext, { padding: [30, 30, 30, 30], duration: 350 });
      return;
    }
    if (sector === "maitri") {
      const [x1, y1] = proj4("EPSG:4326", "EPSG:3412", [2.0, -61.5]);
      const [x2, y2] = proj4("EPSG:4326", "EPSG:3412", [46.0, -72.5]);
      const ext = [
        Math.min(x1, x2),
        Math.min(y1, y2),
        Math.max(x1, x2),
        Math.max(y1, y2),
      ];
      view.fit(ext, { padding: [30, 30, 30, 30], duration: 350 });
      return;
    }
    if (sector === "ship" && routeData?.forecast_aware?.xy?.length) {
      const fcXy = routeData.forecast_aware.xy;
      const leadDay = Math.max(0, timelineStep);
      const idx = Math.min(
        fcXy.length - 1,
        Math.floor((leadDay / 7) * (fcXy.length - 1))
      );
      const [sx, sy] = fcXy[idx] || fcXy[0];
      view.animate({ center: [sx, sy], zoom: 3.4, duration: 350 });
    }
  }

  // 1. Load initial scenario, ML status, validation, hindcast, icebergs
  useEffect(() => {
    async function boot() {
      try {
        const sc = await getJSON("/api/scenario");
        setScenario(sc);
        setDate(sc.d0);

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
        maxZoom: 6,
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

    // Click to inspect any interactive feature (station, iceberg, ship, avoidance waypoint)
    map.on("singleclick", (evt) => {
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
      setSelectedTarget(hit);
    });

    mapRef.current = map;
  }, [scenario]);

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

  // 4. Plan route whenever date, leg, forecastSource, wRisk, wTime, or model epochs change
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
        goal: goalKey,
        from_row: shipPos ? shipPos.row : null,
        from_col: shipPos ? shipPos.col : null,
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
  }, [scenario, date, leg, forecastSource, wRisk, wTime, mlStatus?.model?.totalEpochs]);

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
  }, [scenario, showStations]);

  // 8. Update Calculated Ship Avoidance Path, Naive Climatology Hazard Path & Oriented Ship Marker
  useEffect(() => {
    const src = routeSourceRef.current;
    src.clear();
    if (!routeData || !showRoutes) return;

    // A. Naive Static Climatology Route (Planned without synoptic U-Net forecast)
    const stXy = routeData.static?.xy;
    const stMetrics = routeData.static?.metrics;
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
                width: 4.0,
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

    // B. Calculated Forecast-Aware Ship Avoidance Path (U-Net + A*)
    const fcXy = routeData.forecast_aware?.xy;
    const fcMetrics = routeData.forecast_aware?.metrics;
    const fcTelemetry = fcMetrics?.telemetry || [];
    if (fcXy && fcXy.length > 1) {
      // Outer dark casing + glowing laser-cyan core corridor
      const fcCaseFeat = new Feature({
        geometry: new LineString(fcXy),
      });
      fcCaseFeat.setStyle(
        new Style({
          stroke: new Stroke({
            color: "rgba(8, 51, 68, 0.9)",
            width: 6.5,
          }),
        })
      );
      src.addFeature(fcCaseFeat);

      const fcFeat = new Feature({
        geometry: new LineString(fcXy),
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
            color: "#06b6d4",
            width: 3.4,
          }),
        })
      );
      src.addFeature(fcFeat);

      // Draw directional course chevrons along the calculated avoidance path
      const stepStride = Math.max(4, Math.floor(fcXy.length / 8));
      for (let i = stepStride; i < fcXy.length - 3; i += stepStride) {
        const [x0, y0] = fcXy[i - 1];
        const [x1, y1] = fcXy[i];
        const dx = x1 - x0;
        const dy = y1 - y0;
        const segLen = Math.hypot(dx, dy);
        if (segLen < 1000) continue;
        const ux = dx / segLen;
        const uy = dy / segLen;
        const arm = 24000;
        const wx1 = x1 - ux * arm - uy * (arm * 0.58);
        const wy1 = y1 - uy * arm + ux * (arm * 0.58);
        const wx2 = x1 - ux * arm + uy * (arm * 0.58);
        const wy2 = y1 - uy * arm - ux * (arm * 0.58);

        const chevFeat = new Feature({
          geometry: new LineString([
            [wx1, wy1],
            [x1, y1],
            [wx2, wy2],
          ]),
        });
        chevFeat.setStyle(
          new Style({
            stroke: new Stroke({
              color: "#67e8f9",
              width: 2.2,
            }),
          })
        );
        src.addFeature(chevFeat);
      }

      // Plot Annotated Avoidance Waypoints (WP-1, WP-2, WP-3) along the calculated route
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
              font: "600 9px 'JetBrains Mono', monospace",
              fill: new Fill({ color: "#a5f3fc" }),
              stroke: new Stroke({ color: "#07090e", width: 3 }),
            }),
          })
        );
        src.addFeature(wpFeat);
      }

      // C. Oriented Vessel Hull Marker + Radar Range Ring + Heading Vector (RV POLAR EXPLORER)
      const leadDay = Math.max(0, timelineStep);
      const idx = Math.min(
        fcXy.length - 1,
        Math.floor((leadDay / 7) * (fcXy.length - 1))
      );
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

      // 1. Ship Radar / Safety Surveillance Ring (45 km radius)
      const radarRing = [];
      const radarR = 45000;
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
          fill: new Fill({ color: "rgba(6, 182, 212, 0.08)" }),
          stroke: new Stroke({
            color: "rgba(34, 211, 238, 0.55)",
            width: 1.2,
            lineDash: [4, 4],
          }),
        })
      );
      src.addFeature(radarFeat);

      // 2. Ship Velocity / Heading Leader Line
      const leaderFeat = new Feature({
        geometry: new LineString([
          shipCoord,
          [shipCoord[0] + ux * 85000, shipCoord[1] + uy * 85000],
        ]),
      });
      leaderFeat.setStyle(
        new Style({
          stroke: new Stroke({
            color: "#fbbf24",
            width: 2.0,
            lineDash: [4, 3],
          }),
        })
      );
      src.addFeature(leaderFeat);

      // 3. Oriented Icebreaker Ship Hull Polygon (Bow pointed along course heading)
      const hullLen = 42000;
      const hullBeam = 17000;
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
          stroke: new Stroke({ color: "#07090e", width: 2.2 }),
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
            radius: 3,
            fill: new Fill({ color: "#fef3c7" }),
          }),
          text: new TextStyle({
            text: `RV POLAR EXPLORER\nCOG ${tel.cog_deg}° · ${tel.speed_kmh} km/h · ${Math.round(
              tel.sic * 100
            )}% SIC`,
            offsetY: -22,
            font: "600 10px 'JetBrains Mono', monospace",
            fill: new Fill({ color: "#fde68a" }),
            stroke: new Stroke({ color: "#07090e", width: 3.4 }),
          }),
        })
      );
      src.addFeature(shipLabelFeat);
    }
  }, [routeData, showRoutes, timelineStep, scenario, wRisk]);

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

  return (
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

      {/* Main 3-Column Split Scientific Console */}
      <main className="dss-main">
        {/* Left Control & Parameter Column */}
        <aside className="dss-sidebar dss-left">
          <section className="dss-panel">
            <div className="dss-panel-head">
              <h2>01. Raster Field Selection</h2>
              <button
                type="button"
                className="dss-inline-help"
                onClick={() => {
                  setGuideTab("layers");
                  setDrawer("guide");
                }}
              >
                Explain layers
              </button>
            </div>
            <p className="dss-meta-line">
              <span>NSIDC G02202 V6</span>
              <span aria-hidden="true">·</span>
              <span>EPSG:3412</span>
              <span aria-hidden="true">·</span>
              <span>25 km</span>
            </p>

            <div className="dss-layer-list">
              {[
                {
                  id: "ml",
                  label: "U-Net 7-Day Forecast",
                  meta: "Model",
                },
                {
                  id: "obs",
                  label: "Observed Sea Ice (NSIDC)",
                  meta: "Satellite",
                },
                {
                  id: "residual",
                  label: "U-Net Residual |ΔSIC|",
                  meta: "Neural Δ",
                },
                {
                  id: "enc_grad",
                  label: "U-Net Encoder Ice-Edge",
                  meta: "Feature",
                },
                {
                  id: "b1",
                  label: "Seasonal Tendency (B1)",
                  meta: "Baseline",
                },
                {
                  id: "b0",
                  label: "Persistence (B0)",
                  meta: "Baseline",
                },
                {
                  id: "error",
                  label: "Absolute Error |ML − Obs|",
                  meta: "Derived",
                },
                {
                  id: "uncertainty",
                  label: "Validation Uncertainty σ",
                  meta: "Derived",
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
                  <span className="dss-radio-meta">{item.meta}</span>
                </label>
              ))}
            </div>
          </section>

          {/* Small U-Net Engine Telemetry */}
          <section className="dss-panel">
            <div className="dss-panel-head">
              <h2>02. Polar U-Net Engine</h2>
              <button
                type="button"
                className="dss-inline-help"
                onClick={() => {
                  setMlTab("architecture");
                  setDrawer("ml");
                }}
              >
                Inspect network
              </button>
            </div>
            <p className="dss-meta-line">
              <span>2-Level Residual ConvNet</span>
              <span aria-hidden="true">·</span>
              <span>10ch in → 7d out</span>
            </p>

            <div className="dss-metric-grid">
              <div className="dss-metric-cell">
                <span className="dss-metric-label">Input Tensor</span>
                <div className="dss-metric-val">
                  10×160×184
                </div>
              </div>
              <div className="dss-metric-cell">
                <span className="dss-metric-label">Forward Pass</span>
                <div className="dss-metric-val">
                  {forecast?.inference_ms ??
                    modelSummary?.lastInferenceMs ??
                    "4.2"}
                  <small>ms</small>
                </div>
              </div>
              <div className="dss-metric-cell">
                <span className="dss-metric-label">SGD Epochs</span>
                <div className="dss-metric-val">
                  {modelSummary?.totalEpochs ?? 8}
                  <small>ep</small>
                </div>
              </div>
              <div className="dss-metric-cell">
                <span className="dss-metric-label">Validation MAE</span>
                <div className="dss-metric-val accent">
                  {modelSummary?.trainingHistory?.length
                    ? (
                        modelSummary.trainingHistory[
                          modelSummary.trainingHistory.length - 1
                        ].valMae * 100
                      ).toFixed(2)
                    : "2.95"}
                  <small>%</small>
                </div>
              </div>
            </div>

            <div className="dss-action-row">
              <button
                type="button"
                className="dss-btn-primary"
                onClick={() => handleTrainModel(5, false)}
                disabled={isTraining}
              >
                {isTraining ? "Training SGD..." : "Train +5 Epochs"}
              </button>
              <button
                type="button"
                className="dss-btn-secondary"
                onClick={() => {
                  setMlTab("datasets");
                  setDrawer("ml");
                }}
              >
                Datasets
              </button>
            </div>
          </section>

          {/* Split-Screen Swipe & Vector Overlays */}
          <section className="dss-panel">
            <div className="dss-panel-head">
              <h2>03. Chart Layers &amp; Ice Prediction</h2>
            </div>

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
                <div className="dss-slider-labels">
                  <span>Observed ({swipeSplit}%)</span>
                  <span>U-Net ({100 - swipeSplit}%)</span>
                </div>
              </div>
            )}

            <label className="dss-check-row">
              <input
                type="checkbox"
                checked={showIceContours}
                onChange={(e) => setShowIceContours(e.target.checked)}
              />
              <span>Predicted 15% &amp; 40% Ice Contours</span>
              <span className="dss-radio-meta">U-Net</span>
            </label>

            <label className="dss-check-row">
              <input
                type="checkbox"
                checked={showIceVectors}
                onChange={(e) => setShowIceVectors(e.target.checked)}
              />
              <span>Predicted Sea-Ice Drift Vectors</span>
              <span className="dss-radio-meta">7d Motion</span>
            </label>

            <label className="dss-check-row">
              <input
                type="checkbox"
                checked={showRoutes}
                onChange={(e) => setShowRoutes(e.target.checked)}
              />
              <span>Ship Avoidance &amp; Baseline Paths</span>
              <span className="dss-radio-meta">Live A*</span>
            </label>

            <label className="dss-check-row">
              <input
                type="checkbox"
                checked={showIcebergs}
                onChange={(e) => setShowIcebergs(e.target.checked)}
              />
              <span>Tabular Bergs (D-28, B-22A, A-74)</span>
              <span className="dss-radio-meta">7d Cones</span>
            </label>

            <label className="dss-check-row">
              <input
                type="checkbox"
                checked={showStations}
                onChange={(e) => setShowStations(e.target.checked)}
              />
              <span>Antarctic Stations (6 Sites)</span>
              <span className="dss-radio-meta">Real Coords</span>
            </label>

            <label className="dss-check-row">
              <input
                type="checkbox"
                checked={showGraticule}
                onChange={(e) => setShowGraticule(e.target.checked)}
              />
              <span>Polar Graticule &amp; Seas/Shelves</span>
              <span className="dss-radio-meta">EPSG:3412</span>
            </label>
          </section>

          {/* Calibration Scale & Legend */}
          <section className="dss-panel dss-panel-last">
            <div className="dss-panel-head">
              <h2>04. Sea-Ice &amp; Navigation Legend</h2>
            </div>
            <div className="dss-colorbar-group">
              <div className="dss-colorbar-sic" />
              <div className="dss-colorbar-ticks">
                <span>0% Open</span>
                <span>15% Edge</span>
                <span>40% Heavy</span>
                <span>70% Limit</span>
              </div>
            </div>
            <div className="dss-legend-lines">
              <div>
                <span className="line-swatch cyan" /> Calculated ship avoidance path (A*)
              </div>
              <div>
                <span className="line-swatch dashed" /> Naive climatology path
              </div>
              <div>
                <span className="line-swatch rose" /> Heavy pack-ice trap (≥40% SIC)
              </div>
              <div>
                <span className="line-swatch sky-dashed" /> Predicted 15% ice-edge contour
              </div>
              <div>
                <span className="line-swatch amber" /> Tabular berg 7-day path + cone
              </div>
            </div>
          </section>
        </aside>

        {/* Center Polar Map Viewport */}
        <section className="dss-map-wrap">
          {/* Top Telemetry Ribbon over Map */}
          <div className="dss-telemetry-ribbon">
            <div className="dss-telemetry-item">
              <span className="dss-tel-key">FRAME</span>
              <span className="dss-tel-val">{currentTimelineLabel}</span>
            </div>
            <div className="dss-telemetry-item">
              <span className="dss-tel-key">VESSEL</span>
              <span className="dss-tel-val">
                {scenario?.ship?.name || "RV Polar Explorer"} · PC6 Limit 70% SIC
              </span>
            </div>
            <div className="dss-telemetry-item dss-telemetry-probe">
              <span className="dss-tel-key">PROBE</span>
              <span ref={probeTextRef} className="dss-tel-val">
                Hover polar grid for coordinates &amp; local SIC
              </span>
            </div>
          </div>

          {/* Floating Real-World Sector Camera Presets Bar */}
          <div className="dss-map-camera-bar" role="group" aria-label="Chart Sector Presets">
            <button
              type="button"
              onClick={() => handleFocusMapSector("full")}
              title="Reset view to full Indian Ocean & East Antarctica Sector (10°W–100°E)"
            >
              Full Sector
            </button>
            <button
              type="button"
              onClick={() => handleFocusMapSector("prydz")}
              title="Focus on Cooperation Sea, Prydz Bay & Bharati Station Approach"
            >
              Prydz Bay &amp; Bharati
            </button>
            <button
              type="button"
              onClick={() => handleFocusMapSector("maitri")}
              title="Focus on Cosmonaut Sea, Lazarev Sea & Maitri Station"
            >
              Maitri &amp; Maud Coast
            </button>
            <button
              type="button"
              onClick={() => handleFocusMapSector("ship")}
              title="Center camera on RV Polar Explorer along calculated avoidance path"
            >
              Focus Ship
            </button>
          </div>

          <div ref={mapContainerRef} className="dss-map" />

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

          {scenario?.gate && (
            <div className="dss-map-hud-bottom">
              <span
                className="dss-status-dot"
                data-status={scenario.gate.passed ? "nominal" : "warning"}
              />
              <span className="dss-status-tag">
                {scenario.gate.passed ? "VALIDATION GATE NOMINAL" : "FALLBACK"}
              </span>
              <span aria-hidden="true">·</span>
              <span>
                Click any station, berg, waypoint, or ship on chart to inspect
              </span>
            </div>
          )}
        </section>

        {/* Right Telemetry & Routing Evaluation Column */}
        <aside className="dss-sidebar dss-right">
          <section className="dss-panel">
            <div className="dss-panel-head">
              <h2>01. Route Planner Parameters</h2>
              <button
                type="button"
                className="dss-inline-help"
                onClick={() => {
                  setGuideTab("routing");
                  setDrawer("guide");
                }}
              >
                How A* works
              </button>
            </div>
            <p className="dss-meta-line">
              <span>Time-Dependent 8-Neighbor A*</span>
              <span aria-hidden="true">·</span>
              <span>25 km Grid</span>
            </p>

            <label className="dss-field">
              <span>Voyage Sector</span>
              <select
                value={leg}
                onChange={(e) => {
                  setShipPos(null);
                  setLeg(e.target.value);
                }}
              >
                <option value="ice_entry->bharati">
                  Ice Entry (56°S, 52.5°E) → Bharati Station
                </option>
                <option value="bharati->maitri">
                  Bharati Station → Maitri Station
                </option>
                <option value="ice_entry->maitri">
                  Ice Entry (56°S, 52.5°E) → Maitri Station
                </option>
              </select>
            </label>

            <label className="dss-field">
              <span>Planning Forecast Field</span>
              <select
                value={forecastSource}
                onChange={(e) => setForecastSource(e.target.value)}
              >
                <option value="auto">Auto (Validation Gate Winner: U-Net)</option>
                <option value="unet">Polar U-Net (7-Day Residual Forecast)</option>
                <option value="b1">Seasonal Tendency Baseline (B1)</option>
                <option value="clim">Static Historical Climatology</option>
              </select>
            </label>

            <div className="dss-slider-block">
              <div className="dss-slider-title">
                <span>Ice-Risk Penalty Weight (λ)</span>
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

            <div className="dss-slider-block">
              <div className="dss-slider-title">
                <span>Transit Time Priority Weight</span>
                <strong className="mono">{wTime.toFixed(2)}</strong>
              </div>
              <input
                type="range"
                min={0.5}
                max={2.0}
                step={0.1}
                value={wTime}
                onChange={(e) => setWTime(Number(e.target.value))}
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
            {shipPos && (
              <p className="dss-pos-note">
                Vessel position: cell ({shipPos.row}, {shipPos.col}) · Replanned
                from updated daily satellite observation.
              </p>
            )}
          </section>

          {/* Counterfactual Evaluation Scored on Real Observed Ice */}
          <section className="dss-panel">
            <div className="dss-panel-head">
              <h2>02. Counterfactual Evaluation</h2>
            </div>
            <p className="dss-meta-line">
              <span>Both routes scored post-hoc on observed NSIDC SIC</span>
            </p>

            {fcMetrics?.ok && stMetrics?.ok ? (
              <>
                <div className="dss-metric-grid dss-metric-highlight">
                  <div className="dss-metric-cell">
                    <span className="dss-metric-label">Heavy-Ice Exposure Saved</span>
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
                    <span className="dss-metric-label">Transit Duration Delta</span>
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
                    <span className="cyan-text">Forecast A*</span>
                    <span className="muted-text">Climatology</span>
                  </div>
                  <div className="dss-rc-row">
                    <span>Transit Duration</span>
                    <strong className="mono">{fcMetrics.hours} h</strong>
                    <span className="mono">{stMetrics.hours} h</span>
                  </div>
                  <div className="dss-rc-row">
                    <span>Track Distance</span>
                    <strong className="mono">{fcMetrics.distance_km} km</strong>
                    <span className="mono">{stMetrics.distance_km} km</span>
                  </div>
                  <div className="dss-rc-row">
                    <span>Heavy Ice (≥40% SIC)</span>
                    <strong className="mono accent">
                      {fcMetrics.heavy_ice_hours} h
                    </strong>
                    <span className="mono">{stMetrics.heavy_ice_hours} h</span>
                  </div>
                  <div className="dss-rc-row">
                    <span>Fuel Resistance Proxy</span>
                    <strong className="mono">{fcMetrics.fuel_proxy}</strong>
                    <span className="mono">{stMetrics.fuel_proxy}</span>
                  </div>
                  <div className="dss-rc-row">
                    <span>Peak / Mean SIC</span>
                    <strong className="mono">
                      {Math.round(fcMetrics.max_sic * 100)}% /{" "}
                      {Math.round(fcMetrics.mean_sic * 100)}%
                    </strong>
                    <span className="mono">
                      {Math.round(stMetrics.max_sic * 100)}% /{" "}
                      {Math.round(stMetrics.mean_sic * 100)}%
                    </span>
                  </div>
                </div>
              </>
            ) : (
              <p className="dss-meta-line">Computing route metrics...</p>
            )}
          </section>

          {/* 03. Calculated Ship Avoidance Waypoints Log */}
          {fcMetrics?.waypoints?.length > 0 && (
            <section className="dss-panel">
              <div className="dss-panel-head">
                <h2>03. Ship Avoidance Waypoint Log</h2>
              </div>
              <p className="dss-meta-line">
                <span>Calculated A* course bypassing bergs &amp; ≥40% pack</span>
              </p>
              <div className="dss-wp-list">
                {fcMetrics.waypoints.map((wp) => (
                  <div
                    key={wp.code}
                    className="dss-wp-row"
                    onClick={() => {
                      if (mapRef.current) {
                        mapRef.current
                          .getView()
                          .animate({ center: [wp.x_m, wp.y_m], duration: 300 });
                      }
                    }}
                  >
                    <div className="dss-wp-main">
                      <strong>{wp.label}</strong>
                      <span className="mono">
                        {Math.abs(wp.lat).toFixed(1)}°S, {Math.abs(wp.lon).toFixed(1)}°E · COG{" "}
                        {wp.cog_deg}°
                      </span>
                    </div>
                    <div className="dss-wp-right mono">
                      <span>T+{Math.round(wp.hour)}h</span>
                      <small>{Math.round(wp.sic * 100)}% SIC</small>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {scenario?.hindcast_summary && (
            <section className="dss-panel dss-panel-last">
              <div className="dss-panel-head">
                <h2>04. Multi-Date Hindcast Benchmark</h2>
                <button
                  type="button"
                  className="dss-inline-help"
                  onClick={() => setDrawer("hindcast")}
                >
                  Full table
                </button>
              </div>
              <p className="dss-meta-line">
                <span>{scenario.hindcast_summary.n} Departures</span>
                <span aria-hidden="true">·</span>
                <span>Ice Entry → Bharati</span>
              </p>
              <div className="dss-metric-grid">
                <div className="dss-metric-cell">
                  <span className="dss-metric-label">Mean Heavy Ice (U-Net)</span>
                  <div className="dss-metric-val">
                    {scenario.hindcast_summary.mean_heavy_hours_forecast}
                    <small>h</small>
                  </div>
                </div>
                <div className="dss-metric-cell">
                  <span className="dss-metric-label">Mean Heavy Ice (Static)</span>
                  <div className="dss-metric-val">
                    {scenario.hindcast_summary.mean_heavy_hours_static}
                    <small>h</small>
                  </div>
                </div>
                <div className="dss-metric-cell">
                  <span className="dss-metric-label">Mean Heavy-Ice Saved</span>
                  <div className="dss-metric-val pos">
                    +{scenario.hindcast_summary.mean_heavy_hours_saved}
                    <small>h</small>
                  </div>
                </div>
                <div className="dss-metric-cell">
                  <span className="dss-metric-label">Mean Transit Saved</span>
                  <div className="dss-metric-val pos">
                    +{scenario.hindcast_summary.mean_hours_saved}
                    <small>h</small>
                  </div>
                </div>
              </div>
            </section>
          )}
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
  );
}
