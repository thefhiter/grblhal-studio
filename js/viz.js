// viz.js — 2D top-view renderer for the part, toolpaths, and live tool simulation.
// CNC convention: X right, Y up (canvas Y is flipped). Supports pan (drag), zoom
// (wheel), auto-fit, and an animated tool marker for "simulation d'outil en temps réel".

export class Viz {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.scale = 4; this.ox = 0; this.oy = 0;     // world→screen
    this.scene = { contour: [], contours: [], toolPaths: [], rapids: [], machined: [], highlight: null, partOutline: null, realPath: null, toolRadius: 3 };
    this.sim = null;                               // {polys, seg, t, playing, pos}
    this.stock = null;                             // offscreen material buffer
    this.cut = null;                               // cut-simulation state
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this._bindPointer();
    this._raf = null;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const r = this.cv.getBoundingClientRect();
    this.cv.width = Math.max(10, r.width * this.dpr);
    this.cv.height = Math.max(10, r.height * this.dpr);
    this.draw();
  }

  setScene(s) { this.scene = { ...this.scene, ...s }; this.draw(); }

  fit() {
    const pts = [
      ...flat(this.scene.contour ? [this.scene.contour] : []),
      ...flat(this.scene.contours || []),
      ...flat(this.scene.toolPaths || []),
      ...flat(this.scene.machined || []),
      ...flat(this.scene.partOutline || []),
      ...flat((this.scene.realPath || []).map((s) => s.poly)),
    ];
    if (this.stock) { const s = this.stock; pts.push({ x: s.minX, y: s.maxY }, { x: s.minX + s.w, y: s.maxY - s.h }); }
    if (!pts.length) { this.draw(); return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
    const w = this.cv.width, h = this.cv.height;
    const pad = 60 * this.dpr;
    const sx = (w - pad) / Math.max(1e-3, maxX - minX);
    const sy = (h - pad) / Math.max(1e-3, maxY - minY);
    this.scale = Math.min(sx, sy);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    this.ox = w / 2 - cx * this.scale;
    this.oy = h / 2 + cy * this.scale;             // + because Y flips
    this.draw();
  }

  W2S(p) { return { x: this.ox + p.x * this.scale, y: this.oy - p.y * this.scale }; }
  S2W(x, y) { return { x: (x * this.dpr - this.ox) / this.scale, y: (this.oy - y * this.dpr) / this.scale }; }

  draw() {
    const { ctx, cv } = this;
    ctx.save();
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = '#f4f5f6';                       // light CAD viewport
    ctx.fillRect(0, 0, cv.width, cv.height);
    this._grid();
    this._drawStock();                               // material block (carved by the sim)
    this._axes();
    // part wanted — the finished shape (filled, with holes)
    if (this.scene.partOutline && this.scene.partOutline.length) this._part(this.scene.partOutline);
    // real tool path (comp applied) — cutting solid, rapids dashed
    if (this.scene.realPath) this._realPath(this.scene.realPath);
    // rapids
    this._polys(this.scene.rapids, { color: 'rgba(120,120,120,0.55)', width: 1, dash: [6, 5] });
    // machined boundary (inspection)
    if (this.scene.machined && this.scene.machined.length) this._polys(this.scene.machined, { color: 'rgba(23,130,60,0.9)', width: 1.6, close: true });
    // extra nominal loops (e.g. all DXF profiles / holes)
    if (this.scene.contours && this.scene.contours.length) this._polys(this.scene.contours, { color: 'rgba(22,104,192,0.5)', width: 1.4, close: true });
    // nominal contour (the one being compensated)
    if (this.scene.contour && this.scene.contour.length) this._polys([this.scene.contour], { color: '#1668c0', width: 2, close: true });
    // tool-centre compensated path
    this._polys(this.scene.toolPaths, { color: '#d9770b', width: 2, close: true });
    // highlighted move (line under the editor cursor)
    if (this.scene.highlight && this.scene.highlight.length) {
      this._polys([this.scene.highlight], { color: '#e0143c', width: 3.5 });
      const a = this.W2S(this.scene.highlight[0]);
      const b = this.W2S(this.scene.highlight[this.scene.highlight.length - 1]);
      ctx.fillStyle = '#e0143c';
      ctx.beginPath(); ctx.arc(a.x, a.y, 3 * this.dpr, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.arc(b.x, b.y, 3 * this.dpr, 0, 7); ctx.fill();
    }
    // tool marker
    if (this.sim && this.sim.pos) this._tool(this.sim.pos);
    if (this.cut && this.cut.pos) this._cutTool(this.cut.pos, this.cut.radius);
    ctx.restore();
  }

  _grid() {
    const { ctx, cv } = this;
    const step = niceStep(this.scale);
    const s = step * this.scale;
    if (s < 6) return;
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.07)';
    const startX = this.ox % s, startY = this.oy % s;
    ctx.beginPath();
    for (let x = startX; x < cv.width; x += s) { ctx.moveTo(x, 0); ctx.lineTo(x, cv.height); }
    for (let y = startY; y < cv.height; y += s) { ctx.moveTo(0, y); ctx.lineTo(cv.width, y); }
    ctx.stroke();
  }

  _axes() {
    const { ctx } = this;
    const o = this.W2S({ x: 0, y: 0 });
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = 'rgba(200,45,45,0.8)'; ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(o.x + 34 * this.dpr, o.y); ctx.stroke();      // X red
    ctx.strokeStyle = 'rgba(23,130,60,0.8)'; ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(o.x, o.y - 34 * this.dpr); ctx.stroke();      // Y green
    ctx.fillStyle = 'rgba(40,40,40,0.7)'; ctx.beginPath(); ctx.arc(o.x, o.y, 3 * this.dpr, 0, 7); ctx.fill();
  }

  _polys(polys, { color, width = 2, dash = [], close = false }) {
    if (!polys || !polys.length) return;
    const { ctx } = this;
    ctx.lineWidth = width * this.dpr; ctx.strokeStyle = color;
    ctx.setLineDash(dash.map((d) => d * this.dpr));
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const poly of polys) {
      if (!poly || poly.length < 2) continue;
      ctx.beginPath();
      const p0 = this.W2S(poly[0]); ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < poly.length; i++) { const p = this.W2S(poly[i]); ctx.lineTo(p.x, p.y); }
      if (close) ctx.closePath();
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  _tool(pos) {
    const { ctx } = this;
    const c = this.W2S(pos);
    const r = Math.max(3, this.scene.toolRadius * this.scale);
    ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, 7);
    ctx.fillStyle = 'rgba(217,119,11,0.18)'; ctx.fill();
    ctx.lineWidth = 1.6 * this.dpr; ctx.strokeStyle = '#b45f00'; ctx.stroke();
    ctx.beginPath(); ctx.arc(c.x, c.y, 2.5 * this.dpr, 0, 7); ctx.fillStyle = '#b45f00'; ctx.fill();
  }

  // ---- part + real-path drawing -----------------------------------------
  _part(polys) {
    const { ctx } = this;
    ctx.beginPath();
    for (const poly of polys) {
      if (!poly || poly.length < 2) continue;
      const p0 = this.W2S(poly[0]); ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < poly.length; i++) { const p = this.W2S(poly[i]); ctx.lineTo(p.x, p.y); }
      ctx.closePath();
    }
    ctx.fillStyle = 'rgba(31,138,59,0.14)'; ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(31,138,59,0.85)'; ctx.lineWidth = 1.4 * this.dpr; ctx.stroke();
  }

  _realPath(segs) {
    const cut = [], rapid = [];
    for (const s of segs) (s.cutting ? cut : rapid).push(s.poly);
    this._polys(rapid, { color: 'rgba(120,120,120,0.5)', width: 1, dash: [5, 4] });
    this._polys(cut, { color: '#d9770b', width: 1.6 });
  }

  // ---- material-removal simulation --------------------------------------
  initStock(bounds, margin = 6) {
    const w = bounds.w + 2 * margin, h = bounds.h + 2 * margin;
    const pxPerMm = Math.max(2, Math.min(8, 1100 / Math.max(1, Math.max(w, h))));
    const cw = Math.max(16, Math.round(w * pxPerMm)), ch = Math.max(16, Math.round(h * pxPerMm));
    const canvas = document.createElement('canvas'); canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#c7cbd1'; ctx.fillRect(0, 0, cw, ch);
    ctx.strokeStyle = 'rgba(120,128,140,0.5)'; ctx.lineWidth = Math.max(2, pxPerMm); ctx.strokeRect(0, 0, cw, ch);
    this.stock = { canvas, ctx, minX: bounds.minX - margin, maxY: bounds.maxY + margin, pxPerMm, w, h };
    this.draw();
  }
  clearStock() { this.stock = null; }

  eraseDisc(wx, wy, r) {
    const s = this.stock; if (!s) return;
    const c = s.ctx;
    c.globalCompositeOperation = 'destination-out';
    c.beginPath(); c.arc((wx - s.minX) * s.pxPerMm, (s.maxY - wy) * s.pxPerMm, r * s.pxPerMm, 0, 7); c.fill();
    c.globalCompositeOperation = 'source-over';
  }

  _drawStock() {
    const s = this.stock; if (!s) return;
    const tl = this.W2S({ x: s.minX, y: s.maxY });
    const br = this.W2S({ x: s.minX + s.w, y: s.maxY - s.h });
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(s.canvas, tl.x, tl.y, br.x - tl.x, br.y - tl.y);
  }

  _cutTool(pos, r) {
    const { ctx } = this;
    const c = this.W2S(pos);
    const rr = Math.max(4, r * this.scale);
    ctx.beginPath(); ctx.arc(c.x, c.y, rr, 0, 7);
    ctx.fillStyle = 'rgba(224,20,60,0.16)'; ctx.fill();
    ctx.lineWidth = 1.8 * this.dpr; ctx.strokeStyle = '#e0143c'; ctx.stroke();
    ctx.beginPath(); ctx.arc(c.x, c.y, 2.5 * this.dpr, 0, 7); ctx.fillStyle = '#e0143c'; ctx.fill();
  }

  // Resample the segments into evenly spaced tool positions with a cutting flag.
  _cutSteps(segments, radius) {
    const step = Math.max(0.3, radius / 3);
    const out = [];
    for (const seg of segments) {
      const poly = seg.poly; if (!poly || poly.length < 2) continue;
      for (let i = 0; i < poly.length - 1; i++) {
        const a = poly[i], b = poly[i + 1];
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        const n = Math.max(1, Math.ceil(d / step));
        for (let k = 0; k < n; k++) { const t = k / n; out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, cut: seg.cutting }); }
      }
      const last = poly[poly.length - 1]; out.push({ x: last.x, y: last.y, cut: seg.cutting });
    }
    return out;
  }

  simulateCut(segments, radius, onProgress, onDone) {
    if (this._raf) cancelAnimationFrame(this._raf);
    const steps = this._cutSteps(segments, radius);
    const perFrame = Math.max(6, Math.ceil(steps.length / 320));   // ~5 s total
    this.cut = { steps, radius, i: 0, perFrame, playing: true, pos: steps.length ? { x: steps[0].x, y: steps[0].y } : null, onProgress, onDone };
    this._cutLoop();
  }
  toggleCut() { if (this.cut) { this.cut.playing = !this.cut.playing; if (this.cut.playing) this._cutLoop(); } }
  stopCut() { if (this._raf) cancelAnimationFrame(this._raf); this.cut = null; this.draw(); }

  // Fully clear the simulation (stock + tool + overlays) so a new scene shows clean.
  clearSim() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this.cut = null; this.stock = null;
    this.scene.realPath = null; this.scene.partOutline = null;
  }

  _cutLoop() {
    const c = this.cut; if (!c || !c.playing) return;
    const end = Math.min(c.steps.length, c.i + c.perFrame);
    for (; c.i < end; c.i++) {
      const s = c.steps[c.i];
      if (s.cut) this.eraseDisc(s.x, s.y, c.radius);
      c.pos = { x: s.x, y: s.y };
    }
    this.draw();
    if (c.onProgress) c.onProgress(c.i / Math.max(1, c.steps.length));
    if (c.i >= c.steps.length) {
      c.playing = false;
      const done = c.onDone;
      this.cut = null;               // finished — allow a fresh run; keep the carved stock as the result
      this.draw();                   // redraw without the moving tool marker
      if (done) done();
      return;
    }
    this._raf = requestAnimationFrame(() => this._cutLoop());
  }

  // ---- simulation --------------------------------------------------------
  simulate(polys, onDone) {
    const path = [].concat(...polys.map((p) => p.slice()));
    if (path.length < 2) return;
    this.sim = { path, i: 0, t: 0, playing: true, pos: path[0], speed: 0.06, onDone };
    this._loop();
  }
  toggleSim() { if (this.sim) { this.sim.playing = !this.sim.playing; if (this.sim.playing) this._loop(); } }
  stopSim() { this.sim = null; if (this._raf) cancelAnimationFrame(this._raf); this.draw(); }

  _loop() {
    if (!this.sim || !this.sim.playing) return;
    const s = this.sim;
    s.t += s.speed;
    while (s.t >= 1 && s.i < s.path.length - 2) { s.t -= 1; s.i++; }
    const a = s.path[s.i], b = s.path[Math.min(s.i + 1, s.path.length - 1)];
    s.pos = { x: a.x + (b.x - a.x) * s.t, y: a.y + (b.y - a.y) * s.t };
    this.draw();
    if (s.i >= s.path.length - 2 && s.t >= 1) { s.playing = false; if (s.onDone) s.onDone(); return; }
    this._raf = requestAnimationFrame(() => this._loop());
  }

  _bindPointer() {
    let dragging = false, lx = 0, ly = 0;
    this.cv.addEventListener('pointerdown', (e) => { dragging = true; lx = e.offsetX; ly = e.offsetY; this.cv.setPointerCapture(e.pointerId); });
    this.cv.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      this.ox += (e.offsetX - lx) * this.dpr; this.oy += (e.offsetY - ly) * this.dpr;
      lx = e.offsetX; ly = e.offsetY; this.draw();
    });
    this.cv.addEventListener('pointerup', (e) => { dragging = false; try { this.cv.releasePointerCapture(e.pointerId); } catch (_) {} });
    this.cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const mx = e.offsetX * this.dpr, my = e.offsetY * this.dpr;
      this.ox = mx - (mx - this.ox) * f; this.oy = my - (my - this.oy) * f;
      this.scale *= f; this.draw();
    }, { passive: false });
  }
}

function flat(polys) { return [].concat(...(polys || []).map((p) => p || [])); }
function niceStep(scale) {
  const target = 40 / scale;                        // ~40px between lines
  const p = Math.pow(10, Math.floor(Math.log10(target)));
  const c = [1, 2, 5, 10];
  for (const m of c) if (p * m >= target) return p * m;
  return p * 10;
}
