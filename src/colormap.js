/**
 * Scientific Polar Sea-Ice Concentration (SIC) & Error Colormaps
 * - Open Water (<2%): Deep Southern Ocean bathyal navy
 * - Very Open Drift (2–15%): Nautical shelf blue
 * - Marginal Ice Zone (15–40%): Glacial cyan-blue
 * - Heavy Pack Ice (40–70%): High-albedo pack white-blue
 * - Consolidated Severe Pack (>70%): Bright snow-white with warm hazard tint
 */

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

export function sicColor(v, alphaScale = 1) {
  if (!(v > 0.015)) {
    // Deep Southern Ocean open water (subtle bathyal navy so graticule & routes pop)
    return [8, 19, 36, Math.round(215 * alphaScale)];
  }
  const s = Math.min(1, Math.max(0, v));

  let r, g, b, a;
  if (s < 0.15) {
    // 1.5% -> 15% SIC: Deep ocean navy to navigable marine blue
    const t = (s - 0.015) / 0.135;
    r = lerp(10, 22, t);
    g = lerp(26, 78, t);
    b = lerp(48, 138, t);
    a = lerp(220, 235, t);
  } else if (s < 0.4) {
    // 15% -> 40% SIC: Marginal Ice Zone (glacial cyan-blue -> pack ice blue)
    const t = (s - 0.15) / 0.25;
    r = lerp(28, 135, t);
    g = lerp(110, 198, t);
    b = lerp(175, 238, t);
    a = lerp(235, 248, t);
  } else if (s < 0.7) {
    // 40% -> 70% SIC: Heavy Pack Ice (dense white-blue -> bright snow white)
    const t = (s - 0.4) / 0.3;
    r = lerp(175, 248, t);
    g = lerp(218, 246, t);
    b = lerp(245, 255, t);
    a = 252;
  } else {
    // >70% SIC: Impassable Consolidated Pack (PC6 limit exceeded - subtle rose-amber highlight)
    const t = (s - 0.7) / 0.3;
    r = 255;
    g = lerp(236, 198, t);
    b = lerp(230, 195, t);
    a = 255;
  }

  return [r, g, b, Math.round(a * alphaScale)];
}

export function errorColor(v) {
  if (!(v > 0.008)) {
    return [8, 16, 30, 200];
  }
  const t = Math.min(1, v / 0.32);
  if (t < 0.5) {
    const u = t * 2;
    return [
      lerp(18, 245, u),
      lerp(65, 158, u),
      lerp(110, 11, u),
      lerp(160, 235, u),
    ];
  }
  const u = (t - 0.5) * 2;
  return [
    lerp(245, 244, u),
    lerp(158, 63, u),
    lerp(11, 94, u),
    lerp(235, 255, u),
  ];
}

export function riskColor(v, alphaScale = 1) {
  const s = Math.min(1, Math.max(0, Number(v) || 0));
  let r, g, b, a;
  if (s < 0.25) {
    // Safe (0.00 - 0.25): Deep navigable teal-emerald
    const t = s / 0.25;
    r = lerp(8, 16, t);
    g = lerp(38, 168, t);
    b = lerp(48, 120, t);
    a = lerp(215, 232, t);
  } else if (s < 0.5) {
    // Caution (0.25 - 0.50): Emerald transition into calibrated amber-gold
    const t = (s - 0.25) / 0.25;
    r = lerp(20, 234, t);
    g = lerp(168, 179, t);
    b = lerp(115, 8, t);
    a = lerp(232, 244, t);
  } else if (s < 0.75) {
    // High Risk (0.50 - 0.75): Amber into high-alert orange
    const t = (s - 0.5) / 0.25;
    r = lerp(234, 249, t);
    g = lerp(179, 115, t);
    b = lerp(8, 22, t);
    a = lerp(244, 250, t);
  } else {
    // No-Go (>= 0.75): High-alert orange into crimson rose hazard
    const t = (s - 0.75) / 0.25;
    r = lerp(249, 225, t);
    g = lerp(115, 29, t);
    b = lerp(22, 72, t);
    a = 255;
  }
  return [r, g, b, Math.round(a * alphaScale)];
}

export const sicRgba = sicColor;
export const errorRgba = errorColor;
export const riskRgba = riskColor;

export function paintGrid(canvas, packed, mode = "sic", land = null) {
  const [h, w] = packed.shape;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(w, h);
  const d = packed.data;
  const L = land && land.data;
  for (let i = 0; i < h * w; i++) {
    if (L && L[i] > 0.5) {
      // Grounded Antarctic continent cell base
      img.data[i * 4] = 22;
      img.data[i * 4 + 1] = 30;
      img.data[i * 4 + 2] = 44;
      img.data[i * 4 + 3] = 255;
      continue;
    }
    const c =
      mode === "risk"
        ? riskColor(d[i])
        : mode === "error"
        ? errorColor(d[i])
        : sicColor(d[i]);
    img.data.set(c, i * 4);
  }
  ctx.putImageData(img, 0, 0);
}
