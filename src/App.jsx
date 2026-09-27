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

const BADGE_COLORS = {
  REAL: "#10b981",
  MODEL: "#3b82f6",
  DERIVED: "#6366f1",
  SIMULATED: "#f59e0b",
  LIVE: "#06b6d4",
  PROXY: "#f97316",
  ILLUSTRATIVE: "#a855f7",
  BASELINE: "#64748b",
};

export default function App() {
  const [scenario, setScenario] = useState(null);
  const [date, setDate] = useState("2023-01-10");
  const [forecast, setForecast] = useState(null);
  const [uncertaintyGrid, setUncertaintyGrid] = useState(null);
  const [routeData, setRouteData] = useState(null);
  const [icebergs, setIcebergs] = useState([]);
  const [validation, setValidation] = useState(null);
  const [hindcast, setHindcast] = useState(null);

  // Layer & Timeline controls
  const [activeLayer, setActiveLayer] = useState("ml"); // obs | ml | b1 | b0 | error | uncertainty
  const [swipeEnabled, setSwipeEnabled] = useState(false);
  const [swipeSplit, setSwipeSplit] = useState(50);
  const [leadIdx, setLeadIdx] = useState(0); // -6..0 (history) or 1..7 (forecast leads, mapped to 0..6)
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
  const [shipPos, setShipPos] = useState(null); // { row, col, stepIndex }
  const [loadingRoute, setLoadingRoute] = useState(false);

  // Active drawer: null | "validation" | "hindcast" | "about"
  const [drawer, setDrawer] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);

  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const rasterLayerRef = useRef(null);
  const landLayerRef = useRef(null);
  const routeSourceRef = useRef(new VectorSource());
  const icebergSourceRef = useRef(new VectorSource());
  const stationSourceRef = useRef(new VectorSource());

  // 1. Load initial scenario, validation, hindcast, icebergs
  useEffect(() => {
    async function boot() {
      try {
        const sc = await getJSON("/api/scenario");
        setScenario(sc);
        setDate(sc.d0);

        const [bergsRes, valRes, hcRes] = await Promise.all([
          getJSON("/api/icebergs?day_offset=0"),
          getJSON("/api/validation").catch(() => null),
          getJSON("/api/hindcast").catch(() => null),
        ]);
        if (bergsRes?.bergs) setIcebergs(bergsRes.bergs);
        if (valRes) setValidation(valRes);
        if (hcRes) setHindcast(hcRes);
      } catch (err) {
        setErrorMsg(err.message || "Failed to load scenario");
      }
    }
    boot();
  }, []);

  // 2. Initialize OpenLayers polar-stereographic map once scenario is loaded
  useEffect(() => {
    if (!scenario || !mapContainerRef.current || mapRef.current) return;

    const extent = scenario.extent; // [xmin, ymin, xmax, ymax]
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
        fill: new Fill({ color: "rgba(22, 34, 47, 0.85)" }),
        stroke: new Stroke({ color: "rgba(100, 145, 180, 0.45)", width: 1 }),
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
        zoom: 2,
        minZoom: 1,
        maxZoom: 7,
      }),
    });

    map.getView().fit(extent, { padding: [24, 24, 24, 24] });
    mapRef.current = map;
  }, [scenario]);

  // 3. Load forecast and uncertainty whenever `date` changes
  useEffect(() => {
    if (!scenario || !date) return;
    let cancelled = false;
    async function fetchForecast() {
      try {
        const [fcRaw, uncRaw] = await Promise.all([
          getJSON(`/api/forecast/${date}`),
          getJSON(`/api/grid?date=${date}&lead=${Math.max(0, timelineStep - 1)}&layer=uncertainty`),
        ]);
        if (cancelled) return;
        const unpacked = {
          ...fcRaw,
          history: unpack(fcRaw.history),
          last: unpack(fcRaw.last),
          ml: unpack(fcRaw.ml),
          b0: unpack(fcRaw.b0),
          b1: unpack(fcRaw.b1),
          obs: unpack(fcRaw.obs),
          land: unpack(fcRaw.land),
        };
        setForecast(unpacked);
        if (uncRaw?.grid) {
          setUncertaintyGrid(unpack(uncRaw.grid));
        }
      } catch (err) {
        if (!cancelled) setErrorMsg(err.message);
      }
    }
    fetchForecast();
    return () => {
      cancelled = true;
    };
  }, [scenario, date]);

  // Update uncertainty slice if user scrubs lead day while on uncertainty layer
  useEffect(() => {
    if (!scenario || !date || activeLayer !== "uncertainty") return;
    const lead = Math.max(0, Math.min(6, timelineStep - 1));
    getJSON(`/api/grid?date=${date}&lead=${lead}&layer=uncertainty`)
      .then((res) => {
        if (res?.grid) setUncertaintyGrid(unpack(res.grid));
      })
      .catch(() => {});
  }, [scenario, date, timelineStep, activeLayer]);

  // 4. Plan route whenever date, leg, forecastSource, wRisk, or wTime changes
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
  }, [scenario, date, leg, forecastSource, wRisk, wTime]);

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
      if (timelineStep <= 0 && layerName !== "uncertainty") {
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
      if (layerName === "uncertainty" && uncertaintyGrid) {
        return { slice: uncertaintyGrid, mode: "error" };
      }
      return { slice: sliceLead(forecast.ml, lead), mode: "sic" };
    }

    const canvas = document.createElement("canvas");
    if (!swipeEnabled) {
      const { slice, mode } = getSliceForLayer(activeLayer);
      paintGrid(canvas, slice, mode, forecast.land);
    } else {
      // Left side: Observed SIC, Right side: ML Forecast
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
      ctx.fillStyle = "#38bdf8";
      ctx.fillRect(Math.max(0, splitX - 1), 0, 1.5, H);
    }

    // Draw 15% ice-edge contour pixels subtly on SIC mode
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
      ice_entry: "Ice Entry (55°S)",
      bharati: "Bharati Station",
      maitri: "Maitri Station",
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
            radius: key === "ice_entry" ? 5 : 6.5,
            fill: new Fill({
              color: key === "ice_entry" ? "#38bdf8" : "#f43f5e",
            }),
            stroke: new Stroke({ color: "#ffffff", width: 2 }),
          }),
          text: new TextStyle({
            text: label,
            offsetY: -14,
            font: "600 12px Inter, system-ui, sans-serif",
            fill: new Fill({ color: "#f8fafc" }),
            stroke: new Stroke({ color: "#09111e", width: 3 }),
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

    // Static climatology route (grey dashed)
    const stXy = routeData.static?.xy;
    if (stXy && stXy.length > 1) {
      const stFeat = new Feature({
        geometry: new LineString(stXy),
      });
      stFeat.setStyle(
        new Style({
          stroke: new Stroke({
            color: "rgba(148, 163, 184, 0.85)",
            width: 2.5,
            lineDash: [7, 6],
          }),
        })
      );
      src.addFeature(stFeat);
    }

    // Forecast-aware route (bright cyan solid)
    const fcXy = routeData.forecast_aware?.xy;
    if (fcXy && fcXy.length > 1) {
      const fcFeat = new Feature({
        geometry: new LineString(fcXy),
      });
      fcFeat.setStyle(
        new Style({
          stroke: new Stroke({
            color: "#00f0ff",
            width: 3.5,
          }),
        })
      );
      src.addFeature(fcFeat);

      // Ship position marker along forecast route
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
            radius: 7,
            fill: new Fill({ color: "#facc15" }),
            stroke: new Stroke({ color: "#09111e", width: 2.5 }),
          }),
          text: new TextStyle({
            text: "▲ RV Polar Explorer",
            offsetY: 16,
            font: "700 11px Inter, system-ui, sans-serif",
            fill: new Fill({ color: "#fde047" }),
            stroke: new Stroke({ color: "#09111e", width: 3 }),
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
              color: "#fb923c",
              width: 2,
              lineDash: [4, 4],
            }),
          })
        );
        src.addFeature(lineFeat);
      }

      // Uncertainty cones at Day 3 and Day 7
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
              fill: new Fill({ color: "rgba(251, 146, 60, 0.14)" }),
              stroke: new Stroke({
                color: "rgba(251, 146, 60, 0.55)",
                width: 1,
              }),
            })
          );
          src.addFeature(coneFeat);
        }
      }

      // Current berg position
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
            radius: 5.5,
            fill: new Fill({ color: "#f97316" }),
            stroke: new Stroke({ color: "#fff7ed", width: 1.8 }),
          }),
          text: new TextStyle({
            text: `${berg.id}`,
            offsetY: -12,
            font: "600 11px Inter, system-ui, sans-serif",
            fill: new Fill({ color: "#fed7aa" }),
            stroke: new Stroke({ color: "#09111e", width: 3 }),
          }),
        })
      );
      src.addFeature(bergFeat);
    }
  }, [icebergs, showIcebergs]);

  // Handler: Advance 1 day along planned route
  async function handleAdvanceDay() {
    if (!routeData?.forecast_aware?.path?.length) return;
    const path = routeData.forecast_aware.path;
    // Move ~8 cells (~1 day of sailing) forward along the planned path
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
        ? `D0 (${d}) · Last Observed`
        : `D${timelineStep} (${d}) · Observed Input`;
    }
    const idx = Math.max(0, Math.min(6, timelineStep - 1));
    const d = forecast.forecast_dates?.[idx] || "";
    return `Lead +${timelineStep}d (${d})`;
  }, [forecast, timelineStep, date]);

  return (
    <div className="dss-shell">
      {/* Top Header */}
      <header className="dss-header">
        <div className="dss-brand">
          <span className="dss-logo">❄</span>
          <div>
            <h1>{scenario?.title || "PolarRoute DSS"}</h1>
            <p className="dss-subtitle">
              {scenario?.subtitle ||
                "Cape Town → Bharati → Maitri · hindcast replay"}
            </p>
          </div>
        </div>

        <div className="dss-header-controls">
          <label className="dss-field-inline">
            <span>Departure (D0):</span>
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

          <div className="dss-ship-chip">
            <span>🚢 {scenario?.ship?.name || "RV Polar Explorer"}</span>
            <small>{scenario?.ship?.klass || "PC6-like"}</small>
          </div>

          <div className="dss-drawer-btns">
            <button
              className={drawer === "validation" ? "active" : ""}
              onClick={() =>
                setDrawer(drawer === "validation" ? null : "validation")
              }
            >
              Validation & Skill
            </button>
            <button
              className={drawer === "hindcast" ? "active" : ""}
              onClick={() =>
                setDrawer(drawer === "hindcast" ? null : "hindcast")
              }
            >
              Hindcast Table
            </button>
            <button
              className={drawer === "about" ? "active" : ""}
              onClick={() => setDrawer(drawer === "about" ? null : "about")}
            >
              Provenance
            </button>
          </div>
        </div>
      </header>

      {errorMsg && (
        <div className="dss-toast-error">
          <span>{errorMsg}</span>
          <button onClick={() => setErrorMsg(null)}>✕</button>
        </div>
      )}

      {/* Main 3-Column Grid */}
      <main className="dss-main">
        {/* Left Sidebar: Layers & Provenance */}
        <aside className="dss-sidebar dss-left">
          <section className="dss-card">
            <div className="dss-card-header">
              <h2>Ice Raster Layer</h2>
              <span
                className="dss-badge"
                style={{
                  backgroundColor:
                    BADGE_COLORS[
                      activeLayer === "obs"
                        ? "REAL"
                        : activeLayer === "ml"
                        ? "MODEL"
                        : activeLayer === "error" ||
                          activeLayer === "uncertainty"
                        ? "DERIVED"
                        : "BASELINE"
                    ],
                }}
              >
                {activeLayer === "obs"
                  ? "REAL"
                  : activeLayer === "ml"
                  ? "MODEL"
                  : activeLayer === "error" || activeLayer === "uncertainty"
                  ? "DERIVED"
                  : "BASELINE"}
              </span>
            </div>

            <div className="dss-layer-list">
              {[
                { id: "ml", label: "U-Net Forecast (ML)", badge: "MODEL" },
                { id: "obs", label: "Observed SIC (NSIDC)", badge: "REAL" },
                {
                  id: "b1",
                  label: "Seasonal Tendency (B1)",
                  badge: "BASELINE",
                },
                { id: "b0", label: "Persistence (B0)", badge: "BASELINE" },
                {
                  id: "error",
                  label: "Forecast Error |ML − Obs|",
                  badge: "DERIVED",
                },
                {
                  id: "uncertainty",
                  label: "Validation Uncertainty",
                  badge: "DERIVED",
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
                  <span>{item.label}</span>
                  <em
                    className="dss-mini-badge"
                    style={{ color: BADGE_COLORS[item.badge] }}
                  >
                    {item.badge}
                  </em>
                </label>
              ))}
            </div>
          </section>

          <section className="dss-card">
            <div className="dss-card-header">
              <h2>Obs vs Forecast Swipe</h2>
            </div>
            <label className="dss-check-row">
              <input
                type="checkbox"
                checked={swipeEnabled}
                onChange={(e) => setSwipeEnabled(e.target.checked)}
              />
              <span>Compare Observed (Left) | U-Net (Right)</span>
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
          </section>

          <section className="dss-card">
            <div className="dss-card-header">
              <h2>Map Overlays</h2>
            </div>
            <label className="dss-check-row">
              <input
                type="checkbox"
                checked={showRoutes}
                onChange={(e) => setShowRoutes(e.target.checked)}
              />
              <span>Planned Routes (Forecast vs Static)</span>
              <em
                className="dss-mini-badge"
                style={{ color: BADGE_COLORS.LIVE }}
              >
                LIVE
              </em>
            </label>
            <label className="dss-check-row">
              <input
                type="checkbox"
                checked={showIcebergs}
                onChange={(e) => setShowIcebergs(e.target.checked)}
              />
              <span>Iceberg Drift + Uncertainty Cones</span>
              <em
                className="dss-mini-badge"
                style={{ color: BADGE_COLORS.SIMULATED }}
              >
                SIMULATED
              </em>
            </label>
            <label className="dss-check-row">
              <input
                type="checkbox"
                checked={showStations}
                onChange={(e) => setShowStations(e.target.checked)}
              />
              <span>Antarctic Stations (Bharati, Maitri)</span>
              <em
                className="dss-mini-badge"
                style={{ color: BADGE_COLORS.REAL }}
              >
                REAL
              </em>
            </label>
          </section>

          <section className="dss-card">
            <div className="dss-card-header">
              <h2>Colormap & Legend</h2>
            </div>
            <div className="dss-colorbar-group">
              <div className="dss-colorbar-sic" />
              <div className="dss-colorbar-ticks">
                <span>0% (Open)</span>
                <span>15% (Edge)</span>
                <span>40% (Heavy)</span>
                <span>70%+ (Max)</span>
              </div>
            </div>
            <div className="dss-legend-lines">
              <div>
                <span className="line-swatch cyan" /> Forecast-aware route (A*)
              </div>
              <div>
                <span className="line-swatch dashed" /> Static climatology route
              </div>
              <div>
                <span className="line-swatch orange" /> Iceberg 7-day drift + cone
              </div>
            </div>
          </section>
        </aside>

        {/* Center Map Viewport */}
        <section className="dss-map-wrap">
          <div ref={mapContainerRef} className="dss-map" />

          <div className="dss-map-hud-top">
            <div className="dss-hud-pill">
              <strong>Projection:</strong> EPSG:3412 (NSIDC South Polar
              Stereographic · 25 km grid)
            </div>
            <div className="dss-hud-pill">
              <strong>Frame:</strong> {currentTimelineLabel}
            </div>
          </div>

          {scenario?.gate && (
            <div className="dss-map-hud-bottom">
              <span
                className="dss-gate-dot"
                style={{
                  background: scenario.gate.passed ? "#10b981" : "#f59e0b",
                }}
              />
              <span>{scenario.gate.note}</span>
            </div>
          )}
        </section>

        {/* Right Sidebar: Live Routing & Counterfactual Scoring */}
        <aside className="dss-sidebar dss-right">
          <section className="dss-card">
            <div className="dss-card-header">
              <h2>Voyage & Cost Weights</h2>
              <span
                className="dss-badge"
                style={{ backgroundColor: BADGE_COLORS.LIVE }}
              >
                LIVE A*
              </span>
            </div>

            <label className="dss-field">
              <span>Voyage Leg</span>
              <select
                value={leg}
                onChange={(e) => {
                  setShipPos(null);
                  setLeg(e.target.value);
                }}
              >
                <option value="ice_entry->bharati">
                  Ice Entry (55°S) → Bharati Station
                </option>
                <option value="bharati->maitri">
                  Bharati Station → Maitri Station
                </option>
                <option value="ice_entry->maitri">
                  Ice Entry (55°S) → Maitri Station
                </option>
              </select>
            </label>

            <label className="dss-field">
              <span>Forecast Source</span>
              <select
                value={forecastSource}
                onChange={(e) => setForecastSource(e.target.value)}
              >
                <option value="auto">Auto (Gate Winner: U-Net)</option>
                <option value="unet">Small U-Net (7-day residual)</option>
                <option value="b1">Seasonal Tendency Baseline (B1)</option>
                <option value="clim">Static Climatology</option>
              </select>
            </label>

            <div className="dss-slider-block">
              <div className="dss-slider-title">
                <span>Safety / Ice-Risk Weight (λ)</span>
                <strong>{wRisk.toFixed(2)}</strong>
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
                <span>Time Priority Weight</span>
                <strong>{wTime.toFixed(2)}</strong>
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
                className="dss-btn-primary"
                onClick={handleAdvanceDay}
                disabled={loadingRoute}
              >
                {loadingRoute ? "Replanning..." : "Advance Day +1 ▶"}
              </button>
              {shipPos && (
                <button
                  className="dss-btn-secondary"
                  onClick={handleResetVoyage}
                >
                  Reset
                </button>
              )}
            </div>
            {shipPos && (
              <p className="dss-pos-note">
                Ship underway at grid cell ({shipPos.row}, {shipPos.col}) —
                route replanned live from latest observation.
              </p>
            )}
          </section>

          {/* Route Comparison Scored on Observed Ice */}
          <section className="dss-card">
            <div className="dss-card-header">
              <h2>Scored on Observed Ice</h2>
              <span
                className="dss-badge"
                style={{ backgroundColor: BADGE_COLORS.REAL }}
              >
                COUNTERFACTUAL
              </span>
            </div>

            {fcMetrics?.ok && stMetrics?.ok ? (
              <>
                <div className="dss-delta-banner">
                  <div>
                    <small>Heavy-Ice Hours Saved</small>
                    <strong
                      className={
                        stMetrics.heavy_ice_hours - fcMetrics.heavy_ice_hours >=
                        0
                          ? "pos"
                          : "neg"
                      }
                    >
                      {(
                        stMetrics.heavy_ice_hours - fcMetrics.heavy_ice_hours
                      ).toFixed(1)}{" "}
                      h
                    </strong>
                  </div>
                  <div>
                    <small>Total Voyage Time Saved</small>
                    <strong
                      className={
                        stMetrics.hours - fcMetrics.hours >= 0 ? "pos" : "neg"
                      }
                    >
                      {(stMetrics.hours - fcMetrics.hours).toFixed(1)} h
                    </strong>
                  </div>
                </div>

                <div className="dss-route-compare">
                  <div className="dss-route-box cyan">
                    <h3>Forecast-Aware Route</h3>
                    <div className="dss-stat-grid">
                      <div>
                        <span>Voyage Time</span>
                        <strong>{fcMetrics.hours} h</strong>
                      </div>
                      <div>
                        <span>Distance</span>
                        <strong>{fcMetrics.distance_km} km</strong>
                      </div>
                      <div>
                        <span>Heavy Ice (≥40%)</span>
                        <strong>{fcMetrics.heavy_ice_hours} h</strong>
                      </div>
                      <div>
                        <span>Fuel Proxy</span>
                        <strong>{fcMetrics.fuel_proxy}</strong>
                      </div>
                      <div>
                        <span>Max / Mean SIC</span>
                        <strong>
                          {Math.round(fcMetrics.max_sic * 100)}% /{" "}
                          {Math.round(fcMetrics.mean_sic * 100)}%
                        </strong>
                      </div>
                    </div>
                  </div>

                  <div className="dss-route-box muted">
                    <h3>Static Climatology Route</h3>
                    <div className="dss-stat-grid">
                      <div>
                        <span>Voyage Time</span>
                        <strong>{stMetrics.hours} h</strong>
                      </div>
                      <div>
                        <span>Distance</span>
                        <strong>{stMetrics.distance_km} km</strong>
                      </div>
                      <div>
                        <span>Heavy Ice (≥40%)</span>
                        <strong>{stMetrics.heavy_ice_hours} h</strong>
                      </div>
                      <div>
                        <span>Fuel Proxy</span>
                        <strong>{stMetrics.fuel_proxy}</strong>
                      </div>
                      <div>
                        <span>Max / Mean SIC</span>
                        <strong>
                          {Math.round(stMetrics.max_sic * 100)}% /{" "}
                          {Math.round(stMetrics.mean_sic * 100)}%
                        </strong>
                      </div>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <p className="dss-muted">Computing route metrics...</p>
            )}
          </section>

          {scenario?.hindcast_summary && (
            <section className="dss-card">
              <div className="dss-card-header">
                <h2>Aggregate Hindcast ({scenario.hindcast_summary.n} Voyages)</h2>
              </div>
              <div className="dss-stat-grid">
                <div>
                  <span>Mean Heavy Ice (Forecast)</span>
                  <strong>
                    {scenario.hindcast_summary.mean_heavy_hours_forecast} h
                  </strong>
                </div>
                <div>
                  <span>Mean Heavy Ice (Static)</span>
                  <strong>
                    {scenario.hindcast_summary.mean_heavy_hours_static} h
                  </strong>
                </div>
                <div>
                  <span>Mean Heavy-Ice Saved</span>
                  <strong className="pos">
                    {scenario.hindcast_summary.mean_heavy_hours_saved} h
                  </strong>
                </div>
                <div>
                  <span>Mean Total Hours Saved</span>
                  <strong className="pos">
                    {scenario.hindcast_summary.mean_hours_saved} h
                  </strong>
                </div>
              </div>
            </section>
          )}
        </aside>
      </main>

      {/* Bottom Timeline & Lead-Day Skill Bar */}
      <footer className="dss-Timeline">
        <div className="dss-timeline-controls">
          <button
            className="dss-play-btn"
            onClick={() => setIsPlaying(!isPlaying)}
          >
            {isPlaying ? "⏸ Pause" : "▶ Play"}
          </button>
          <div className="dss-step-pills">
            {[-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7].map((st) => (
              <button
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
            <span>Lead 1–7d MAE (U-Net vs B1):</span>
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
                      1
                    )}% vs B1 ${(b1Val * 100).toFixed(1)}%`}
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
                    <small>+{i + 1}</small>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </footer>

      {/* Modal / Drawer Overlay for Validation, Hindcast, and Provenance */}
      {drawer && (
        <div className="dss-drawer-backdrop" onClick={() => setDrawer(null)}>
          <div
            className="dss-drawer-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="dss-drawer-top">
              <h2>
                {drawer === "validation" &&
                  "Model Validation & Baseline Comparison (Unseen Years)"}
                {drawer === "hindcast" &&
                  "Counterfactual Hindcast Route Evaluation"}
                {drawer === "about" && "Data Provenance, Citations & Disclaimer"}
              </h2>
              <button onClick={() => setDrawer(null)}>✕ Close</button>
            </div>

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
                  <strong>Dataset:</strong> {scenario.dataset} (
                  <a href={scenario.doi} target="_blank" rel="noreferrer">
                    {scenario.doi}
                  </a>
                  )
                </p>
                <table className="dss-table">
                  <thead>
                    <tr>
                      <th>Component</th>
                      <th>Badge</th>
                      <th>Implementation & Provenance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scenario.provenance?.map((p, idx) => (
                      <tr key={idx}>
                        <td>{p.layer}</td>
                        <td>
                          <span
                            className="dss-badge"
                            style={{
                              backgroundColor:
                                BADGE_COLORS[p.badge] || "#475569",
                            }}
                          >
                            {p.badge}
                          </span>
                        </td>
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
