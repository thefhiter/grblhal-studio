// dxf.js — minimal DXF reader for 2D profiles: LINE, LWPOLYLINE, POLYLINE,
// ARC, CIRCLE. Returns closed polylines (in mm, {x,y}) ready for the cutter-comp
// pipeline. Arcs and polyline bulges are flattened to chords. Open segments are
// stitched end-to-end into loops so a profile drawn as separate lines still closes.

const ARC_TOL = 0.05;         // max chord deviation (mm) when flattening arcs
const WELD = 1e-3;            // endpoint match tolerance (mm) when chaining

export function parseDXF(text) {
  const pairs = tokenize(text);
  const entities = readEntities(pairs);
  const loops = [];            // closed polylines
  const segs = [];             // open segments {a,b}

  for (const e of entities) {
    if (e.type === 'LINE') {
      segs.push({ a: { x: e.x1, y: e.y1 }, b: { x: e.x2, y: e.y2 } });
    } else if (e.type === 'CIRCLE') {
      loops.push(sampleArc(e.cx, e.cy, e.r, 0, Math.PI * 2));
    } else if (e.type === 'ARC') {
      const poly = sampleArc(e.cx, e.cy, e.r, e.a0, e.a1);
      for (let i = 0; i < poly.length - 1; i++) segs.push({ a: poly[i], b: poly[i + 1] });
    } else if (e.type === 'LWPOLYLINE' || e.type === 'POLYLINE') {
      const poly = polyFromVerts(e.verts, e.closed);
      if (poly.length < 2) continue;
      if (e.closed) loops.push(poly);
      else for (let i = 0; i < poly.length - 1; i++) segs.push({ a: poly[i], b: poly[i + 1] });
    }
  }

  for (const c of chain(segs)) if (c.length >= 3) loops.push(c);
  const polylines = loops.map(dedupe).filter((p) => p.length >= 3);
  return { polylines, bounds: bounds(polylines), count: polylines.length };
}

// Pick the profile most useful as the working contour: largest bounding-box area.
export function largestLoop(polylines) {
  let best = null, bestA = -1;
  for (const p of polylines) {
    const b = bounds([p]); const a = b.w * b.h;
    if (a > bestA) { bestA = a; best = p; }
  }
  return best;
}

// ---- tokenizer + entity reader ---------------------------------------------
function tokenize(text) {
  const raw = text.split(/\r\n|\r|\n/);
  const pairs = [];
  let i = 0;
  while (i < raw.length - 1) {
    const codeStr = raw[i].trim();
    if (codeStr === '') { i++; continue; }
    const code = parseInt(codeStr, 10);
    if (Number.isNaN(code)) { i++; continue; }
    pairs.push([code, raw[i + 1]]);
    i += 2;
  }
  return pairs;
}

function readEntities(pairs) {
  // isolate the ENTITIES section
  let start = -1, end = pairs.length;
  for (let i = 0; i < pairs.length - 1; i++) {
    if (pairs[i][0] === 2 && pairs[i][1].trim() === 'ENTITIES') { start = i + 1; break; }
  }
  if (start < 0) start = 0;                     // some exporters omit sections
  for (let i = start; i < pairs.length; i++) {
    if (pairs[i][0] === 0 && pairs[i][1].trim() === 'ENDSEC') { end = i; break; }
  }

  const ents = [];
  let cur = null;                               // current entity being built
  let poly = null;                              // active POLYLINE (old style)
  const flush = () => { if (cur) { ents.push(cur); cur = null; } };

  for (let i = start; i < end; i++) {
    const [code, valRaw] = pairs[i];
    const val = valRaw.trim();
    if (code === 0) {
      const type = val;
      if (type === 'VERTEX' && poly) {
        cur = { type: 'VERTEX', x: 0, y: 0, bulge: 0 };
      } else if (type === 'SEQEND') {
        if (poly) { ents.push(poly); poly = null; }
        cur = null;
      } else {
        flush();
        if (type === 'POLYLINE') { poly = { type: 'POLYLINE', verts: [], closed: false }; cur = null; }
        else if (['LINE', 'LWPOLYLINE', 'ARC', 'CIRCLE'].includes(type)) {
          cur = newEntity(type);
        } else cur = null;
      }
      continue;
    }
    if (cur && cur.type === 'VERTEX') {
      const num = parseFloat(val);
      if (code === 10) cur.x = num;
      else if (code === 20) cur.y = num;
      else if (code === 42) cur.bulge = num;
      // vertex closes when the next 0 arrives; push then
      if (i + 1 < end && pairs[i + 1][0] === 0) { poly.verts.push({ x: cur.x, y: cur.y, bulge: cur.bulge }); cur = null; }
      continue;
    }
    if (poly && !cur) { if (code === 70) poly.closed = (parseInt(val, 10) & 1) === 1; continue; }
    if (!cur) continue;
    applyCode(cur, code, val);
  }
  flush();
  if (poly) ents.push(poly);
  return ents;
}

function newEntity(type) {
  if (type === 'LINE') return { type, x1: 0, y1: 0, x2: 0, y2: 0 };
  if (type === 'LWPOLYLINE') return { type, verts: [], closed: false, _v: null };
  if (type === 'ARC') return { type, cx: 0, cy: 0, r: 0, a0: 0, a1: 0 };
  if (type === 'CIRCLE') return { type, cx: 0, cy: 0, r: 0 };
  return { type };
}

function applyCode(e, code, val) {
  const n = parseFloat(val);
  switch (e.type) {
    case 'LINE':
      if (code === 10) e.x1 = n; else if (code === 20) e.y1 = n;
      else if (code === 11) e.x2 = n; else if (code === 21) e.y2 = n; break;
    case 'CIRCLE':
      if (code === 10) e.cx = n; else if (code === 20) e.cy = n; else if (code === 40) e.r = n; break;
    case 'ARC':
      if (code === 10) e.cx = n; else if (code === 20) e.cy = n; else if (code === 40) e.r = n;
      else if (code === 50) e.a0 = n * Math.PI / 180; else if (code === 51) e.a1 = n * Math.PI / 180; break;
    case 'LWPOLYLINE':
      if (code === 70) e.closed = (parseInt(val, 10) & 1) === 1;
      else if (code === 10) { e._v = { x: n, y: 0, bulge: 0 }; e.verts.push(e._v); }
      else if (code === 20 && e._v) e._v.y = n;
      else if (code === 42 && e._v) e._v.bulge = n;
      break;
  }
}

// ---- geometry helpers -------------------------------------------------------
function polyFromVerts(verts, closed) {
  const out = [];
  const n = verts.length;
  if (!n) return out;
  const last = closed ? n : n - 1;
  for (let i = 0; i < n; i++) {
    const v = verts[i];
    out.push({ x: v.x, y: v.y });
    if (i < last && v.bulge) {
      const nx = verts[(i + 1) % n];
      const arc = bulgeArc({ x: v.x, y: v.y }, { x: nx.x, y: nx.y }, v.bulge);
      for (let k = 1; k < arc.length - 1; k++) out.push(arc[k]);   // interior arc points
    }
  }
  if (closed) out.push({ x: verts[0].x, y: verts[0].y });
  return out;
}

function bulgeArc(p0, p1, g) {
  const ang = 4 * Math.atan(g);
  const chord = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  if (chord < 1e-9 || Math.abs(ang) < 1e-6) return [p0, p1];
  const radius = chord / (2 * Math.sin(ang / 2));
  const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
  const dir = { x: (p1.x - p0.x) / chord, y: (p1.y - p0.y) / chord };
  const perp = { x: -dir.y, y: dir.x };
  const h = radius * Math.cos(ang / 2);
  const c = { x: mid.x + perp.x * h, y: mid.y + perp.y * h };
  const a0 = Math.atan2(p0.y - c.y, p0.x - c.x);
  return sampleArcAbs(c.x, c.y, Math.abs(radius), a0, a0 + ang);
}

function sampleArc(cx, cy, r, a0, a1) {
  // ensure CCW sweep for a positive range
  if (a1 <= a0) a1 += Math.PI * 2;
  return sampleArcAbs(cx, cy, r, a0, a1);
}

function sampleArcAbs(cx, cy, r, a0, a1) {
  const sweep = a1 - a0;
  const step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - ARC_TOL / Math.max(ARC_TOL, r))));
  const n = Math.max(2, Math.ceil(Math.abs(sweep) / Math.max(0.05, step)));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

// stitch open segments into loops by matching endpoints
function chain(segs) {
  const used = new Array(segs.length).fill(false);
  const loops = [];
  const near = (p, q) => Math.abs(p.x - q.x) < WELD && Math.abs(p.y - q.y) < WELD;
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const path = [segs[i].a, segs[i].b];
    let extended = true;
    while (extended) {
      extended = false;
      const tail = path[path.length - 1];
      for (let j = 0; j < segs.length; j++) {
        if (used[j]) continue;
        if (near(segs[j].a, tail)) { path.push(segs[j].b); used[j] = true; extended = true; break; }
        if (near(segs[j].b, tail)) { path.push(segs[j].a); used[j] = true; extended = true; break; }
      }
    }
    loops.push(path);
  }
  return loops;
}

function dedupe(poly) {
  const out = [];
  for (const p of poly) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last.x - p.x) > WELD || Math.abs(last.y - p.y) > WELD) out.push(p);
  }
  // drop closing duplicate
  if (out.length > 2) {
    const a = out[0], b = out[out.length - 1];
    if (Math.abs(a.x - b.x) < WELD && Math.abs(a.y - b.y) < WELD) out.pop();
  }
  return out;
}

function bounds(polys) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of polys) for (const p of poly) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0, w: 0, h: 0 };
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}
