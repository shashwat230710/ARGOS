const API = "";
let useInBrowserEngine = false;
let enginePromise = null;

async function runLocalEngine(path, opts) {
  if (!enginePromise) {
    enginePromise = import("./polarEngine.ts");
  }
  const { handlePolarApi } = await enginePromise;
  const method = (opts?.method || "GET").toUpperCase();
  let body = {};
  if (opts?.body) {
    try {
      body = typeof opts.body === "string" ? JSON.parse(opts.body) : opts.body;
    } catch {
      body = {};
    }
  }
  return handlePolarApi(path, method, body);
}

export async function getJSON(path, opts) {
  if (useInBrowserEngine) {
    return runLocalEngine(path, opts);
  }
  try {
    const r = await fetch(API + path, opts);
    if (!r.ok) {
      if (r.status === 404 || r.status === 405 || r.status >= 500) {
        useInBrowserEngine = true;
        return await runLocalEngine(path, opts);
      }
      const t = await r.text();
      throw new Error(t || r.statusText);
    }
    const contentType = r.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      useInBrowserEngine = true;
      return await runLocalEngine(path, opts);
    }
    return await r.json();
  } catch (err) {
    useInBrowserEngine = true;
    return await runLocalEngine(path, opts);
  }
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
