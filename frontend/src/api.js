const API = "";

export async function getJSON(path, opts) {
  const r = await fetch(API + path, opts);
  if (!r.ok) {
    const t = await r.text();
    throw new Error(t || r.statusText);
  }
  return r.json();
}

export function f16ToF32(h) {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * 2 ** -14 * (f / 1024);
  if (e === 0x1f) return f ? NaN : s ? -Infinity : Infinity;
  return (s ? -1 : 1) * 2 ** (e - 15) * (1 + f / 1024);
}

export function unpack(packed) {
  if (!packed) return null;
  const bin = Uint8Array.from(atob(packed.b64), (c) => c.charCodeAt(0));
  const u16 = new Uint16Array(bin.buffer);
  const out = new Float32Array(u16.length);
  for (let i = 0; i < u16.length; i++) out[i] = f16ToF32(u16[i]);
  return { data: out, shape: packed.shape };
}

export function sliceLead(grid, lead) {
  const [k, h, w] = grid.shape;
  const n = h * w;
  return { data: grid.data.subarray(lead * n, (lead + 1) * n), shape: [h, w] };
}
