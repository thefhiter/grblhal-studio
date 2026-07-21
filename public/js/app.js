// app.js — wires the cockpit together.
import { MATERIALS, STRATEGY } from './materials.js';
import { TOOL_TYPES, loadTools, saveTools, mkTool, effRadius, effDia, effLength, toolToG10, nextToolId } from './tools.js';
import { computeCutting } from './feeds.js';
import { parseGcode, compensate, polysToGcode, demoContour, polyBounds } from './geometry.js';
import { inspect } from './inspect.js';
import { Viz } from './viz.js';
import { grbl } from './grbl.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const state = {
  tools: loadTools(),
  activeId: 1,
  strategy: 'semifinition',
  materialKey: 'alu',
  rpmMax: 24000,
  tol: 0.05,
  cutZ: -1, safeZ: 5, feed: 600, plunge: 200,
  contour: [],           // nominal closed profile
  toolPaths: [],         // compensated tool-centre polys
  rapids: [],
  machined: [],
  compSide: 'outside',
};

let viz;

// ---------- init ----------
window.addEventListener('DOMContentLoaded', () => {
  if (!window.ClipperLib) console.warn('ClipperLib manquant');
  viz = new Viz($('#view'));
  populateSelects();
  renderToolList();
  selectTool(state.activeId);
  bindMenus();
  bindTools();
  bindFeeds();
  bindStrategy();
  bindViz();
  bindGcode();
  bindMachine();
  loadDemo();
  logSys('Prêt. Connecte la machine (Chrome/Edge) ou explore la CAO.');
});

// ---------- selects ----------
function populateSelects() {
  const mat = $('#fMaterial');
  mat.innerHTML = MATERIALS.map((m) => `<option value="${m.key}">${m.label}</option>`).join('');
  mat.value = state.materialKey;

  const tType = $('#tType');
  tType.innerHTML = Object.values(TOOL_TYPES).map((t) => `<option value="${t.key}">${t.label}</option>`).join('');

  refreshCompToolSelect();
}
function refreshCompToolSelect() {
  const sel = $('#compTool');
  sel.innerHTML = state.tools.map((t) => `<option value="${t.id}">T${t.id} · ${t.name}</option>`).join('');
  sel.value = String(state.activeId);
}

// ---------- tool list + editor ----------
function toolIcon(type) {
  const map = { flat: 'M7 3h10v9l-5 9-5-9V3z', ball: 'M7 3h10v8a5 5 0 0 1-10 0V3z', bull: 'M7 3h10v9l-2 8h-6l-2-8V3z',
    drill: 'M12 3l4 5v6l-4 7-4-7V8l4-5z', chamfer: 'M7 3h10v6l-5 12L7 9V3z', engrave: 'M12 3l3 6-3 12-3-12 3-6z',
    face: 'M5 4h14v6a7 7 0 0 1-14 0V4z', tap: 'M8 3h8v7l-4 11-4-11V3z' };
  const t = TOOL_TYPES[type] || TOOL_TYPES.endmill_flat;
  return `<svg class="tico" viewBox="0 0 24 24"><path d="${map[t.icon] || map.flat}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}

function renderToolList() {
  const box = $('#toolList');
  box.innerHTML = state.tools.map((t) => {
    const wear = (t.radiusWear || t.lenWear) ? `<span class="wearflag">usure R${sig(t.radiusWear)} L${sig(t.lenWear)}</span>` : '';
    return `<div class="tool-card ${t.id === state.activeId ? 'is-active' : ''}" data-id="${t.id}">
      <span class="tnum">T${t.id}</span>${toolIcon(t.type)}
      <div class="tmeta"><div class="tname">${esc(t.name)}</div>
      <div class="tsub">Ø${effDia(t).toFixed(2)} · z${t.flutes} · L${effLength(t).toFixed(1)}</div></div>${wear}</div>`;
  }).join('');
  $$('#toolList .tool-card').forEach((c) => c.addEventListener('click', () => selectTool(+c.dataset.id)));
}

function selectTool(id) {
  const t = state.tools.find((x) => x.id === id);
  if (!t) return;
  state.activeId = id;
  $('#toolIdPill').textContent = 'T' + id;
  $('#tName').value = t.name; $('#tType').value = t.type; $('#tMat').value = t.material;
  $('#tDia').value = t.dia; $('#tFlutes').value = t.flutes;
  $('#tRadGeom').value = t.radiusGeom; $('#tRadWear').value = t.radiusWear;
  $('#tLenGeom').value = t.lenGeom; $('#tLenWear').value = t.lenWear;
  renderToolList();
  refreshCompToolSelect();
  updateEff();
  computeFeeds();
}

function readEditor() {
  const t = state.tools.find((x) => x.id === state.activeId);
  if (!t) return null;
  Object.assign(t, mkTool({
    id: t.id, name: $('#tName').value, type: $('#tType').value, material: $('#tMat').value,
    dia: $('#tDia').value, flutes: $('#tFlutes').value,
    radiusGeom: $('#tRadGeom').value, radiusWear: $('#tRadWear').value,
    lenGeom: $('#tLenGeom').value, lenWear: $('#tLenWear').value,
  }));
  return t;
}

function updateEff() {
  const t = state.tools.find((x) => x.id === state.activeId); if (!t) return;
  $('#tEff').innerHTML = `Effectif → Ø <b>${effDia(t).toFixed(3)}</b> mm · R <b>${effRadius(t).toFixed(3)}</b> · L <b>${effLength(t).toFixed(3)}</b> mm`;
}

function bindTools() {
  ['#tName', '#tType', '#tMat', '#tDia', '#tFlutes', '#tRadGeom', '#tRadWear', '#tLenGeom', '#tLenWear']
    .forEach((s) => $(s).addEventListener('input', () => { readEditor(); updateEff(); computeFeeds(); renderToolList(); }));

  $('#btnSaveTool').addEventListener('click', () => { readEditor(); saveTools(state.tools); renderToolList(); refreshCompToolSelect(); flash($('#btnSaveTool')); logSys(`Outil T${state.activeId} enregistré.`); });
  $('#btnAddTool').addEventListener('click', addTool);
  $('#btnDeleteTool').addEventListener('click', deleteTool);
  $('#btnPushTools').addEventListener('click', pushTools);
}

function addTool() {
  const id = nextToolId(state.tools);
  const t = mkTool({ id, name: `Outil ${id}`, dia: 6, lenGeom: 45, flutes: 2 });
  state.tools.push(t); saveTools(state.tools);
  selectTool(id); logSys(`Outil T${id} ajouté.`);
}
function deleteTool() {
  if (state.tools.length <= 1) return logSys('Au moins un outil requis.');
  state.tools = state.tools.filter((t) => t.id !== state.activeId);
  saveTools(state.tools);
  selectTool(state.tools[0].id);
}
function pushTools() {
  if (!grbl.connected) return logSys('Connecte la machine pour pousser la table.', 'err');
  grbl.pushToolTable(state.tools, toolToG10);
  logSys(`${state.tools.length} outils → G10 L1 envoyés.`, 'ok');
}

// ---------- feeds ----------
function bindFeeds() {
  $('#fMaterial').addEventListener('change', (e) => { state.materialKey = e.target.value; computeFeeds(); });
  $('#fRpmMax').addEventListener('input', (e) => { state.rpmMax = +e.target.value || 24000; computeFeeds(); });
  $('#fFzOverride').addEventListener('input', computeFeeds);
}

function computeFeeds() {
  const t = state.tools.find((x) => x.id === state.activeId); if (!t) return;
  const fz = parseFloat($('#fFzOverride').value);
  const r = computeCutting({ tool: t, materialKey: state.materialKey, strategy: state.strategy, rpmMax: state.rpmMax, fzOverride: Number.isFinite(fz) ? fz : null });
  $('#feedsOut').innerHTML = [
    stat('N (broche)', r.n, 'rpm', 'hero' + (r.clamped ? ' warn' : '')),
    stat('Vf (avance)', r.vf, 'mm/min', 'hero'),
    stat('Vc', r.vc, 'm/min'),
    stat('fz', r.fz, 'mm/dent'),
    stat('ap', r.ap, 'mm'),
    stat('ae', r.ae, 'mm'),
  ].join('');
  if (r.clamped) logOnce('rpmclamp', `N calculé ${r.nUnclamped} rpm > max ${state.rpmMax} → bridé.`);
  state.feed = r.vf;
}
function stat(k, v, u, cls = '') { return `<div class="stat ${cls}"><div class="k">${k}</div><div class="v">${v}</div><div class="u">${u}</div></div>`; }

// ---------- strategy ----------
function bindStrategy() {
  $$('.strat-tab').forEach((tab) => tab.addEventListener('click', () => {
    $$('.strat-tab').forEach((t) => t.classList.remove('is-active'));
    tab.classList.add('is-active');
    state.strategy = tab.dataset.strat;
    $('#stratPill').textContent = STRATEGY[state.strategy].label;
    computeFeeds();
  }));
}

// ---------- viz / compensation ----------
function bindViz() {
  $('#btnFit').addEventListener('click', () => viz.fit());
  $('#compSide').addEventListener('change', (e) => { state.compSide = e.target.value; });
  $('#btnComp').addEventListener('click', runComp);
  $('#btnSim').addEventListener('click', toggleSim);
  $('#btnInspect').addEventListener('click', runInspect);
}

function runComp() {
  if (!state.contour.length) return logSys('Aucun profil. Charge la géométrie démo.', 'err');
  const id = +$('#compTool').value;
  const t = state.tools.find((x) => x.id === id) || state.tools[0];
  const r = effRadius(t);
  const stock = STRATEGY[state.strategy].stock;
  state.compSide = $('#compSide').value;                 // single source of truth = the control
  const res = compensate(state.contour, r, state.compSide, stock);
  state.toolPaths = res.paths;
  state.machined = [];
  viz.setScene({ contour: state.contour, toolPaths: state.toolPaths, machined: [], toolRadius: r });
  viz.fit();
  hideBadge();
  if (res.gouge) logSys('⚠ Gouge : outil plus grand que la poche — décalage impossible.', 'err');
  else logSys(`Compensation T${id} · R${r.toFixed(3)} · ${state.compSide} · surép. ${stock} → ${res.paths.length} contour(s).`, 'ok');
}

function toggleSim() {
  if (!state.toolPaths.length) return logSys('Compense d\'abord un profil.', 'err');
  if (viz.sim && viz.sim.playing) { viz.toggleSim(); setSimIcon(false); return; }
  if (viz.sim && !viz.sim.playing) { viz.toggleSim(); setSimIcon(true); return; }
  viz.simulate(state.toolPaths, () => setSimIcon(false));
  setSimIcon(true);
}
function setSimIcon(playing) { $('#btnSim').innerHTML = `<svg class="ic"><use href="#${playing ? 'i-pause' : 'i-play'}"/></svg> ${playing ? 'Pause' : 'Simuler'}`; }

function runInspect() {
  if (!state.toolPaths.length) return logSys('Compense d\'abord un profil.', 'err');
  const id = +$('#compTool').value;
  const t = state.tools.find((x) => x.id === id) || state.tools[0];
  const res = inspect(state.contour, state.toolPaths, effRadius(t), state.compSide, state.tol);
  state.machined = res.machinedPolys;
  viz.setScene({ machined: state.machined });
  const verdict = res.pass
    ? `<span class="insp-verdict pass"><svg class="ic"><use href="#i-check"/></svg>CONFORME</span>`
    : `<span class="insp-verdict fail">HORS TOLÉRANCE</span>`;
  const cells = res.dims.map((d) => `<div class="cell"><span class="k">${d.axis} nominal</span><span class="v">${d.nominal} mm</span></div>
    <div class="cell"><span class="k">${d.axis} usiné</span><span class="v">${d.actual} mm</span></div>
    <div class="cell"><span class="k">Δ${d.axis}</span><span class="v">${sig(d.dev)} mm</span></div>`).join('');
  $('#inspectOut').innerHTML = `${verdict}<div class="insp-tbl">${cells}
    <div class="cell"><span class="k">écart max</span><span class="v">${res.maxDev} mm</span></div>
    <div class="cell"><span class="k">tol.</span><span class="v">±${state.tol} mm</span></div></div>`;
  logSys(`Contrôle : écart max ${res.maxDev} mm — ${res.pass ? 'conforme' : 'hors tolérance'}.`, res.pass ? 'ok' : 'err');
}

// ---------- g-code ----------
function bindGcode() {
  $('#btnLoadDemo').addEventListener('click', loadDemo);
  $('#btnGenerate').addEventListener('click', generateGcode);
  $('#btnOpenFile').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', openFile);
  $('#btnStream').addEventListener('click', streamGcode);
}

function loadDemo() {
  state.contour = demoContour('bracket');
  state.toolPaths = []; state.machined = [];
  const b = polyBounds([state.contour]);
  viz.setScene({ contour: state.contour, toolPaths: [], rapids: [], machined: [], toolRadius: effRadius(activeTool()) });
  viz.fit(); hideBadge();
  $('#gcode').value = profileGcode(state.contour);
  $('#inspectOut').innerHTML = `<span class="muted">Profil chargé : ${b.w.toFixed(1)} × ${b.h.toFixed(1)} mm. Lance « Compenser » puis « Contrôler ».</span>`;
  logSys('Géométrie démo chargée (équerre 70×50).');
}

function profileGcode(pts) {
  const out = ['; Profil nominal (non compensé) — centre = arête pièce', 'G21 G90 G17', 'G0 Z5', `G0 X${f(pts[0].x)} Y${f(pts[0].y)}`, 'G1 Z-1 F200'];
  for (let i = 1; i < pts.length; i++) out.push(`G1 X${f(pts[i].x)} Y${f(pts[i].y)} F600`);
  out.push(`G1 X${f(pts[0].x)} Y${f(pts[0].y)}`, 'G0 Z5', 'M30');
  return out.join('\n');
}

function generateGcode() {
  if (!state.toolPaths.length) return logSys('Compense d\'abord un profil.', 'err');
  const t = activeTool();
  const r = computeCutting({ tool: t, materialKey: state.materialKey, strategy: state.strategy, rpmMax: state.rpmMax });
  $('#gcode').value = polysToGcode(state.toolPaths, { feed: r.vf, plunge: state.plunge, safeZ: state.safeZ, cutZ: state.cutZ, rpm: r.n });
  logSys('G-code généré depuis la trajectoire compensée.', 'ok');
}

function openFile(e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { $('#gcode').value = reader.result; traceGcode(reader.result); logSys(`Chargé : ${file.name}`); };
  reader.readAsText(file);
  e.target.value = '';
}

function traceGcode(text) {
  const p = parseGcode(text);
  const cuts = p.moves.filter((m) => !m.rapid).map((m) => m.poly);
  const rapids = p.moves.filter((m) => m.rapid).map((m) => m.poly);
  state.toolPaths = cuts; state.rapids = rapids;
  viz.setScene({ toolPaths: cuts, rapids, contour: state.contour, machined: [] });
  viz.fit(); hideBadge();
}

function streamGcode() {
  const text = $('#gcode').value.trim();
  if (!text) return logSys('G-code vide.', 'err');
  if (!grbl.connected) return logSys('Machine non connectée.', 'err');
  grbl.streamProgram(text);
  logSys('Envoi du programme à grblHAL…', 'ok');
}

// ---------- machine ----------
function bindMachine() {
  $('#btnConnect').addEventListener('click', toggleConnect);
  $('#estop').addEventListener('click', () => { grbl.softReset(); logSys('ARRÊT D\'URGENCE — soft reset.', 'err'); });
  $('#btnStart').addEventListener('click', () => grbl.resume());
  $('#btnHold').addEventListener('click', () => grbl.feedHold());
  $('#btnReset').addEventListener('click', () => grbl.softReset());
  $('#btnHome').addEventListener('click', () => grbl.home());
  $('#btnUnlock').addEventListener('click', () => grbl.unlock());
  $$('.z0').forEach((b) => b.addEventListener('click', () => grbl.zeroWork(b.dataset.zero)));
  $$('.jog').forEach((b) => b.addEventListener('click', () => doJog(b.dataset.jog)));
  $('#cmdForm').addEventListener('submit', (e) => { e.preventDefault(); const v = $('#cmdLine').value.trim(); if (!v) return; grbl.send(v); logLine(v, 'tx'); $('#cmdLine').value = ''; });

  grbl.addEventListener('state', (e) => renderState(e.detail));
  grbl.addEventListener('open', () => setConn('on', 'Connecté'));
  grbl.addEventListener('close', () => setConn('', 'Déconnecté'));
  grbl.addEventListener('line', (e) => logLine(e.detail.line, 'rx'));
  grbl.addEventListener('sent', (e) => logLine(e.detail.line, 'tx'));
  grbl.addEventListener('error', (e) => logLine(e.detail.message, 'err'));
  grbl.addEventListener('progress', (e) => { const d = e.detail; $('#streamProg').textContent = d.total ? `${d.sent}/${d.total}` : ''; });
  grbl.addEventListener('streamdone', () => logSys('Programme terminé.', 'ok'));
}

async function toggleConnect() {
  if (grbl.connected) { await grbl.disconnect(); return; }
  try { setConn('busy', 'Connexion…'); await grbl.connect(); logSys('Port série ouvert (115200).', 'ok'); }
  catch (err) { setConn('err', 'Échec'); logSys('Connexion : ' + err.message, 'err'); }
}
function setConn(cls, txt) {
  $('#connDot').className = 'status-dot ' + cls;
  $('#connState').textContent = txt;
  $('#btnConnect').innerHTML = `<svg class="ic"><use href="#i-plug"/></svg> ${grbl.connected ? 'Déconnecter' : 'Connecter'}`;
}
function renderState(s) {
  const p = s.wpos && s.wpos.some(Boolean) ? s.wpos : s.mpos;
  $('#droX').textContent = (p[0] ?? 0).toFixed(3);
  $('#droY').textContent = (p[1] ?? 0).toFixed(3);
  $('#droZ').textContent = (p[2] ?? 0).toFixed(3);
  $('#droF').textContent = Math.round(s.feed || 0);
  $('#droS').textContent = Math.round(s.spindle || 0);
  const st = $('#mcState'); st.textContent = s.status;
  const cls = /Run|Jog|Home/.test(s.status) ? 'busy' : /Alarm|Error/.test(s.status) ? 'err' : /Idle/.test(s.status) ? 'on' : '';
  $('#connDot').className = 'status-dot ' + (grbl.connected ? (cls || 'on') : '');
}
function doJog(dir) {
  if (!grbl.connected) return logSys('Machine non connectée.', 'err');
  if (dir === '0') return;
  const step = parseFloat($('#jogStep').value) || 1;
  const map = { 'X+': ['X', step], 'X-': ['X', -step], 'Y+': ['Y', step], 'Y-': ['Y', -step], 'Z+': ['Z', step], 'Z-': ['Z', -step] };
  const [ax, d] = map[dir] || []; if (!ax) return;
  grbl.jog(ax, d, 800);
}

// ---------- menus ----------
function bindMenus() {
  $$('.menu-item').forEach((mi) => {
    mi.addEventListener('click', (e) => {
      if (e.target.closest('.dropdown')) return;
      const open = mi.classList.contains('open');
      $$('.menu-item').forEach((m) => m.classList.remove('open'));
      if (!open) mi.classList.add('open');
    });
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.menu-item')) $$('.menu-item').forEach((m) => m.classList.remove('open')); });
  $$('.dropdown button').forEach((b) => b.addEventListener('click', () => { menuAct(b.dataset.act); $$('.menu-item').forEach((m) => m.classList.remove('open')); }));
}
function menuAct(act) {
  switch (act) {
    case 'open-gcode': $('#fileInput').click(); break;
    case 'save-gcode': download('program.nc', $('#gcode').value); break;
    case 'export-tools': download('tools.json', JSON.stringify(state.tools, null, 2)); break;
    case 'import-tools': $('#fileTools').click(); break;
    case 'clear-gcode': $('#gcode').value = ''; break;
    case 'clear-comp': state.toolPaths = []; state.machined = []; viz.setScene({ toolPaths: [], machined: [] }); break;
    case 'set-rpm': ask('RPM max broche', state.rpmMax, (v) => { state.rpmMax = +v || state.rpmMax; $('#fRpmMax').value = state.rpmMax; computeFeeds(); }); break;
    case 'set-tol': ask('Tolérance de contrôle (mm)', state.tol, (v) => { state.tol = +v || state.tol; }); break;
    case 'set-cutz': ask('Z de coupe (mm)', state.cutZ, (v) => { state.cutZ = parseFloat(v); }); break;
    case 'add-tool': addTool(); break;
    case 'push-tools': pushTools(); break;
    case 'reset-tools': localStorage.removeItem('grblhal-studio.tools.v1'); state.tools = loadTools(); selectTool(state.tools[0].id); renderToolList(); refreshCompToolSelect(); break;
    case 'ins-G0': insG('G0 X0 Y0'); break;
    case 'ins-G1': insG('G1 X0 Y0 F600'); break;
    case 'ins-G2': insG('G2 X0 Y0 I0 J0 F600'); break;
    case 'ins-G43': insG('G43 H1'); break;
    case 'ins-M3': insG('M3 S12000'); break;
  }
}
function insG(t) { const ta = $('#gcode'); ta.value += (ta.value.endsWith('\n') || !ta.value ? '' : '\n') + t + '\n'; }
$('#fileTools')?.addEventListener?.('change', (e) => { const file = e.target.files[0]; if (!file) return; const r = new FileReader(); r.onload = () => { try { state.tools = JSON.parse(r.result).map(mkTool); saveTools(state.tools); selectTool(state.tools[0].id); renderToolList(); refreshCompToolSelect(); logSys('Outils importés.', 'ok'); } catch (_) { logSys('JSON outils invalide.', 'err'); } }; r.readAsText(file); e.target.value = ''; });

// ---------- helpers ----------
function activeTool() { return state.tools.find((x) => x.id === state.activeId) || state.tools[0]; }
function hideBadge() { $('#vizBadge').classList.add('hide'); }
const seen = new Set();
function logOnce(k, m) { if (seen.has(k)) return; seen.add(k); logSys(m); }
function logSys(m, cls = 'sys') { logLine(m, cls); }
function logLine(text, cls) {
  const c = $('#console'); const d = document.createElement('div');
  d.className = 'l-' + (cls || 'rx'); d.textContent = (cls === 'tx' ? '» ' : cls === 'rx' ? '‹ ' : '') + text;
  c.appendChild(d); c.scrollTop = c.scrollHeight;
  while (c.children.length > 400) c.removeChild(c.firstChild);
}
function flash(el) { el.style.borderColor = 'var(--green)'; setTimeout(() => (el.style.borderColor = ''), 500); }
function download(name, text) { const b = new Blob([text], { type: 'text/plain' }); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = name; a.click(); URL.revokeObjectURL(u); }
function ask(label, def, cb) { const v = window.prompt(label, def); if (v != null) cb(v); }
const f = (v) => (Math.round(v * 1000) / 1000).toFixed(3);
const sig = (v) => (v > 0 ? '+' : '') + (Math.round(v * 1000) / 1000);
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
