// geometry.js — the curvature / cutter-radius-compensation engine.
// This is the work the microcontroller (grblHAL) cannot do: offsetting a profile
// by the tool radius with correct corner handling (arcs on convex, trims on
// concave), gouge detection, and interior/exterior direction.
//
// Uses ClipperLib (vendored global) for robust polygon offsetting — the same class
// of algorithm CAM packages and slicers rely on.

const CL = () => window.ClipperLib;
const SCALE = 10000;                 // integer grid: 0.1 µm resolution
const ARC_TOL = 0.01;                // chord tolerance for offset arcs (mm)

// ---- coordinate helpers ---------------------------------------------------
const toCl = (pts) => pts.map((p) => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }));
const fromCl = (path) => path.map((p) => ({ x: p.X / SCALE, y: p.Y / SCALE }));

export function signedArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}
export const isCCW = (pts) => signedArea(pts) > 0;

export function polyBounds(polys) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of polys) for (const p of poly) {
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0, w: 0, h: 0 };
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

// ---- cutter compensation --------------------------------------------------
// Offset a CLOSED contour by `delta` mm (>0 grows, <0 shrinks). Round joins give
// true tool-radius arcs at convex corners; concave corners self-trim.
export function offsetClosed(pts, delta, joinType = 'round') {
  const ClipperLib = CL();
  const co = new ClipperLib.ClipperOffset(2.0, ARC_TOL * SCALE);
  const jt = joinType === 'miter' ? ClipperLib.JoinType.jtMiter
    : joinType === 'square' ? ClipperLib.JoinType.jtSquare
      : ClipperLib.JoinType.jtRound;
  co.AddPath(toCl(pts), jt, ClipperLib.EndType.etClosedPolygon);
  const sol = new ClipperLib.Paths();
  co.Execute(sol, delta * SCALE);
  return sol.map(fromCl).filter((p) => p.length > 2);
}

// Map machining intent → offset delta and return the tool-CENTRE path(s).
//   side: 'outside' (profile/boss, tool outside)  → +radius
//         'inside'  (pocket/bore, tool inside)     → -radius
//   stock: finishing allowance left on the wall (mm)
export function compensate(contour, radius, side = 'outside', stock = 0) {
  const r = Math.max(0, radius) + Math.max(0, stock);
  const delta = side === 'inside' ? -r : r;
  const result = offsetClosed(contour, delta, 'round');
  const gouge = side === 'inside' && result.length === 0; // tool bigger than pocket
  return { paths: result, delta, gouge, radius: r, side };
}

// Pocket clearing (ébauche) — concentric offset rings that empty the inside of a
// closed contour. Each ring is offset from the ORIGINAL wall (not the previous
// ring) so errors don't compound; Clipper naturally splits into multiple loops
// when a pocket pinches to a waist. Returned centre-out (gentler on the tool).
//   radius   : effective tool radius
//   stepover : radial engagement ae between rings (mm)
//   stock    : finishing allowance left on the wall
export function pocketClear(contour, radius, stepover, stock = 0) {
  const step = Math.max(0.1, stepover);
  const first = Math.max(0, radius) + Math.max(0, stock);   // wall → first ring centre
  const passes = [];
  let d = first, guard = 0;
  while (guard++ < 1000) {
    const rings = offsetClosed(contour, -d, 'round');        // inward
    if (!rings.length) break;
    passes.push(...rings);
    d += step;
  }
  passes.reverse();                                          // innermost first (center-out)
  return { passes, gouge: passes.length === 0, stepover: step, rings: passes.length };
}

// Translate G41/G42 + contour winding into an inside/outside intent.
// G41 = left of travel, G42 = right of travel.
export function sideFromGcode(code, contour) {
  const ccw = isCCW(contour);
  // For a CCW contour the interior lies to the LEFT of travel.
  // G41 (left)  → toward interior → 'inside' ; G42 (right) → 'outside'  (CCW)
  // Winding flips the mapping.
  if (code === 'G41') return ccw ? 'inside' : 'outside';
  if (code === 'G42') return ccw ? 'outside' : 'inside';
  return 'outside';
}

// ---- G-code parsing -------------------------------------------------------
// Produces display moves (rapid vs cut) with flattened geometry, plus bounds.
export function parseGcode(text) {
  const moves = [];
  let x = 0, y = 0, z = 0, g = 0, abs = true;
  const lines = String(text).split(/\r?\n/);

  for (let raw of lines) {
    const line = raw.replace(/\(.*?\)/g, '').replace(/;.*$/, '').trim();
    if (!line) continue;
    const words = line.match(/([A-Za-z])\s*(-?\d*\.?\d+)/g) || [];
    const w = {};
    for (const tok of words) {
      const letter = tok[0].toUpperCase();
      const val = parseFloat(tok.slice(1));
      if (letter === 'G') { w.G = val; }
      else w[letter] = val;
    }
    if (w.G === 90) abs = true;
    if (w.G === 91) abs = false;
    if (w.G != null && [0, 1, 2, 3].includes(w.G)) g = w.G;

    const nx = w.X != null ? (abs ? w.X : x + w.X) : x;
    const ny = w.Y != null ? (abs ? w.Y : y + w.Y) : y;
    const nz = w.Z != null ? (abs ? w.Z : z + w.Z) : z;

    const hasMove = w.X != null || w.Y != null || w.Z != null || w.I != null || w.J != null;
    if (hasMove) {
      if (g === 2 || g === 3) {
        const cx = x + (w.I || 0), cy = y + (w.J || 0);
        const poly = flattenArc(x, y, nx, ny, cx, cy, g === 2);
        moves.push({ rapid: false, kind: 'arc', from: { x, y, z }, to: { x: nx, y: ny, z: nz }, poly });
      } else {
        moves.push({ rapid: g === 0, kind: 'line', from: { x, y, z }, to: { x: nx, y: ny, z: nz }, poly: [{ x, y }, { x: nx, y: ny }] });
      }
    }
    x = nx; y = ny; z = nz;
  }

  const all = moves.flatMap((m) => m.poly);
  return { moves, bounds: polyBounds([all.length ? all : [{ x: 0, y: 0 }]]) };
}

export function flattenArc(x0, y0, x1, y1, cx, cy, cw, maxSeg = 0.2) {
  const r = Math.hypot(x0 - cx, y0 - cy);
  let a0 = Math.atan2(y0 - cy, x0 - cx);
  let a1 = Math.atan2(y1 - cy, x1 - cx);
  if (cw) { if (a1 >= a0) a1 -= 2 * Math.PI; }
  else { if (a1 <= a0) a1 += 2 * Math.PI; }
  const sweep = Math.abs(a1 - a0);
  const steps = Math.max(2, Math.ceil((sweep * r) / maxSeg));
  const pts = [{ x: x0, y: y0 }];
  for (let i = 1; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

// ---- emit grbl-safe G-code from tool-centre polylines ---------------------
export function polysToGcode(polys, { feed = 600, plunge = 200, safeZ = 5, cutZ = -1, rpm = 12000 } = {}) {
  const out = [];
  out.push('; Generated by grblHAL Studio — tool-centre path (comp resolved on PC)');
  out.push('G21 G90 G17');                 // mm, absolute, XY plane
  out.push(`M3 S${Math.round(rpm)}`);
  out.push(`G0 Z${safeZ}`);
  for (const poly of polys) {
    if (poly.length < 2) continue;
    const p0 = poly[0];
    out.push(`G0 X${f(p0.x)} Y${f(p0.y)}`);
    out.push(`G1 Z${f(cutZ)} F${plunge}`);
    for (let i = 1; i < poly.length; i++) out.push(`G1 X${f(poly[i].x)} Y${f(poly[i].y)} F${feed}`);
    out.push(`G1 X${f(p0.x)} Y${f(p0.y)}`);  // close
    out.push(`G0 Z${safeZ}`);
  }
  out.push('M5');
  out.push('G0 X0 Y0');
  out.push('M30');
  return out.join('\n');
}

const f = (v) => (Math.round(v * 1000) / 1000).toFixed(3);

// ---- demo geometry --------------------------------------------------------
export function demoContour(kind = 'bracket') {
  if (kind === 'rect') return [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 40 }, { x: 0, y: 40 }];
  // an L-bracket with a mix of convex & concave corners to exercise the offset
  return [
    { x: 0, y: 0 }, { x: 70, y: 0 }, { x: 70, y: 22 },
    { x: 28, y: 22 }, { x: 28, y: 50 }, { x: 0, y: 50 },
  ];
}
