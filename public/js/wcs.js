// wcs.js — work coordinate systems (G54–G59), the "work offsets" the Haas tip
// contrasts with tool offsets: a work offset shifts ALL tools at once (G54 for op 1,
// G55 for op 2…). Editable, persisted, pushed to grblHAL via G10 L2, and each row
// can be zeroed at the current machine position via G10 L20 — exactly the Z-face
// measure gesture the video shows on the work-offset page.

const KEY = 'grblhal-studio.wcs.v1';

export const WCS_CODES = [
  { code: 'G54', p: 1 }, { code: 'G55', p: 2 }, { code: 'G56', p: 3 },
  { code: 'G57', p: 4 }, { code: 'G58', p: 5 }, { code: 'G59', p: 6 },
];

export function mkWcs(o = {}) {
  return { code: o.code, p: o.p, x: num(o.x), y: num(o.y), z: num(o.z), note: o.note || '' };
}
export function defaultWcs() { return WCS_CODES.map((c) => mkWcs(c)); }

export function loadWcs() {
  try { const r = localStorage.getItem(KEY); if (r) return JSON.parse(r).map(mkWcs); } catch (e) {}
  return defaultWcs();
}
export function saveWcs(w) { try { localStorage.setItem(KEY, JSON.stringify(w)); } catch (e) {} }

// Set the WCS origin directly (machine coords of the origin).
export function wcsToG10(w) {
  return `G10 L2 P${w.p} X${f(w.x)} Y${f(w.y)} Z${f(w.z)}`;
}
// Make the CURRENT machine position become (x,y,z) in this WCS — the touch-off form.
export function wcsSetHere(w, x = 0, y = 0, z = 0) {
  return `G10 L20 P${w.p} X${f(x)} Y${f(y)} Z${f(z)}`;
}

function f(v) { return (Math.round((+v || 0) * 1000) / 1000).toFixed(3); }
function num(v, d = 0) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }
