import { latLngToCell, cellToBoundary, cellToLatLng } from "h3-js";
import proj4 from "proj4";

/**
 * Vessel Profile Presets & Editable Operational Capabilities
 * Connected to NSIDC G02202 sea-ice concentration (SIC), thickness proxy, and route fuel calculations.
 */
export const VESSEL_PRESETS = {
  pc6_research: {
    id: "pc6_research",
    name: "RV Polar Explorer",
    model: "PC6 Ice-Strengthened Research Vessel",
    iceClass: "Polar Class 6 (PC6)",
    speedKmh: 22.0,
    maxSicPct: 70,
    cautionSicPct: 40,
    maxIceThicknessM: 1.2,
    fuelCapacityTons: 1250,
    initialFuelTons: 1100,
    baseFuelTonsPerDay: 18.5,
    operationalLimits:
      "Summer/autumn operation in medium first-year ice up to 1.2 m thickness (≤70% SIC). Avoid consolidated multi-year ridges.",
    damageToleranceDesc:
      "Reinforced bow & ice belt rated for 1.20 m level first-year ice; high hull damage risk above 70% SIC.",
  },
  pc5_supply: {
    id: "pc5_supply",
    name: "SA Agulhas II Class",
    model: "PC5 Polar Supply & Research Ship",
    iceClass: "Polar Class 5 (PC5)",
    speedKmh: 24.0,
    maxSicPct: 80,
    cautionSicPct: 45,
    maxIceThicknessM: 1.5,
    fuelCapacityTons: 1800,
    initialFuelTons: 1620,
    baseFuelTonsPerDay: 24.0,
    operationalLimits:
      "Year-round operation in medium first-year ice up to 1.5 m thickness (≤80% SIC) with old-ice inclusions.",
    damageToleranceDesc:
      "PC5 strengthened hull framing rated for 1.50 m first-year pack ice; structural overload above 80% SIC.",
  },
  pc3_icebreaker: {
    id: "pc3_icebreaker",
    name: "Polar Heavy Icebreaker",
    model: "PC3 Heavy Escort Icebreaker",
    iceClass: "Polar Class 3 (PC3)",
    speedKmh: 26.0,
    maxSicPct: 92,
    cautionSicPct: 60,
    maxIceThicknessM: 2.5,
    fuelCapacityTons: 3200,
    initialFuelTons: 2950,
    baseFuelTonsPerDay: 36.0,
    operationalLimits:
      "Year-round operation in second-year ice up to 2.5 m thickness (≤92% SIC) and heavy pack ridges.",
    damageToleranceDesc:
      "Heavy ice-knife bow & double hull rated for 2.50 m consolidated pack and pressure ridges.",
  },
  fsicr_1a: {
    id: "fsicr_1a",
    name: "MV Antarctic Resupply",
    model: "1A Ice-Strengthened Cargo Vessel",
    iceClass: "FSICR 1A (Light Ice)",
    speedKmh: 19.0,
    maxSicPct: 50,
    cautionSicPct: 25,
    maxIceThicknessM: 0.8,
    fuelCapacityTons: 850,
    initialFuelTons: 740,
    baseFuelTonsPerDay: 14.0,
    operationalLimits:
      "Marginal ice zone and open polynya leads up to 0.8 m thin first-year ice (≤50% SIC). Escort required in heavy pack.",
    damageToleranceDesc:
      "Light ice belt rated for 0.80 m brash/thin drift ice; severe plating damage risk above 50% SIC.",
  },
};

/**
 * Convert a normalized risk score [0..1] into the 4-tier Polar Risk classification:
 * Safe (<0.25), Caution (0.25..0.50), High (0.50..0.75), No-Go (>=0.75)
 */
export function classifyPolarRisk(score) {
  const s = Math.max(0, Math.min(1, Number(score) || 0));
  if (s >= 0.75) {
    return {
      level: "No-Go",
      code: "NO-GO",
      color: "#e11d48",
      rgba: [225, 29, 72, 238],
      stroke: "rgba(251, 113, 133, 0.92)",
      fill: "rgba(225, 29, 72, 0.28)",
    };
  }
  if (s >= 0.5) {
    return {
      level: "High",
      code: "HIGH",
      color: "#f97316",
      rgba: [249, 115, 22, 228],
      stroke: "rgba(251, 146, 60, 0.88)",
      fill: "rgba(249, 115, 22, 0.22)",
    };
  }
  if (s >= 0.25) {
    return {
      level: "Caution",
      code: "CAUTION",
      color: "#eab308",
      rgba: [234, 179, 8, 218],
      stroke: "rgba(250, 204, 21, 0.82)",
      fill: "rgba(234, 179, 8, 0.16)",
    };
  }
  return {
    level: "Safe",
    code: "SAFE",
    color: "#10b981",
    rgba: [16, 185, 129, 195],
    stroke: "rgba(52, 211, 153, 0.65)",
    fill: "rgba(16, 185, 129, 0.09)",
  };
}

/**
 * Estimate physical sea-ice thickness (m) from passive microwave SIC fraction [0..1]
 */
export function estimateIceThicknessM(sic) {
  if (!(sic > 0.02)) return 0;
  return Number((0.12 + 1.55 * Math.pow(Math.min(1, sic), 1.32)).toFixed(2));
}

/**
 * Compute Fuel Consumption, Remaining Fuel, Remaining Range, Vessel Ice Safety,
 * plus Route Summary Metrics (Fuel Saved, Fuel Saving %, Risks Avoided, Avg/Max Risk Level)
 * directly from existing routeData, polarRiskFields, and configured Vessel Profile.
 */
export function computeRouteFuelAndSafety(
  fcMetrics,
  stMetrics,
  vesselProfile,
  progressPct = 0,
  routeData = null,
  polarRiskFields = null
) {
  const vp = vesselProfile || VESSEL_PRESETS.pc6_research;
  const speedRatio = 22.0 / Math.max(8, Number(vp.speedKmh) || 22.0);
  const hourlyOpenBurnTons = (Number(vp.baseFuelTonsPerDay) || 18.5) / 24.0;

  if (!fcMetrics?.ok) {
    const cap = Number(vp.fuelCapacityTons) || 1250;
    const initFuel = Math.min(cap, Number(vp.initialFuelTons) || 1100);
    const openRangeKm =
      (initFuel / hourlyOpenBurnTons) * (Number(vp.speedKmh) || 22.0);
    return {
      hasRoute: false,
      fuelCapacityTons: cap,
      initialFuelTons: initFuel,
      estimatedBurnTons: 0,
      baselineBurnTons: 0,
      fuelSavedTons: 0,
      fuelSavedPct: 0,
      remainingFuelTons: initFuel,
      remainingFuelPct: Math.round((initFuel / Math.max(1, cap)) * 100),
      currentStepFuelTons: initFuel,
      estimatedRangeKm: Math.round(openRangeKm),
      estimatedRangeNm: Math.round(openRangeKm * 0.539957),
      adjustedHours: 0,
      baselineAdjustedHours: 0,
      peakSicPct: 0,
      peakIceThicknessM: 0,
      heavyCellsAvoided: 0,
      majorRisksAvoidedCount: 0,
      avgRiskScore: 0,
      maxRiskScore: 0,
      avgRiskLevel: "Safe",
      maxRiskLevel: "Safe",
      baselineMaxRiskLevel: "Safe",
      capabilityStatus: "SAFE",
      capabilityLabel: "Safe Operating Envelope",
      capabilityDetail: `Rated up to ${vp.maxSicPct}% SIC and ${vp.maxIceThicknessM.toFixed(
        2
      )} m ice thickness.`,
    };
  }

  // fcMetrics.fuel_proxy is sum(step_km * (1 + 1.5 * sic^2)) from server.ts
  const fuelProxyKm =
    Number(fcMetrics.fuel_proxy) || Number(fcMetrics.distance_km) || 0;
  const baseProxyKm =
    Number(stMetrics?.fuel_proxy) ||
    Number(stMetrics?.distance_km) ||
    fuelProxyKm;

  const adjustedHours = Number((fcMetrics.hours * speedRatio).toFixed(1));
  const baselineAdjustedHours = stMetrics?.hours
    ? Number((stMetrics.hours * speedRatio).toFixed(1))
    : adjustedHours;

  const effectiveIceHours =
    fuelProxyKm / Math.max(8, Number(vp.speedKmh) || 22.0);
  const baseEffectiveIceHours =
    baseProxyKm / Math.max(8, Number(vp.speedKmh) || 22.0);

  const estimatedBurnTons = Number(
    (effectiveIceHours * hourlyOpenBurnTons).toFixed(1)
  );
  const baselineBurnTons = Number(
    (baseEffectiveIceHours * hourlyOpenBurnTons).toFixed(1)
  );
  const fuelSavedTons = Number(
    (baselineBurnTons - estimatedBurnTons).toFixed(1)
  );
  const fuelSavedPct =
    baselineBurnTons > 0
      ? Number(((fuelSavedTons / baselineBurnTons) * 100).toFixed(1))
      : 0;

  const cap = Math.max(50, Number(vp.fuelCapacityTons) || 1250);
  const initFuel = Math.min(
    cap,
    Math.max(0, Number(vp.initialFuelTons) || 1100)
  );
  const remainingAfterRouteTons = Number(
    Math.max(0, initFuel - estimatedBurnTons).toFixed(1)
  );
  const consumedSoFarTons = Number(
    (
      (estimatedBurnTons * Math.max(0, Math.min(100, progressPct))) /
      100
    ).toFixed(1)
  );
  const currentStepFuelTons = Number(
    Math.max(0, initFuel - consumedSoFarTons).toFixed(1)
  );
  const remainingFuelPct = Math.round((remainingAfterRouteTons / cap) * 100);

  // Average fuel burn per km along the active route
  const tonsPerKm =
    fcMetrics.distance_km > 0
      ? estimatedBurnTons / fcMetrics.distance_km
      : hourlyOpenBurnTons / (Number(vp.speedKmh) || 22.0);
  const estimatedRangeKm = Math.round(
    remainingAfterRouteTons / Math.max(0.005, tonsPerKm)
  );
  const estimatedRangeNm = Math.round(estimatedRangeKm * 0.539957);

  // Number of Major Ice / Iceberg Risks Avoided (from actual route high_risk cells & course corrections)
  const stHeavyCells = stMetrics?.high_risk?.length || 0;
  const fcHeavyCells = fcMetrics?.high_risk?.length || 0;
  const heavyCellsAvoided = Math.max(0, stHeavyCells - fcHeavyCells);
  const ccCount = routeData?.course_corrections?.length || 0;
  const hzCount = routeData?.projected_hazard_zones?.length || 0;
  const majorRisksAvoidedCount =
    heavyCellsAvoided > 0
      ? Math.max(ccCount, hzCount, Math.ceil(heavyCellsAvoided / 3))
      : ccCount;

  // Compute Average & Maximum Risk Level along the active Optimal A* path
  const fcPath = routeData?.forecast_aware?.path || [];
  const stPath = routeData?.static?.path || [];
  let avgRiskScore = 0;
  let maxRiskScore = 0;
  let baseMaxRiskScore = 0;

  if (polarRiskFields?.combinedRisk && polarRiskFields.shape?.length === 2) {
    const W = polarRiskFields.shape[1];
    const comb = polarRiskFields.combinedRisk;
    if (fcPath.length > 0) {
      let sumR = 0;
      for (const [r, c] of fcPath) {
        const val = comb[r * W + c] || 0;
        sumR += val;
        if (val > maxRiskScore) maxRiskScore = val;
      }
      avgRiskScore = Number((sumR / fcPath.length).toFixed(2));
      maxRiskScore = Number(maxRiskScore.toFixed(2));
    }
    if (stPath.length > 0) {
      for (const [r, c] of stPath) {
        const val = comb[r * W + c] || 0;
        if (val > baseMaxRiskScore) baseMaxRiskScore = val;
      }
      baseMaxRiskScore = Number(baseMaxRiskScore.toFixed(2));
    }
  } else {
    // Fallback directly from route mean_sic and max_sic if polarRiskFields not yet ready
    const maxSic = Math.max(0.25, (Number(vp.maxSicPct) || 70) / 100);
    avgRiskScore = Number(
      Math.min(0.95, ((fcMetrics.mean_sic || 0.12) / maxSic) * 0.75).toFixed(2)
    );
    maxRiskScore = Number(
      Math.min(0.95, ((fcMetrics.max_sic || 0.25) / maxSic) * 0.75).toFixed(2)
    );
    baseMaxRiskScore = Number(
      Math.min(0.95, ((stMetrics?.max_sic || 0.45) / maxSic) * 0.75).toFixed(2)
    );
  }

  const avgRiskClass = classifyPolarRisk(avgRiskScore);
  const maxRiskClass = classifyPolarRisk(maxRiskScore);
  const baseMaxRiskClass = classifyPolarRisk(baseMaxRiskScore);

  // Evaluate Vessel Ice Capability against Route Peak SIC & Ice Thickness
  const peakSic = Number(fcMetrics.max_sic) || 0;
  const peakSicPct = Math.round(peakSic * 100);
  const peakIceThicknessM = estimateIceThicknessM(peakSic);

  let capabilityStatus = "SAFE";
  let capabilityLabel = "Within Vessel Ice Capability";
  let capabilityDetail = `Route peak ${peakSicPct}% SIC (~${peakIceThicknessM} m) is safely below ${vp.iceClass} limit (${vp.maxSicPct}% SIC / ${vp.maxIceThicknessM.toFixed(
    2
  )} m).`;

  if (peakSicPct > vp.maxSicPct || peakIceThicknessM > vp.maxIceThicknessM) {
    capabilityStatus = "NO-GO";
    capabilityLabel = "Exceeds Hull Damage Tolerance";
    capabilityDetail = `Route peak ${peakSicPct}% SIC (~${peakIceThicknessM} m) exceeds ${vp.iceClass} limit (${vp.maxSicPct}% SIC / ${vp.maxIceThicknessM.toFixed(
      2
    )} m). Increase λ or upgrade vessel class.`;
  } else if (
    peakSicPct >= vp.cautionSicPct ||
    peakIceThicknessM >= vp.maxIceThicknessM * 0.78
  ) {
    capabilityStatus = "CAUTION";
    capabilityLabel = "Caution — Heavy Ice Operations";
    capabilityDetail = `Route peak ${peakSicPct}% SIC (~${peakIceThicknessM} m) requires active icebreaking within ${vp.iceClass} envelope (max ${vp.maxSicPct}% SIC / ${vp.maxIceThicknessM.toFixed(
      2
    )} m).`;
  }

  return {
    hasRoute: true,
    fuelCapacityTons: cap,
    initialFuelTons: initFuel,
    estimatedBurnTons,
    baselineBurnTons,
    fuelSavedTons,
    fuelSavedPct,
    remainingFuelTons: remainingAfterRouteTons,
    remainingFuelPct,
    currentStepFuelTons,
    estimatedRangeKm,
    estimatedRangeNm,
    adjustedHours,
    baselineAdjustedHours,
    peakSicPct,
    peakIceThicknessM,
    heavyCellsAvoided,
    majorRisksAvoidedCount,
    avgRiskScore,
    maxRiskScore,
    avgRiskLevel: avgRiskClass.level,
    maxRiskLevel: maxRiskClass.level,
    baselineMaxRiskLevel: baseMaxRiskClass.level,
    capabilityStatus,
    capabilityLabel,
    capabilityDetail,
  };
}

/**
 * Compute Multi-Factor Polar Risk Grids [H * W] using ONLY existing project data/models:
 * - iceRisk: From U-Net / Observed SIC + U-Net validation uncertainty + Vessel Profile maxSicPct / maxIceThicknessM
 * - icebergRisk: From tracked USNIC/BYU tabular icebergs (D-28, B-22A, A-74, A-76A) & 7-day drift cones at timelineStep
 * - weatherRisk: From dataset 10m wind vectors (u10_e, u10_n in tabular_icebergs_usnic.json) + East Antarctic katabatic terrain slope
 * - oceanRisk: From IBCSO v2 bathymetry (elevationGrid shoals/shelf break) + coastal current (cur_e, cur_n) & ice-drift convergence
 * - combinedRisk: Weighted operational synthesis mapped to Safe / Caution / High / No-Go
 */
export function computePolarRiskFields({
  scenario,
  sicSlice,
  uncertaintyGrid,
  elevationGrid,
  surfaceTypeGrid,
  icebergs,
  timelineStep = 1,
  vesselProfile = VESSEL_PRESETS.pc6_research,
}) {
  if (!scenario?.shape || !scenario?.extent || !sicSlice?.data) return null;

  const [H, W] = scenario.shape;
  const [xmin, ymin, xmax, ymax] = scenario.extent;
  const N = H * W;

  const sicData = sicSlice.data;
  const uncData = uncertaintyGrid?.data || null;
  const elevData = elevationGrid?.data || null;
  const surfData = surfaceTypeGrid?.data || null;

  const iceRisk = new Float32Array(N);
  const icebergRisk = new Float32Array(N);
  const weatherRisk = new Float32Array(N);
  const oceanRisk = new Float32Array(N);
  const combinedRisk = new Float32Array(N);
  const windSpeedMs = new Float32Array(N);
  const windU = new Float32Array(N);
  const windV = new Float32Array(N);
  const currentSpeedMs = new Float32Array(N);
  const curU = new Float32Array(N);
  const curV = new Float32Array(N);
  const waveHeightM = new Float32Array(N);
  const nearestBergDistKm = new Float32Array(N);
  nearestBergDistKm.fill(9999);

  const maxSic = Math.max(0.25, (Number(vesselProfile?.maxSicPct) || 70) / 100);
  const cautionSic = Math.max(
    0.12,
    (Number(vesselProfile?.cautionSicPct) || 40) / 100
  );
  const maxThickM = Math.max(
    0.4,
    Number(vesselProfile?.maxIceThicknessM) || 1.2
  );

  // Extract active iceberg positions, cones, and observed wind/current seeds at current timelineStep
  const activeBergs = (icebergs || []).map((b) => {
    let pt = { x_m: b.x_m, y_m: b.y_m, lon: b.lon, lat: b.lat, cone_km: 18 };
    if (timelineStep < 0 && b.history?.length) {
      const targetLead = Math.max(-5, timelineStep);
      pt = b.history.reduce((best, cur) =>
        Math.abs(cur.lead_days - targetLead) <
        Math.abs(best.lead_days - targetLead)
          ? cur
          : best
      );
    } else if (timelineStep > 0 && b.track?.length) {
      pt = b.track.reduce((best, cur) =>
        Math.abs(cur.lead_days - timelineStep) <
        Math.abs(best.lead_days - timelineStep)
          ? cur
          : best
      );
    }
    const u10e = Number(b.u10_e) || 6.2;
    const u10n = Number(b.u10_n) || -1.2;
    const cure = Number(b.cur_e) || -0.08;
    const curn = Number(b.cur_n) || 0.01;
    return {
      id: b.id,
      name: b.name,
      x_m: pt.x_m ?? b.x_m,
      y_m: pt.y_m ?? b.y_m,
      coneKm: pt.cone_km || 12 + Math.max(0, timelineStep) * 11.5,
      u10e,
      u10n,
      u10Ms: Math.hypot(u10e, u10n),
      cure,
      curn,
      curMs: Math.hypot(cure, curn),
    };
  });

  for (let r = 0; r < H; r++) {
    const ym = ymax - ((r + 0.5) / H) * (ymax - ymin);
    for (let c = 0; c < W; c++) {
      const xm = xmin + ((c + 0.5) / W) * (xmax - xmin);
      const idx = r * W + c;

      const sType = surfData ? Math.round(surfData[idx]) : 0;
      const elevM = elevData ? elevData[idx] : -1500;
      const sic = Math.max(0, Math.min(1, sicData[idx] || 0));
      const unc = uncData ? Math.max(0, uncData[idx] || 0) : 0;

      // Grounded continent or floating ice shelf is No-Go for marine navigation
      if (sType > 0) {
        iceRisk[idx] = 0.95;
        icebergRisk[idx] = 0.0;
        weatherRisk[idx] = 0.45;
        oceanRisk[idx] = 0.95;
        combinedRisk[idx] = 0.95;
        continue;
      }

      // 1. ICE RISK
      const estThick = estimateIceThicknessM(sic);
      let rIce = 0;
      if (sic >= maxSic || estThick >= maxThickM) {
        const excess = Math.min(1, (sic - maxSic) / Math.max(0.08, 1 - maxSic));
        rIce = 0.76 + 0.22 * excess;
      } else if (sic >= cautionSic) {
        const t = (sic - cautionSic) / Math.max(0.05, maxSic - cautionSic);
        rIce = 0.5 + 0.25 * t;
      } else if (sic >= 0.15) {
        const t = (sic - 0.15) / Math.max(0.05, cautionSic - 0.15);
        rIce = 0.25 + 0.25 * t;
      } else {
        rIce = (sic / 0.15) * 0.22;
      }
      rIce = Math.min(0.98, rIce + Math.min(0.14, unc * 0.85));
      iceRisk[idx] = rIce;

      // 2. ICEBERG RISK & Interpolated Wind/Current vectors from USNIC dataset seeds
      let rBerg = 0;
      let minBergKm = 9999;
      let wUe = 0,
        wUn = 0,
        wCe = 0,
        wCn = 0,
        wDenom = 0;

      for (let bIdx = 0; bIdx < activeBergs.length; bIdx++) {
        const b = activeBergs[bIdx];
        const distKm = Math.hypot(xm - b.x_m, ym - b.y_m) / 1000.0;
        if (distKm < minBergKm) minBergKm = distKm;

        const coneKm = b.coneKm;
        if (distKm <= coneKm * 0.65) {
          rBerg = Math.max(rBerg, 0.82);
        } else if (distKm <= coneKm * 1.35) {
          const t = 1 - (distKm - coneKm * 0.65) / (coneKm * 0.7);
          rBerg = Math.max(rBerg, 0.5 + 0.28 * t);
        } else if (distKm <= coneKm * 2.6) {
          const t = 1 - (distKm - coneKm * 1.35) / (coneKm * 1.25);
          rBerg = Math.max(rBerg, 0.25 + 0.24 * t);
        } else if (distKm <= 340) {
          rBerg = Math.max(rBerg, 0.18 * (1 - distKm / 340));
        }

        const w = 1 / (1 + Math.pow(distKm / 420, 2));
        wUe += b.u10e * w;
        wUn += b.u10n * w;
        wCe += b.cure * w;
        wCn += b.curn * w;
        wDenom += w;
      }
      nearestBergDistKm[idx] = minBergKm;
      icebergRisk[idx] = Math.min(0.96, rBerg);

      const cR = Math.min(W - 1, c + 1);
      const rD = Math.min(H - 1, r + 1);
      const dElev = elevData
        ? Math.hypot(
            elevData[r * W + cR] - elevM,
            elevData[rD * W + c] - elevM
          )
        : 0;
      const cSicR = sicData[r * W + cR] || 0;
      const rSicD = sicData[rD * W + c] || 0;
      const sicGrad = Math.hypot(cSicR - sic, rSicD - sic);

      // 3. WEATHER RISK & Wind Vector Field
      const ue = wDenom > 0 ? wUe / wDenom : 6.2;
      const un = wDenom > 0 ? wUn / wDenom : -1.1;
      const coastalKatabatic =
        elevM > -650 ? Math.min(5.5, ((elevM + 650) / 500) * 3.2) : 0;
      const frontWind = Math.min(3.5, sicGrad * 14.0);
      // Katabatic outflow adds northward/westward coastal wind component
      const totalUe = ue - coastalKatabatic * 0.65;
      const totalUn = un + coastalKatabatic * 0.75;
      const u10Total = Math.hypot(totalUe, totalUn) + frontWind;
      windU[idx] = totalUe;
      windV[idx] = totalUn;
      windSpeedMs[idx] = Number(u10Total.toFixed(1));

      const rWeather = Math.max(
        0.05,
        Math.min(0.84, (u10Total - 4.2) / 13.2)
      );
      weatherRisk[idx] = rWeather;

      // Wave Height Proxy in open water / marginal ice (damped by sea ice cover)
      const iceDamping = Math.max(0, 1 - Math.pow(Math.min(1, sic / 0.45), 1.2));
      const estHs = Number(
        (0.22 * Math.pow(u10Total, 1.18) * iceDamping).toFixed(1)
      );
      waveHeightM[idx] = estHs;

      // 4. OCEAN RISK & Coastal Current Field
      const ce = wDenom > 0 ? wCe / wDenom : -0.08;
      const cn = wDenom > 0 ? wCn / wDenom : 0.01;
      const shelfCurrentBoost = Math.min(0.14, (dElev / 1400) * 0.09);
      const curTotal = Math.hypot(ce, cn) + shelfCurrentBoost + sicGrad * 0.12;
      curU[idx] = ce * (1 + shelfCurrentBoost * 4);
      curV[idx] = cn * (1 + shelfCurrentBoost * 4);
      currentSpeedMs[idx] = Number(curTotal.toFixed(2));

      const shoalRisk =
        elevM > -320 ? Math.min(0.58, (elevM + 320) / 320) : 0.04;
      const slopeRisk = Math.min(0.45, dElev / 1600);
      const shearRisk = Math.min(0.48, sicGrad * 2.2 + curTotal * 1.4);
      const rOcean = Math.min(
        0.85,
        Math.max(shoalRisk, 0.45 * slopeRisk + 0.55 * shearRisk)
      );
      oceanRisk[idx] = rOcean;

      // 5. COMBINED POLAR RISK MAP
      const dominantHazard = Math.max(rIce, rBerg);
      const weightedMean =
        0.48 * rIce + 0.24 * rBerg + 0.14 * rWeather + 0.14 * rOcean;
      combinedRisk[idx] = Math.min(
        0.98,
        Math.max(dominantHazard * 0.92, weightedMean)
      );
    }
  }

  return {
    shape: [H, W],
    iceRisk,
    icebergRisk,
    weatherRisk,
    oceanRisk,
    combinedRisk,
    windSpeedMs,
    windU,
    windV,
    currentSpeedMs,
    curU,
    curV,
    waveHeightM,
    nearestBergDistKm,
  };
}

/**
 * Build lightweight, non-noisy visual overlays for the 4 optional Weather & Ocean layers:
 * - windArrows: Strong Wind vectors + animated streamlines explaining ship & iceberg wind drift
 * - currentStreamlines: Antarctic Coastal Current & ACC flow lines carrying tabular icebergs
 * - waveIndicators: Open-ocean High Wave swell chevrons (damped inside pack ice)
 * - weatherZones: Severe Weather / Katabatic Gale intensity zone polygons
 */
export function buildWeatherEffectOverlays({
  scenario,
  sicSlice,
  surfaceTypeGrid,
  polarRiskFields,
  timelineStep = 1,
}) {
  if (!scenario?.shape || !scenario?.extent || !polarRiskFields) {
    return {
      windArrows: [],
      currentStreamlines: [],
      waveIndicators: [],
      weatherZones: [],
    };
  }

  const [H, W] = scenario.shape;
  const [xmin, ymin, xmax, ymax] = scenario.extent;
  const surfData = surfaceTypeGrid?.data || null;
  const sicData = sicSlice?.data || null;
  const {
    windSpeedMs,
    windU,
    windV,
    currentSpeedMs,
    curU,
    curV,
    waveHeightM,
    weatherRisk,
  } = polarRiskFields;

  const cellW = (xmax - xmin) / W;
  const cellH = (ymax - ymin) / H;
  const phaseShift = Math.max(0, timelineStep) * 0.15;

  const windArrows = [];
  const currentStreamlines = [];
  const waveIndicators = [];

  // 1. Strong Wind Vectors (sampled on a clean 12x14 grid where windSpeedMs >= 7.2 m/s)
  for (let r = 8; r < H - 8; r += 11) {
    const ym = ymax - (r + 0.5) * cellH;
    for (let c = 8; c < W - 8; c += 12) {
      const xm = xmin + (c + 0.5) * cellW;
      const idx = r * W + c;
      if (surfData && surfData[idx] > 0) continue;

      const wspd = windSpeedMs[idx] || 0;
      if (wspd < 7.0) continue;

      const [lon, lat] = proj4("EPSG:3412", "EPSG:4326", [xm, ym]);
      // Compute downstream point in EPSG:3412 from eastward/northward wind components
      // Note: in server.ts, bergDriftMs uses we = -u10_e (Polar Easterlies blow westward near coast, Westerlies blow eastward offshore)
      const isCoastalEasterly = lat <= -63.0;
      const dLon = isCoastalEasterly ? -1.8 : 2.1;
      const dLat = (windV[idx] >= 0 ? 0.35 : -0.35) + 0.18 * Math.sin(lon * 0.08 + phaseShift);
      const [x1, y1] = proj4("EPSG:4326", "EPSG:3412", [lon + dLon, lat + dLat]);

      const dx = x1 - xm;
      const dy = y1 - ym;
      const len = Math.hypot(dx, dy) || 1;
      const scaleLen = (65000 + Math.min(75000, (wspd - 6) * 11000));
      const ex = xm + (dx / len) * scaleLen;
      const ey = ym + (dy / len) * scaleLen;

      const knots = Math.round(wspd * 1.94384);
      const isSevere = wspd >= 10.5;

      windArrows.push({
        id: `wind-${r}-${c}`,
        x0: xm,
        y0: ym,
        x1: ex,
        y1: ey,
        speedMs: wspd,
        knots,
        isSevere,
        regime: isCoastalEasterly
          ? "Antarctic Polar Easterly / Katabatic Outflow"
          : "Southern Ocean Circumpolar Westerly",
        inspect: {
          kind: "Strong Wind Vector (10m U10)",
          title: `${wspd.toFixed(1)} m/s (${knots} kn) · ${
            isCoastalEasterly ? "Polar Easterly" : "Westerly Gale"
          }`,
          subtitle: `${Math.abs(lat).toFixed(2)}°S, ${Math.abs(lon).toFixed(
            2
          )}°${lon >= 0 ? "E" : "W"}`,
          metrics: [
            {
              label: "Wind Speed (10m)",
              value: `${wspd.toFixed(1)} m/s (${knots} knots)`,
            },
            {
              label: "Iceberg Drift Effect",
              value: `Drives ~${(wspd * 0.022 * 86.4).toFixed(
                1
              )} km/day wind-induced drift (+25° Coriolis deflection)`,
            },
            {
              label: "Vessel Impact",
              value: isSevere
                ? "High windage resistance & freezing spray hazard"
                : "Moderate crosswind drift on hull",
            },
          ],
        },
      });
    }
  }

  // 2. Ocean Currents (Antarctic Coastal Current & Southern Ocean Drift Streamlines)
  for (let r = 12; r < H - 10; r += 14) {
    const ym0 = ymax - (r + 0.5) * cellH;
    for (let c = 12; c < W - 12; c += 18) {
      const xm0 = xmin + (c + 0.5) * cellW;
      const idx = r * W + c;
      if (surfData && surfData[idx] > 0) continue;

      const cspd = currentSpeedMs[idx] || 0.08;
      const [lon0, lat0] = proj4("EPSG:3412", "EPSG:4326", [xm0, ym0]);
      const isCoastalCurrent = lat0 <= -62.5;

      // Build a smooth 5-point streamline segment following the current
      const pts = [];
      let curLon = lon0;
      let curLat = lat0;
      let valid = true;
      for (let s = 0; s < 5; s++) {
        const [px, py] = proj4("EPSG:4326", "EPSG:3412", [curLon, curLat]);
        if (px < xmin || px > xmax || py < ymin || py > ymax) {
          valid = false;
          break;
        }
        pts.push([px, py]);
        curLon += isCoastalCurrent ? -1.45 : 1.65;
        curLat += 0.14 * Math.sin((curLon * Math.PI) / 22.0);
      }
      if (!valid || pts.length < 3) continue;

      const cmPerSec = Math.round(cspd * 100);
      currentStreamlines.push({
        id: `cur-${r}-${c}`,
        pts,
        speedMs: cspd,
        isCoastalCurrent,
        inspect: {
          kind: "Southern Ocean / Coastal Current Streamline",
          title: isCoastalCurrent
            ? "Antarctic Coastal Current (Westward)"
            : "Antarctic Circumpolar Current (Eastward)",
          subtitle: `${Math.abs(lat0).toFixed(2)}°S, ${Math.abs(lon0).toFixed(
            2
          )}°E · Speed ${cspd.toFixed(2)} m/s (${cmPerSec} cm/s)`,
          metrics: [
            {
              label: "Current Velocity",
              value: `${cspd.toFixed(2)} m/s (${(cspd * 86.4).toFixed(
                1
              )} km/day)`,
            },
            {
              label: "Tabular Iceberg Transport",
              value:
                "Primary carrier of deep-draft tabular bergs (D-28, B-22A, A-74) along shelf break",
            },
            {
              label: "Ship Navigation Effect",
              value: isCoastalCurrent
                ? "Favorable +0.2 kn westward set toward Maitri Station"
                : "Eastward open-ocean set along 56°S–61°S",
            },
          ],
        },
      });
    }
  }

  // 3. High Waves (Open-ocean swell chevrons where SIC < 18% and waveHeightM >= 2.2 m)
  for (let r = 10; r < H - 14; r += 13) {
    const ym = ymax - (r + 0.5) * cellH;
    for (let c = 10; c < W - 10; c += 14) {
      const xm = xmin + (c + 0.5) * cellW;
      const idx = r * W + c;
      if (surfData && surfData[idx] > 0) continue;
      const sic = sicData ? sicData[idx] : 0;
      if (sic >= 0.22) continue; // Sea ice damps high open-ocean waves

      const hs = waveHeightM[idx] || 0;
      if (hs < 2.1) continue;

      const [lon, lat] = proj4("EPSG:3412", "EPSG:4326", [xm, ym]);
      const span = 42000;
      // Double wave crest chevron geometry
      const crest1 = [
        [xm - span, ym - span * 0.25],
        [xm - span * 0.35, ym + span * 0.22],
        [xm + span * 0.35, ym - span * 0.22],
        [xm + span, ym + span * 0.25],
      ];
      const crest2 = crest1.map(([x, y]) => [x, y - 24000]);

      waveIndicators.push({
        id: `wave-${r}-${c}`,
        xm,
        ym,
        crest1,
        crest2,
        hs,
        isRough: hs >= 3.2,
        inspect: {
          kind: "High Waves & Southern Ocean Swell",
          title: `Est. Swell ~${hs.toFixed(1)} m (Open-Fetch Wind Sea)`,
          subtitle: `${Math.abs(lat).toFixed(2)}°S, ${Math.abs(lon).toFixed(
            2
          )}°E · Local SIC ${Math.round(sic * 100)}%`,
          metrics: [
            {
              label: "Estimated Wave State",
              value: `~${hs.toFixed(
                1
              )} m (Derived from U10 wind & open-water fetch; buoy spectra unavailable)`,
            },
            {
              label: "Ship Motion Impact",
              value:
                hs >= 3.2
                  ? "Pitch/roll speed penalty (-10% to -18%) & bow slamming risk"
                  : "Moderate open-ocean swell roll",
            },
            {
              label: "Marginal Ice Zone Interaction",
              value:
                "Swell penetrates outer 15% ice edge, flexing and fracturing floes",
            },
          ],
        },
      });
    }
  }

  // 4. Severe Weather Areas (Coherent polygons where katabatic outflow & wind-ice shear peak)
  const makeWeatherZone = (id, title, lonC, latC, lonR, latR, windDesc, effectDesc) => {
    const ring = [];
    const steps = 28;
    for (let i = 0; i <= steps; i++) {
      const ang = (i / steps) * Math.PI * 2;
      const lon = lonC + lonR * Math.cos(ang);
      const lat = latC + latR * Math.sin(ang);
      ring.push(proj4("EPSG:4326", "EPSG:3412", [lon, lat]));
    }
    const [cx, cy] = proj4("EPSG:4326", "EPSG:3412", [lonC, latC]);
    return {
      id,
      title,
      lon: lonC,
      lat: latC,
      centerXm: cx,
      centerYm: cy,
      ringXy: ring,
      inspect: {
        kind: "Severe Weather & Katabatic Gale Area",
        title,
        subtitle: `${Math.abs(latC).toFixed(1)}°S, ${Math.abs(lonC).toFixed(
          1
        )}°E · Active Marine Weather Advisory`,
        metrics: [
          { label: "Dominant Weather Regime", value: windDesc },
          { label: "Impact on Ship & Icebergs", value: effectDesc },
          {
            label: "Route Safety Action",
            value:
              "A* risk weight (λ) penalizes high wind-ice compression corridors",
          },
        ],
      },
    };
  };

  const weatherZones = [
    makeWeatherZone(
      "WX-COOP-GALE",
      "Cooperation Sea Polar Low & Pack Compression Zone",
      63.5,
      -63.2,
      7.2,
      2.3,
      "Strong Polar Easterly / Trough Shear (11–14 m/s U10)",
      "Accelerates Tabular Berg D-28 westward and compresses 65°E pack-ice ridge"
    ),
    makeWeatherZone(
      "WX-ENDERBY-KATABATIC",
      "Enderby Land Katabatic Outflow & Freezing Spray Sector",
      44.0,
      -65.4,
      6.8,
      2.0,
      "Steep Coastal Ice-Slope Katabatic Gale (12–15 m/s)",
      "Pushes coastal pack offshore and increases vessel superstructure icing risk"
    ),
    makeWeatherZone(
      "WX-LAZAREV-SWELL",
      "Lazarev Sea Frontal Wind & Swell Corridor",
      16.5,
      -63.8,
      6.2,
      2.1,
      "Frontal Wind Shear & Open-Fetch Swell (10–13 m/s)",
      "Drives Berg A-76A drift cone across outer Maitri approach"
    ),
  ];

  // Suppress unused variable lint if weatherRisk not directly iterated here
  void weatherRisk;

  return {
    windArrows,
    currentStreamlines,
    waveIndicators,
    weatherZones,
  };
}

/**
 * Determine adaptive Uber H3 Resolution (2, 3, or 4) from current 3D camera radius or 2D zoom
 */
export function getAdaptiveH3Resolution(
  viewMode,
  cameraRadius = 158,
  zoom2d = 2.5
) {
  if (viewMode === "2d") {
    if (zoom2d >= 4.1) return 4;
    if (zoom2d >= 3.0) return 3;
    return 2;
  }
  if (cameraRadius <= 78) return 4;
  if (cameraRadius <= 132) return 3;
  return 2;
}

/**
 * Build real Uber H3 Polar Hexagonal Grid cells over the Antarctic domain using `h3-js`.
 * Aggregates the 4 risk factors (Ice, Iceberg, Weather, Ocean) and projects exact H3 hex boundaries to EPSG:3412.
 */
export function buildAdaptiveH3Grid({
  scenario,
  sicSlice,
  elevationGrid,
  surfaceTypeGrid,
  riskFields,
  h3Resolution = 3,
}) {
  if (!scenario?.shape || !scenario?.extent || !sicSlice?.data || !riskFields) {
    return [];
  }

  const [H, W] = scenario.shape;
  const [xmin, ymin, xmax, ymax] = scenario.extent;
  const sicData = sicSlice.data;
  const elevData = elevationGrid?.data || null;
  const surfData = surfaceTypeGrid?.data || null;

  const stride = h3Resolution >= 4 ? 1 : 2;
  const cellMap = new Map();

  for (let r = 0; r < H; r += stride) {
    const ym = ymax - ((r + 0.5) / H) * (ymax - ymin);
    for (let c = 0; c < W; c += stride) {
      const xm = xmin + ((c + 0.5) / W) * (xmax - xmin);
      const idx = r * W + c;
      const [lon, lat] = proj4("EPSG:3412", "EPSG:4326", [xm, ym]);

      let h3Index;
      try {
        h3Index = latLngToCell(lat, lon, h3Resolution);
      } catch {
        continue;
      }
      if (!h3Index) continue;

      let acc = cellMap.get(h3Index);
      if (!acc) {
        acc = {
          h3Index,
          count: 0,
          oceanCount: 0,
          sicSum: 0,
          sicMax: 0,
          elevSum: 0,
          iceRiskMax: 0,
          icebergRiskMax: 0,
          weatherRiskSum: 0,
          oceanRiskSum: 0,
          combinedRiskMax: 0,
          windSum: 0,
          curSum: 0,
          minBergKm: 9999,
        };
        cellMap.set(h3Index, acc);
      }

      const sType = surfData ? Math.round(surfData[idx]) : 0;
      const sic = sicData[idx] || 0;
      const elev = elevData ? elevData[idx] : -1200;

      acc.count++;
      if (sType === 0) {
        acc.oceanCount++;
        acc.sicSum += sic;
        if (sic > acc.sicMax) acc.sicMax = sic;
        if (riskFields.iceRisk[idx] > acc.iceRiskMax) {
          acc.iceRiskMax = riskFields.iceRisk[idx];
        }
        if (riskFields.icebergRisk[idx] > acc.icebergRiskMax) {
          acc.icebergRiskMax = riskFields.icebergRisk[idx];
        }
        acc.weatherRiskSum += riskFields.weatherRisk[idx];
        acc.oceanRiskSum += riskFields.oceanRisk[idx];
        if (riskFields.combinedRisk[idx] > acc.combinedRiskMax) {
          acc.combinedRiskMax = riskFields.combinedRisk[idx];
        }
        acc.windSum += riskFields.windSpeedMs[idx];
        acc.curSum += riskFields.currentSpeedMs[idx];
        if (riskFields.nearestBergDistKm[idx] < acc.minBergKm) {
          acc.minBergKm = riskFields.nearestBergDistKm[idx];
        }
      }
      acc.elevSum += elev;
    }
  }

  const xMargin = (xmax - xmin) * 0.08;
  const yMargin = (ymax - ymin) * 0.08;
  const outCells = [];

  for (const acc of cellMap.values()) {
    if (acc.oceanCount === 0) continue;

    let boundaryLatLng;
    let centerLatLng;
    try {
      boundaryLatLng = cellToBoundary(acc.h3Index);
      centerLatLng = cellToLatLng(acc.h3Index);
    } catch {
      continue;
    }
    if (!boundaryLatLng || boundaryLatLng.length < 3) continue;

    const ringXy = [];
    let outOfBounds = false;
    for (const [vLat, vLon] of boundaryLatLng) {
      const [vx, vy] = proj4("EPSG:4326", "EPSG:3412", [vLon, vLat]);
      if (
        vx < xmin - xMargin ||
        vx > xmax + xMargin ||
        vy < ymin - yMargin ||
        vy > ymax + yMargin
      ) {
        outOfBounds = true;
        break;
      }
      ringXy.push([vx, vy]);
    }
    if (outOfBounds || ringXy.length < 3) continue;
    ringXy.push(ringXy[0]);

    const [centerXm, centerYm] = proj4("EPSG:4326", "EPSG:3412", [
      centerLatLng[1],
      centerLatLng[0],
    ]);

    const nOcean = Math.max(1, acc.oceanCount);
    const meanSic = acc.sicSum / nOcean;
    const maxSic = acc.sicMax;
    const meanElev = Math.round(acc.elevSum / Math.max(1, acc.count));
    const iceRiskVal = Number(acc.iceRiskMax.toFixed(2));
    const icebergRiskVal = Number(acc.icebergRiskMax.toFixed(2));
    const weatherRiskVal = Number((acc.weatherRiskSum / nOcean).toFixed(2));
    const oceanRiskVal = Number((acc.oceanRiskSum / nOcean).toFixed(2));
    const combinedRiskVal = Number(acc.combinedRiskMax.toFixed(2));
    const meanWindMs = Number((acc.windSum / nOcean).toFixed(1));
    const meanCurMs = Number((acc.curSum / nOcean).toFixed(2));

    const overallClass = classifyPolarRisk(combinedRiskVal);
    const iceClass = classifyPolarRisk(iceRiskVal);
    const bergClass = classifyPolarRisk(icebergRiskVal);
    const weatherClass = classifyPolarRisk(weatherRiskVal);
    const oceanClass = classifyPolarRisk(oceanRiskVal);

    const maxSicPct = Math.round(maxSic * 100);
    const meanSicPct = Math.round(meanSic * 100);
    const estThickM = estimateIceThicknessM(maxSic);

    const iceCondition =
      maxSic >= 0.7
        ? `Consolidated Pack (${maxSicPct}% peak SIC · ~${estThickM} m)`
        : maxSic >= 0.4
        ? `Heavy Pack Ice (${maxSicPct}% peak / ${meanSicPct}% mean SIC · ~${estThickM} m)`
        : maxSic >= 0.15
        ? `Marginal Drift Ice (${maxSicPct}% peak / ${meanSicPct}% mean SIC)`
        : `Open Polar Water (${meanSicPct}% mean SIC)`;

    const inspectPayload = {
      kind: `Adaptive H3 Polar Hex Cell (Res ${h3Resolution})`,
      title: `H3 Index ${acc.h3Index}`,
      subtitle: `${Math.abs(centerLatLng[0]).toFixed(2)}°S, ${Math.abs(
        centerLatLng[1]
      ).toFixed(2)}°${centerLatLng[1] >= 0 ? "E" : "W"} · Risk: ${
        overallClass.level
      }`,
      h3Index: acc.h3Index,
      resolution: h3Resolution,
      riskLevel: overallClass.level,
      riskColor: overallClass.color,
      metrics: [
        {
          label: "H3 Cell Index",
          value: `${acc.h3Index} (Resolution ${h3Resolution})`,
        },
        {
          label: "Combined Polar Risk Level",
          value: `${overallClass.level.toUpperCase()} (Score ${combinedRiskVal.toFixed(
            2
          )})`,
        },
        {
          label: "Ice Condition",
          value: iceCondition,
        },
        {
          label: "Ice Risk",
          value: `${iceClass.level} (${iceRiskVal.toFixed(
            2
          )}) · Est. max thickness ${estThickM} m`,
        },
        {
          label: "Iceberg Risk",
          value:
            acc.minBergKm < 900
              ? `${bergClass.level} (${icebergRiskVal.toFixed(
                  2
                )}) · Nearest tracked berg ${Math.round(acc.minBergKm)} km`
              : `${bergClass.level} (${icebergRiskVal.toFixed(
                  2
                )}) · Clear of tracked berg cones`,
        },
        {
          label: "Weather Risk",
          value: `${weatherClass.level} (${weatherRiskVal.toFixed(
            2
          )}) · U10 Wind ~${meanWindMs} m/s (Synoptic visibility: Unavailable)`,
        },
        {
          label: "Ocean Risk",
          value: `${oceanClass.level} (${oceanRiskVal.toFixed(
            2
          )}) · Depth ${meanElev} m · Current ${meanCurMs} m/s (Wave height: Unavailable)`,
        },
      ],
    };

    outCells.push({
      h3Index: acc.h3Index,
      resolution: h3Resolution,
      centerLat: centerLatLng[0],
      centerLon: centerLatLng[1],
      centerXm,
      centerYm,
      ringXy,
      meanSic,
      maxSic,
      iceRiskVal,
      icebergRiskVal,
      weatherRiskVal,
      oceanRiskVal,
      combinedRiskVal,
      riskLevel: overallClass.level,
      riskCode: overallClass.code,
      color: overallClass.color,
      stroke: overallClass.stroke,
      fill: overallClass.fill,
      inspect: inspectPayload,
    });
  }

  return outCells;
}
