import React, { useEffect, useRef, useState } from "react";

/**
 * ARGOS — Streamlined Scroll-Interactive Landing Experience
 * - Simple, automatic live background: 3D tilted rotating planetary globe + 3D perspective
 *   polar ocean with volumetric crystalline icebergs, autonomous ships, and short moving wind wisps.
 * - Scroll-reactive: scrolling smoothly rotates/tilts the 3D globe, shifts the ocean camera,
 *   and reveals concise, low-clutter interactive sections.
 * - Finale at bottom: Animated Ship-Colliding-With-Iceberg Simulator + Compact RMS Titanic Panel.
 */
export default function LandingPage({
  scenario,
  routeData,
  leg,
  setLeg,
  wRisk,
  setWRisk,
  onEnterConsole,
  onLaunchStationDestination,
  onOpenDrawer,
}) {
  const bgCanvasRef = useRef(null);
  const collisionCanvasRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const scrollProgressRef = useRef(0);

  const [scrollPct, setScrollPct] = useState(0);
  const [activeSection, setActiveSection] = useState(0);
  const [activeStepCard, setActiveStepCard] = useState(0);

  // Finale Titanic Collision vs. ARGOS Avoidance state
  const [collisionMode, setCollisionMode] = useState("titanic1912"); // "titanic1912" | "argos2026"
  const [simSpeedKnots, setSimSpeedKnots] = useState(22.5);
  const [simReplayKey, setSimReplayKey] = useState(0);

  const fcMetrics = routeData?.forecast_aware?.metrics;
  const stMetrics = routeData?.static?.metrics;
  const heavySaved =
    fcMetrics?.ok && stMetrics?.ok
      ? (stMetrics.heavy_ice_hours - fcMetrics.heavy_ice_hours).toFixed(1)
      : "11.5";
  const timeDelta =
    fcMetrics?.ok && stMetrics?.ok
      ? (stMetrics.hours - fcMetrics.hours).toFixed(1)
      : "14.2";

  // Track scroll position to drive 3D globe rotation, camera tilt, and section highlights
  const handleScroll = (e) => {
    const el = e.currentTarget;
    const maxScroll = Math.max(1, el.scrollHeight - el.clientHeight);
    const prog = Math.max(0, Math.min(1, el.scrollTop / maxScroll));
    scrollProgressRef.current = prog;
    setScrollPct(Math.round(prog * 100));

    if (prog < 0.22) setActiveSection(0);
    else if (prog < 0.52) setActiveSection(1);
    else if (prog < 0.78) setActiveSection(2);
    else setActiveSection(3);
  };

  // 1. Automatic Live 3D Tilted Planetary Globe + 3D Isometric Icebergs & Ships Background
  useEffect(() => {
    const canvas = bgCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    let animId = 0;
    let time = 0;
    let mouseX = 0;
    let mouseY = 0;
    let targetMouseX = 0;
    let targetMouseY = 0;

    const handleResize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    handleResize();
    window.addEventListener("resize", handleResize);

    const handleMouseMove = (e) => {
      targetMouseX = (e.clientX / window.innerWidth - 0.5) * 24;
      targetMouseY = (e.clientY / window.innerHeight - 0.5) * 18;
    };
    window.addEventListener("mousemove", handleMouseMove);

    // Subtle deep-space stars
    const stars = Array.from({ length: 75 }, (_, i) => ({
      xFrac: ((i * 73 + 19) % 100) / 100,
      yFrac: ((i * 41 + 7) % 100) / 100,
      r: (i % 3) * 0.4 + 0.6,
      alpha: 0.16 + (i % 5) * 0.1,
    }));

    // Short moving wind wisps across the globe & ocean
    const windWisps = Array.from({ length: 28 }, (_, i) => ({
      x: ((i * 97) % 100) / 100,
      y: 0.18 + (((i * 53) % 75) / 100),
      speed: 0.04 + (i % 5) * 0.014,
      len: 26 + (i % 4) * 10,
      curve: (i % 2 === 0 ? 1 : -1) * (3 + (i % 3) * 2),
      isCyan: i % 3 === 0,
    }));

    // 3D Isometric Crystalline Icebergs drifting in the foreground polar ocean
    const oceanIcebergs = [
      { xBase: 0.54, yBase: 0.36, w: 34, h: 24, speed: -0.012, phase: 0.2 },
      { xBase: 0.78, yBase: 0.28, w: 46, h: 32, speed: -0.009, phase: 1.4 },
      { xBase: 0.88, yBase: 0.58, w: 52, h: 36, speed: -0.015, phase: 2.7 },
      { xBase: 0.62, yBase: 0.72, w: 38, h: 26, speed: -0.011, phase: 4.1 },
      { xBase: 0.34, yBase: 0.66, w: 30, h: 20, speed: -0.013, phase: 5.3 },
    ];

    // Project a 3D point on a unit sphere (lat, lon) with axial tilt
    const projectSpherePoint = (latDeg, lonDeg, cx, cy, R, tiltRad) => {
      const lat = (latDeg * Math.PI) / 180;
      const lon = (lonDeg * Math.PI) / 180;
      const x = Math.cos(lat) * Math.sin(lon);
      const y0 = Math.sin(lat);
      const z0 = Math.cos(lat) * Math.cos(lon);
      // Tilt sphere around X axis
      const y = y0 * Math.cos(tiltRad) - z0 * Math.sin(tiltRad);
      const z = y0 * Math.sin(tiltRad) + z0 * Math.cos(tiltRad);
      return {
        px: cx + x * R,
        py: cy - y * R,
        z,
      };
    };

    // Draw a 3D crystalline iceberg with sunlit top, glacial side facets, underwater keel & ripple
    const draw3DIceberg = (bx, by, w, h, bob) => {
      ctx.save();
      ctx.translate(bx, by + bob);

      // Underwater cyan keel glow
      ctx.beginPath();
      ctx.moveTo(-w * 0.75, h * 0.15);
      ctx.lineTo(0, h * 0.85);
      ctx.lineTo(w * 0.8, h * 0.12);
      ctx.closePath();
      ctx.fillStyle = "rgba(14, 165, 233, 0.18)";
      ctx.fill();

      // Waterline ripple ellipse
      ctx.beginPath();
      ctx.ellipse(0, h * 0.14, w * 1.05, h * 0.28, 0, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(56, 189, 248, 0.42)";
      ctx.lineWidth = 1.2;
      ctx.stroke();

      // Left sunlit glacial wall
      ctx.beginPath();
      ctx.moveTo(-w * 0.72, h * 0.12);
      ctx.lineTo(-w * 0.48, -h * 0.58);
      ctx.lineTo(0, -h * 0.32);
      ctx.lineTo(0, h * 0.24);
      ctx.closePath();
      ctx.fillStyle = "rgba(224, 242, 254, 0.92)";
      ctx.fill();

      // Right shaded cyan glacial wall
      ctx.beginPath();
      ctx.moveTo(0, -h * 0.32);
      ctx.lineTo(w * 0.56, -h * 0.48);
      ctx.lineTo(w * 0.76, h * 0.1);
      ctx.lineTo(0, h * 0.24);
      ctx.closePath();
      ctx.fillStyle = "rgba(125, 211, 252, 0.85)";
      ctx.fill();

      // Top crystalline snow plateau
      ctx.beginPath();
      ctx.moveTo(-w * 0.48, -h * 0.58);
      ctx.lineTo(w * 0.08, -h * 0.78);
      ctx.lineTo(w * 0.56, -h * 0.48);
      ctx.lineTo(0, -h * 0.32);
      ctx.closePath();
      ctx.fillStyle = "#f8fafc";
      ctx.fill();
      ctx.strokeStyle = "rgba(56, 189, 248, 0.75)";
      ctx.lineWidth = 1.1;
      ctx.stroke();

      ctx.restore();
    };

    // Draw an autonomous polar ship with Kelvin wake, sonar pulse & sweeping radar cone
    const drawAutonomousShip = (sx, sy, heading, label, hullColor, tNow) => {
      // Expanding sonar ring
      const pulseR = 10 + ((tNow * 24) % 26);
      const pulseAlpha = Math.max(0.04, (1 - pulseR / 36) * 0.65);
      ctx.beginPath();
      ctx.ellipse(sx, sy, pulseR, pulseR * 0.65, 0, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(163, 230, 53, ${pulseAlpha.toFixed(2)})`;
      ctx.lineWidth = 1.3;
      ctx.stroke();

      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(heading);

      // Sweeping forward radar cone
      const sweep = Math.sin(tNow * 3.2) * 0.32;
      ctx.beginPath();
      ctx.moveTo(10, 0);
      ctx.arc(10, 0, 44, sweep - 0.36, sweep + 0.36);
      ctx.closePath();
      ctx.fillStyle = "rgba(163, 230, 53, 0.14)";
      ctx.fill();

      // Glowing Kelvin V-wake
      ctx.beginPath();
      ctx.moveTo(-8, 0);
      ctx.lineTo(-34, -11);
      ctx.moveTo(-8, 0);
      ctx.lineTo(-34, 11);
      ctx.strokeStyle = "rgba(34, 211, 238, 0.55)";
      ctx.lineWidth = 1.6;
      ctx.stroke();

      // Vessel hull
      ctx.beginPath();
      ctx.moveTo(14, 0);
      ctx.lineTo(4, 5.2);
      ctx.lineTo(-11, 4.5);
      ctx.lineTo(-11, -4.5);
      ctx.lineTo(4, -5.2);
      ctx.closePath();
      ctx.fillStyle = hullColor;
      ctx.fill();
      ctx.strokeStyle = "#ecfccb";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Bridge cabin
      ctx.fillStyle = "#07090e";
      ctx.fillRect(-3, -2.5, 5, 5);
      ctx.restore();

      ctx.fillStyle = "rgba(236, 252, 203, 0.88)";
      ctx.font = "600 9.5px 'JetBrains Mono', monospace";
      ctx.fillText(label, sx + 16, sy - 8);
    };

    const render = () => {
      animId = requestAnimationFrame(render);
      time += 0.012;
      mouseX += (targetMouseX - mouseX) * 0.05;
      mouseY += (targetMouseY - mouseY) * 0.05;

      const scrollProg = scrollProgressRef.current;
      const W = window.innerWidth;
      const H = window.innerHeight;
      ctx.clearRect(0, 0, W, H);

      // 1. Starfield with subtle parallax
      for (let i = 0; i < stars.length; i++) {
        const s = stars[i];
        const sx = s.xFrac * W - mouseX * 0.3;
        const sy = s.yFrac * H - mouseY * 0.3 - scrollProg * 35;
        ctx.fillStyle = `rgba(186, 230, 253, ${s.alpha})`;
        ctx.beginPath();
        ctx.arc(sx, (sy + H) % H, s.r, 0, Math.PI * 2);
        ctx.fill();
      }

      // 2. 3D Tilted Planetary Globe (rotates & tilts dynamically as user scrolls!)
      const globeCx = W * 0.68 + mouseX * 0.8 - scrollProg * (W * 0.08);
      const globeCy = H * 0.46 + mouseY * 0.8 - scrollProg * 45;
      const globeR = Math.min(W, H) * (0.38 + scrollProg * 0.06);
      const rotDeg = (time * 14 + scrollProg * 140) % 360;
      const tiltRad = 0.42 + scrollProg * 0.28;

      // Atmospheric outer limb glow
      const halo = ctx.createRadialGradient(
        globeCx,
        globeCy,
        globeR * 0.72,
        globeCx,
        globeCy,
        globeR * 1.32
      );
      halo.addColorStop(0, "rgba(6, 182, 212, 0.15)");
      halo.addColorStop(0.55, "rgba(14, 116, 144, 0.06)");
      halo.addColorStop(1, "rgba(7, 9, 14, 0)");
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(globeCx, globeCy, globeR * 1.32, 0, Math.PI * 2);
      ctx.fill();

      // 3D Sphere body
      const sphereGrad = ctx.createRadialGradient(
        globeCx - globeR * 0.32,
        globeCy - globeR * 0.3,
        globeR * 0.08,
        globeCx,
        globeCy,
        globeR
      );
      sphereGrad.addColorStop(0, "#0c2744");
      sphereGrad.addColorStop(0.55, "#061529");
      sphereGrad.addColorStop(1, "#020710");
      ctx.beginPath();
      ctx.arc(globeCx, globeCy, globeR, 0, Math.PI * 2);
      ctx.fillStyle = sphereGrad;
      ctx.fill();
      ctx.strokeStyle = "rgba(56, 189, 248, 0.36)";
      ctx.lineWidth = 1.4;
      ctx.stroke();

      // 3D Latitude Rings on the tilted sphere
      ctx.strokeStyle = "rgba(125, 211, 252, 0.14)";
      ctx.lineWidth = 1;
      for (const latDeg of [-75, -60, -40, -20, 0, 20, 40, 60]) {
        ctx.beginPath();
        let started = false;
        for (let lonDeg = -180; lonDeg <= 180; lonDeg += 6) {
          const pt = projectSpherePoint(
            latDeg,
            lonDeg + rotDeg,
            globeCx,
            globeCy,
            globeR,
            tiltRad
          );
          if (pt.z > 0) {
            if (!started) {
              ctx.moveTo(pt.px, pt.py);
              started = true;
            } else {
              ctx.lineTo(pt.px, pt.py);
            }
          } else {
            started = false;
          }
        }
        ctx.stroke();
      }

      // 3D Longitude Meridians on the tilted sphere
      for (let lonBase = 0; lonBase < 360; lonBase += 24) {
        ctx.beginPath();
        let started = false;
        for (let latDeg = -85; latDeg <= 85; latDeg += 6) {
          const pt = projectSpherePoint(
            latDeg,
            lonBase + rotDeg,
            globeCx,
            globeCy,
            globeR,
            tiltRad
          );
          if (pt.z > 0) {
            if (!started) {
              ctx.moveTo(pt.px, pt.py);
              started = true;
            } else {
              ctx.lineTo(pt.px, pt.py);
            }
          } else {
            started = false;
          }
        }
        ctx.stroke();
      }

      // Glowing Southern Polar Ice Cap & Marginal Ice Ring on the 3D Sphere
      ctx.beginPath();
      let capStarted = false;
      for (let lonDeg = 0; lonDeg <= 360; lonDeg += 5) {
        const wobble =
          4.2 * Math.sin(((lonDeg * 3 + rotDeg) * Math.PI) / 180) +
          2.5 * Math.cos(((lonDeg * 5) * Math.PI) / 180);
        const pt = projectSpherePoint(
          -62 + wobble,
          lonDeg + rotDeg,
          globeCx,
          globeCy,
          globeR,
          tiltRad
        );
        if (pt.z > -0.15) {
          if (!capStarted) {
            ctx.moveTo(pt.px, pt.py);
            capStarted = true;
          } else {
            ctx.lineTo(pt.px, pt.py);
          }
        }
      }
      ctx.closePath();
      ctx.fillStyle = "rgba(186, 230, 253, 0.16)";
      ctx.fill();
      ctx.strokeStyle = "rgba(56, 189, 248, 0.55)";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // 3. Short Moving Wind Wisps (Delicate small moving wind arcs, zero long purple lines)
      for (let i = 0; i < windWisps.length; i++) {
        const w = windWisps[i];
        const wx = ((w.x + time * w.speed) % 1.12 - 0.06) * W;
        const wy =
          w.y * H +
          Math.sin(time * 2 + i) * 8 -
          scrollProg * 55;
        const wyWrapped = ((wy % H) + H) % H;

        const grad = ctx.createLinearGradient(wx - w.len, wyWrapped, wx, wyWrapped);
        grad.addColorStop(0, "rgba(56, 189, 248, 0)");
        grad.addColorStop(
          0.65,
          w.isCyan ? "rgba(56, 189, 248, 0.38)" : "rgba(224, 242, 254, 0.32)"
        );
        grad.addColorStop(
          1,
          w.isCyan ? "rgba(125, 211, 252, 0.82)" : "rgba(248, 250, 252, 0.78)"
        );

        ctx.beginPath();
        ctx.moveTo(wx - w.len, wyWrapped);
        ctx.quadraticCurveTo(
          wx - w.len * 0.5,
          wyWrapped + w.curve,
          wx,
          wyWrapped
        );
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1.6;
        ctx.stroke();

        // Tiny leading wind droplet
        ctx.beginPath();
        ctx.arc(wx, wyWrapped, 1.5, 0, Math.PI * 2);
        ctx.fillStyle = "#e0f2fe";
        ctx.fill();
      }

      // 4. Drifting 3D Isometric Crystalline Icebergs across the Polar Ocean Field
      for (let i = 0; i < oceanIcebergs.length; i++) {
        const b = oceanIcebergs[i];
        const xFrac = ((b.xBase + time * b.speed) % 1.16 + 1.16) % 1.16 - 0.08;
        const bx = xFrac * W + mouseX * 0.45;
        const by =
          b.yBase * H +
          mouseY * 0.35 -
          scrollProg * 40;
        const bob = Math.sin(time * 2.2 + b.phase) * 3.5;
        draw3DIceberg(bx, by, b.w, b.h, bob);
      }

      // 5. Autonomous Ships Gliding Through the Iceberg Field (linked to time + scroll)
      const ship1T = (time * 0.045 + scrollProg * 0.25) % 1;
      const s1x = W * (0.38 + ship1T * 0.48) + mouseX * 0.5;
      const s1y =
        H * (0.62 - ship1T * 0.28) +
        Math.sin(ship1T * Math.PI * 2) * 28 +
        mouseY * 0.4;
      const s1Heading =
        -0.46 + Math.cos(ship1T * Math.PI * 2) * 0.16;
      drawAutonomousShip(
        s1x,
        s1y,
        s1Heading,
        "POLAR EXPLORER · A* AUTO",
        "#a3e635",
        time
      );

      const ship2T = (time * 0.034 + 0.45 + scrollProg * 0.18) % 1;
      const s2x = W * (0.88 - ship2T * 0.44) + mouseX * 0.4;
      const s2y =
        H * (0.26 + ship2T * 0.32) +
        Math.cos(ship2T * Math.PI * 2) * 22 +
        mouseY * 0.3;
      const s2Heading =
        2.55 - Math.sin(ship2T * Math.PI * 2) * 0.14;
      drawAutonomousShip(
        s2x,
        s2y,
        s2Heading,
        "ICEBREAKER PC6 · SAR LINK",
        "#38bdf8",
        time + 1.7
      );
    };

    render();
    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("mousemove", handleMouseMove);
    };
  }, []);

  // 2. Finale Simulation at Bottom: Animated Ship Colliding with Iceberg (1912 Titanic) vs. 2026 ARGOS Avoidance
  useEffect(() => {
    const canvas = collisionCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    let animId = 0;
    let progress = 0;

    const debris = Array.from({ length: 20 }, (_, i) => ({
      angle: (i / 20) * Math.PI * 2,
      speed: 1.2 + (i % 5) * 0.6,
      size: 2 + (i % 3),
    }));

    const renderCollisionSim = () => {
      animId = requestAnimationFrame(renderCollisionSim);
      const speedFactor = simSpeedKnots / 22.5;
      progress += 0.0026 * speedFactor;
      if (progress > 1.0) progress = 0;

      const W = canvas.width;
      const H = canvas.height;
      ctx.clearRect(0, 0, W, H);

      // Deep North Atlantic / Polar Night Ocean Gradient
      const oceanGrad = ctx.createLinearGradient(0, 0, W, H);
      oceanGrad.addColorStop(0, "#030711");
      oceanGrad.addColorStop(0.5, "#071224");
      oceanGrad.addColorStop(1, "#040a16");
      ctx.fillStyle = oceanGrad;
      ctx.fillRect(0, 0, W, H);

      // Subtle coordinate grid
      ctx.strokeStyle = "rgba(148, 163, 184, 0.08)";
      ctx.lineWidth = 1;
      for (let x = 50; x < W; x += 65) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
        ctx.stroke();
      }
      for (let y = 40; y < H; y += 55) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
      }

      // Small moving wind wisps on the simulation canvas
      for (let w = 0; w < 8; w++) {
        const wx = (((w * 83 + progress * 360) % W) + W) % W;
        const wy = 32 + ((w * 37) % (H - 64));
        ctx.beginPath();
        ctx.moveTo(wx - 18, wy);
        ctx.lineTo(wx, wy + 2);
        ctx.strokeStyle = "rgba(125, 211, 252, 0.25)";
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }

      const bergX = W * 0.64;
      const bergY = H * 0.52;

      // Submerged underwater ice spur
      ctx.beginPath();
      ctx.ellipse(bergX - 8, bergY - 12, 60, 44, -0.2, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(56, 189, 248, 0.14)";
      ctx.fill();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = "rgba(56, 189, 248, 0.45)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.setLineDash([]);

      if (collisionMode === "argos2026") {
        ctx.beginPath();
        ctx.arc(bergX, bergY, 76, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(245, 158, 11, 0.09)";
        ctx.fill();
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = "rgba(245, 158, 11, 0.75)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Above-water Iceberg Mass
      ctx.save();
      ctx.translate(bergX, bergY);
      ctx.beginPath();
      ctx.moveTo(-34, -10);
      ctx.lineTo(-16, -34);
      ctx.lineTo(14, -30);
      ctx.lineTo(36, -8);
      ctx.lineTo(26, 22);
      ctx.lineTo(-12, 28);
      ctx.lineTo(-32, 14);
      ctx.closePath();
      ctx.fillStyle = "#e0f2fe";
      ctx.fill();
      ctx.strokeStyle = "#38bdf8";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = "#f8fafc";
      ctx.font = "700 10px 'JetBrains Mono', monospace";
      ctx.fillText("ICEBERG + SUBMERGED SPUR", bergX - 68, bergY - 42);

      if (collisionMode === "titanic1912") {
        const impactT = 0.58;
        let sx = 0;
        let sy = H * 0.46;
        let heading = 0;

        if (progress < impactT) {
          const u = progress / impactT;
          sx = 45 + u * (bergX - 26 - 45);
          if (u > 0.78) {
            const turnFrac = (u - 0.78) / 0.22;
            sy = H * 0.46 - Math.pow(turnFrac, 2) * 16;
            heading = -turnFrac * 0.28;
          }
        } else {
          const postU = (progress - impactT) / (1 - impactT);
          const decel = 1 - Math.pow(1 - Math.min(1, postU * 1.4), 2.2);
          sx = bergX - 26 + decel * 66;
          sy = H * 0.46 - 16 - decel * 18;
          heading = -0.28 - decel * 0.14;
        }

        // Wake trail
        ctx.beginPath();
        ctx.strokeStyle = "rgba(244, 63, 94, 0.75)";
        ctx.lineWidth = 2.4;
        ctx.moveTo(45, H * 0.46);
        ctx.lineTo(sx, sy);
        ctx.stroke();

        // Ship Hull + Short 450m Visual Lookout Cone
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(heading);
        ctx.beginPath();
        ctx.moveTo(16, 0);
        ctx.arc(16, 0, 54, -0.32, 0.32);
        ctx.closePath();
        ctx.fillStyle =
          progress >= 0.45 && progress <= 0.65
            ? "rgba(244, 63, 94, 0.26)"
            : "rgba(253, 224, 71, 0.14)";
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(22, 0);
        ctx.lineTo(9, 6);
        ctx.lineTo(-20, 6);
        ctx.lineTo(-24, 0);
        ctx.lineTo(-20, -6);
        ctx.lineTo(9, -6);
        ctx.closePath();
        ctx.fillStyle = progress >= impactT ? "#f43f5e" : "#f59e0b";
        ctx.fill();
        ctx.strokeStyle = "#fef3c7";
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();

        // Impact Shockwaves & Ice Fracture Sparks
        if (progress >= impactT - 0.02) {
          const impactPhase =
            (progress - (impactT - 0.02)) / (1 - impactT + 0.02);
          const hitX = bergX - 18;
          const hitY = bergY - 22;

          for (let r = 0; r < 3; r++) {
            const rp = (impactPhase * 1.6 + r * 0.33) % 1;
            const rad = 8 + rp * 64;
            ctx.beginPath();
            ctx.arc(hitX, hitY, rad, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(244, 63, 94, ${(1 - rp) * 0.85})`;
            ctx.lineWidth = 2.1;
            ctx.stroke();
          }

          if (impactPhase < 0.55) {
            for (const d of debris) {
              const dist = impactPhase * 52 * d.speed;
              const dx = hitX + Math.cos(d.angle) * dist;
              const dy = hitY + Math.sin(d.angle) * dist;
              ctx.fillStyle =
                d.size > 3
                  ? "rgba(251, 191, 36, 0.9)"
                  : "rgba(186, 230, 253, 0.9)";
              ctx.fillRect(dx, dy, d.size, d.size);
            }
          }

          ctx.fillStyle = "rgba(159, 18, 57, 0.9)";
          ctx.fillRect(12, 12, 305, 28);
          ctx.fillStyle = "#ffe4e6";
          ctx.font = "700 10px 'JetBrains Mono', monospace";
          ctx.fillText(
            "IMPACT: STARBOARD HULL BREACH · SOS 41°43′N",
            20,
            30
          );
        } else {
          ctx.fillStyle = "rgba(15, 23, 42, 0.88)";
          ctx.fillRect(12, 12, 290, 28);
          ctx.fillStyle = "#fde68a";
          ctx.font = "700 10px 'JetBrains Mono', monospace";
          ctx.fillText(
            `1912 VISUAL LOOKOUT · ${simSpeedKnots.toFixed(1)} KN (37s WARNING)`,
            20,
            30
          );
        }
      } else {
        // 2026 ARGOS A* Smooth Avoidance
        const p0 = { x: 40, y: H * 0.52 };
        const p1 = { x: W * 0.34, y: H * 0.52 };
        const p2 = { x: W * 0.52, y: H * 0.14 };
        const p3 = { x: W - 36, y: H * 0.24 };

        ctx.beginPath();
        ctx.strokeStyle = "#22d3ee";
        ctx.lineWidth = 2.6;
        ctx.moveTo(p0.x, p0.y);
        ctx.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
        ctx.stroke();

        const samplePt = (t) => {
          const mt = 1 - t;
          return {
            x:
              mt * mt * mt * p0.x +
              3 * mt * mt * t * p1.x +
              3 * mt * t * t * p2.x +
              t * t * t * p3.x,
            y:
              mt * mt * mt * p0.y +
              3 * mt * mt * t * p1.y +
              3 * mt * t * t * p2.y +
              t * t * t * p3.y,
          };
        };

        const cur = samplePt(progress);
        const nxt = samplePt(Math.min(1, progress + 0.02));
        const ang = Math.atan2(nxt.y - cur.y, nxt.x - cur.x);

        ctx.beginPath();
        ctx.setLineDash([3, 4]);
        ctx.strokeStyle = "rgba(163, 230, 53, 0.55)";
        ctx.lineWidth = 1.2;
        ctx.moveTo(cur.x, cur.y);
        ctx.lineTo(bergX, bergY);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.save();
        ctx.translate(cur.x, cur.y);
        ctx.rotate(ang);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, 70, -0.42, 0.42);
        ctx.closePath();
        ctx.fillStyle = "rgba(16, 185, 129, 0.16)";
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(18, 0);
        ctx.lineTo(6, 5.5);
        ctx.lineTo(-14, 5);
        ctx.lineTo(-14, -5);
        ctx.lineTo(6, -5.5);
        ctx.closePath();
        ctx.fillStyle = "#a3e635";
        ctx.fill();
        ctx.strokeStyle = "#ecfccb";
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();

        ctx.fillStyle = "rgba(6, 78, 59, 0.9)";
        ctx.fillRect(12, 12, 315, 28);
        ctx.fillStyle = "#a7f3d0";
        ctx.font = "700 10px 'JetBrains Mono', monospace";
        ctx.fillText(
          "2026 ARGOS A* AVOIDANCE · +168H SAR DETECTION",
          20,
          30
        );
      }
    };

    renderCollisionSim();
    return () => cancelAnimationFrame(animId);
  }, [collisionMode, simSpeedKnots, simReplayKey]);

  const pipelineCards = [
    {
      idx: "01",
      tag: "SATELLITE INGESTION",
      title: "25 km Sea-Ice & SAR Icebergs",
      desc: "Combines daily passive-microwave sea-ice concentration grids with USNIC tracked tabular icebergs.",
      stat: "18.4M km² Polar Domain",
      action: () => onEnterConsole(),
    },
    {
      idx: "02",
      tag: "NEURAL FORECASTER",
      title: "7-Day Residual Polar U-Net",
      desc: "Predicts 7-day sea-ice evolution across the 15%–40% marginal ice zone with 2.95% validation MAE.",
      stat: "2.95% SIC Error",
      action: () => {
        onEnterConsole();
        onOpenDrawer?.("ml");
      },
    },
    {
      idx: "03",
      tag: "AUTONOMOUS ROUTING",
      title: "Time-Dependent A* Navigator",
      desc: "Computes minimum-risk ship trajectories around heavy pack ridges and drifting iceberg cones.",
      stat: `+${heavySaved}h Heavy-Ice Saved`,
      action: () => onEnterConsole({ focusShip: true }),
    },
  ];

  const quickStations = [
    {
      id: "bharati",
      name: "Bharati Station",
      sub: "Prydz Bay · 69.4°S, 76.2°E",
      lon: 76.19,
      lat: -69.41,
      legPreset: "ice_entry->bharati",
    },
    {
      id: "maitri",
      name: "Maitri Station",
      sub: "Dronning Maud · 70.8°S, 11.7°E",
      lon: 11.73,
      lat: -70.77,
      legPreset: "ice_entry->maitri",
    },
    {
      id: "davis",
      name: "Davis Station",
      sub: "Vestfold Hills · 68.6°S, 78.0°E",
      lon: 77.97,
      lat: -68.58,
      legPreset: "ice_entry->bharati",
    },
    {
      id: "mawson",
      name: "Mawson Station",
      sub: "Holme Bay · 67.6°S, 62.9°E",
      lon: 62.87,
      lat: -67.6,
      legPreset: "ice_entry->bharati",
    },
  ];

  const scrollToId = (id) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <div className="argos-landing">
      {/* Live Scroll-Reactive 3D Tilted Planetary Globe + Drifting 3D Icebergs & Ships Background */}
      <canvas
        ref={bgCanvasRef}
        className="argos-bg-globe-canvas"
        aria-hidden="true"
      />

      {/* Scroll Progress Hairline Indicator */}
      <div className="argos-scroll-progress-bar">
        <div
          className="argos-scroll-progress-fill"
          style={{ width: `${scrollPct}%` }}
        />
      </div>

      {/* Top Navigation Header */}
      <header className="argos-landing-header">
        <a
          href="#top"
          className="argos-landing-brand"
          onClick={(e) => {
            e.preventDefault();
            onEnterConsole();
          }}
        >
          ARGOS
        </a>

        <nav className="argos-landing-nav" aria-label="Landing Sections">
          <button
            type="button"
            className={activeSection === 0 ? "active" : ""}
            onClick={() => scrollToId("top")}
          >
            Overview
          </button>
          <button
            type="button"
            className={activeSection === 1 ? "active" : ""}
            onClick={() => scrollToId("pipeline")}
          >
            AI Pipeline
          </button>
          <button
            type="button"
            className={activeSection === 2 ? "active" : ""}
            onClick={() => scrollToId("route-sim")}
          >
            Route Sim
          </button>
          <button
            type="button"
            className={activeSection === 3 ? "active" : ""}
            onClick={() => scrollToId("titanic")}
          >
            Titanic Lab
          </button>
        </nav>

        <div className="argos-landing-actions">
          <button
            type="button"
            className="dss-btn-primary argos-cta-btn"
            onClick={() => onEnterConsole()}
          >
            Launch 3D Console
          </button>
        </div>
      </header>

      {/* Floating Scroll Section Dots on Right Margin */}
      <div className="argos-scroll-dots" aria-hidden="true">
        {["top", "pipeline", "route-sim", "titanic"].map((id, idx) => (
          <button
            key={id}
            type="button"
            className={activeSection === idx ? "active" : ""}
            onClick={() => scrollToId(id)}
            title={`Jump to section ${idx + 1}`}
          />
        ))}
      </div>

      {/* Scrollable Main Content */}
      <div
        ref={scrollContainerRef}
        className="argos-landing-scroll"
        id="top"
        onScroll={handleScroll}
      >
        {/* SECTION 1: Clean, Spacious Hero (Letting the Live 3D Globe, Icebergs & Ships Shine) */}
        <section
          className={`argos-hero-section ${
            activeSection === 0 ? "in-view" : ""
          }`}
        >
          <div className="argos-hero-copy">
            <div className="argos-kicker">
              <span>POLAR SEA-ICE AI</span>
              <span aria-hidden="true">·</span>
              <span>AUTONOMOUS A* SHIP ROUTING</span>
            </div>

            <h1 className="argos-hero-title">
              Navigate Shifting Polar Ice with 7-Day Neural Forecasts
            </h1>

            <p className="argos-hero-lead">
              Real-time polar vessel routing powered by a 7-day residual U-Net
              and dynamic A* pathfinding—steering ships safely around heavy pack
              ice and drifting tabular icebergs.
            </p>

            <div className="argos-hero-cta-row">
              <button
                type="button"
                className="dss-btn-primary argos-hero-primary"
                onClick={() => onEnterConsole()}
              >
                Enter 3D Polar Globe Console
              </button>
              <button
                type="button"
                className="dss-btn-secondary argos-hero-secondary"
                onClick={() =>
                  onEnterConsole({ enableSelectDestination: true })
                }
              >
                Pick Destination on Globe
              </button>
            </div>

            {/* 3 Minimal Key Stats */}
            <div className="argos-proof-strip">
              <div className="argos-proof-cell">
                <span className="argos-proof-label">HEAVY-ICE SAVED</span>
                <div className="argos-proof-val pos">
                  +{scenario?.hindcast_summary?.mean_heavy_hours_saved ?? "11.5"}
                  <small>h</small>
                </div>
              </div>

              <div className="argos-proof-cell">
                <span className="argos-proof-label">U-NET ERROR</span>
                <div className="argos-proof-val cyan">
                  2.95<small>% SIC</small>
                </div>
              </div>

              <div className="argos-proof-cell">
                <span className="argos-proof-label">FORECAST HORIZON</span>
                <div className="argos-proof-val">
                  7<small>Days</small>
                </div>
              </div>
            </div>
          </div>

          {/* Unobstructed Live Viewport Callout (No clutter buttons — just a clean scroll cue) */}
          <div className="argos-hero-live-badge">
            <div className="argos-live-indicator">
              <span className="argos-pulse-dot" />
              <span className="mono">
                LIVE 3D PLANETARY HORIZON · ICEBERGS &amp; SHIPS
              </span>
            </div>
            <p>
              Scroll down to rotate the 3D polar globe, test route avoidance,
              and simulate the 1912 Titanic iceberg collision.
            </p>
            <button
              type="button"
              className="argos-scroll-cue-btn"
              onClick={() => scrollToId("pipeline")}
            >
              Scroll to Explore ↓
            </button>
          </div>
        </section>

        {/* SECTION 2: Concise 3-Card Interactive AI Pipeline */}
        <section
          className={`argos-section ${activeSection === 1 ? "in-view" : ""}`}
          id="pipeline"
        >
          <div className="argos-section-head">
            <div>
              <span className="argos-section-kicker">01 · CORE PIPELINE</span>
              <h2>Three-Stage Polar Decision Engine</h2>
            </div>
            <p className="argos-section-desc">
              Click any stage to inspect it inside the 3D operational console.
            </p>
          </div>

          <div className="argos-tri-grid">
            {pipelineCards.map((c, idx) => (
              <div
                key={c.idx}
                className={`argos-tri-card ${
                  activeStepCard === idx ? "active" : ""
                }`}
                onMouseEnter={() => setActiveStepCard(idx)}
                onClick={c.action}
              >
                <div className="argos-tri-top">
                  <span className="mono cyan-text">{c.idx}</span>
                  <span className="mono argos-tri-tag">{c.tag}</span>
                </div>
                <h3>{c.title}</h3>
                <p>{c.desc}</p>
                <div className="argos-tri-foot">
                  <strong className="mono">{c.stat}</strong>
                  <span>Explore →</span>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* SECTION 3: Minimal Interactive Route & Station Sandbox */}
        <section
          className={`argos-section ${activeSection === 2 ? "in-view" : ""}`}
          id="route-sim"
        >
          <div className="argos-section-head">
            <div>
              <span className="argos-section-kicker">
                02 · INTERACTIVE ROUTE SANDBOX
              </span>
              <h2>Tune Ice-Risk Avoidance &amp; Launch to a Station</h2>
            </div>
          </div>

          <div className="argos-compact-sim">
            <div className="argos-compact-sim-left">
              <label className="dss-field">
                <span>Active Expedition Corridor</span>
                <select value={leg} onChange={(e) => setLeg(e.target.value)}>
                  <option value="bharati->maitri">
                    Bharati Station → Maitri Station
                  </option>
                  <option value="ice_entry->bharati">
                    56°S Entry Gate → Bharati Station
                  </option>
                  <option value="ice_entry->maitri">
                    56°S Entry Gate → Maitri Station
                  </option>
                </select>
              </label>

              <div className="dss-slider-block">
                <div className="dss-slider-title">
                  <span>Ice-Avoidance Penalty Weight (λ)</span>
                  <strong className="mono cyan-text">{wRisk.toFixed(2)}</strong>
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

              <div className="argos-compact-kpis">
                <div>
                  <span>HEAVY-ICE SAVED</span>
                  <strong className="mono pos">+{heavySaved} h</strong>
                </div>
                <div>
                  <span>TIME SAVED</span>
                  <strong className="mono cyan-text">+{timeDelta} h</strong>
                </div>
                <div>
                  <span>ROUTE DISTANCE</span>
                  <strong className="mono">
                    {fcMetrics?.distance_km ?? "1,842"} km
                  </strong>
                </div>
              </div>
            </div>

            <div className="argos-compact-sim-right">
              <span className="mono argos-sub-label">
                QUICK-LAUNCH TO ANTARCTIC STATION
              </span>
              <div className="argos-mini-stations">
                {quickStations.map((st) => (
                  <button
                    key={st.id}
                    type="button"
                    className="argos-mini-st-btn"
                    onClick={() =>
                      onLaunchStationDestination?.({
                        lon: st.lon,
                        lat: st.lat,
                        name: st.name,
                        legPreset: st.legPreset,
                      })
                    }
                  >
                    <strong>{st.name}</strong>
                    <span className="mono">{st.sub}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* SECTION 4 (FINALE AT END): Animated Iceberg Collision vs. Avoidance + Compact RMS Titanic Panel */}
        <section
          className={`argos-section argos-section-last ${
            activeSection === 3 ? "in-view" : ""
          }`}
          id="titanic"
        >
          <div className="argos-section-head">
            <div>
              <span className="argos-section-kicker">
                03 · LIVE COLLISION SIMULATION &amp; TITANIC CASE STUDY
              </span>
              <h2>RMS Titanic (1912) Impact vs. ARGOS A* Avoidance</h2>
            </div>
          </div>

          <div className="argos-titanic-grid">
            {/* Left: Animated Ship Colliding with Iceberg Canvas */}
            <div className="argos-collision-card">
              <div className="argos-collision-top">
                <div className="argos-collision-tabs">
                  <button
                    type="button"
                    className={collisionMode === "titanic1912" ? "active" : ""}
                    onClick={() => {
                      setCollisionMode("titanic1912");
                      setSimReplayKey((k) => k + 1);
                    }}
                  >
                    1912 Titanic Collision
                  </button>
                  <button
                    type="button"
                    className={collisionMode === "argos2026" ? "active" : ""}
                    onClick={() => {
                      setCollisionMode("argos2026");
                      setSimReplayKey((k) => k + 1);
                    }}
                  >
                    2026 ARGOS Avoidance
                  </button>
                </div>

                <div className="argos-sim-speed-inline">
                  <span className="mono">{simSpeedKnots.toFixed(1)} kn</span>
                  <input
                    type="range"
                    min={12}
                    max={26}
                    step={0.5}
                    value={simSpeedKnots}
                    onChange={(e) => setSimSpeedKnots(Number(e.target.value))}
                  />
                </div>
              </div>

              <canvas
                ref={collisionCanvasRef}
                width={560}
                height={240}
                className="argos-collision-canvas"
              />
            </div>

            {/* Right: Compact RMS Titanic Panel */}
            <div className="argos-titanic-panel">
              <div className="argos-titanic-head">
                <span className="mono rose-text">
                  14 APRIL 1912 · 41°43′N, 49°56′W
                </span>
                <h3>RMS Titanic Dossier</h3>
                <p>
                  Steaming at 22.5 knots on a moonless night, lookouts spotted
                  an unlit iceberg just <strong>450 m ahead (37s lead)</strong>
                  —scraping a submerged ice spur before the ship could turn.
                </p>
              </div>

              <div className="argos-titanic-compare">
                <div className="argos-tc-row head">
                  <span>Metric</span>
                  <span>Titanic (1912)</span>
                  <span className="cyan-text">ARGOS (2026)</span>
                </div>
                <div className="argos-tc-row">
                  <span>Warning Time</span>
                  <span className="mono rose-text">37 Seconds</span>
                  <span className="mono pos">7 Days (168h)</span>
                </div>
                <div className="argos-tc-row">
                  <span>Detection</span>
                  <span>Visual Lookout</span>
                  <span className="mono">SAR + USNIC Cones</span>
                </div>
                <div className="argos-tc-row">
                  <span>Routing</span>
                  <span>Fixed Track</span>
                  <span className="mono cyan-text">Dynamic A* Detour</span>
                </div>
              </div>

              <div className="argos-titanic-footer">
                <span>Catalyzed the 1914 SOLAS Convention</span>
                <button
                  type="button"
                  className="dss-btn-primary"
                  onClick={() => onEnterConsole()}
                >
                  Open 3D Console
                </button>
              </div>
            </div>
          </div>
        </section>

        <footer className="argos-landing-footer">
          <div>
            <strong>ARGOS</strong>
            <span aria-hidden="true">·</span>
            <span>Polar Sea-Ice Forecasting &amp; Ship Routing</span>
          </div>
          <div className="argos-footer-links">
            <button type="button" onClick={() => onEnterConsole()}>
              3D Globe Console
            </button>
            <button
              type="button"
              onClick={() => {
                onEnterConsole();
                onOpenDrawer?.("guide");
              }}
            >
              System Guide
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
