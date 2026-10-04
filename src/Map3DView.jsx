import React, {
  useEffect,
  useRef,
  useState,
  useImperativeHandle,
  forwardRef,
} from "react";
import * as THREE from "three";
import proj4 from "proj4";
import { latLngToCell } from "h3-js";
import { sicRgba, errorRgba, riskRgba } from "./colormap.js";

const R_GLOBE = 215;

/**
 * Interactive 3D Polar Globe & Sector Terrain Navigation Map (Three.js WebGL)
 * - Stable polar rotation pivot (no unexpected pivot jumps on click/drag)
 * - Smooth inertial zoom, orbit rotation, and bounded surface-locked pan
 * - Supports Polar Risk Map rendering (Safe / Caution / High / No-Go)
 * - Supports real Uber H3 Adaptive Polar Hexagonal Grid overlay & click/hover inspection
 */
const Map3DView = forwardRef(function Map3DView(
  {
    scenario,
    forecast,
    activeSlice,
    elevationSlice,
    surfaceTypeSlice,
    timelineStep,
    basemapStyle, // "satellite" | "terrain" | "scientific"
    globeMode = true,
    onToggleGlobeMode,
    verticalExaggeration = 1.2,
    showIceContours,
    showIceVectors,
    showRoutes,
    showCourseCorrections,
    showIcebergs,
    showStations,
    showGraticule,
    showRoads = false,
    showWeatherFigures = false,
    weatherOverlays = null,
    showH3Grid = false,
    h3Cells = [],
    h3Resolution = 3,
    selectedH3Index = null,
    onCameraZoomChange,
    routeData,
    icebergs,
    activeShipTelemetry,
    selectedDestination,
    isSelectingDestination,
    onToggleSelectDestination,
    onSelectDestinationPoint,
    onClearDestination,
    onInspectFeature,
    probeTextRef,
    paused = false,
  },
  ref
) {
  const mountRef = useRef(null);
  const overlayContainerRef = useRef(null);
  const [hoverTooltip, setHoverTooltip] = useState(null);
  const [gibsStatus, setGibsStatus] = useState("ready");
  const [labelVersion, setLabelVersion] = useState(0);

  const threeRef = useRef({
    renderer: null,
    scene: null,
    camera: null,
    terrainMesh: null,
    terrainGeo: null,
    terrainTex: null,
    waterMesh: null,
    waterGeo: null,
    frameLines: null,
    globeBackdropGroup: null,
    dynamicGroup: null,
    pulseGroup: null,
    gibsImage: null,
    globeMode: true,
    panXZ: { x: 0, z: 0 },
    targetExtraY: 0,
    target: new THREE.Vector3(0, 0, 0),
    curTarget: new THREE.Vector3(0, 0, 0),
    spherical: {
      radius: 158,
      phi: 0.64,
      theta: 0.0,
    },
    curSpherical: {
      radius: 158,
      phi: 0.64,
      theta: 0.0,
    },
    lastReportedBucket: 2,
    isDragging: false,
    pointerDownOnCanvas: false,
    dragButton: 0,
    downClientX: 0,
    downClientY: 0,
    lastClientX: 0,
    lastClientY: 0,
    labels: [],
    showH3Grid: false,
    h3CellLookup: new Map(),
    h3Resolution: 3,
    paused: false,
  });

  threeRef.current.paused = Boolean(paused);

  // Convert EPSG:3412 (x_m, y_m) to planar scene coordinates (sx, sz) in [-W/2..W/2, -H/2..H/2]
  function mapToSceneXZ(xm, ym) {
    if (!scenario?.extent || !scenario?.shape) return [0, 0];
    const [xmin, ymin, xmax, ymax] = scenario.extent;
    const [H, W] = scenario.shape;
    const nx = (xm - xmin) / (xmax - xmin) - 0.5;
    const nz = (ymax - ym) / (ymax - ymin) - 0.5;
    return [nx * W, nz * H];
  }

  function sceneXZToMap(sx, sz) {
    if (!scenario?.extent || !scenario?.shape) return [0, 0];
    const [xmin, ymin, xmax, ymax] = scenario.extent;
    const [H, W] = scenario.shape;
    const xm = xmin + (sx / W + 0.5) * (xmax - xmin);
    const ym = ymax - (sz / H + 0.5) * (ymax - ymin);
    return [xm, ym];
  }

  // Project planar (sx, sz) + elevation height h onto the 3D Polar Globe (or flat 3D plane)
  function flatXZToSceneVec3(sx, sz, h = 0, useGlobe = globeMode) {
    if (!useGlobe) {
      return new THREE.Vector3(sx, h, sz);
    }
    const rho = Math.hypot(sx, sz);
    const r = R_GLOBE + h;
    if (rho < 1e-5) {
      return new THREE.Vector3(0, h, 0);
    }
    const thetaCap = rho / R_GLOBE;
    const sinT = Math.sin(thetaCap);
    const cosT = Math.cos(thetaCap);
    const nx = (sx / rho) * sinT;
    const ny = cosT;
    const nz = (sz / rho) * sinT;
    return new THREE.Vector3(nx * r, ny * r - R_GLOBE, nz * r);
  }

  function flatXZToSurfaceNormal(sx, sz, useGlobe = globeMode) {
    if (!useGlobe) {
      return new THREE.Vector3(0, 1, 0);
    }
    const rho = Math.hypot(sx, sz);
    if (rho < 1e-5) {
      return new THREE.Vector3(0, 1, 0);
    }
    const thetaCap = rho / R_GLOBE;
    const sinT = Math.sin(thetaCap);
    const cosT = Math.cos(thetaCap);
    return new THREE.Vector3(
      (sx / rho) * sinT,
      cosT,
      (sz / rho) * sinT
    ).normalize();
  }

  // Exact analytical inverse from 3D raycast intersection point on globe/plane back to (sx, sz)
  function scenePointToFlatXZ(pt, useGlobe = threeRef.current.globeMode) {
    if (!useGlobe) {
      return [pt.x, pt.z];
    }
    const vx = pt.x;
    const vy = pt.y + R_GLOBE;
    const vz = pt.z;
    const r = Math.hypot(vx, vy, vz) || R_GLOBE;
    const cosTheta = Math.max(-1, Math.min(1, vy / r));
    const thetaCap = Math.acos(cosTheta);
    const rho = R_GLOBE * thetaCap;
    const horiz = Math.hypot(vx, vz);
    if (horiz < 1e-6) return [0, 0];
    return [(vx / horiz) * rho, (vz / horiz) * rho];
  }

  function sampleElevationSceneY(xm, ym) {
    if (!scenario?.extent || !scenario?.shape || !elevationSlice?.data) return 0.2;
    const [xmin, ymin, xmax, ymax] = scenario.extent;
    const [H, W] = scenario.shape;
    const col = Math.max(
      0,
      Math.min(W - 1, Math.floor(((xm - xmin) / (xmax - xmin)) * W))
    );
    const row = Math.max(
      0,
      Math.min(H - 1, Math.floor(((ymax - ym) / (ymax - ymin)) * H))
    );
    const elevM = elevationSlice.data[row * W + col] || 0;
    if (elevM <= 0) return 0.15;
    return (elevM / 250) * verticalExaggeration + 0.25;
  }

  function mapToScene3D(xm, ym, extraHeight = 0, useGlobe = globeMode) {
    const [sx, sz] = mapToSceneXZ(xm, ym);
    const baseH = sampleElevationSceneY(xm, ym);
    return flatXZToSceneVec3(sx, sz, baseH + extraHeight, useGlobe);
  }

  function clampCameraTargets() {
    const st = threeRef.current;
    st.spherical.phi = Math.max(0.06, Math.min(1.28, st.spherical.phi));
    st.spherical.radius = Math.max(22, Math.min(320, st.spherical.radius));

    // Keep camera pivot locked to the exact globe/terrain surface point so it can focus directly on the ship or any station
    const maxPan = 115;
    const panDist = Math.hypot(st.panXZ.x, st.panXZ.z);
    if (panDist > maxPan && panDist > 1e-5) {
      st.panXZ.x = (st.panXZ.x / panDist) * maxPan;
      st.panXZ.z = (st.panXZ.z / panDist) * maxPan;
    }
    const surfPt = flatXZToSceneVec3(
      st.panXZ.x,
      st.panXZ.z,
      st.targetExtraY || 0,
      st.globeMode
    );
    st.target.copy(surfPt);

    // Notify parent when zoom bucket changes so Adaptive H3 Grid resolution updates smoothly
    const r = st.spherical.radius;
    const bucket = r <= 78 ? 4 : r <= 132 ? 3 : 2;
    if (bucket !== st.lastReportedBucket) {
      st.lastReportedBucket = bucket;
      st.onCameraZoomChange?.(r);
    }
  }

  function applyCameraImmediate() {
    const st = threeRef.current;
    if (!st.camera) return;
    clampCameraTargets();
    st.curSpherical.radius = st.spherical.radius;
    st.curSpherical.phi = st.spherical.phi;
    st.curSpherical.theta = st.spherical.theta;
    st.curTarget.copy(st.target);

    const { radius, phi, theta } = st.curSpherical;
    const sinPhi = Math.sin(phi);
    const cx = st.curTarget.x + radius * sinPhi * Math.sin(theta);
    const cy = st.curTarget.y + radius * Math.cos(phi);
    const cz = st.curTarget.z + radius * sinPhi * Math.cos(theta);
    st.camera.position.set(cx, cy, cz);
    st.camera.lookAt(st.curTarget);
  }

  useImperativeHandle(ref, () => ({
    zoomIn() {
      threeRef.current.spherical.radius *= 0.82;
      clampCameraTargets();
    },
    zoomOut() {
      threeRef.current.spherical.radius *= 1.22;
      clampCameraTargets();
    },
    resetView() {
      threeRef.current.panXZ.x = 0;
      threeRef.current.panXZ.z = 0;
      threeRef.current.targetExtraY = 0;
      threeRef.current.spherical.radius = 158;
      threeRef.current.spherical.phi = 0.64;
      threeRef.current.spherical.theta = 0.0;
      clampCameraTargets();
    },
    topDownView() {
      threeRef.current.panXZ.x = 0;
      threeRef.current.panXZ.z = 0;
      threeRef.current.targetExtraY = 0;
      threeRef.current.spherical.phi = 0.08;
      threeRef.current.spherical.theta = 0.0;
      clampCameraTargets();
    },
    rotateStep(deltaRad = 0.35) {
      threeRef.current.spherical.theta += deltaRad;
      clampCameraTargets();
    },
    tiltStep(deltaPhi = -0.15) {
      threeRef.current.spherical.phi += deltaPhi;
      clampCameraTargets();
    },
    focusMapCoord(xm, ym, closeUp = false) {
      const st = threeRef.current;
      const [sx, sz] = mapToSceneXZ(xm, ym);
      st.panXZ.x = sx;
      st.panXZ.z = sz;
      st.targetExtraY = closeUp ? 1.8 : 0.6;
      if (closeUp) {
        st.spherical.radius = 42;
        st.spherical.phi = 0.48;
      }
      clampCameraTargets();
    },
  }));

  // Optional background load of NASA Earthdata GIBS Polar Stereographic Satellite Imagery
  useEffect(() => {
    if (!scenario?.extent) return;
    const [xmin, ymin, xmax, ymax] = scenario.extent;
    const wmsUrl = `https://gibs.earthdata.nasa.gov/wms/epsg3031/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1&LAYERS=BlueMarble_ShadedRelief_Bathymetry&STYLES=&FORMAT=image/jpeg&TRANSPARENT=false&SRS=EPSG:3031&BBOX=${xmin},${ymin},${xmax},${ymax}&WIDTH=512&HEIGHT=448`;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      threeRef.current.gibsImage = img;
      setGibsStatus("live-gibs");
    };
    img.onerror = () => {
      setGibsStatus("ready");
    };
    img.src = wmsUrl;
  }, [scenario]);

  // 1. Initialize Three.js WebGL Scene, 3D Planetary Globe Context, Terrain Mesh & Interaction Listeners
  useEffect(() => {
    const container = mountRef.current;
    if (!container || !scenario) return;

    const width = container.clientWidth || 960;
    const height = container.clientHeight || 660;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#040811");
    scene.fog = new THREE.FogExp2("#040811", 0.0012);

    const camera = new THREE.PerspectiveCamera(40, width / height, 1, 1600);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.innerHTML = "";
    container.appendChild(renderer.domElement);

    // Polar Studio Three-Point Illumination
    const hemiLight = new THREE.HemisphereLight(0xe0f2fe, 0x091326, 1.0);
    scene.add(hemiLight);

    const sunLight = new THREE.DirectionalLight(0xfffbeb, 1.18);
    sunLight.position.set(-110, 190, -90);
    scene.add(sunLight);

    const rimLight = new THREE.DirectionalLight(0x38bdf8, 0.45);
    rimLight.position.set(130, 70, 120);
    scene.add(rimLight);

    const [H, W] = scenario.shape;

    // Build 3D Planetary Globe Backdrop (Outer Southern Hemisphere Earth Sphere + Graticule + Atmosphere Rim)
    const globeBackdropGroup = new THREE.Group();

    const globeCanvas = document.createElement("canvas");
    globeCanvas.width = 1024;
    globeCanvas.height = 512;
    const gCtx = globeCanvas.getContext("2d");

    const oceanGrad = gCtx.createLinearGradient(0, 0, 0, 512);
    oceanGrad.addColorStop(0.0, "#040b17");
    oceanGrad.addColorStop(0.45, "#071830");
    oceanGrad.addColorStop(0.75, "#0b2548");
    oceanGrad.addColorStop(0.84, "#1e3a5f");
    oceanGrad.addColorStop(0.88, "#cbd5e1");
    oceanGrad.addColorStop(1.0, "#f1f5f9");
    gCtx.fillStyle = oceanGrad;
    gCtx.fillRect(0, 0, 1024, 512);

    gCtx.strokeStyle = "rgba(56, 189, 248, 0.16)";
    gCtx.lineWidth = 1;
    for (let x = 0; x < 1024; x += 64) {
      gCtx.beginPath();
      gCtx.moveTo(x, 0);
      gCtx.lineTo(x, 512);
      gCtx.stroke();
    }
    for (let y = 64; y < 512; y += 48) {
      gCtx.beginPath();
      gCtx.moveTo(0, y);
      gCtx.lineTo(1024, y);
      gCtx.stroke();
    }

    const globeSphereTex = new THREE.CanvasTexture(globeCanvas);
    globeSphereTex.colorSpace = THREE.SRGBColorSpace;
    const globeSphereGeo = new THREE.SphereGeometry(R_GLOBE - 0.55, 72, 54);
    const globeSphereMat = new THREE.MeshStandardMaterial({
      map: globeSphereTex,
      roughness: 0.72,
      metalness: 0.12,
    });
    const globeSphereMesh = new THREE.Mesh(globeSphereGeo, globeSphereMat);
    globeSphereMesh.position.set(0, -R_GLOBE, 0);
    globeBackdropGroup.add(globeSphereMesh);

    const atmoGeo = new THREE.SphereGeometry(R_GLOBE + 3.2, 64, 48);
    const atmoMat = new THREE.MeshBasicMaterial({
      color: 0x0ea5e9,
      transparent: true,
      opacity: 0.065,
      side: THREE.BackSide,
    });
    const atmoMesh = new THREE.Mesh(atmoGeo, atmoMat);
    atmoMesh.position.set(0, -R_GLOBE, 0);
    globeBackdropGroup.add(atmoMesh);

    const orbitRingGeo = new THREE.RingGeometry(R_GLOBE + 1.5, R_GLOBE + 2.1, 96);
    orbitRingGeo.rotateX(-Math.PI / 2);
    const orbitRingMat = new THREE.MeshBasicMaterial({
      color: 0x1e3a5f,
      transparent: true,
      opacity: 0.4,
      side: THREE.DoubleSide,
    });
    const orbitRing = new THREE.Mesh(orbitRingGeo, orbitRingMat);
    orbitRing.position.set(0, -34, 0);
    globeBackdropGroup.add(orbitRing);

    scene.add(globeBackdropGroup);

    // Create High-Resolution 3D Antarctic Sector Terrain & Sea-Ice Mesh (W x H units, 183 x 159 segments)
    const terrainGeo = new THREE.PlaneGeometry(W, H, W - 1, H - 1);
    terrainGeo.rotateX(-Math.PI / 2);

    const texCanvas = document.createElement("canvas");
    texCanvas.width = W * 4;
    texCanvas.height = H * 4;
    const terrainTex = new THREE.CanvasTexture(texCanvas);
    terrainTex.minFilter = THREE.LinearFilter;
    terrainTex.magFilter = THREE.LinearFilter;
    terrainTex.colorSpace = THREE.SRGBColorSpace;

    const terrainMat = new THREE.MeshStandardMaterial({
      map: terrainTex,
      roughness: 0.58,
      metalness: 0.08,
    });

    const terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
    scene.add(terrainMesh);

    // Sea-level water surface mesh
    const waterGeo = new THREE.PlaneGeometry(W, H, 48, 40);
    waterGeo.rotateX(-Math.PI / 2);
    const waterMat = new THREE.MeshStandardMaterial({
      color: 0x0a2748,
      transparent: true,
      opacity: 0.24,
      roughness: 0.25,
      metalness: 0.35,
    });
    const waterMesh = new THREE.Mesh(waterGeo, waterMat);
    scene.add(waterMesh);

    // Base platform frame for planar 3D mode
    const frameGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(W, 2.2, H));
    const frameMat = new THREE.LineBasicMaterial({
      color: 0x1e3a5f,
      transparent: true,
      opacity: 0.55,
    });
    const frameLines = new THREE.LineSegments(frameGeo, frameMat);
    frameLines.position.y = -1.1;
    scene.add(frameLines);

    const dynamicGroup = new THREE.Group();
    scene.add(dynamicGroup);

    const pulseGroup = new THREE.Group();
    scene.add(pulseGroup);

    const st = threeRef.current;
    st.renderer = renderer;
    st.scene = scene;
    st.camera = camera;
    st.terrainMesh = terrainMesh;
    st.terrainGeo = terrainGeo;
    st.terrainTex = terrainTex;
    st.waterMesh = waterMesh;
    st.waterGeo = waterGeo;
    st.frameLines = frameLines;
    st.globeBackdropGroup = globeBackdropGroup;
    st.dynamicGroup = dynamicGroup;
    st.pulseGroup = pulseGroup;

    applyCameraImmediate();

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    function getIntersection(clientX, clientY) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);

      const interactiveHits = raycaster.intersectObjects(
        dynamicGroup.children,
        true
      );
      let hitInspect = null;
      for (const h of interactiveHits) {
        let obj = h.object;
        while (obj && !obj.userData?.inspect) {
          obj = obj.parent;
        }
        if (obj?.userData?.inspect) {
          hitInspect = { inspect: obj.userData.inspect, point: h.point };
          break;
        }
      }

      const terrainHits = raycaster.intersectObjects(
        [terrainMesh, waterMesh],
        false
      );
      const terrainPoint = terrainHits.length > 0 ? terrainHits[0].point : null;

      return { hitInspect, terrainPoint, rect };
    }

    const domElem = renderer.domElement;

    const onPointerDown = (e) => {
      if (e.target !== domElem) return;
      st.pointerDownOnCanvas = true;
      st.isDragging = true;
      st.dragButton = e.button;
      st.downClientX = e.clientX;
      st.downClientY = e.clientY;
      st.lastClientX = e.clientX;
      st.lastClientY = e.clientY;
    };

    const onPointerMove = (e) => {
      if (st.isDragging && st.pointerDownOnCanvas) {
        const totalMove = Math.hypot(
          e.clientX - st.downClientX,
          e.clientY - st.downClientY
        );
        if (st.selectDestActive && e.buttons === 1 && totalMove < 8) {
          return;
        }
        const dx = e.clientX - st.lastClientX;
        const dy = e.clientY - st.lastClientY;
        st.lastClientX = e.clientX;
        st.lastClientY = e.clientY;

        if (st.dragButton === 2 || e.shiftKey) {
          // Smooth bounded surface pan (Right-Drag or Shift+Drag)
          const panScale = st.spherical.radius * 0.0012;
          const cosT = Math.cos(st.spherical.theta);
          const sinT = Math.sin(st.spherical.theta);
          st.panXZ.x -= (dx * cosT + dy * sinT) * panScale;
          st.panXZ.z -= (-dx * sinT + dy * cosT) * panScale;
        } else {
          // Pure stable orbit rotation around fixed pivot (Left-Drag)
          st.spherical.theta -= dx * 0.0055;
          st.spherical.phi -= dy * 0.0048;
        }
        clampCameraTargets();
        return;
      }

      if (e.target !== domElem) {
        setHoverTooltip(null);
        return;
      }

      const { hitInspect, terrainPoint, rect } = getIntersection(
        e.clientX,
        e.clientY
      );
      if (terrainPoint) {
        const [sx, sz] = scenePointToFlatXZ(terrainPoint, st.globeMode);
        const [xm, ym] = sceneXZToMap(sx, sz);
        const [xmin, ymin, xmax, ymax] = scenario.extent;
        if (xm < xmin || xm > xmax || ym < ymin || ym > ymax) {
          setHoverTooltip(null);
          return;
        }
        const [lon, lat] = proj4("EPSG:3412", "EPSG:4326", [xm, ym]);
        const col = Math.max(
          0,
          Math.min(W - 1, Math.floor(((xm - xmin) / (xmax - xmin)) * W))
        );
        const row = Math.max(
          0,
          Math.min(H - 1, Math.floor(((ymax - ym) / (ymax - ymin)) * H))
        );
        const idx = row * W + col;
        const curElev = st.elevationSlice || elevationSlice;
        const curSurf = st.surfaceTypeSlice || surfaceTypeSlice;
        const curSic = st.activeSlice || activeSlice;
        const elevM = curElev?.data ? Math.round(curElev.data[idx]) : 0;
        const sType = curSurf?.data ? Math.round(curSurf.data[idx]) : 0;
        const sicVal = curSic?.slice?.data ? curSic.slice.data[idx] : 0;

        const latStr = `${Math.abs(lat).toFixed(2)}°S`;
        const lonStr = `${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`;
        const surfaceStr =
          sType === 3
            ? `Ice Shelf (+${elevM}m)`
            : sType === 2
            ? `Antarctic Continent (+${elevM}m)`
            : sType === 1
            ? `Coastal Bedrock Oasis (+${elevM}m)`
            : curSic?.mode === "risk"
            ? `Risk Score ${sicVal.toFixed(2)} · Depth ${elevM}m`
            : `${(sicVal * 100).toFixed(1)}% SIC · Depth ${elevM}m`;

        if (probeTextRef?.current) {
          probeTextRef.current.textContent = `${latStr}, ${lonStr} · Cell (${row},${col}) · ${surfaceStr}`;
        }

        if (hitInspect && !st.selectDestActive) {
          setHoverTooltip({
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
            title: hitInspect.inspect.title,
            subtitle: hitInspect.inspect.subtitle,
            kind: hitInspect.inspect.kind,
            isFeature: true,
          });
          return;
        }

        // Check if Adaptive H3 Grid is active and cursor is over an H3 cell
        if (st.showH3Grid && !st.selectDestActive && sType === 0) {
          try {
            const h3Idx = latLngToCell(lat, lon, st.h3Resolution || 3);
            const h3Cell = st.h3CellLookup?.get(h3Idx);
            if (h3Cell) {
              setHoverTooltip({
                x: e.clientX - rect.left,
                y: e.clientY - rect.top,
                title: `H3 Cell ${h3Cell.h3Index}`,
                subtitle: `Risk: ${h3Cell.riskLevel.toUpperCase()} (${h3Cell.combinedRiskVal.toFixed(
                  2
                )}) · Peak ${Math.round(h3Cell.maxSic * 100)}% SIC`,
                kind: `Adaptive H3 Hex Grid (Res ${h3Cell.resolution})`,
                isFeature: true,
              });
              return;
            }
          } catch {
            // ignore out-of-range lat/lon
          }
        }

        setHoverTooltip({
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
          title: `${latStr}, ${lonStr}`,
          subtitle: surfaceStr,
          kind:
            sType === 0
              ? sicVal >= 0.4
                ? "Heavy Pack Ice Zone"
                : sicVal >= 0.15
                ? "Marginal Sea Ice"
                : "Southern Ocean"
              : sType === 3
              ? "Floating Glacial Shelf"
              : sType === 1
              ? "Coastal Rock Oasis"
              : elevM >= 1500
              ? "Mountain / Polar Plateau"
              : "Continental Ice Sheet",
          isFeature: false,
        });
      } else {
        setHoverTooltip(null);
      }
    };

    const onPointerUp = (e) => {
      const wasOnCanvas = st.pointerDownOnCanvas;
      st.pointerDownOnCanvas = false;
      st.isDragging = false;
      if (!wasOnCanvas) return;

      const moveDist = Math.hypot(
        e.clientX - st.downClientX,
        e.clientY - st.downClientY
      );
      const clickThreshold = st.selectDestActive ? 10 : 5;
      if (moveDist < clickThreshold && e.button === 0) {
        const { hitInspect, terrainPoint } = getIntersection(
          e.clientX,
          e.clientY
        );

        // 1. Explicit Select Destination Mode: place destination pin without altering camera pivot
        if (st.selectDestActive && terrainPoint) {
          const [sx, sz] = scenePointToFlatXZ(terrainPoint, st.globeMode);
          const [xm, ym] = sceneXZToMap(sx, sz);
          const [lon, lat] = proj4("EPSG:3412", "EPSG:4326", [xm, ym]);
          st.onSelectDestinationPoint?.({ lon, lat, x_m: xm, y_m: ym });
          return;
        }

        // 2. Inspect 3D feature (Station, Iceberg, Route, Destination Pin) without shifting camera pivot
        if (hitInspect?.inspect) {
          st.onInspectFeature?.(hitInspect.inspect);
          return;
        }

        // 3. If Adaptive H3 Grid is active, clicking a hex cell inspects that H3 cell's multi-factor Polar Risk
        if (st.showH3Grid && terrainPoint) {
          const [sx, sz] = scenePointToFlatXZ(terrainPoint, st.globeMode);
          const [xm, ym] = sceneXZToMap(sx, sz);
          const [lon, lat] = proj4("EPSG:3412", "EPSG:4326", [xm, ym]);
          try {
            const h3Idx = latLngToCell(lat, lon, st.h3Resolution || 3);
            const h3Cell = st.h3CellLookup?.get(h3Idx);
            if (h3Cell?.inspect) {
              st.onInspectFeature?.(h3Cell.inspect);
              return;
            }
          } catch {
            // ignore
          }
        }
      }
    };

    const onWheel = (e) => {
      e.preventDefault();
      // Continuous exponential zoom for smooth trackpad & mouse wheel control
      const delta = Math.max(-120, Math.min(120, e.deltaY));
      st.spherical.radius *= Math.exp(delta * 0.0011);
      clampCameraTargets();
    };

    const onContextMenu = (e) => e.preventDefault();

    domElem.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    domElem.addEventListener("wheel", onWheel, { passive: false });
    domElem.addEventListener("contextmenu", onContextMenu);

    const ro = new ResizeObserver(() => {
      if (!container || !st.renderer || !st.camera) return;
      const cw = container.clientWidth || 800;
      const ch = container.clientHeight || 600;
      st.camera.aspect = cw / ch;
      st.camera.updateProjectionMatrix();
      st.renderer.setSize(cw, ch);
    });
    ro.observe(container);

    let animId = 0;
    let phase = 0;
    const tempV = new THREE.Vector3();

    const animate = () => {
      animId = requestAnimationFrame(animate);
      if (st.paused) return;
      phase = (phase + 0.022) % 1;

      // Smoothly damp camera spherical coordinates and target for fluid 60fps globe rotation/zoom
      const damp = 0.2;
      st.curSpherical.radius +=
        (st.spherical.radius - st.curSpherical.radius) * damp;
      st.curSpherical.phi += (st.spherical.phi - st.curSpherical.phi) * damp;
      st.curSpherical.theta +=
        (st.spherical.theta - st.curSpherical.theta) * damp;
      st.curTarget.lerp(st.target, damp);

      const { radius, phi, theta } = st.curSpherical;
      const sinPhi = Math.sin(phi);
      const cx = st.curTarget.x + radius * sinPhi * Math.sin(theta);
      const cy = st.curTarget.y + radius * Math.cos(phi);
      const cz = st.curTarget.z + radius * sinPhi * Math.cos(theta);
      st.camera.position.set(cx, cy, cz);
      st.camera.lookAt(st.curTarget);

      if (st.shipGroup && st.activeShipTelemetry) {
        const tel = st.activeShipTelemetry;
        const [sx, sz] = mapToSceneXZ(tel.x_m, tel.y_m);
        const [nx, nz] = mapToSceneXZ(tel.next_x_m, tel.next_y_m);
        const bobY = Math.sin(phase * Math.PI * 4) * 0.08;
        const shipPos3D = flatXZToSceneVec3(sx, sz, 1.45 + bobY, st.globeMode);
        const nextPos3D = flatXZToSceneVec3(nx, nz, 1.45 + bobY, st.globeMode);
        st.shipGroup.position.copy(shipPos3D);
        if (shipPos3D.distanceTo(nextPos3D) > 0.005) {
          st.shipGroup.lookAt(nextPos3D);
        }
        // Subtle realistic ocean roll & pitch
        st.shipGroup.rotateZ(Math.sin(phase * Math.PI * 2) * 0.038);
        st.shipGroup.rotateX(Math.cos(phase * Math.PI * 4) * 0.024);

        if (st.shipRadarBar) {
          st.shipRadarBar.rotation.y = phase * Math.PI * 8;
        }
        if (st.shipRadarCone) {
          st.shipRadarCone.rotation.z = Math.sin(phase * Math.PI * 2) * 0.36;
        }
        if (st.shipWakeGroup) {
          const wakePulse = 0.88 + Math.sin(phase * Math.PI * 6) * 0.14;
          st.shipWakeGroup.scale.set(wakePulse, 1, 1 + (1 - wakePulse) * 0.5);
        }
        if (st.shipSonarRings?.length) {
          const surfPos = flatXZToSceneVec3(sx, sz, 0.55, st.globeMode);
          const upV = new THREE.Vector3(0, 1, 0);
          const normV = st.globeMode
            ? flatXZToSurfaceNormal(sx, sz, true)
            : upV;
          st.shipSonarRings.forEach((rm) => {
            rm.position.copy(surfPos);
            if (st.globeMode) {
              rm.quaternion.setFromUnitVectors(upV, normV);
            } else {
              rm.rotation.set(0, 0, 0);
            }
          });
        }
        if (st.shipLabelEntry) {
          st.shipLabelEntry.pos3D.copy(
            flatXZToSceneVec3(sx, sz, 8.8, st.globeMode)
          );
          st.shipLabelEntry.sub = `${Math.abs(tel.lat).toFixed(
            1
          )}°S, ${Math.abs(tel.lon).toFixed(1)}°E · COG ${
            tel.cog_deg
          }° · ${tel.speed_kmh} km/h`;
        }
      }

      if (st.pulseGroup) {
        st.pulseGroup.children.forEach((child) => {
          if (child.userData?.kind === "sonar") {
            const p = (phase + (child.userData.offset || 0)) % 1;
            const scale = 1 + p * 3.2;
            child.scale.set(scale, scale, scale);
            if (child.material) {
              child.material.opacity = Math.max(0.05, (1 - p) * 0.8);
            }
          } else if (child.userData?.kind === "chevronStream") {
            const pts = child.userData.points;
            if (pts && pts.length > 2) {
              const idx = Math.min(
                pts.length - 2,
                Math.floor(
                  ((phase + (child.userData.offset || 0)) % 1) *
                    (pts.length - 1)
                )
              );
              const p0 = pts[idx];
              const p1 = pts[idx + 1];
              child.position.copy(p0);
              child.lookAt(p1);
            }
          } else if (child.userData?.kind === "windComet") {
            const curvePts = child.userData.curvePts;
            const tailLen = child.userData.tailLen || 5;
            const totalPts = curvePts.length;
            const prog =
              ((phase * (child.userData.speedFactor || 1) +
                (child.userData.offset || 0)) %
                1) *
              (totalPts - 1);
            const posAttr = child.geometry.getAttribute("position");
            if (posAttr) {
              for (let k = 0; k < tailLen; k++) {
                // Tight sampling spacing (0.38) so each wind particle is a short, crisp moving wind wisp
                const sampleIdx = Math.max(
                  0,
                  Math.min(totalPts - 1, prog - (tailLen - 1 - k) * 0.38)
                );
                const i0 = Math.floor(sampleIdx);
                const i1 = Math.min(totalPts - 1, i0 + 1);
                const frac = sampleIdx - i0;
                const a = curvePts[i0];
                const b = curvePts[i1];
                posAttr.setXYZ(
                  k,
                  a.x + (b.x - a.x) * frac,
                  a.y + (b.y - a.y) * frac,
                  a.z + (b.z - a.z) * frac
                );
              }
              posAttr.needsUpdate = true;
            }
            if (child.userData.headMesh) {
              const hi0 = Math.floor(prog);
              const hi1 = Math.min(totalPts - 1, hi0 + 1);
              const hFrac = prog - hi0;
              const ha = curvePts[hi0];
              const hb = curvePts[hi1];
              child.userData.headMesh.position.set(
                ha.x + (hb.x - ha.x) * hFrac,
                ha.y + (hb.y - ha.y) * hFrac,
                ha.z + (hb.z - ha.z) * hFrac
              );
            }
          }
        });
      }

      renderer.render(scene, camera);

      const overlayEl = overlayContainerRef.current;
      if (overlayEl && st.labels.length > 0) {
        const cw = container.clientWidth || 800;
        const ch = container.clientHeight || 600;
        const children = overlayEl.children;
        for (let i = 0; i < st.labels.length; i++) {
          const lbl = st.labels[i];
          const domNode = children[i];
          if (!domNode) continue;
          if (lbl.id === "vessel-rv-polar" && lbl.sub) {
            const subEl = domNode.querySelector(".dss-3d-lbl-sub");
            if (subEl && subEl.textContent !== lbl.sub) {
              subEl.textContent = lbl.sub;
            }
          }
          tempV.copy(lbl.pos3D);
          tempV.project(camera);
          if (tempV.z > 1.0 || tempV.z < -1.0) {
            domNode.style.opacity = "0";
            domNode.style.pointerEvents = "none";
          } else {
            const px = (tempV.x * 0.5 + 0.5) * cw;
            const py = (-tempV.y * 0.5 + 0.5) * ch;
            if (px < -80 || px > cw + 80 || py < -40 || py > ch + 40) {
              domNode.style.opacity = "0";
              domNode.style.pointerEvents = "none";
            } else {
              domNode.style.opacity = "1";
              domNode.style.pointerEvents = "auto";
              domNode.style.transform = `translate3d(${px.toFixed(
                1
              )}px, ${py.toFixed(1)}px, 0) translate(-50%, -100%)`;
            }
          }
        }
      }
    };
    animate();

    return () => {
      cancelAnimationFrame(animId);
      ro.disconnect();
      domElem.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      domElem.removeEventListener("wheel", onWheel);
      domElem.removeEventListener("contextmenu", onContextMenu);
      renderer.dispose();
    };
  }, [scenario]);

  // Keep latest callbacks and H3 lookup synced on threeRef.current
  useEffect(() => {
    const st = threeRef.current;
    const prevGlobe = st.globeMode;
    st.globeMode = globeMode;
    if (prevGlobe !== globeMode) {
      clampCameraTargets();
    }
    st.selectDestActive = isSelectingDestination;
    st.onSelectDestinationPoint = onSelectDestinationPoint;
    st.onInspectFeature = onInspectFeature;
    st.onCameraZoomChange = onCameraZoomChange;
    st.activeSlice = activeSlice;
    st.elevationSlice = elevationSlice;
    st.surfaceTypeSlice = surfaceTypeSlice;
    st.showH3Grid = showH3Grid;
    st.h3Resolution = h3Resolution;
    st.activeShipTelemetry = activeShipTelemetry;

    const map = new Map();
    if (h3Cells?.length) {
      for (const c of h3Cells) {
        map.set(c.h3Index, c);
      }
    }
    st.h3CellLookup = map;
  }, [
    globeMode,
    isSelectingDestination,
    onSelectDestinationPoint,
    onInspectFeature,
    onCameraZoomChange,
    activeSlice,
    elevationSlice,
    surfaceTypeSlice,
    showH3Grid,
    h3Cells,
    h3Resolution,
    activeShipTelemetry,
  ]);

  // 2. Update 3D Globe / Terrain Vertex Geometry + Multi-Spectral Satellite / Hypsometric / Polar Risk Texture
  useEffect(() => {
    const st = threeRef.current;
    if (
      !st.terrainGeo ||
      !st.waterGeo ||
      !st.terrainTex ||
      !scenario ||
      !activeSlice?.slice ||
      !elevationSlice?.data ||
      !surfaceTypeSlice?.data
    )
      return;

    const [H, W] = scenario.shape;
    const sicData = activeSlice.slice.data;
    const mode = activeSlice.mode || "sic";
    const elevData = elevationSlice.data;
    const surfData = surfaceTypeSlice.data;

    if (st.globeBackdropGroup) {
      st.globeBackdropGroup.visible = Boolean(globeMode);
    }
    if (st.frameLines) {
      st.frameLines.visible = !globeMode;
    }

    // A1. Update Sea-Level Water Mesh vertices to match Globe curvature or Flat plane
    const wPos = st.waterGeo.attributes.position;
    const wSegX = 48;
    const wSegZ = 40;
    for (let rz = 0; rz <= wSegZ; rz++) {
      for (let cx = 0; cx <= wSegX; cx++) {
        const wIdx = rz * (wSegX + 1) + cx;
        const sx = (cx / wSegX - 0.5) * W;
        const sz = (rz / wSegZ - 0.5) * H;
        const p3 = flatXZToSceneVec3(sx, sz, -0.02, globeMode);
        wPos.setXYZ(wIdx, p3.x, p3.y, p3.z);
      }
    }
    wPos.needsUpdate = true;
    st.waterGeo.computeVertexNormals();

    // A2. Displace 3D Terrain & Sea-Ice vertices onto Curved Globe or Flat Terrain
    const posAttr = st.terrainGeo.attributes.position;
    for (let r = 0; r < H; r++) {
      const sz = (r / (H - 1) - 0.5) * H;
      for (let c = 0; c < W; c++) {
        const sx = (c / (W - 1) - 0.5) * W;
        const idx = r * W + c;
        const elevM = elevData[idx] || 0;
        const sType = Math.round(surfData[idx] || 0);
        const sic = sicData[idx] || 0;

        let yVal = 0;
        if (sType === 3) {
          yVal = 0.85 * verticalExaggeration;
        } else if (sType === 1 || sType === 2) {
          yVal = Math.max(0.28, (elevM / 250) * verticalExaggeration);
        } else {
          const bathySubtle = Math.max(-0.55, elevM / 9500);
          const iceOrRiskHeight =
            (mode === "sic" || mode === "risk") && sic >= 0.15
              ? Math.pow(sic, 1.35) * 0.85 * verticalExaggeration
              : 0;
          yVal = bathySubtle + iceOrRiskHeight;
        }

        const p3 = flatXZToSceneVec3(sx, sz, yVal, globeMode);
        posAttr.setXYZ(idx, p3.x, p3.y, p3.z);
      }
    }
    posAttr.needsUpdate = true;
    st.terrainGeo.computeVertexNormals();

    // B. Paint high-resolution 3D surface texture (Satellite / Terrain / Scientific / Polar Risk Map)
    const canvas = st.terrainTex.image;
    const scale = 4;
    const TW = W * scale;
    const TH = H * scale;
    const ctx = canvas.getContext("2d");

    const cellCanvas = document.createElement("canvas");
    cellCanvas.width = W;
    cellCanvas.height = H;
    const cCtx = cellCanvas.getContext("2d");
    const imgData = cCtx.createImageData(W, H);
    const buf = imgData.data;

    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        const idx = r * W + c;
        const p = idx * 4;
        const elevM = elevData[idx] || 0;
        const sType = Math.round(surfData[idx] || 0);
        const val = sicData[idx] || 0;

        const cRight = Math.min(W - 1, c + 1);
        const rDown = Math.min(H - 1, r + 1);
        const dxElev = (elevData[r * W + cRight] - elevM) / 400;
        const dyElev = (elevData[rDown * W + c] - elevM) / 400;
        const shade = Math.max(
          0.72,
          Math.min(1.22, 1.0 - dxElev * 0.28 - dyElev * 0.22)
        );

        let R = 10,
          G = 28,
          B = 54;

        const sampleColor = (v) =>
          mode === "risk"
            ? riskRgba(v)
            : mode === "sic"
            ? sicRgba(v)
            : errorRgba(v);

        if (basemapStyle === "terrain") {
          if (sType === 3) {
            R = 165 * shade;
            G = 235 * shade;
            B = 250 * shade;
          } else if (sType === 1) {
            R = 118 * shade;
            G = 96 * shade;
            B = 82 * shade;
          } else if (sType === 2) {
            if (elevM >= 2200) {
              R = 252 * shade;
              G = 250 * shade;
              B = 255 * shade;
            } else if (elevM >= 1300) {
              const t = (elevM - 1300) / 900;
              R = (185 + t * 60) * shade;
              G = (205 + t * 42) * shade;
              B = (228 + t * 25) * shade;
            } else {
              const t = Math.min(1, elevM / 1300);
              R = (205 + t * 30) * shade;
              G = (222 + t * 20) * shade;
              B = (240 + t * 12) * shade;
            }
          } else {
            const depthNorm = Math.min(1, Math.max(0, -elevM / 4200));
            const waterR = Math.round(14 - depthNorm * 8);
            const waterG = Math.round(58 - depthNorm * 34);
            const waterB = Math.round(108 - depthNorm * 52);

            if (mode === "risk" || val >= 0.12) {
              const [ir, ig, ib, ia] = sampleColor(val);
              const a = Math.min(1, (ia / 255) * (mode === "risk" ? 0.92 : 1.05));
              R = waterR * (1 - a) + ir * a;
              G = waterG * (1 - a) + ig * a;
              B = waterB * (1 - a) + ib * a;
            } else {
              R = waterR;
              G = waterG;
              B = waterB;
            }
          }
        } else if (basemapStyle === "satellite") {
          if (sType === 3) {
            R = 195 * shade;
            G = 236 * shade;
            B = 252 * shade;
          } else if (sType === 1) {
            R = 98 * shade;
            G = 85 * shade;
            B = 76 * shade;
          } else if (sType === 2) {
            const isNunatakRidge =
              elevM > 1450 && Math.abs(dxElev) + Math.abs(dyElev) > 0.42;
            if (isNunatakRidge) {
              R = 135 * shade;
              G = 128 * shade;
              B = 124 * shade;
            } else {
              const t = Math.min(1, elevM / 2800);
              R = (222 + t * 30) * shade;
              G = (234 + t * 18) * shade;
              B = (248 + t * 7) * shade;
            }
          } else {
            const depthNorm = Math.min(1, Math.max(0, -elevM / 4200));
            const waterR = Math.round(8 - depthNorm * 4);
            const waterG = Math.round(32 - depthNorm * 16);
            const waterB = Math.round(68 - depthNorm * 28);

            if (mode === "risk" || val >= 0.08) {
              const [ir, ig, ib, ia] = sampleColor(val);
              const a = Math.min(1, (ia / 255) * (mode === "risk" ? 0.92 : 1.08));
              R = waterR * (1 - a) + ir * a;
              G = waterG * (1 - a) + ig * a;
              B = waterB * (1 - a) + ib * a;
            } else {
              R = waterR;
              G = waterG;
              B = waterB;
            }
          }
        } else {
          if (sType >= 1) {
            const elevFactor = Math.min(1, Math.max(0, elevM / 3000));
            R = (30 + elevFactor * 55) * shade;
            G = (42 + elevFactor * 65) * shade;
            B = (62 + elevFactor * 80) * shade;
          } else {
            const [ir, ig, ib, ia] = sampleColor(val);
            const a = ia / 255;
            R = 8 * (1 - a) + ir * a;
            G = 18 * (1 - a) + ig * a;
            B = 34 * (1 - a) + ib * a;
          }
        }

        buf[p] = Math.max(0, Math.min(255, Math.round(R)));
        buf[p + 1] = Math.max(0, Math.min(255, Math.round(G)));
        buf[p + 2] = Math.max(0, Math.min(255, Math.round(B)));
        buf[p + 3] = 255;
      }
    }
    cCtx.putImageData(imgData, 0, 0);

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(cellCanvas, 0, 0, TW, TH);

    if (basemapStyle === "satellite" && st.gibsImage && mode !== "risk") {
      ctx.save();
      ctx.globalAlpha = 0.24;
      ctx.drawImage(st.gibsImage, 0, 0, TW, TH);
      ctx.restore();
    }

    // Crisp topographic elevation contour lines & coastline rim
    ctx.lineWidth = 1.2;
    for (let r = 1; r < H - 1; r++) {
      for (let c = 1; c < W - 1; c++) {
        const idx = r * W + c;
        const sType = Math.round(surfData[idx]);
        const e0 = elevData[idx];
        const eR = elevData[r * W + (c + 1)];
        const eD = elevData[(r + 1) * W + c];

        if (
          sType >= 1 &&
          (surfData[r * W + (c + 1)] === 0 || surfData[(r + 1) * W + c] === 0)
        ) {
          ctx.fillStyle =
            sType === 3
              ? "rgba(56, 189, 248, 0.9)"
              : "rgba(148, 163, 184, 0.85)";
          ctx.fillRect(c * scale, r * scale, scale, scale);
        }

        if (sType === 2) {
          for (const level of [1000, 2000, 2800]) {
            if (
              (e0 < level && eR >= level) ||
              (e0 >= level && eR < level) ||
              (e0 < level && eD >= level)
            ) {
              ctx.fillStyle = "rgba(71, 85, 105, 0.42)";
              ctx.fillRect(c * scale, r * scale, 2, 2);
            }
          }
        }
      }
    }

    if (showGraticule) {
      const [xmin, ymin, xmax, ymax] = scenario.extent;
      const toTexXY = (lon, lat) => {
        const [xm, ym] = proj4("EPSG:4326", "EPSG:3412", [lon, lat]);
        return [
          ((xm - xmin) / (xmax - xmin)) * TW,
          ((ymax - ym) / (ymax - ymin)) * TH,
        ];
      };

      ctx.strokeStyle = "rgba(148, 163, 184, 0.24)";
      ctx.lineWidth = 1.1;
      ctx.setLineDash([5, 5]);
      for (const lat of [-55, -60, -65, -66.56, -70]) {
        ctx.beginPath();
        for (let lon = -15; lon <= 105; lon += 2) {
          const [tx, ty] = toTexXY(lon, lat);
          if (lon === -15) ctx.moveTo(tx, ty);
          else ctx.lineTo(tx, ty);
        }
        ctx.stroke();
      }
      for (const lon of [0, 20, 40, 60, 80, 100]) {
        ctx.beginPath();
        for (let lat = -54; lat >= -75; lat -= 1) {
          const [tx, ty] = toTexXY(lon, lat);
          if (lat === -54) ctx.moveTo(tx, ty);
          else ctx.lineTo(tx, ty);
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    st.terrainTex.needsUpdate = true;
  }, [
    scenario,
    activeSlice,
    elevationSlice,
    surfaceTypeSlice,
    basemapStyle,
    globeMode,
    verticalExaggeration,
    showGraticule,
    gibsStatus,
  ]);

  // 3. Rebuild 3D Vector Overlays on Globe / Terrain (including Adaptive H3 Polar Hex Grid)
  useEffect(() => {
    const st = threeRef.current;
    if (!st.dynamicGroup || !st.pulseGroup || !scenario) return;

    while (st.dynamicGroup.children.length > 0) {
      const obj = st.dynamicGroup.children[0];
      st.dynamicGroup.remove(obj);
    }
    while (st.pulseGroup.children.length > 0) {
      const obj = st.pulseGroup.children[0];
      st.pulseGroup.remove(obj);
    }
    st.shipGroup = null;
    st.shipRadarBar = null;
    st.shipRadarCone = null;
    st.shipWakeGroup = null;
    st.shipSonarRings = [];
    st.shipLabelEntry = null;

    const newLabels = [];
    const upVec = new THREE.Vector3(0, 1, 0);

    function orientToGlobeNormal(obj3D, sx, sz) {
      if (!globeMode) return;
      const n = flatXZToSurfaceNormal(sx, sz, true);
      obj3D.quaternion.setFromUnitVectors(upVec, n);
    }

    function addLine3D(xyCoords, colorHex, yOffset = 0.45, dashed = false) {
      if (!xyCoords || xyCoords.length < 2) return null;
      const pts = xyCoords.map(([xm, ym]) =>
        mapToScene3D(xm, ym, yOffset, globeMode)
      );
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      let mat;
      if (dashed) {
        mat = new THREE.LineDashedMaterial({
          color: colorHex,
          dashSize: 1.4,
          gapSize: 0.9,
        });
      } else {
        mat = new THREE.LineBasicMaterial({ color: colorHex });
      }
      const line = new THREE.Line(geo, mat);
      if (dashed) line.computeLineDistances();
      st.dynamicGroup.add(line);
      return { line, pts };
    }

    function addRouteRibbon3D(
      xyCoords,
      colorHex,
      radius = 0.36,
      yOffset = 0.52,
      inspect = null
    ) {
      if (!xyCoords || xyCoords.length < 2) return null;
      const pts = xyCoords.map(([xm, ym]) => {
        const [sx, sz] = mapToSceneXZ(xm, ym);
        return flatXZToSceneVec3(sx, sz, 0.35 + yOffset, globeMode);
      });
      const curve = new THREE.CatmullRomCurve3(pts);
      const tubeGeo = new THREE.TubeGeometry(
        curve,
        Math.min(180, xyCoords.length * 2),
        radius,
        8,
        false
      );
      const tubeMat = new THREE.MeshStandardMaterial({
        color: colorHex,
        emissive: colorHex,
        emissiveIntensity: 0.42,
        roughness: 0.3,
      });
      const mesh = new THREE.Mesh(tubeGeo, tubeMat);
      if (inspect) mesh.userData.inspect = inspect;
      st.dynamicGroup.add(mesh);
      return { mesh, pts };
    }

    // 0. Adaptive H3 Polar Hexagonal Grid Layer (batched by Risk Level for 60fps performance)
    if (showH3Grid && h3Cells?.length) {
      const buckets = {
        Safe: { color: 0x10b981, verts: [] },
        Caution: { color: 0xeab308, verts: [] },
        High: { color: 0xf97316, verts: [] },
        "No-Go": { color: 0xe11d48, verts: [] },
        Selected: { color: 0x38bdf8, verts: [] },
      };

      for (const cell of h3Cells) {
        const ring = cell.ringXy;
        if (!ring || ring.length < 4) continue;
        const isSel = selectedH3Index && cell.h3Index === selectedH3Index;
        const bKey = isSel ? "Selected" : cell.riskLevel || "Safe";
        const targetArr = (buckets[bKey] || buckets.Safe).verts;
        const yOff = isSel ? 0.78 : 0.44;

        for (let i = 0; i < ring.length - 1; i++) {
          const p0 = mapToScene3D(ring[i][0], ring[i][1], yOff, globeMode);
          const p1 = mapToScene3D(ring[i + 1][0], ring[i + 1][1], yOff, globeMode);
          targetArr.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
        }

        if (isSel) {
          newLabels.push({
            id: `h3-sel-${cell.h3Index}`,
            text: `H3 ${cell.h3Index}`,
            sub: `Res ${cell.resolution} · ${cell.riskLevel.toUpperCase()} (${cell.combinedRiskVal.toFixed(
              2
            )})`,
            kind: "station",
            pos3D: mapToScene3D(cell.centerXm, cell.centerYm, 2.2, globeMode),
            inspect: cell.inspect,
          });
        }
      }

      for (const [key, b] of Object.entries(buckets)) {
        if (b.verts.length === 0) continue;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute(
          "position",
          new THREE.Float32BufferAttribute(b.verts, 3)
        );
        const mat = new THREE.LineBasicMaterial({
          color: b.color,
          transparent: true,
          opacity: key === "Selected" ? 1.0 : 0.78,
        });
        const segs = new THREE.LineSegments(geo, mat);
        st.dynamicGroup.add(segs);
      }
    }

    // A. Predicted 15% & 40% Sea-Ice Contours + Drift Vectors
    if (forecast?.ice_contours?.length) {
      const leadIdx = Math.max(
        0,
        Math.min(6, timelineStep <= 0 ? 4 : timelineStep - 1)
      );
      const contourObj =
        forecast.ice_contours[leadIdx] || forecast.ice_contours[4];
      if (contourObj && showIceContours) {
        if (contourObj.edge15_pred?.length > 2) {
          addLine3D(contourObj.edge15_pred, 0x38bdf8, 0.35, true);
        }
        if (contourObj.pack40_pred?.length > 2) {
          addLine3D(contourObj.pack40_pred, 0xfb7185, 0.48, true);
        } else if (contourObj.heavy40_pred?.length > 2) {
          addLine3D(contourObj.heavy40_pred, 0xfb7185, 0.48, true);
        }
      }
      if (contourObj && showIceVectors && contourObj.vectors?.length) {
        for (const vec of contourObj.vectors) {
          addLine3D(
            [
              [vec.x0, vec.y0],
              [vec.x1, vec.y1],
            ],
            vec.deltaSic > 0.03 ? 0xfbbf24 : 0x7dd3fc,
            0.38,
            false
          );
        }
      }
    }

    // B. Overland Antarctic Roads & Ice-Sheet Scientific Traverses
    if (showRoads && scenario.roads_and_traverses?.length) {
      for (const road of scenario.roads_and_traverses) {
        if (!road.xy || road.xy.length < 2) continue;
        const res = addLine3D(road.xy, 0xfde047, 0.55, true);
        if (res && res.pts.length >= 2) {
          const midCoord = road.xy[Math.floor(road.xy.length / 2)];
          newLabels.push({
            id: road.id,
            text: road.name.split("(")[0].trim(),
            sub: "Overland Traverse",
            kind: "road",
            pos3D: mapToScene3D(midCoord[0], midCoord[1], 1.8, globeMode),
            inspect: {
              kind: "Antarctic Overland Road / Traverse",
              title: road.name,
              subtitle: road.type,
              metrics: [
                { label: "Surface Type", value: road.surface },
                { label: "Waypoints", value: `${road.xy.length} traverse nodes` },
              ],
            },
          });
        }
      }
    }

    // C. Mountain Summit 3D Markers & Labels
    if (showGraticule && scenario.mountains?.length) {
      for (const mt of scenario.mountains) {
        const [sx, sz] = mapToSceneXZ(mt.x_m, mt.y_m);
        const peakY = sampleElevationSceneY(mt.x_m, mt.y_m);
        const coneGeo = new THREE.ConeGeometry(0.95, 2.2, 4);
        const coneMat = new THREE.MeshStandardMaterial({
          color: 0xe2e8f0,
          emissive: 0x38bdf8,
          emissiveIntensity: 0.22,
          roughness: 0.35,
        });
        const cone = new THREE.Mesh(coneGeo, coneMat);
        const p3 = flatXZToSceneVec3(sx, sz, peakY + 0.9, globeMode);
        cone.position.copy(p3);
        orientToGlobeNormal(cone, sx, sz);
        const inspectObj = {
          kind: "Antarctic Mountain Range / Nunatak",
          title: mt.name,
          subtitle: `${Math.abs(mt.lat).toFixed(1)}°S, ${Math.abs(
            mt.lon
          ).toFixed(1)}°E · Summit +${mt.peak_m} m`,
          metrics: [
            { label: "Summit Elevation", value: `+${mt.peak_m} m (REMA DEM)` },
            { label: "Geological Feature", value: mt.description },
          ],
        };
        cone.userData.inspect = inspectObj;
        st.dynamicGroup.add(cone);

        newLabels.push({
          id: mt.id,
          text: `▲ ${mt.name}`,
          sub: `+${mt.peak_m}m`,
          kind: "mountain",
          pos3D: flatXZToSceneVec3(sx, sz, peakY + 2.5, globeMode),
          inspect: inspectObj,
        });
      }
    }

    // D. Antarctic Research Stations & Entry Gate
    if (showStations && scenario.stations) {
      const stationKeys = [
        "ice_entry",
        "bharati",
        "maitri",
        "davis",
        "mawson",
        "syowa",
      ];
      for (const key of stationKeys) {
        const stInfo = scenario.stations[key];
        if (!stInfo || !stInfo.in_grid) continue;
        const [sx, sz] = mapToSceneXZ(stInfo.x_m, stInfo.y_m);
        const baseY = sampleElevationSceneY(stInfo.x_m, stInfo.y_m);
        const isPrimary =
          key === "bharati" || key === "maitri" || key === "ice_entry";
        const colorHex =
          key === "ice_entry"
            ? 0x06b6d4
            : isPrimary
            ? 0xf43f5e
            : 0x10b981;

        const inspectObj = {
          kind: "Antarctic Research Station / Gate",
          title: stInfo.name,
          subtitle: `${stInfo.country} · ${Math.abs(stInfo.lat).toFixed(
            2
          )}°S, ${Math.abs(stInfo.lon).toFixed(2)}°E`,
          metrics: [
            { label: "Operational Role", value: stInfo.role },
            {
              label: "Elevation",
              value: `+${stInfo.elevation_m || 25} m above MSL`,
            },
            {
              label: "Grid Cell",
              value: `Row ${stInfo.row}, Col ${stInfo.col}`,
            },
          ],
        };

        const pillarH = isPrimary ? 4.6 : 3.2;
        const stGroup = new THREE.Group();
        stGroup.position.copy(flatXZToSceneVec3(sx, sz, baseY, globeMode));
        orientToGlobeNormal(stGroup, sx, sz);

        const pillarGeo = new THREE.CylinderGeometry(0.26, 0.26, pillarH, 12);
        const pillarMat = new THREE.MeshStandardMaterial({
          color: colorHex,
          emissive: colorHex,
          emissiveIntensity: 0.65,
        });
        const pillar = new THREE.Mesh(pillarGeo, pillarMat);
        pillar.position.set(0, pillarH / 2, 0);
        pillar.userData.inspect = inspectObj;
        stGroup.add(pillar);

        const headGeo = new THREE.SphereGeometry(isPrimary ? 0.9 : 0.65, 16, 16);
        const head = new THREE.Mesh(headGeo, pillarMat);
        head.position.set(0, pillarH + 0.35, 0);
        head.userData.inspect = inspectObj;
        stGroup.add(head);

        st.dynamicGroup.add(stGroup);

        if (isPrimary) {
          const ringGeo = new THREE.RingGeometry(0.9, 1.3, 28);
          ringGeo.rotateX(-Math.PI / 2);
          const ringMat = new THREE.MeshBasicMaterial({
            color: colorHex,
            transparent: true,
            opacity: 0.75,
            side: THREE.DoubleSide,
          });
          const ring = new THREE.Mesh(ringGeo, ringMat);
          ring.position.copy(
            flatXZToSceneVec3(sx, sz, baseY + 0.15, globeMode)
          );
          orientToGlobeNormal(ring, sx, sz);
          ring.userData = { kind: "sonar", offset: key === "bharati" ? 0 : 0.5 };
          st.pulseGroup.add(ring);
        }

        newLabels.push({
          id: `st-${key}`,
          text: stInfo.name.split("(")[0].trim().toUpperCase(),
          sub: `${Math.abs(stInfo.lat).toFixed(1)}°S, ${Math.abs(
            stInfo.lon
          ).toFixed(1)}°E`,
          kind: isPrimary ? "station-primary" : "station",
          pos3D: flatXZToSceneVec3(
            sx,
            sz,
            baseY + pillarH + 1.5,
            globeMode
          ),
          inspect: inspectObj,
        });
      }
    }

    // E. 3D Tabular Icebergs (D-28, B-22A, A-74, A-76A) + 7-Day Drift Tracks & Uncertainty Cones
    if (showIcebergs && icebergs?.length) {
      for (const berg of icebergs) {
        const track = berg.track || [];
        const history = berg.history || [];

        if (history.length > 1) {
          addLine3D(
            history.map((p) => [p.x_m, p.y_m]),
            0x94a3b8,
            0.32,
            true
          );
        }
        if (track.length > 1) {
          addLine3D(
            track.map((p) => [p.x_m, p.y_m]),
            0xf59e0b,
            0.42,
            false
          );
        }

        let activePt = {
          x_m: berg.x_m,
          y_m: berg.y_m,
          lon: berg.lon,
          lat: berg.lat,
        };
        if (timelineStep < 0 && history.length) {
          const targetLead = Math.max(-5, timelineStep);
          activePt = history.reduce((best, cur) =>
            Math.abs(cur.lead_days - targetLead) <
            Math.abs(best.lead_days - targetLead)
              ? cur
              : best
          );
        } else if (timelineStep > 0 && track.length) {
          activePt = track.reduce((best, cur) =>
            Math.abs(cur.lead_days - timelineStep) <
            Math.abs(best.lead_days - timelineStep)
              ? cur
              : best
          );
        }

        const [bx, bz] = mapToSceneXZ(activePt.x_m, activePt.y_m);
        const bergL = Math.max(1.8, (berg.length_km || 25) / 10);
        const bergW = Math.max(1.2, (berg.width_km || 15) / 10);
        const bergH = 1.45;

        const bergGroup = new THREE.Group();
        bergGroup.position.copy(
          flatXZToSceneVec3(bx, bz, bergH / 2 + 0.15, globeMode)
        );
        orientToGlobeNormal(bergGroup, bx, bz);

        const bergGeo = new THREE.BoxGeometry(bergL, bergH, bergW);
        const bergMat = new THREE.MeshStandardMaterial({
          color: 0xe0f2fe,
          emissive: 0x38bdf8,
          emissiveIntensity: 0.25,
          roughness: 0.25,
        });
        const bergMesh = new THREE.Mesh(bergGeo, bergMat);
        bergMesh.rotation.y = 0.45;

        const mlC = berg.ml_caution;
        const cShort = mlC?.caution_short || "CAUTION";
        const cPct = mlC?.probability_pct ?? 54;
        const cHex =
          mlC?.caution_color === "#f43f5e"
            ? 0xf43f5e
            : mlC?.caution_color === "#fb923c"
            ? 0xfb923c
            : mlC?.caution_color === "#10b981"
            ? 0x10b981
            : 0xf59e0b;
        const topDrivers = (mlC?.feature_attributions || [])
          .slice(0, 3)
          .map((f) => `${f.feature} (${f.share_pct}%)`)
          .join(" · ");

        const inspectBerg = {
          kind: "ML-Assessed Antarctic Tabular Iceberg (USNIC / BYU)",
          title: `${berg.name || `Tabular Berg ${berg.id}`} · ML ${cShort} (${cPct}%)`,
          subtitle: `${Math.abs(activePt.lat).toFixed(2)}°S, ${Math.abs(
            activePt.lon
          ).toFixed(2)}°E · ${berg.size_nm}`,
          metrics: [
            {
              label: "ML Caution Level & Probability",
              value: `${mlC?.caution_level || "MODERATE CAUTION"} (${cPct}% risk · ${
                mlC?.confidence_pct ?? 88
              }% conf.)`,
            },
            {
              label: "Why Risky (ML Risk Drivers)",
              value:
                mlC?.risk_reasons?.slice(0, 2).join(" · ") ||
                "Active drift cone & marginal sea-ice convergence",
            },
            {
              label: "Top Feature Attributions",
              value: topDrivers || "Proximity & Drift · Sea-Ice Compression",
            },
            {
              label: "Recommended Navigation Action",
              value:
                mlC?.recommended_action ||
                "Maintain radar watch and route outside 7-day drift cone",
            },
            {
              label: "Freeboard / Draft & Drift",
              value: `+${berg.freeboard_m || 40} m / -${berg.draft_m || 220} m · ${
                berg.drift_km_day || 11.4
              } km/day`,
            },
          ],
        };
        bergMesh.userData.inspect = inspectBerg;
        bergGroup.add(bergMesh);
        st.dynamicGroup.add(bergGroup);

        const coneRingGeo = new THREE.RingGeometry(
          bergL * 0.85,
          bergL * 1.35,
          28
        );
        coneRingGeo.rotateX(-Math.PI / 2);
        const coneRingMat = new THREE.MeshBasicMaterial({
          color: cHex,
          transparent: true,
          opacity: 0.65,
          side: THREE.DoubleSide,
        });
        const coneRing = new THREE.Mesh(coneRingGeo, coneRingMat);
        coneRing.position.copy(flatXZToSceneVec3(bx, bz, 0.22, globeMode));
        orientToGlobeNormal(coneRing, bx, bz);
        st.dynamicGroup.add(coneRing);

        newLabels.push({
          id: `berg-${berg.id}`,
          text: `BERG ${berg.id} · ML ${cShort} ${cPct}%`,
          sub: `${berg.size_nm} · ${berg.drift_km_day || 11} km/d`,
          kind: "berg",
          pos3D: flatXZToSceneVec3(bx, bz, bergH + 1.4, globeMode),
          inspect: inspectBerg,
        });
      }
    }

    // F. Optimal A* Vessel Route, Baseline Route & 3D Ship Model
    if (showRoutes && routeData) {
      const stXy = routeData.static?.xy;
      const fcXy = routeData.forecast_aware?.xy;
      const fcMetrics = routeData.forecast_aware?.metrics;
      const stMetrics = routeData.static?.metrics;

      if (stXy && stXy.length > 1) {
        addRouteRibbon3D(stXy, 0xf43f5e, 0.24, 0.42, {
          kind: "Baseline Climatology Route",
          title: "Naive Climatological Corridor",
          subtitle: "Planned on 10-year historical mean without U-Net forecast",
          metrics: [
            {
              label: "Heavy-Ice Exposure",
              value: `${stMetrics?.heavy_ice_hours ?? "—"} h`,
            },
            { label: "Duration", value: `${stMetrics?.hours ?? "—"} h` },
            { label: "Distance", value: `${stMetrics?.distance_km ?? "—"} km` },
          ],
        });
      }

      if (fcXy && fcXy.length > 1) {
        const res = addRouteRibbon3D(fcXy, 0x22d3ee, 0.4, 0.62, {
          kind: "U-Net Forecast-Aware Optimal Route",
          title: "Optimal A* Avoidance Corridor",
          subtitle: "Time-dependent 8-neighbor route avoiding pack ridges & bergs",
          metrics: [
            {
              label: "Heavy-Ice Exposure",
              value: `${fcMetrics?.heavy_ice_hours ?? 0} h`,
            },
            { label: "Duration", value: `${fcMetrics?.hours ?? "—"} h` },
            { label: "Distance", value: `${fcMetrics?.distance_km ?? "—"} km` },
          ],
        });

        if (res && res.pts.length > 4) {
          for (let cIdx = 0; cIdx < 5; cIdx++) {
            const chevGeo = new THREE.ConeGeometry(0.58, 1.5, 4);
            chevGeo.rotateX(Math.PI / 2);
            const chevMat = new THREE.MeshBasicMaterial({
              color: 0xa5f3fc,
            });
            const chev = new THREE.Mesh(chevGeo, chevMat);
            chev.userData = {
              kind: "chevronStream",
              points: res.pts,
              offset: cIdx / 5,
            };
            st.pulseGroup.add(chev);
          }
        }

        if (showCourseCorrections && routeData.course_corrections?.length) {
          for (const cc of routeData.course_corrections) {
            const [cx, cz] = mapToSceneXZ(cc.fc_x_m, cc.fc_y_m);
            const ccInspect = {
              kind: "ML-Guided Course Correction Maneuver",
              title: `${cc.id}: ${cc.maneuver}`,
              subtitle: `Voyage T+${cc.hour}h · COG ${cc.cog_deg}°`,
              metrics: [
                {
                  label: "Why Risky (ML Driver)",
                  value: cc.ml_why_risky || cc.reason,
                },
                {
                  label: "ML Caution Risk Avoided",
                  value: `-${
                    cc.ml_caution_avoided_pct ?? cc.sic_reduction_pct
                  }% (${cc.ml_caution_level_avoided || "HIGH CAUTION"})`,
                },
                {
                  label: "Ice Exposure Reduction",
                  value: `-${cc.sic_reduction_pct}% SIC (+${cc.deviation_km} km offset)`,
                },
              ],
            };
            const markerGeo = new THREE.OctahedronGeometry(0.85, 0);
            const markerMat = new THREE.MeshStandardMaterial({
              color: 0xfbbf24,
              emissive: 0xf59e0b,
              emissiveIntensity: 0.7,
            });
            const marker = new THREE.Mesh(markerGeo, markerMat);
            marker.position.copy(
              flatXZToSceneVec3(cx, cz, 1.35, globeMode)
            );
            orientToGlobeNormal(marker, cx, cz);
            marker.userData.inspect = ccInspect;
            st.dynamicGroup.add(marker);
          }
        }

        if (activeShipTelemetry) {
          const [sx, sz] = mapToSceneXZ(
            activeShipTelemetry.x_m,
            activeShipTelemetry.y_m
          );
          const [nx, nz] = mapToSceneXZ(
            activeShipTelemetry.next_x_m,
            activeShipTelemetry.next_y_m
          );

          const shipGroup = new THREE.Group();
          const shipPos3D = flatXZToSceneVec3(sx, sz, 1.45, globeMode);
          const nextPos3D = flatXZToSceneVec3(nx, nz, 1.45, globeMode);
          shipGroup.position.copy(shipPos3D);
          if (shipPos3D.distanceTo(nextPos3D) > 0.01) {
            shipGroup.lookAt(nextPos3D);
          }

          const shipInspect = {
            kind: "Active Ice-Class Research Vessel",
            title: scenario?.ship?.name || "RV Polar Explorer",
            subtitle: `${Math.abs(activeShipTelemetry.lat).toFixed(
              2
            )}°S, ${Math.abs(activeShipTelemetry.lon).toFixed(
              2
            )}°E · Heading COG ${activeShipTelemetry.cog_deg}°`,
            metrics: [
              {
                label: "Vessel Speed",
                value: `${activeShipTelemetry.speed_kmh} km/h`,
              },
              {
                label: "Local Sea-Ice Concentration",
                value: `${(activeShipTelemetry.sic * 100).toFixed(1)}% SIC`,
              },
              {
                label: "Live ML Iceberg Caution",
                value: `${
                  activeShipTelemetry.caution_level || "LOW / SAFE"
                } (${Math.round(
                  (activeShipTelemetry.ml_caution_prob ?? 0.14) * 100
                )}% · ${activeShipTelemetry.nearest_iceberg_id || "D-28"} ${
                  activeShipTelemetry.nearest_iceberg_km ?? 110
                } km)`,
              },
              {
                label: "Voyage Elapsed",
                value: `T+${activeShipTelemetry.hour}h (${activeShipTelemetry.progressPct}%)`,
              },
            ],
          };

          // Enlarged High-Visibility Neon Lime-Chartreuse Icebreaker Hull (2.7x larger for instant recognition)
          const hullGeo = new THREE.BoxGeometry(3.2, 1.85, 7.6);
          const hullMat = new THREE.MeshStandardMaterial({
            color: 0xa3e635,
            emissive: 0x65a30d,
            emissiveIntensity: 0.88,
            roughness: 0.22,
            metalness: 0.15,
          });
          const hullMesh = new THREE.Mesh(hullGeo, hullMat);
          hullMesh.userData.inspect = shipInspect;
          shipGroup.add(hullMesh);

          // Glowing Neon Ice-Belt Trim Band around Vessel Hull
          const beltGeo = new THREE.BoxGeometry(3.5, 0.48, 7.85);
          const beltMat = new THREE.MeshBasicMaterial({
            color: 0xd9f99d,
          });
          const beltMesh = new THREE.Mesh(beltGeo, beltMat);
          beltMesh.position.set(0, 0.2, 0);
          beltMesh.userData.inspect = shipInspect;
          shipGroup.add(beltMesh);

          // Enlarged Reinforced Icebreaker Bow Wedge
          const bowGeo = new THREE.ConeGeometry(2.35, 3.8, 4);
          bowGeo.rotateX(Math.PI / 2);
          bowGeo.rotateZ(Math.PI / 4);
          const bowMesh = new THREE.Mesh(bowGeo, hullMat);
          bowMesh.position.set(0, 0.05, 5.15);
          bowMesh.userData.inspect = shipInspect;
          shipGroup.add(bowMesh);

          // Multi-Tier High-Contrast White & Electric Cyan Bridge Superstructure
          const bridgeGeo = new THREE.BoxGeometry(2.45, 1.75, 2.8);
          const bridgeMat = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            emissive: 0x38bdf8,
            emissiveIntensity: 0.45,
            roughness: 0.2,
          });
          const bridgeMesh = new THREE.Mesh(bridgeGeo, bridgeMat);
          bridgeMesh.position.set(0, 1.65, 0.2);
          bridgeMesh.userData.inspect = shipInspect;
          shipGroup.add(bridgeMesh);

          const upperBridgeGeo = new THREE.BoxGeometry(1.8, 1.15, 1.65);
          const upperBridgeMat = new THREE.MeshStandardMaterial({
            color: 0xecfccb,
            emissive: 0xa3e635,
            emissiveIntensity: 0.65,
          });
          const upperBridgeMesh = new THREE.Mesh(upperBridgeGeo, upperBridgeMat);
          upperBridgeMesh.position.set(0, 2.95, 0.45);
          upperBridgeMesh.userData.inspect = shipInspect;
          shipGroup.add(upperBridgeMesh);

          // Tall Radar Mast + High-Visibility Glowing Beacon Sphere
          const mastGeo = new THREE.CylinderGeometry(0.18, 0.24, 2.8, 10);
          const mastMesh = new THREE.Mesh(mastGeo, beltMat);
          mastMesh.position.set(0, 4.4, 0.45);
          mastMesh.userData.inspect = shipInspect;
          shipGroup.add(mastMesh);

          const beaconGeo = new THREE.SphereGeometry(0.78, 16, 16);
          const beaconMat = new THREE.MeshBasicMaterial({
            color: 0xfef08a,
          });
          const beaconMesh = new THREE.Mesh(beaconGeo, beaconMat);
          beaconMesh.position.set(0, 5.9, 0.45);
          beaconMesh.userData.inspect = shipInspect;
          shipGroup.add(beaconMesh);

          // Vertical Translucent Locator Beam so Ship is Easily Noticeable from Full-Globe Orbit
          const beamGeo = new THREE.CylinderGeometry(0.15, 0.65, 11.5, 12);
          const beamMat = new THREE.MeshBasicMaterial({
            color: 0xa3e635,
            transparent: true,
            opacity: 0.42,
          });
          const beamMesh = new THREE.Mesh(beamGeo, beamMat);
          beamMesh.position.set(0, 6.5, 0);
          beamMesh.userData.inspect = shipInspect;
          shipGroup.add(beamMesh);

          // Spinning X-Band Marine Radar Scanner Bar atop Mast
          const radarBarGeo = new THREE.BoxGeometry(2.6, 0.24, 0.38);
          const radarBarMat = new THREE.MeshBasicMaterial({
            color: 0x22d3ee,
          });
          const radarBarMesh = new THREE.Mesh(radarBarGeo, radarBarMat);
          radarBarMesh.position.set(0, 5.15, 0.45);
          shipGroup.add(radarBarMesh);
          st.shipRadarBar = radarBarMesh;

          // Sweeping Forward Surface Radar Sector Cone ahead of Vessel Bow
          const radarConeGeo = new THREE.CircleGeometry(
            10.5,
            24,
            Math.PI * 0.34,
            Math.PI * 0.32
          );
          radarConeGeo.rotateX(-Math.PI / 2);
          const radarConeMat = new THREE.MeshBasicMaterial({
            color: 0xa3e635,
            transparent: true,
            opacity: 0.22,
            side: THREE.DoubleSide,
          });
          const radarConeMesh = new THREE.Mesh(radarConeGeo, radarConeMat);
          radarConeMesh.position.set(0, -0.75, 4.2);
          shipGroup.add(radarConeMesh);
          st.shipRadarCone = radarConeMesh;

          // Animated Kelvin V-Wave & Glowing Stern Foam Wake
          const wakeGroup = new THREE.Group();
          const wakeWingMat = new THREE.MeshBasicMaterial({
            color: 0x22d3ee,
            transparent: true,
            opacity: 0.68,
          });
          const wakeGeo = new THREE.BoxGeometry(0.38, 0.18, 8.2);
          const wakePort = new THREE.Mesh(wakeGeo, wakeWingMat);
          wakePort.position.set(-2.9, -0.72, -6.5);
          wakePort.rotation.y = 0.28;
          const wakeStbd = new THREE.Mesh(wakeGeo, wakeWingMat);
          wakeStbd.position.set(2.9, -0.72, -6.5);
          wakeStbd.rotation.y = -0.28;

          const sternTrailGeo = new THREE.BoxGeometry(1.6, 0.14, 9.5);
          const sternTrailMat = new THREE.MeshBasicMaterial({
            color: 0x10b981,
            transparent: true,
            opacity: 0.55,
          });
          const sternTrail = new THREE.Mesh(sternTrailGeo, sternTrailMat);
          sternTrail.position.set(0, -0.76, -8.2);
          wakeGroup.add(wakePort, wakeStbd, sternTrail);
          shipGroup.add(wakeGroup);
          st.shipWakeGroup = wakeGroup;

          st.dynamicGroup.add(shipGroup);
          st.shipGroup = shipGroup;

          // 3 Large High-Contrast Neon Lime Sonar Target Rings around Ship
          const shipRings = [];
          for (let rIdx = 0; rIdx < 3; rIdx++) {
            const ringGeo = new THREE.RingGeometry(2.4, 3.25, 36);
            ringGeo.rotateX(-Math.PI / 2);
            const ringMat = new THREE.MeshBasicMaterial({
              color: rIdx % 2 === 0 ? 0xa3e635 : 0xfef08a,
              transparent: true,
              opacity: 0.9,
              side: THREE.DoubleSide,
            });
            const ringMesh = new THREE.Mesh(ringGeo, ringMat);
            ringMesh.position.copy(flatXZToSceneVec3(sx, sz, 0.55, globeMode));
            orientToGlobeNormal(ringMesh, sx, sz);
            ringMesh.userData = { kind: "sonar", offset: rIdx * 0.33 };
            st.pulseGroup.add(ringMesh);
            shipRings.push(ringMesh);
          }
          st.shipSonarRings = shipRings;

          const shipLblObj = {
            id: "vessel-rv-polar",
            text: "SHIP: RV POLAR EXPLORER",
            sub: `${Math.abs(activeShipTelemetry.lat).toFixed(1)}°S, ${Math.abs(
              activeShipTelemetry.lon
            ).toFixed(1)}°E · COG ${activeShipTelemetry.cog_deg}° · ${
              activeShipTelemetry.speed_kmh
            } km/h`,
            kind: "ship",
            pos3D: flatXZToSceneVec3(sx, sz, 8.8, globeMode),
            inspect: shipInspect,
          };
          st.shipLabelEntry = shipLblObj;
          newLabels.push(shipLblObj);
        }
      }
    }

    // F2. Clean Animated Short Wind & Current Wisps + Callout Badges on 3D Globe / Map (No Long Static Purple Lines)
    if (showWeatherFigures && weatherOverlays) {
      // 1. Short Moving Wind & Current Wisps (2 staggered short wisps per track, zero static guide lines)
      if (weatherOverlays.flowTracks?.length) {
        const tailLen = 5;
        weatherOverlays.flowTracks.forEach((ft) => {
          const raw3D = ft.pts.map(([xm, ym]) =>
            mapToScene3D(xm, ym, ft.isCurrentTrack ? 0.42 : 0.68, globeMode)
          );
          if (raw3D.length < 3) return;
          const curve = new THREE.CatmullRomCurve3(raw3D);
          const curvePts = curve.getPoints(26);

          // Spawn 2 staggered short moving wind wisps along the invisible flow curve
          for (const shift of [0, 0.5]) {
            const positions = new Float32Array(tailLen * 3);
            const colors = new Float32Array(tailLen * 3);
            const tailColor = new THREE.Color(
              ft.isCurrentTrack
                ? 0x0284c7
                : ft.isKatabaticOrCoastal
                  ? 0x38bdf8
                  : 0x7dd3fc
            );
            const headColor = new THREE.Color(
              ft.isCurrentTrack ? 0xbae6fd : 0xf8fafc
            );
            const tmpColor = new THREE.Color();

            for (let k = 0; k < tailLen; k++) {
              const frac = k / (tailLen - 1);
              tmpColor.copy(tailColor).lerp(headColor, frac * frac);
              const intensity = 0.22 + 0.78 * Math.pow(frac, 1.6);
              colors[k * 3] = tmpColor.r * intensity;
              colors[k * 3 + 1] = tmpColor.g * intensity;
              colors[k * 3 + 2] = tmpColor.b * intensity;

              const pt = curvePts[Math.min(curvePts.length - 1, k)];
              positions[k * 3] = pt.x;
              positions[k * 3 + 1] = pt.y;
              positions[k * 3 + 2] = pt.z;
            }

            const cometGeo = new THREE.BufferGeometry();
            cometGeo.setAttribute(
              "position",
              new THREE.BufferAttribute(positions, 3)
            );
            cometGeo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
            const cometMat = new THREE.LineBasicMaterial({
              vertexColors: true,
              transparent: true,
              opacity: 0.94,
            });
            const cometLine = new THREE.Line(cometGeo, cometMat);

            // Small glowing droplet at the leading tip of each short wind wisp
            const tipGeo = new THREE.SphereGeometry(
              ft.isCurrentTrack ? 0.16 : 0.2,
              8,
              8
            );
            const tipMat = new THREE.MeshBasicMaterial({
              color: ft.isCurrentTrack ? 0x7dd3fc : 0xf0f9ff,
            });
            const tipMesh = new THREE.Mesh(tipGeo, tipMat);
            st.pulseGroup.add(tipMesh);

            cometLine.userData = {
              kind: "windComet",
              curvePts,
              tailLen,
              offset: (ft.phaseOffset + shift) % 1,
              speedFactor: ft.speedFactor,
              headMesh: tipMesh,
            };
            st.pulseGroup.add(cometLine);
          }
        });
      }

      // 2. Floating Speed & Compass Callout Pills on the Globe
      if (weatherOverlays.windBadges?.length) {
        for (const wb of weatherOverlays.windBadges) {
          newLabels.push({
            id: wb.id,
            text: wb.isPrimaryCallout
              ? `${wb.speedKmh} km/h ${wb.arrow} ${wb.compass}`
              : `${wb.speedKmh} ${wb.arrow}`,
            sub: wb.isPrimaryCallout
              ? `${wb.name} · Current ${wb.currentCmS} cm/s`
              : wb.name,
            kind: wb.isPrimaryCallout ? "wind-callout" : "wind-pill",
            pos3D: mapToScene3D(wb.xm, wb.ym, 1.9, globeMode),
            inspect: wb.inspect,
          });
        }
      }
    }

    // G. User-Selected Custom Destination Pin
    if (selectedDestination) {
      const [dx, dz] = mapToSceneXZ(
        selectedDestination.x_m,
        selectedDestination.y_m
      );

      const destInspect = {
        kind: "Selected Custom Destination",
        title:
          selectedDestination.custom_name ||
          selectedDestination.label ||
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
            label: "Distance from Start / Ship",
            value: `${selectedDestination.direct_distance_km ?? "—"} km (${
              selectedDestination.direct_distance_nm ?? "—"
            } NM)`,
          },
        ],
      };

      const pinH = 6.6;
      const pinGroup = new THREE.Group();
      pinGroup.position.copy(
        mapToScene3D(
          selectedDestination.x_m,
          selectedDestination.y_m,
          0,
          globeMode
        )
      );
      orientToGlobeNormal(pinGroup, dx, dz);

      const stemGeo = new THREE.CylinderGeometry(0.25, 0.25, pinH, 12);
      const stemMat = new THREE.MeshStandardMaterial({
        color: 0xec4899,
        emissive: 0xf43f5e,
        emissiveIntensity: 0.75,
      });
      const stemMesh = new THREE.Mesh(stemGeo, stemMat);
      stemMesh.position.set(0, pinH / 2, 0);
      stemMesh.userData.inspect = destInspect;
      pinGroup.add(stemMesh);

      const orbGeo = new THREE.OctahedronGeometry(1.2, 1);
      const orbMesh = new THREE.Mesh(orbGeo, stemMat);
      orbMesh.position.set(0, pinH + 0.55, 0);
      orbMesh.userData.inspect = destInspect;
      pinGroup.add(orbMesh);

      st.dynamicGroup.add(pinGroup);

      const dRingGeo = new THREE.RingGeometry(1.0, 1.4, 32);
      dRingGeo.rotateX(-Math.PI / 2);
      const dRingMat = new THREE.MeshBasicMaterial({
        color: 0xf43f5e,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
      });
      const dRing = new THREE.Mesh(dRingGeo, dRingMat);
      dRing.position.copy(
        mapToScene3D(
          selectedDestination.x_m,
          selectedDestination.y_m,
          0.35,
          globeMode
        )
      );
      orientToGlobeNormal(dRing, dx, dz);
      dRing.userData = { kind: "sonar", offset: 0.25 };
      st.pulseGroup.add(dRing);

      if (
        selectedDestination.is_land &&
        selectedDestination.nav_x_m != null &&
        selectedDestination.nav_y_m != null
      ) {
        addLine3D(
          [
            [selectedDestination.nav_x_m, selectedDestination.nav_y_m],
            [selectedDestination.x_m, selectedDestination.y_m],
          ],
          0xf43f5e,
          0.65,
          true
        );
      }

      newLabels.push({
        id: "selected-destination-pin",
        text: `DESTINATION: ${
          selectedDestination.custom_name ||
          selectedDestination.nearest_feature ||
          "SELECTED POINT"
        }`,
        sub: `${Math.abs(selectedDestination.lat).toFixed(2)}°S, ${Math.abs(
          selectedDestination.lon
        ).toFixed(2)}°E · ${selectedDestination.direct_distance_km ?? "—"} km`,
        kind: "destination",
        pos3D: mapToScene3D(
          selectedDestination.x_m,
          selectedDestination.y_m,
          pinH + 2.1,
          globeMode
        ),
        inspect: destInspect,
      });
    }

    st.labels = newLabels;
    setLabelVersion((v) => v + 1);
  }, [
    scenario,
    forecast,
    timelineStep,
    globeMode,
    verticalExaggeration,
    showIceContours,
    showIceVectors,
    showRoutes,
    showCourseCorrections,
    showIcebergs,
    showStations,
    showGraticule,
    showRoads,
    showWeatherFigures,
    weatherOverlays,
    showH3Grid,
    h3Cells,
    selectedH3Index,
    routeData,
    icebergs,
    Boolean(activeShipTelemetry),
    selectedDestination,
  ]);

  const currentLabels = threeRef.current.labels || [];

  return (
    <div
      className={`dss-map3d-stage ${
        isSelectingDestination ? "selecting-dest-cursor" : ""
      }`}
    >
      {/* WebGL 3D Globe / Terrain Canvas Container */}
      <div ref={mountRef} className="dss-map3d-canvas-wrap" />

      {/* Crisp 3D-Projected HTML Map Labels Layer */}
      <div
        ref={overlayContainerRef}
        key={labelVersion}
        className="dss-map3d-labels-layer"
      >
        {currentLabels.map((lbl) => (
          <div
            key={lbl.id}
            className={`dss-3d-label kind-${lbl.kind}`}
            onClick={(e) => {
              e.stopPropagation();
              if (lbl.inspect) onInspectFeature?.(lbl.inspect);
            }}
          >
            <span className="dss-3d-lbl-title">{lbl.text}</span>
            {lbl.sub && <span className="dss-3d-lbl-sub">{lbl.sub}</span>}
          </div>
        ))}
      </div>

      {/* Interactive Hover Tooltip */}
      {hoverTooltip && (
        <div
          className="dss-map3d-tooltip"
          style={{
            transform: `translate3d(${hoverTooltip.x + 14}px, ${
              hoverTooltip.y + 14
            }px, 0)`,
          }}
        >
          <span className="dss-tt-kind">{hoverTooltip.kind}</span>
          <strong>{hoverTooltip.title}</strong>
          <span>{hoverTooltip.subtitle}</span>
          <span className="dss-tt-cta">
            {isSelectingDestination
              ? "Click map to set destination pin"
              : hoverTooltip.isFeature
              ? "Click to inspect telemetry"
              : "Drag to rotate · Scroll to zoom"}
          </span>
        </div>
      )}

      {/* On-Map Destination & 3D Globe Navigation Controls in Bottom-Right */}
      <div className="dss-map3d-nav-controls">
        <span className="dss-nav-hint">
          Left-Drag: Rotate Globe · Right-Drag / Shift: Pan · Scroll: Zoom
        </span>
        <div className="dss-nav-btn-group">
          <button
            type="button"
            className={`dss-onmap-dest-btn ${
              isSelectingDestination ? "active" : ""
            }`}
            onClick={() => onToggleSelectDestination?.()}
            title="Click to place or move a custom destination pin on the map"
          >
            {isSelectingDestination
              ? "Click Map to Place Pin..."
              : selectedDestination
              ? "Move Destination Pin"
              : "Choose Destination"}
          </button>
          {selectedDestination && (
            <button
              type="button"
              onClick={() => onClearDestination?.()}
              title="Clear custom destination pin"
            >
              Clear Pin
            </button>
          )}
          <button
            type="button"
            onClick={() => onToggleGlobeMode?.()}
            title="Switch between 3D Spherical Globe and 3D Planar Sector"
          >
            {globeMode ? "3D Globe [ON]" : "3D Sector"}
          </button>
          <button
            type="button"
            onClick={() => {
              threeRef.current.spherical.radius *= 0.82;
              clampCameraTargets();
            }}
            title="Zoom In 3D Camera"
          >
            + Zoom
          </button>
          <button
            type="button"
            onClick={() => {
              threeRef.current.spherical.radius *= 1.22;
              clampCameraTargets();
            }}
            title="Zoom Out 3D Camera"
          >
            - Zoom
          </button>
          <button
            type="button"
            onClick={() => {
              threeRef.current.spherical.theta -= 0.42;
              clampCameraTargets();
            }}
            title="Rotate 3D Globe Counter-Clockwise"
          >
            Rotate
          </button>
          <button
            type="button"
            onClick={() => {
              threeRef.current.spherical.phi =
                threeRef.current.spherical.phi > 0.42 ? 0.12 : 0.72;
              clampCameraTargets();
            }}
            title="Toggle between oblique 3D horizon tilt and top-down South Polar view"
          >
            Tilt
          </button>
          <button
            type="button"
            onClick={() => {
              threeRef.current.panXZ.x = 0;
              threeRef.current.panXZ.z = 0;
              threeRef.current.targetExtraY = 0;
              threeRef.current.spherical.radius = 158;
              threeRef.current.spherical.phi = 0.64;
              threeRef.current.spherical.theta = 0.0;
              clampCameraTargets();
            }}
            title="Reset 3D Globe center pivot and orientation"
          >
            Reset
          </button>
        </div>
      </div>
    </div>
  );
});

export default Map3DView;
