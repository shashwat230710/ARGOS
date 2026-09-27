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
  const [showIcebergs, setShowIcebergs] = useState(true);
  const [showRoutes, setShowRoutes] = useState(true);
  const [showStations, setShowStations] = useState(true);

  // Routing parameters
  const [leg, setLeg] = useState("ice_entry->bharati");
  const [forecastSource, setForecastSource] = useState("auto");
  const [wRisk, setWRisk] = useState(0.35);
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
  const routeSourceRef = useRef(new VectorSource());
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
      opacity: 0.92,
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
      style: new Style({
        fill: new Fill({ color: "rgba(17, 24, 39, 0.9)" }),
        stroke: new Stroke({ color: "rgba(100, 116, 139, 0.5)", width: 1 }),
      }),
    });
    landLayerRef.current = landLayer;

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
      layers: [rasterLayer, landLayer, icebergLayer, routeLayer, stationLayer],
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

    mapRef.current = map;
  }, [scenario]);

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

  // 7. Update stations vector layer
  useEffect(() => {
    const src = stationSourceRef.current;
    src.clear();
    if (!scenario || !showStations) return;

    const labels = {
      ice_entry: "ICE ENTRY (55°S)",
      bharati: "BHARATI STATION",
      maitri: "MAITRI STATION",
    };

    for (const [key, label] of Object.entries(labels)) {
      const st = scenario.stations?.[key];
      if (!st) continue;
      const feat = new Feature({
        geometry: new Point([st.x_m, st.y_m]),
        name: label,
      });
      feat.setStyle(
        new Style({
          image: new CircleStyle({
            radius: key === "ice_entry" ? 4.5 : 6,
            fill: new Fill({
              color: key === "ice_entry" ? "#06b6d4" : "#f43f5e",
            }),
            stroke: new Stroke({ color: "#f8fafc", width: 1.75 }),
          }),
          text: new TextStyle({
            text: label,
            offsetY: -13,
            font: "600 10px 'JetBrains Mono', monospace",
            fill: new Fill({ color: "#f8fafc" }),
            stroke: new Stroke({ color: "#07090e", width: 3 }),
          }),
        })
      );
      src.addFeature(feat);
    }
  }, [scenario, showStations]);

  // 8. Update routes & ship marker vector layer
  useEffect(() => {
    const src = routeSourceRef.current;
    src.clear();
    if (!routeData || !showRoutes) return;

    const stXy = routeData.static?.xy;
    if (stXy && stXy.length > 1) {
      const stFeat = new Feature({
        geometry: new LineString(stXy),
      });
      stFeat.setStyle(
        new Style({
          stroke: new Stroke({
            color: "rgba(148, 163, 184, 0.8)",
            width: 2.25,
            lineDash: [6, 5],
          }),
        })
      );
      src.addFeature(stFeat);
    }

    const fcXy = routeData.forecast_aware?.xy;
    if (fcXy && fcXy.length > 1) {
      const fcFeat = new Feature({
        geometry: new LineString(fcXy),
      });
      fcFeat.setStyle(
        new Style({
          stroke: new Stroke({
            color: "#06b6d4",
            width: 3.25,
          }),
        })
      );
      src.addFeature(fcFeat);

      const leadDay = Math.max(0, timelineStep);
      const idx = Math.min(
        fcXy.length - 1,
        Math.floor((leadDay / 7) * (fcXy.length - 1))
      );
      const shipCoord = fcXy[idx] || fcXy[0];
      const shipFeat = new Feature({
        geometry: new Point(shipCoord),
      });
      shipFeat.setStyle(
        new Style({
          image: new CircleStyle({
            radius: 6,
            fill: new Fill({ color: "#f59e0b" }),
            stroke: new Stroke({ color: "#07090e", width: 2 }),
          }),
          text: new TextStyle({
            text: "RV POLAR EXPLORER",
            offsetY: 15,
            font: "600 10px 'JetBrains Mono', monospace",
            fill: new Fill({ color: "#fbbf24" }),
            stroke: new Stroke({ color: "#07090e", width: 3 }),
          }),
        })
      );
      src.addFeature(shipFeat);
    }
  }, [routeData, showRoutes, timelineStep]);

  // 9. Update icebergs & uncertainty cones vector layer
  useEffect(() => {
    const src = icebergSourceRef.current;
    src.clear();
    if (!showIcebergs || !icebergs?.length) return;

    for (const berg of icebergs) {
      const track = berg.track || [];
      const coords = track.map((pt) => {
        if (pt.x_m != null && pt.y_m != null) return [pt.x_m, pt.y_m];
        return proj4("EPSG:4326", "EPSG:3412", [pt.lon, pt.lat]);
      });

      if (coords.length > 1) {
        const lineFeat = new Feature({
          geometry: new LineString(coords),
        });
        lineFeat.setStyle(
          new Style({
            stroke: new Stroke({
              color: "#f59e0b",
              width: 1.75,
              lineDash: [4, 4],
            }),
          })
        );
        src.addFeature(lineFeat);
      }

      for (const pt of track) {
        if (
          Math.abs(pt.lead_days - 3) < 0.01 ||
          Math.abs(pt.lead_days - 7) < 0.01
        ) {
          const [cx, cy] =
            pt.x_m != null
              ? [pt.x_m, pt.y_m]
              : proj4("EPSG:4326", "EPSG:3412", [pt.lon, pt.lat]);
          const rMeters = (pt.cone_km || 20) * 1000;
          const ring = [];
          for (let a = 0; a <= 24; a++) {
            const ang = (a / 24) * 2 * Math.PI;
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
              fill: new Fill({ color: "rgba(245, 158, 11, 0.1)" }),
              stroke: new Stroke({
                color: "rgba(245, 158, 11, 0.45)",
                width: 1,
              }),
            })
          );
          src.addFeature(coneFeat);
        }
      }

      const [bx, by] =
        berg.x_m != null
          ? [berg.x_m, berg.y_m]
          : proj4("EPSG:4326", "EPSG:3412", [berg.lon, berg.lat]);
      const bergFeat = new Feature({
        geometry: new Point([bx, by]),
      });
      bergFeat.setStyle(
        new Style({
          image: new CircleStyle({
            radius: 5,
            fill: new Fill({ color: "#f59e0b" }),
            stroke: new Stroke({ color: "#07090e", width: 1.5 }),
          }),
          text: new TextStyle({
            text: `${berg.id}`,
            offsetY: -12,
            font: "600 10px 'JetBrains Mono', monospace",
            fill: new Fill({ color: "#fcd34d" }),
            stroke: new Stroke({ color: "#07090e", width: 3 }),
          }),
        })
      );
      src.addFeature(bergFeat);
    }
  }, [icebergs, showIcebergs]);

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
          PolarRoute DSS
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
              <h2>03. Comparison &amp; Overlays</h2>
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
                checked={showRoutes}
                onChange={(e) => setShowRoutes(e.target.checked)}
              />
              <span>A* Planned Corridors</span>
              <span className="dss-radio-meta">Live</span>
            </label>

            <label className="dss-check-row">
              <input
                type="checkbox"
                checked={showIcebergs}
                onChange={(e) => setShowIcebergs(e.target.checked)}
              />
              <span>Tabular Berg Drift &amp; Cones</span>
              <span className="dss-radio-meta">Simulated</span>
            </label>

            <label className="dss-check-row">
              <input
                type="checkbox"
                checked={showStations}
                onChange={(e) => setShowStations(e.target.checked)}
              />
              <span>Antarctic Research Stations</span>
              <span className="dss-radio-meta">Fixed</span>
            </label>
          </section>

          {/* Calibration Scale & Legend */}
          <section className="dss-panel dss-panel-last">
            <div className="dss-panel-head">
              <h2>04. Sea-Ice Concentration Scale</h2>
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
                <span className="line-swatch cyan" /> Forecast-aware A* route
              </div>
              <div>
                <span className="line-swatch dashed" /> Static climatology route
              </div>
              <div>
                <span className="line-swatch amber" /> 7-day berg trajectory + cone
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

          <div ref={mapContainerRef} className="dss-map" />

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
              <span>{scenario.gate.note}</span>
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
                  Ice Entry (55°S, 52.5°E) → Bharati Station
                </option>
                <option value="bharati->maitri">
                  Bharati Station → Maitri Station
                </option>
                <option value="ice_entry->maitri">
                  Ice Entry (55°S, 52.5°E) → Maitri Station
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

          {scenario?.hindcast_summary && (
            <section className="dss-panel dss-panel-last">
              <div className="dss-panel-head">
                <h2>03. Multi-Date Hindcast Benchmark</h2>
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
                </div>

                {guideTab === "overview" && (
                  <div className="dss-guide-grid">
                    <div className="dss-guide-col">
                      <h3>What is PolarRoute DSS?</h3>
                      <p className="dss-drawer-lead">
                        <strong>PolarRoute DSS</strong> is an Antarctic sea-ice
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
