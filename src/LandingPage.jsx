import React, { useEffect, useRef, useState } from "react";
import ArgosLogo from "./ArgosLogo.jsx";

/**
 * ARGOS — Clean, High-Performance Editorial & Scroll-Reactive Polar Landing Page
 * - Zero React re-renders during scroll: scroll progress bar & background canvas are driven
 *   directly via refs for 60/120fps butter-smooth scrolling with zero frame drops.
 * - Pre-computed 3D sphere trigonometry & IntersectionObserver-gated Titanic simulation canvas.
 * - Clean, natural typography (removed boxed highlight tags and removed center VIEW button).
 */
export default function LandingPage({
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
  const progressFillRef = useRef(null);
  const scrollProgressRef = useRef(0);
  const targetScrollRef = useRef(0);
  const activeSceneRef = useRef(0);

  const [activeScene, setActiveScene] = useState(0);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Titanic Collision vs. ARGOS Avoidance Simulator state
  const [collisionMode, setCollisionMode] = useState("titanic1912");
  const [simSpeedKnots, setSimSpeedKnots] = useState(22.5);

  // Passive, zero-re-render scroll handler (only updates React state when section index changes)
  const handleScroll = (e) => {
    const el = e.currentTarget;
    const maxScroll = Math.max(1, el.scrollHeight - el.clientHeight);
    const prog = Math.max(0, Math.min(1, el.scrollTop / maxScroll));
    targetScrollRef.current = prog;

    if (progressFillRef.current) {
      progressFillRef.current.style.transform = `scaleX(${prog.toFixed(4)})`;
    }

    const nextScene =
      prog < 0.26 ? 0 : prog < 0.56 ? 1 : prog < 0.82 ? 2 : 3;
    if (nextScene !== activeSceneRef.current) {
      activeSceneRef.current = nextScene;
      setActiveScene(nextScene);
    }
  };

  const scrollToId = (id) => {
    setMobileMenuOpen(false);
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth" });
  };

  // 1. Hardware-Friendly Scroll-Reactive Polar Background Canvas
  useEffect(() => {
    const canvas = bgCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    let animId = 0;
    let time = 0;
    let mouseX = 0;
    let mouseY = 0;
    let targetMouseX = 0;
    let targetMouseY = 0;
    let W = window.innerWidth;
    let H = window.innerHeight;

    const handleResize = () => {
      W = window.innerWidth;
      H = window.innerHeight;
      // Cap DPR at 1.25 on full-screen background canvas to prevent fill-rate frame drops on scroll
      const dpr = Math.min(window.devicePixelRatio || 1, 1.25);
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    handleResize();
    window.addEventListener("resize", handleResize, { passive: true });

    const handleMouseMove = (e) => {
      targetMouseX = (e.clientX / W - 0.5) * 22;
      targetMouseY = (e.clientY / H - 0.5) * 16;
    };
    window.addEventListener("mousemove", handleMouseMove, { passive: true });

    const stars = Array.from({ length: 55 }, (_, i) => ({
      xFrac: ((i * 73 + 19) % 100) / 100,
      yFrac: ((i * 41 + 7) % 100) / 100,
      r: (i % 3) * 0.35 + 0.6,
      alpha: 0.16 + (i % 5) * 0.08,
    }));

    const windWisps = Array.from({ length: 18 }, (_, i) => ({
      x: ((i * 97) % 100) / 100,
      y: 0.15 + (((i * 53) % 72) / 100),
      speed: 0.034 + (i % 5) * 0.011,
      len: 22 + (i % 4) * 8,
      curve: (i % 2 === 0 ? 1 : -1) * (3 + (i % 3) * 2),
      isCyan: i % 2 === 0,
    }));

    const oceanIcebergs = [
      {
        xBase: 0.2,
        yBase: 0.7,
        w: 42,
        h: 28,
        speed: -0.008,
        phase: 0.4,
        name: "B-22A",
      },
      {
        xBase: 0.5,
        yBase: 0.46,
        w: 36,
        h: 24,
        speed: -0.011,
        phase: 1.7,
        name: "D-28",
      },
      {
        xBase: 0.78,
        yBase: 0.64,
        w: 50,
        h: 34,
        speed: -0.009,
        phase: 3.1,
        name: "A-76A",
      },
      {
        xBase: 0.88,
        yBase: 0.34,
        w: 32,
        h: 21,
        speed: -0.013,
        phase: 4.6,
        name: "A-74",
      },
    ];

    const glacierPeaks = [
      { x: 0.0, h: 0.16 },
      { x: 0.09, h: 0.24 },
      { x: 0.18, h: 0.19 },
      { x: 0.27, h: 0.29 },
      { x: 0.37, h: 0.21 },
      { x: 0.46, h: 0.31 },
      { x: 0.55, h: 0.23 },
      { x: 0.65, h: 0.27 },
      { x: 0.75, h: 0.2 },
      { x: 0.85, h: 0.29 },
      { x: 0.93, h: 0.22 },
      { x: 1.0, h: 0.17 },
    ];

    // Pre-compute lat/lon trig tables for fast 3D globe projection
    const latLevels = [-75, -60, -45, -30, -15, 0, 15, 30, 45].map((deg) => {
      const rad = (deg * Math.PI) / 180;
      return { deg, sinLat: Math.sin(rad), cosLat: Math.cos(rad) };
    });

    const projectSphereFast = (
      sinLat,
      cosLat,
      lonRad,
      cx,
      cy,
      R,
      sinTilt,
      cosTilt
    ) => {
      const x = cosLat * Math.sin(lonRad);
      const z0 = cosLat * Math.cos(lonRad);
      const y = sinLat * cosTilt - z0 * sinTilt;
      const z = sinLat * sinTilt + z0 * cosTilt;
      return {
        px: cx + x * R,
        py: cy - y * R,
        z,
      };
    };

    const draw3DIceberg = (bx, by, w, h, bob, showRing, label) => {
      ctx.save();
      ctx.translate(bx, by + bob);

      if (showRing > 0.06) {
        ctx.beginPath();
        ctx.ellipse(0, h * 0.14, w * 1.4, h * 0.5, 0, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(245, 158, 11, ${(showRing * 0.48).toFixed(2)})`;
        ctx.lineWidth = 1.1;
        ctx.stroke();
      }

      // Underwater cyan keel
      ctx.beginPath();
      ctx.moveTo(-w * 0.75, h * 0.15);
      ctx.lineTo(0, h * 0.85);
      ctx.lineTo(w * 0.8, h * 0.12);
      ctx.closePath();
      ctx.fillStyle = "rgba(14, 165, 233, 0.17)";
      ctx.fill();

      // Waterline ripple
      ctx.beginPath();
      ctx.ellipse(0, h * 0.14, w * 1.04, h * 0.26, 0, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(56, 189, 248, 0.38)";
      ctx.lineWidth = 1;
      ctx.stroke();

      // Left sunlit glacial wall
      ctx.beginPath();
      ctx.moveTo(-w * 0.72, h * 0.12);
      ctx.lineTo(-w * 0.48, -h * 0.58);
      ctx.lineTo(0, -h * 0.32);
      ctx.lineTo(0, h * 0.24);
      ctx.closePath();
      ctx.fillStyle = "rgba(224, 242, 254, 0.9)";
      ctx.fill();

      // Right shaded glacial wall
      ctx.beginPath();
      ctx.moveTo(0, -h * 0.32);
      ctx.lineTo(w * 0.56, -h * 0.48);
      ctx.lineTo(w * 0.76, h * 0.1);
      ctx.lineTo(0, h * 0.24);
      ctx.closePath();
      ctx.fillStyle = "rgba(125, 211, 252, 0.82)";
      ctx.fill();

      // Top snow plateau
      ctx.beginPath();
      ctx.moveTo(-w * 0.48, -h * 0.58);
      ctx.lineTo(w * 0.08, -h * 0.78);
      ctx.lineTo(w * 0.56, -h * 0.48);
      ctx.lineTo(0, -h * 0.32);
      ctx.closePath();
      ctx.fillStyle = "#f8fafc";
      ctx.fill();

      if (label && showRing > 0.22) {
        ctx.fillStyle = `rgba(253, 230, 138, ${(showRing * 0.8).toFixed(2)})`;
        ctx.font = "500 9px 'JetBrains Mono', monospace";
        ctx.fillText(label, -w * 0.35, -h * 0.95);
      }

      ctx.restore();
    };

    const drawAutonomousShip = (sx, sy, heading, label, hullColor, tNow) => {
      const pulseR = 10 + ((tNow * 22) % 24);
      const pulseAlpha = Math.max(0.04, (1 - pulseR / 34) * 0.55);
      ctx.beginPath();
      ctx.ellipse(sx, sy, pulseR, pulseR * 0.65, 0, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(163, 230, 53, ${pulseAlpha.toFixed(2)})`;
      ctx.lineWidth = 1.1;
      ctx.stroke();

      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(heading);

      // Sweeping forward radar cone
      const sweep = Math.sin(tNow * 2.8) * 0.28;
      ctx.beginPath();
      ctx.moveTo(10, 0);
      ctx.arc(10, 0, 42, sweep - 0.32, sweep + 0.32);
      ctx.closePath();
      ctx.fillStyle = "rgba(163, 230, 53, 0.13)";
      ctx.fill();

      // Kelvin V-wake
      ctx.beginPath();
      ctx.moveTo(-8, 0);
      ctx.lineTo(-32, -9);
      ctx.moveTo(-8, 0);
      ctx.lineTo(-32, 9);
      ctx.strokeStyle = "rgba(34, 211, 238, 0.48)";
      ctx.lineWidth = 1.4;
      ctx.stroke();

      // Vessel hull
      ctx.beginPath();
      ctx.moveTo(14, 0);
      ctx.lineTo(4, 4.8);
      ctx.lineTo(-11, 4.2);
      ctx.lineTo(-11, -4.2);
      ctx.lineTo(4, -4.8);
      ctx.closePath();
      ctx.fillStyle = hullColor;
      ctx.fill();
      ctx.strokeStyle = "#f8fafc";
      ctx.lineWidth = 1.2;
      ctx.stroke();

      ctx.fillStyle = "#07090e";
      ctx.fillRect(-3, -2, 5, 4);
      ctx.restore();

      if (label) {
        ctx.fillStyle = "rgba(226, 232, 240, 0.8)";
        ctx.font = "500 9.5px 'JetBrains Mono', monospace";
        ctx.fillText(label, sx + 16, sy - 8);
      }
    };

    const render = () => {
      animId = requestAnimationFrame(render);
      time += 0.01;
      mouseX += (targetMouseX - mouseX) * 0.06;
      mouseY += (targetMouseY - mouseY) * 0.06;
      scrollProgressRef.current +=
        (targetScrollRef.current - scrollProgressRef.current) * 0.08;

      const sp = scrollProgressRef.current;

      // Solid fast background clear
      ctx.fillStyle = "#050912";
      ctx.fillRect(0, 0, W, H);

      // Stars
      ctx.fillStyle = "rgba(186, 230, 253, 0.24)";
      for (const s of stars) {
        const sx = s.xFrac * W - mouseX * 0.2;
        const sy = ((s.yFrac - sp * 0.16 + 1) % 1) * H - mouseY * 0.2;
        ctx.fillRect(sx, sy, s.r * 1.6, s.r * 1.6);
      }

      // 3D Tilted Rotating Planetary Globe (shifts & tilts smoothly on scroll)
      const globeX =
        W * (0.64 - Math.sin(sp * Math.PI) * 0.13) + mouseX * 0.85;
      const globeY =
        H * (0.44 - sp * 0.07 + Math.cos(sp * Math.PI * 2) * 0.04) +
        mouseY * 0.85;
      const R = Math.min(W, H) * (0.34 + Math.sin(sp * Math.PI) * 0.08);
      const tiltRad = 0.36 + sp * 0.66;
      const sinTilt = Math.sin(tiltRad);
      const cosTilt = Math.cos(tiltRad);
      const rotRad = ((time * 13 + sp * 210) * Math.PI) / 180;

      // 3D Sphere body
      const sphereGrad = ctx.createRadialGradient(
        globeX - R * 0.25,
        globeY - R * 0.25,
        R * 0.1,
        globeX,
        globeY,
        R * 1.15
      );
      sphereGrad.addColorStop(0, "rgba(15, 46, 82, 0.9)");
      sphereGrad.addColorStop(0.75, "rgba(7, 20, 38, 0.95)");
      sphereGrad.addColorStop(1, "rgba(5, 9, 18, 0)");
      ctx.beginPath();
      ctx.arc(globeX, globeY, R * 1.15, 0, Math.PI * 2);
      ctx.fillStyle = sphereGrad;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(globeX, globeY, R, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(56, 189, 248, 0.36)";
      ctx.lineWidth = 1.3;
      ctx.stroke();

      // 3D Latitude Rings (step = 12 deg for fast 60fps rendering)
      for (const latObj of latLevels) {
        ctx.beginPath();
        let started = false;
        for (let lon = -180; lon <= 180; lon += 12) {
          const lonRad = (lon * Math.PI) / 180 + rotRad;
          const pt = projectSphereFast(
            latObj.sinLat,
            latObj.cosLat,
            lonRad,
            globeX,
            globeY,
            R,
            sinTilt,
            cosTilt
          );
          if (pt.z > -0.05) {
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
        ctx.strokeStyle =
          latObj.deg <= -60
            ? "rgba(56, 189, 248, 0.4)"
            : "rgba(148, 163, 184, 0.12)";
        ctx.lineWidth = latObj.deg === -60 ? 1.3 : 0.8;
        ctx.stroke();
      }

      // 3D Longitude Meridians
      ctx.strokeStyle = "rgba(148, 163, 184, 0.12)";
      ctx.lineWidth = 0.8;
      for (let lon = 0; lon < 360; lon += 30) {
        const lonRad = (lon * Math.PI) / 180 + rotRad;
        ctx.beginPath();
        let started = false;
        for (let lat = -80; lat <= 80; lat += 10) {
          const rad = (lat * Math.PI) / 180;
          const pt = projectSphereFast(
            Math.sin(rad),
            Math.cos(rad),
            lonRad,
            globeX,
            globeY,
            R,
            sinTilt,
            cosTilt
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

      // Illuminated Southern Polar Sea-Ice Cap (-62°S to -88°S)
      ctx.beginPath();
      let capStarted = false;
      for (let lon = 0; lon <= 360; lon += 10) {
        const lonRad = (lon * Math.PI) / 180 + rotRad;
        const wobble = Math.sin(lonRad * 4) * 3 + Math.cos(lonRad * 3) * 2;
        const latRad = ((-62 + wobble - sp * 3) * Math.PI) / 180;
        const pt = projectSphereFast(
          Math.sin(latRad),
          Math.cos(latRad),
          lonRad,
          globeX,
          globeY,
          R,
          sinTilt,
          cosTilt
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
      if (capStarted) {
        ctx.closePath();
        ctx.fillStyle = `rgba(56, 189, 248, ${(0.15 + Math.sin(sp * Math.PI) * 0.1).toFixed(2)})`;
        ctx.fill();
        ctx.strokeStyle = "rgba(34, 211, 238, 0.68)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // Orbiting Satellite Ring around the 3D Globe
      ctx.save();
      ctx.translate(globeX, globeY);
      ctx.rotate(-0.28 + sp * 0.52);
      ctx.beginPath();
      ctx.ellipse(0, 0, R * 1.18, R * 0.34, 0, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(56, 189, 248, 0.25)";
      ctx.lineWidth = 1;
      ctx.stroke();

      const satAngle = time * 1.15 + sp * 3.2;
      const satX = Math.cos(satAngle) * R * 1.18;
      const satY = Math.sin(satAngle) * R * 0.34;
      ctx.beginPath();
      ctx.arc(satX, satY, 3.8, 0, Math.PI * 2);
      ctx.fillStyle = "#38bdf8";
      ctx.fill();
      ctx.restore();

      // Sculpted Crystalline Glacier Ridge Horizon (Prominent in Hero, recedes smoothly on scroll)
      const glacierAlpha = Math.max(0, 1 - sp * 1.75);
      if (glacierAlpha > 0.03) {
        const glacierShiftY = sp * H * 0.48;
        const baseRidgeY = H * 0.74 + glacierShiftY;

        ctx.beginPath();
        ctx.moveTo(0, H);
        for (let i = 0; i < glacierPeaks.length; i++) {
          const p = glacierPeaks[i];
          const px = p.x * W - mouseX * 0.35;
          const py = baseRidgeY - p.h * H * 0.58;
          ctx.lineTo(px, py);
        }
        ctx.lineTo(W, H);
        ctx.closePath();
        ctx.fillStyle = `rgba(18, 42, 72, ${(glacierAlpha * 0.55).toFixed(2)})`;
        ctx.fill();

        ctx.beginPath();
        for (let i = 0; i < glacierPeaks.length; i++) {
          const p = glacierPeaks[i];
          const px = p.x * W - mouseX * 0.35;
          const py = baseRidgeY - p.h * H * 0.58;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.strokeStyle = `rgba(186, 230, 253, ${(glacierAlpha * 0.36).toFixed(2)})`;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }

      // Short Moving Wind Wisps
      for (const w of windWisps) {
        const prog = (w.x + time * w.speed + sp * 0.18) % 1;
        const wx = prog * W;
        const wy = w.y * H + Math.sin(prog * 8 + w.len) * 7;
        const alpha = Math.sin(prog * Math.PI) * 0.4;
        if (alpha > 0.05) {
          ctx.beginPath();
          ctx.moveTo(wx, wy);
          ctx.quadraticCurveTo(
            wx + w.len * 0.5,
            wy + w.curve,
            wx + w.len,
            wy
          );
          ctx.strokeStyle = w.isCyan
            ? `rgba(56, 189, 248, ${alpha.toFixed(2)})`
            : `rgba(224, 242, 254, ${(alpha * 0.82).toFixed(2)})`;
          ctx.lineWidth = 1.25;
          ctx.stroke();
        }
      }

      // Drifting 3D Crystalline Icebergs
      const ringStrength = Math.max(0, Math.sin(sp * Math.PI));
      for (const berg of oceanIcebergs) {
        const bx =
          (((berg.xBase + time * berg.speed + sp * 0.14) % 1 + 1) % 1) * W;
        const by = berg.yBase * H + (0.4 - sp) * 60;
        const bob = Math.sin(time * 2.0 + berg.phase) * 3;
        draw3DIceberg(bx, by, berg.w, berg.h, bob, ringStrength, berg.name);
      }

      // Dynamic A* Ship Trajectory & Sailing Vessels
      const ship1T = (time * 0.05 + sp * 0.35) % 1;
      const routeBaseY = H * (0.66 - sp * 0.14);
      const s1x = W * (0.18 + ship1T * 0.66);
      const s1y =
        routeBaseY -
        ship1T * H * 0.22 +
        Math.sin(ship1T * Math.PI * 2) * 30;
      const s1Heading = -0.36 + Math.cos(ship1T * Math.PI * 2) * 0.2;

      ctx.beginPath();
      for (let u = 0; u <= 1; u += 0.05) {
        const tx = W * (0.18 + u * 0.66);
        const ty = routeBaseY - u * H * 0.22 + Math.sin(u * Math.PI * 2) * 30;
        if (u === 0) ctx.moveTo(tx, ty);
        else ctx.lineTo(tx, ty);
      }
      ctx.strokeStyle = "rgba(6, 182, 212, 0.38)";
      ctx.lineWidth = 1.8;
      ctx.setLineDash([7, 7]);
      ctx.stroke();
      ctx.setLineDash([]);

      drawAutonomousShip(
        s1x,
        s1y,
        s1Heading,
        "RV POLAR EXPLORER",
        "#a3e635",
        time
      );

      const ship2T = (time * 0.036 + 0.48 + sp * 0.2) % 1;
      const s2x = W * (0.85 - ship2T * 0.5);
      const s2y =
        H * (0.28 + ship2T * 0.36) + Math.cos(ship2T * Math.PI * 2) * 18;
      const s2Heading = 2.5 - Math.sin(ship2T * Math.PI * 2) * 0.14;
      drawAutonomousShip(
        s2x,
        s2y,
        s2Heading,
        "RSV NUYINA",
        "#38bdf8",
        time + 1.4
      );
    };

    render();
    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("mousemove", handleMouseMove);
    };
  }, []);

  // 2. IntersectionObserver-Gated Ship-Iceberg Collision Simulator Canvas (Only animates when in viewport)
  useEffect(() => {
    const canvas = collisionCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    let animId = 0;
    let progress = 0;
    let isVisible = false;
    const speedFactor = simSpeedKnots / 22.5;

    const sparks = Array.from({ length: 14 }, (_, i) => ({
      angle: (i / 14) * Math.PI * 2,
      speed: 1.2 + (i % 4) * 0.6,
    }));

    const renderSim = () => {
      if (!isVisible) return;
      animId = requestAnimationFrame(renderSim);
      progress += 0.0036 * speedFactor;
      if (progress > 1) progress = 0;

      const W = canvas.width;
      const H = canvas.height;
      ctx.fillStyle = "#040b16";
      ctx.fillRect(0, 0, W, H);

      const bergX = W * 0.65;
      const bergY = H * 0.52;

      if (collisionMode === "argos2026") {
        ctx.beginPath();
        ctx.ellipse(bergX, bergY, 76, 50, -0.15, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(245, 158, 11, 0.09)";
        ctx.fill();
        ctx.setLineDash([5, 5]);
        ctx.strokeStyle = "rgba(245, 158, 11, 0.65)";
        ctx.lineWidth = 1.3;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Submerged ice spur
      ctx.beginPath();
      ctx.ellipse(bergX - 6, bergY + 6, 44, 28, 0.1, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(14, 165, 233, 0.24)";
      ctx.fill();

      // Iceberg polygon
      ctx.beginPath();
      ctx.moveTo(bergX - 28, bergY + 12);
      ctx.lineTo(bergX - 19, bergY - 25);
      ctx.lineTo(bergX + 4, bergY - 32);
      ctx.lineTo(bergX + 26, bergY - 13);
      ctx.lineTo(bergX + 30, bergY + 13);
      ctx.lineTo(bergX + 2, bergY + 22);
      ctx.closePath();
      ctx.fillStyle = "#e0f2fe";
      ctx.fill();
      ctx.strokeStyle = "#38bdf8";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      let shipX = 40 + progress * (W - 80);
      let shipY = H * 0.52;
      let shipHeading = 0;
      let isColliding = false;

      if (collisionMode === "titanic1912") {
        ctx.beginPath();
        ctx.moveTo(30, H * 0.52);
        ctx.lineTo(W - 30, H * 0.52);
        ctx.setLineDash([4, 5]);
        ctx.strokeStyle = "rgba(244, 63, 94, 0.45)";
        ctx.lineWidth = 1.4;
        ctx.stroke();
        ctx.setLineDash([]);

        if (progress > 0.52 && progress < 0.72) {
          isColliding = true;
          const localP = (progress - 0.52) / 0.2;
          shipY = H * 0.52 - Math.sin(localP * Math.PI) * 10;
          shipHeading = -0.18 * Math.sin(localP * Math.PI);
        } else if (progress >= 0.72) {
          shipX = 40 + (0.72 + (progress - 0.72) * 0.25) * (W - 80);
          shipY = H * 0.5;
          shipHeading = 0.08;
        }
      } else {
        ctx.beginPath();
        for (let u = 0; u <= 1; u += 0.025) {
          const px = 40 + u * (W - 80);
          const detour = Math.exp(-Math.pow((u - 0.6) / 0.19, 2)) * -66;
          const py = H * 0.52 + detour;
          if (u === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.strokeStyle = "rgba(6, 182, 212, 0.85)";
        ctx.lineWidth = 2;
        ctx.stroke();

        const detourNow =
          Math.exp(-Math.pow((progress - 0.6) / 0.19, 2)) * -66;
        const detourNext =
          Math.exp(-Math.pow((progress + 0.01 - 0.6) / 0.19, 2)) * -66;
        shipY = H * 0.52 + detourNow;
        shipHeading = Math.atan2(detourNext - detourNow, (W - 80) * 0.01);
      }

      if (isColliding) {
        const impactR = ((progress - 0.52) / 0.2) * 42;
        ctx.beginPath();
        ctx.arc(bergX - 22, bergY + 6, impactR, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(244, 63, 94, 0.9)";
        ctx.lineWidth = 2;
        ctx.stroke();

        for (const sp of sparks) {
          const sx = bergX - 22 + Math.cos(sp.angle) * impactR * sp.speed * 0.6;
          const sy = bergY + 6 + Math.sin(sp.angle) * impactR * sp.speed * 0.6;
          ctx.beginPath();
          ctx.arc(sx, sy, 2, 0, Math.PI * 2);
          ctx.fillStyle = "#fb7185";
          ctx.fill();
        }
      }

      ctx.save();
      ctx.translate(shipX, shipY);
      ctx.rotate(shipHeading);

      ctx.beginPath();
      ctx.moveTo(15, 0);
      ctx.lineTo(5, 5);
      ctx.lineTo(-12, 4.5);
      ctx.lineTo(-12, -4.5);
      ctx.lineTo(5, -5);
      ctx.closePath();
      ctx.fillStyle =
        collisionMode === "titanic1912" ? "#f43f5e" : "#a3e635";
      ctx.fill();
      ctx.strokeStyle = "#f8fafc";
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = "rgba(226, 232, 240, 0.9)";
      ctx.font = "500 10.5px 'JetBrains Mono', monospace";
      ctx.fillText(
        collisionMode === "titanic1912"
          ? isColliding
            ? "1912 TITANIC · ICEBERG SPUR IMPACT"
            : "1912 VISUAL LOOKOUT · 37s WARNING"
          : "2026 ARGOS · 7-DAY FORECAST DETOUR",
        14,
        22
      );
    };

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting) {
          if (!isVisible) {
            isVisible = true;
            renderSim();
          }
        } else {
          isVisible = false;
          cancelAnimationFrame(animId);
        }
      },
      { threshold: 0.05 }
    );
    observer.observe(canvas);

    return () => {
      isVisible = false;
      cancelAnimationFrame(animId);
      observer.disconnect();
    };
  }, [collisionMode, simSpeedKnots]);

  const stations = [
    {
      id: "bharati",
      name: "Bharati Station",
      region: "Prydz Bay Coast",
      lon: 76.19,
      lat: -69.41,
      legPreset: "ice_entry->bharati",
    },
    {
      id: "maitri",
      name: "Maitri Station",
      region: "Dronning Maud Land",
      lon: 11.73,
      lat: -70.77,
      legPreset: "ice_entry->maitri",
    },
    {
      id: "davis",
      name: "Davis Station",
      region: "Vestfold Hills",
      lon: 77.97,
      lat: -68.58,
      legPreset: "ice_entry->bharati",
    },
    {
      id: "mawson",
      name: "Mawson Station",
      region: "Holme Bay",
      lon: 62.87,
      lat: -67.6,
      legPreset: "ice_entry->bharati",
    },
  ];

  const sceneLabels = [
    "01 · GLACIAL HORIZON",
    "02 · SATELLITE ICE VISION",
    "03 · AUTONOMOUS ROUTING",
    "04 · ICEBERG AVOIDANCE",
  ];

  return (
    <div className="argos-landing">
      {/* Full-Viewport Scroll-Reactive Polar Globe, Glacier & Ship Canvas */}
      <canvas
        ref={bgCanvasRef}
        className="argos-bg-globe-canvas"
        aria-hidden="true"
      />

      {/* Top Scroll Progress Hairline (GPU transform-driven, zero React re-renders) */}
      <div className="argos-scroll-progress-bar">
        <div
          ref={progressFillRef}
          className="argos-scroll-progress-fill"
          style={{ transform: "scaleX(0)" }}
        />
      </div>

      {/* Minimal, Clean Editorial Top Navigation Bar */}
      <header className="argos-landing-header">
        <a
          href="#top"
          className="argos-landing-brand"
          onClick={(e) => {
            e.preventDefault();
            scrollToId("top");
          }}
        >
          <ArgosLogo size={32} showWordmark={true} />
        </a>

        <nav className="argos-landing-nav" aria-label="Landing Navigation">
          <button
            type="button"
            className={activeScene === 0 ? "active" : ""}
            onClick={() => scrollToId("top")}
          >
            Home
          </button>
          <button
            type="button"
            className={activeScene === 1 ? "active" : ""}
            onClick={() => scrollToId("about")}
          >
            About
          </button>
          <button
            type="button"
            className={activeScene === 2 ? "active" : ""}
            onClick={() => scrollToId("capabilities")}
          >
            How It Works
          </button>
          <button
            type="button"
            className={activeScene === 3 ? "active" : ""}
            onClick={() => scrollToId("titanic")}
          >
            Collision Sim
          </button>
        </nav>

        <div className="argos-landing-actions">
          <button
            type="button"
            className="argos-editorial-cta-btn"
            onClick={() => onEnterConsole()}
          >
            LAUNCH CONSOLE
          </button>

          <button
            type="button"
            className="argos-mobile-menu-btn"
            aria-label="Toggle Menu"
            onClick={() => setMobileMenuOpen((v) => !v)}
          >
            {mobileMenuOpen ? "✕" : "☰"}
          </button>
        </div>
      </header>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="argos-mobile-nav-drawer">
          <button type="button" onClick={() => scrollToId("top")}>
            Home
          </button>
          <button type="button" onClick={() => scrollToId("about")}>
            About
          </button>
          <button type="button" onClick={() => scrollToId("capabilities")}>
            How It Works
          </button>
          <button type="button" onClick={() => scrollToId("titanic")}>
            Collision Sim
          </button>
          <button
            type="button"
            className="dss-btn-primary"
            onClick={() => {
              setMobileMenuOpen(false);
              onEnterConsole();
            }}
          >
            Launch 3D Console
          </button>
        </div>
      )}

      {/* Subtle Scroll Scene Indicator on Right Margin */}
      <div className="argos-scene-rail" aria-hidden="true">
        <span className="argos-scene-rail-label mono">
          {sceneLabels[activeScene]}
        </span>
        <div className="argos-scroll-dots">
          {["top", "about", "capabilities", "titanic"].map((id, idx) => (
            <button
              key={id}
              type="button"
              className={activeScene === idx ? "active" : ""}
              onClick={() => scrollToId(id)}
            />
          ))}
        </div>
      </div>

      {/* Main Scrollable Editorial Content */}
      <div
        ref={scrollContainerRef}
        className="argos-landing-scroll"
        id="top"
        onScroll={handleScroll}
      >
        {/* ====================================================================
            SECTION 1: EDITORIAL HERO (Clean Typography, No Highlight Box, No VIEW Block)
            ==================================================================== */}
        <section className="argos-ed-hero">
          <div className="argos-ed-hero-top">
            <span className="argos-ed-eyebrow mono">
              ANTARCTIC SEA-ICE &amp; ROUTE GUIDANCE
            </span>
            <h1 className="argos-ed-display-title">ARGOS</h1>
            <p className="argos-ed-quote">
              Guiding polar vessels safely through shifting Antarctic sea ice
              with seven-day satellite intelligence and autonomous pathfinding.
            </p>

            <div className="argos-ed-hero-actions">
              <button
                type="button"
                className="dss-btn-primary argos-hero-primary"
                onClick={() => onEnterConsole()}
              >
                Enter 3D Polar Console
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
          </div>

          {/* Lower Hero Horizon: Two Minimal Floating Notes on Right */}
          <div className="argos-ed-hero-horizon">
            <div className="argos-ed-floating-notes">
              <div
                className="argos-ed-note-card"
                onClick={() => {
                  onEnterConsole();
                  onOpenDrawer?.("ml");
                }}
              >
                <div className="argos-ed-note-title">
                  <span className="argos-square-bullet" />
                  <strong>7-Day Sea-Ice Forecast</strong>
                </div>
                <p>
                  Deep learning predicts where pack ice will open or freeze
                  across the Southern Ocean.
                </p>
              </div>

              <div
                className="argos-ed-note-card"
                onClick={() => onEnterConsole({ focusShip: true })}
              >
                <div className="argos-ed-note-title">
                  <span className="argos-square-bullet" />
                  <strong>Autonomous Ship Routing</strong>
                </div>
                <p>
                  Finds the safest corridor around heavy ice ridges and drifting
                  tabular icebergs.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ====================================================================
            SECTION 2: PRODUCT EXPLANATION & INTERACTIVE ROUTE PLATE
            ==================================================================== */}
        <section className="argos-ed-section" id="about">
          <div className="argos-ed-split">
            {/* Left: Crisp, Short Editorial Lines (Zero Metric Boxes) */}
            <div className="argos-ed-prose-col">
              <span className="argos-ed-eyebrow mono">01 · THE CHALLENGE</span>
              <h2 className="argos-ed-h2">
                See the ice seven days ahead,
                <br />
                not just where it sits today.
              </h2>

              <p className="argos-ed-lead-p">
                Polar winds and ocean currents constantly push icebergs and seal
                open-water leads during a multi-day voyage. Routing a vessel on
                yesterday’s static map leaves ships vulnerable to sudden ice
                entrapment.
              </p>

              <p className="argos-ed-sub-p">
                <strong>ARGOS Passage</strong> continuously forecasts ice
                movement and computes a live path that adapts to your ship’s
                speed and destination.
              </p>

              <p className="argos-ed-whisper">
                “Designed for research icebreakers and Antarctic station
                resupply.”
              </p>
            </div>

            {/* Right: Clean Interactive Expedition Plate */}
            <div className="argos-ed-visual-plate">
              <span className="argos-plate-caption">
                « Interactive Antarctic Expedition Corridors »
              </span>

              <div className="argos-plate-card">
                <div className="argos-plate-top">
                  <ArgosLogo size={42} showWordmark={true} />
                  <button
                    type="button"
                    className="dss-btn-primary"
                    onClick={() => onEnterConsole({ focusShip: true })}
                  >
                    Sail in 3D →
                  </button>
                </div>

                <div className="argos-plate-controls">
                  <label className="dss-field">
                    <span>Choose Expedition Route</span>
                    <select
                      value={leg}
                      onChange={(e) => setLeg(e.target.value)}
                    >
                      <option value="bharati->maitri">
                        Bharati Station → Maitri Station
                      </option>
                      <option value="ice_entry->bharati">
                        56°S Ocean Gate → Bharati Station
                      </option>
                      <option value="ice_entry->maitri">
                        56°S Ocean Gate → Maitri Station
                      </option>
                    </select>
                  </label>

                  <div className="dss-slider-block">
                    <div className="dss-slider-title">
                      <span>Ice-Avoidance Preference</span>
                      <strong className="mono cyan-text">
                        {wRisk < 0.4
                          ? "Direct Path"
                          : wRisk < 1.0
                          ? "Balanced Safety"
                          : "Max Ice Avoidance"}
                      </strong>
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
                </div>

                <div className="argos-plate-stations">
                  {stations.map((st) => (
                    <button
                      key={st.id}
                      type="button"
                      className="argos-plate-st-btn"
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
                      <span>{st.region}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ====================================================================
            SECTION 3: HOW IT WORKS (THREE SHORT, CLEAN EDITORIAL BLOCKS)
            ==================================================================== */}
        <section className="argos-ed-section" id="capabilities">
          <div className="argos-ed-split is-reversed">
            {/* Left: Visual Feature Showcase Stack */}
            <div className="argos-ed-feature-stack">
              <div
                className="argos-ed-strip-card"
                onClick={() => {
                  onEnterConsole();
                  onOpenDrawer?.("ml");
                }}
              >
                <h4>01 · Satellite Sea-Ice Vision</h4>
                <p>
                  Daily polar satellite passes feed our neural network to map
                  drifting pack ice and open water leads.
                </p>
              </div>

              <div
                className="argos-ed-strip-card"
                onClick={() => onEnterConsole()}
              >
                <h4>02 · Multi-Hazard Safety Grid</h4>
                <p>
                  Combines sea-ice thickness, katabatic gale winds, ocean
                  currents, and iceberg drift zones into one clear map.
                </p>
              </div>

              <div
                className="argos-ed-strip-card"
                onClick={() => onEnterConsole({ focusShip: true })}
              >
                <h4>03 · Live 3D Bridge Playback</h4>
                <p>
                  Animate your ship day-by-day along the recommended corridor on
                  an interactive 3D globe or 2D chart.
                </p>
              </div>
            </div>

            {/* Right: Minimal Editorial Heading & Short Explanation */}
            <div className="argos-ed-prose-col">
              <span className="argos-ed-eyebrow mono">02 · HOW IT WORKS</span>
              <h2 className="argos-ed-h2">
                Built for clarity on the
                <br />
                polar navigation bridge.
              </h2>

              <p className="argos-ed-lead-p">
                Instead of overwhelming navigators with raw satellite files,
                ARGOS turns complex polar weather and sea-ice forecasts into a{" "}
                <strong>single clear route</strong>.
              </p>

              <p className="argos-ed-sub-p">
                Click any point on the 3D globe to set a custom destination,
                compare alternative paths, and inspect local wind and ice
                conditions in real time.
              </p>

              <div className="argos-ed-inline-actions">
                <button
                  type="button"
                  className="dss-btn-primary"
                  onClick={() => onEnterConsole()}
                >
                  Open 3D Globe →
                </button>
                <button
                  type="button"
                  className="dss-btn-secondary"
                  onClick={() => {
                    onEnterConsole();
                    onOpenDrawer?.("guide");
                  }}
                >
                  Read System Guide
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* ====================================================================
            SECTION 4: TITANIC COLLISION SIMULATOR & FINAL LAUNCH
            ==================================================================== */}
        <section className="argos-ed-section argos-section-last" id="titanic">
          <div className="argos-ed-split">
            {/* Left: Concise Story of Why Early Iceberg Detection Matters */}
            <div className="argos-ed-prose-col">
              <span className="argos-ed-eyebrow mono">
                03 · ICEBERG AVOIDANCE
              </span>
              <h2 className="argos-ed-h2">
                From thirty-seven seconds
                <br />
                to seven days of warning.
              </h2>

              <p className="argos-ed-lead-p">
                In April 1912, lookouts aboard <strong>RMS Titanic</strong>{" "}
                spotted an unlit iceberg just thirty-seven seconds before
                impact—too late to swing the hull clear of its submerged ice
                spur.
              </p>

              <p className="argos-ed-sub-p">
                With <strong>satellite radar tracking</strong> and automated
                pathfinding, ARGOS routes vessels safely around iceberg hazard
                zones days before visual contact.
              </p>

              <div className="argos-ed-inline-actions">
                <button
                  type="button"
                  className="dss-btn-primary argos-hero-primary"
                  onClick={() => onEnterConsole()}
                >
                  Launch 3D Polar Console
                </button>
              </div>
            </div>

            {/* Right: Clean Interactive Ship vs. Iceberg Simulator Plate */}
            <div className="argos-ed-visual-plate">
              <span className="argos-plate-caption">
                « Interactive Iceberg Avoidance Simulation »
              </span>

              <div className="argos-collision-card">
                <div className="argos-collision-top">
                  <div className="argos-collision-tabs">
                    <button
                      type="button"
                      className={
                        collisionMode === "titanic1912" ? "active" : ""
                      }
                      onClick={() => setCollisionMode("titanic1912")}
                    >
                      1912 Visual Lookout
                    </button>
                    <button
                      type="button"
                      className={collisionMode === "argos2026" ? "active" : ""}
                      onClick={() => setCollisionMode("argos2026")}
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
                  height={230}
                  className="argos-collision-canvas"
                />
              </div>
            </div>
          </div>
        </section>

        {/* Minimal Quiet Footer */}
        <footer className="argos-landing-footer">
          <div className="argos-footer-brand-zone">
            <ArgosLogo size={26} showWordmark={true} />
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
                onOpenDrawer?.("ml");
              }}
            >
              AI Model
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
