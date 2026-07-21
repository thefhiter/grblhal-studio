// viz.js — 2D top-view renderer for the part, toolpaths, and live tool simulation.
// CNC convention: X right, Y up (canvas Y is flipped). Supports pan (drag), zoom
// (wheel), auto-fit, and an animated tool marker for "simulation d'outil en temps réel".

export class Viz {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.scale = 4; this.ox = 0; this.oy = 0;     // world→screen
    this.scene = { contour: [], toolPaths: [], rapids: [], machined: [], toolRadius: 3 };
    this.sim = null;                               // {polys, seg, t, playing, pos}
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
      ...flat(this.scene.toolPaths || []),
      ...flat(this.scene.machined || []),
    ];
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
    ctx.fillStyle = '#0c1016';
    ctx.fillRect(0, 0, cv.width, cv.height);
    this._grid();
    this._axes();
    // rapids
    this._polys(this.scene.rapids, { color: 'rgba(120,140,160,0.35)', width: 1, dash: [6, 5] });
    // machined boundary (inspection)
    if (this.scene.machined && this.scene.machined.length) this._polys(this.scene.machined, { color: 'rgba(72,213,151,0.85)', width: 1.5, close: true });
    // nominal contour
    if (this.scene.contour && this.scene.contour.length) this._polys([this.scene.contour], { color: '#4cc9f0', width: 2, close: true });
    // tool-centre compensated path
    this._polys(this.scene.toolPaths, { color: '#f5b043', width: 2, close: true });
    // tool marker
    if (this.sim && this.sim.pos) this._tool(this.sim.pos);
    ctx.restore();
  }

  _grid() {
    const { ctx, cv } = this;
    const step = niceStep(this.scale);
    const s = step * this.scale;
    if (s < 6) return;
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(90,120,150,0.08)';
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
    ctx.strokeStyle = 'rgba(248,115,127,0.7)'; ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(o.x + 34 * this.dpr, o.y); ctx.stroke();      // X red
    ctx.strokeStyle = 'rgba(72,213,151,0.7)'; ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(o.x, o.y - 34 * this.dpr); ctx.stroke();      // Y green
    ctx.fillStyle = 'rgba(200,215,230,0.7)'; ctx.beginPath(); ctx.arc(o.x, o.y, 3 * this.dpr, 0, 7); ctx.fill();
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
    ctx.fillStyle = 'rgba(245,176,67,0.18)'; ctx.fill();
    ctx.lineWidth = 1.6 * this.dpr; ctx.strokeStyle = '#ffd27a'; ctx.stroke();
    ctx.beginPath(); ctx.arc(c.x, c.y, 2.5 * this.dpr, 0, 7); ctx.fillStyle = '#ffd27a'; ctx.fill();
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
