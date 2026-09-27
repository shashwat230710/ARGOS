/** Ice concentration: transparent open water → ice-blue → white. */

export function sicColor(v, alphaScale = 1) {
  if (!(v > 0.02)) return [0, 0, 0, 0];
  const t = Math.min(1, Math.max(0, v));
  const r = Math.round(180 + 75 * t);
  const g = Math.round(210 + 45 * t);
  const b = Math.round(230 + 25 * t);
  const a = Math.round(255 * Math.min(1, 0.25 + 0.75 * t) * alphaScale);
  return [r, g, b, a];
}

export function errorColor(v) {
  const t = Math.min(1, v / 0.35);
  return [220, Math.round(80 + 100 * (1 - t)), 70, Math.round(40 + 180 * t)];
}

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
      img.data[i * 4] = 18;
      img.data[i * 4 + 1] = 28;
      img.data[i * 4 + 2] = 36;
      img.data[i * 4 + 3] = 255;
      continue;
    }
    const c = mode === "error" ? errorColor(d[i]) : sicColor(d[i]);
    img.data.set(c, i * 4);
  }
  ctx.putImageData(img, 0, 0);
}
