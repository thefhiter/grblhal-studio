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

// ---- G41/G42 resolution (the job grblHAL can't do) ------------------------
// Offset an OPEN polyline to one side by `radius` — this is true cutter comp:
// the tool centre runs left (G41) or right (G42) of the programmed edge. Convex
// corners get a tool-radius arc; concave corners self-intersect (trim).
export function offsetOpenPath(pts, radius, side) {
  const s = side === 'left' ? 1 : -1;
  const P = [];
  for (const p of pts) { const l = P[P.length - 1]; if (!l || Math.abs(l.x - p.x) > 1e-6 || Math.abs(l.y - p.y) > 1e-6) P.push(p); }
  if (P.length < 2 || radius <= 0) return P.slice();

  const segs = [];
  for (let i = 0; i < P.length - 1; i++) {
    const a = P[i], b = P[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    const nx = s * (-dy / len) * radius, ny = s * (dx / len) * radius;
    segs.push({ a: { x: a.x + nx, y: a.y + ny }, b: { x: b.x + nx, y: b.y + ny }, dir: { x: dx / len, y: dy / len }, v: a });
  }
  if (!segs.length) return P.slice();

  const out = [segs[0].a];
  for (let i = 1; i < segs.length; i++) {
    const prev = segs[i - 1], cur = segs[i], vertex = P[i];
    const cross = prev.dir.x * cur.dir.y - prev.dir.y * cur.dir.x;
    const convex = s * cross < 0;
    if (convex && Math.abs(cross) > 1e-6) {
      out.push(prev.b);
      let a0 = Math.atan2(prev.b.y - vertex.y, prev.b.x - vertex.x);
      let a1 = Math.atan2(cur.a.y - vertex.y, cur.a.x - vertex.x);
      let sweep = a1 - a0;
      while (sweep <= -Math.PI) sweep += 2 * Math.PI;
      while (sweep > Math.PI) sweep -= 2 * Math.PI;
      const steps = Math.max(1, Math.ceil(Math.abs(sweep) / 0.25));
      for (let k = 1; k < steps; k++) { const a = a0 + (sweep * k) / steps; out.push({ x: vertex.x + radius * Math.cos(a), y: vertex.y + radius * Math.sin(a) }); }
      out.push(cur.a);
    } else {
      const ip = lineIntersect(prev.a, prev.b, cur.a, cur.b);
      if (ip && Math.hypot(ip.x - vertex.x, ip.y - vertex.y) < radius * 4) out.push(ip);
      else { out.push(prev.b); out.push(cur.a); }
    }
  }
  out.push(segs[segs.length - 1].b);
  return out;
}

function lineIntersect(p1, p2, p3, p4) {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  return { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) };
}

// Read a whole program, find each G41/G42…G40 region, offset it by the tool
// radius, and tag it interior/exterior from its winding. Returns everything
// needed to *show the correction*.
export function resolveCutterComp(text, radius) {
  const { moves } = parseGcode(text);
  const raw = [];
  let cur = null;
  for (const m of moves) {
    const active = m.comp === 'left' || m.comp === 'right';
    if (active) {
      if (!cur || cur.side !== m.comp) { if (cur) raw.push(cur); cur = { side: m.comp, dReg: m.dReg, pts: [{ x: m.from.x, y: m.from.y }] }; }
      for (let i = 1; i < m.poly.length; i++) cur.pts.push(m.poly[i]);
    } else if (cur) { raw.push(cur); cur = null; }
  }
  if (cur) raw.push(cur);

  const regions = raw.filter((r) => r.pts.length >= 2).map((r) => {
    const compensated = offsetOpenPath(r.pts, radius, r.side);
    const interior = sideFromGcode(r.side === 'left' ? 'G41' : 'G42', r.pts);   // 'inside' | 'outside'
    return { side: r.side, code: r.side === 'left' ? 'G41' : 'G42', dReg: r.dReg, programmed: r.pts, compensated, interior };
  });
  return { radius, regions, count: regions.length };
}

// Resolve the WHOLE program into the tool's real trajectory (comp applied where
// G41/G42 is active), as an ordered list of segments flagged cutting vs rapid.
// This is what the PC simulation sweeps to carve the stock.
export function resolveToolPath(text, radius) {
  const { moves } = parseGcode(text);
  const segments = [];
  let i = 0;
  while (i < moves.length) {
    const m = moves[i];
    if (m.comp === 'left' || m.comp === 'right') {
      const side = m.comp; const region = [m];
      let j = i + 1;
      while (j < moves.length && moves[j].comp === side) { region.push(moves[j]); j++; }
      const pts = [{ x: region[0].from.x, y: region[0].from.y }];
      for (const rm of region) for (let k = 1; k < rm.poly.length; k++) pts.push(rm.poly[k]);
      segments.push({ poly: offsetOpenPath(pts, radius, side), cutting: true, comp: true });
      i = j;
    } else {
      segments.push({ poly: m.poly, cutting: !m.rapid, comp: false });
      i++;
    }
  }
  return { segments };
}

// The "part wanted": fill the exterior contour(s) and subtract the pockets, from
// the PROGRAMMED edges (the design geometry). Returns polygons (with holes) to draw.
export function partFromRegions(regions) {
  const ClipperLib = CL(); if (!ClipperLib) return [];
  const ext = regions.filter((r) => r.interior === 'outside').map((r) => toCl(r.programmed));
  const inr = regions.filter((r) => r.interior === 'inside').map((r) => toCl(r.programmed));
  if (!ext.length) return [];
  const c1 = new ClipperLib.Clipper();
  c1.AddPaths(ext, ClipperLib.PolyType.ptSubject, true);
  let sol = new ClipperLib.Paths();
  c1.Execute(ClipperLib.ClipType.ctUnion, sol, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  if (inr.length) {
    const c2 = new ClipperLib.Clipper();
    c2.AddPaths(sol, ClipperLib.PolyType.ptSubject, true);
    c2.AddPaths(inr, ClipperLib.PolyType.ptClip, true);
    const diff = new ClipperLib.Paths();
    c2.Execute(ClipperLib.ClipType.ctDifference, diff, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
    sol = diff;
  }
  return sol.map(fromCl);
}

// ---- G-code parsing -------------------------------------------------------
// Produces display moves (rapid vs cut) with flattened geometry, plus bounds.
export function parseGcode(text) {
  const moves = [];
  let x = 0, y = 0, z = 0, g = 0, abs = true;
  let comp = 'off', dReg = null;          // cutter comp state: off | left (G41) | right (G42)
  const lines = String(text).split(/\r?\n/);

  let srcLine = 0;
  for (let raw of lines) {
    srcLine++;
    const line = raw.replace(/\(.*?\)/g, '').replace(/;.*$/, '').trim();
    if (!line) continue;
    // A block can carry several G-codes (e.g. "G01 G41 X.. D03"); collect them all
    // so a comp code after the motion code doesn't clobber the motion mode.
    const words = line.match(/([A-Za-z])\s*(-?\d*\.?\d+)/g) || [];
    const w = {}; const gs = [];
    for (const tok of words) {
      const letter = tok[0].toUpperCase();
      const val = parseFloat(tok.slice(1));
      if (letter === 'G') gs.push(val);
      else w[letter] = val;
    }
    for (const gv of gs) {
      if (gv === 90) abs = true;
      else if (gv === 91) abs = false;
      else if (gv === 0 || gv === 1 || gv === 2 || gv === 3) g = gv;
      else if (gv === 40) comp = 'off';
      else if (gv === 41) comp = 'left';
      else if (gv === 42) comp = 'right';
    }
    if (w.D != null) dReg = w.D;

    const nx = w.X != null ? (abs ? w.X : x + w.X) : x;
    const ny = w.Y != null ? (abs ? w.Y : y + w.Y) : y;
    const nz = w.Z != null ? (abs ? w.Z : z + w.Z) : z;

    const hasMove = w.X != null || w.Y != null || w.Z != null || w.I != null || w.J != null;
    if (hasMove) {
      if (g === 2 || g === 3) {
        const cx = x + (w.I || 0), cy = y + (w.J || 0);
        const poly = flattenArc(x, y, nx, ny, cx, cy, g === 2);
        moves.push({ rapid: false, kind: 'arc', from: { x, y, z }, to: { x: nx, y: ny, z: nz }, poly, srcLine, comp, dReg });
      } else {
        moves.push({ rapid: g === 0, kind: 'line', from: { x, y, z }, to: { x: nx, y: ny, z: nz }, poly: [{ x, y }, { x: nx, y: ny }], srcLine, comp, dReg });
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

// Total polyline length (mm) — used for the live G-code stats.
export function pathLength(polys) {
  let len = 0;
  for (const poly of polys || []) {
    for (let i = 1; i < poly.length; i++) len += Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y);
  }
  return len;
}

// ---- demo geometry --------------------------------------------------------
export function demoContour(kind = 'bracket') {
  if (kind === 'rect') return [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 40 }, { x: 0, y: 40 }];
  // an L-bracket with a mix of convex & concave corners to exercise the offset
  return [
    { x: 0, y: 0 }, { x: 70, y: 0 }, { x: 70, y: 22 },
    { x: 28, y: 22 }, { x: 28, y: 50 }, { x: 0, y: 50 },
  ];
}
