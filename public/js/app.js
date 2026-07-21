// app.js — wires the cockpit together.
import { MATERIALS, STRATEGY } from './materials.js';
import { TOOL_TYPES, TIP_DIRS, loadTools, saveTools, mkTool, effRadius, effDia, effLength, toolToG10, nextToolId, toolsToCSV, csvToTools } from './tools.js';
import { computeCutting } from './feeds.js';
import { parseGcode, compensate, pocketClear, polysToGcode, demoContour, polyBounds } from './geometry.js';
import { inspect } from './inspect.js';
import { Viz } from './viz.js';
import { grbl } from './grbl.js';
import { ToolTable } from './tooltable.js';
import { parseDXF, largestLoop } from './dxf.js';
import { loadWcs, saveWcs, wcsToG10, wcsSetHere } from './wcs.js';

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
  contour: [],           // nominal closed profile (the one compensated)
  contours: [],          // all nominal loops (e.g. from a DXF)
  toolPaths: [],         // compensated tool-centre polys
  rapids: [],
  machined: [],
  compSide: 'outside',
  wcs: loadWcs(),
  wcsActiveP: 1,
};

let viz;
let toolTable;

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
  initToolTable();
  bindConnDialog();
  initWcs();
  loadDemo();
  logSys('Prêt. Connecte la machine (Chrome/Edge) ou explore la CAO.');
});

// ---------- correction table (editable grid) ----------
function initToolTable() {
  toolTable = new ToolTable({
    back: $('#ttBack'),
    table: $('#ttTable'),
    modeBtns: $$('#ttMode button'),
    latheHint: $('#ttLatheHint'),
    tipPicker: { back: $('#tipBack'), grid: $('#tipGrid') },
    controls: {
      add: $('#ttAdd'), del: $('#ttDel'), apply: $('#ttApply'),
      grabZ: $('#ttGrabZ'), grabX: $('#ttGrabX'), close: $('#ttClose'),
    },
    deps: {
      getTools: () => state.tools,
      setTools: (t) => { state.tools = t; },
      persist: () => saveTools(state.tools),
      getActiveId: () => state.activeId,
      setActiveId: (id) => { state.activeId = id; },
      getDRO: () => (grbl.connected ? droVec() : null),
      onApply: applyTable,
      onChanged: syncFromTable,
      log: (m, cls) => logSys(m, cls),
    },
  });
  $('#btnOpenTable').addEventListener('click', () => toolTable.open());
  $('#btnOpenTable2').addEventListener('click', () => toolTable.open());
  $('#ttExport').addEventListener('click', exportToolsCSV);
  $('#ttImport').addEventListener('click', () => $('#fileTools').click());
}

// Extract the full declared tool table as a CSV spreadsheet.
function exportToolsCSV() {
  const csv = toolsToCSV(state.tools);
  download('table-outils.csv', '﻿' + csv);      // BOM → accents OK in Excel
  logSys(`Table exportée : ${state.tools.length} outils → table-outils.csv`, 'ok');
  if (toolTable) flash($('#ttExport'));
}

// Table edited a tool → keep the left cockpit (list, editor, comp select, feeds) in sync.
function syncFromTable(id) {
  renderToolList();
  refreshCompToolSelect();
  if (id === state.activeId) {
    const t = state.tools.find((x) => x.id === id);
    if (t) {
      $('#toolIdPill').textContent = 'T' + id;
      $('#tName').value = t.name; $('#tType').value = t.type; $('#tMat').value = t.material;
      $('#tDia').value = t.dia; $('#tFlutes').value = t.flutes;
      $('#tRadGeom').value = t.radiusGeom; $('#tRadWear').value = t.radiusWear;
      $('#tLenGeom').value = t.lenGeom; $('#tLenWear').value = t.lenWear;
      updateEff(); computeFeeds();
    }
  }
}

// "Appliquer" — declare the whole table in grblHAL (G10 L1), or preview if offline.
function applyTable(tools, mode) {
  const lines = tools.map(toolToG10);
  if (grbl.connected) {
    for (const l of lines) grbl.send(l);
    grbl.emit('line', { line: `; ${tools.length} outils appliqués (${mode}) → table grblHAL` });
    logSys(`${tools.length} outils appliqués → grblHAL (G10 L1, ${mode}).`, 'ok');
  } else {
    $('#gcode').value = ['; Table de correction d\'outil — G10 L1 (' + mode + ')', ...lines, ''].join('\n');
    logSys(`Hors ligne : ${tools.length} lignes G10 L1 générées dans l'éditeur G-code.`, 'sys');
  }
  flash($('#ttApply'));
}

function droVec() {
  const s = grbl.state;
  const p = s.wpos && s.wpos.some(Boolean) ? s.wpos : s.mpos;
  return { x: p[0] || 0, y: p[1] || 0, z: p[2] || 0 };
}

// ---------- work offsets (G54–G59) ----------
function initWcs() {
  $('#btnWcs').addEventListener('click', openWcs);
  $('#wcsClose').addEventListener('click', () => ($('#wcsBack').hidden = true));
  $('#wcsBack').addEventListener('mousedown', (e) => { if (e.target === $('#wcsBack')) $('#wcsBack').hidden = true; });
  $('#wcsApply').addEventListener('click', applyWcs);
  $('#wcsFromDro').addEventListener('click', wcsFromDro);
  $('#wcsZeroHere').addEventListener('click', wcsZeroHere);
  $('#wcsActivate').addEventListener('click', wcsActivate);

  const t = $('#wcsTable');
  t.addEventListener('input', (e) => {
    const el = e.target; const p = +el.dataset.p; const field = el.dataset.field; if (!field) return;
    const w = state.wcs.find((x) => x.p === p); if (!w) return;
    w[field] = field === 'note' ? el.value : (parseFloat(el.value) || 0);
    saveWcs(state.wcs);
  });
  t.addEventListener('click', (e) => {
    const r = e.target.closest('[data-act="wcs-sel"]');
    if (r) { state.wcsActiveP = +r.dataset.p; renderWcs(); return; }
    const tr = e.target.closest('tr[data-p]');
    if (tr && !e.target.closest('input,button')) { state.wcsActiveP = +tr.dataset.p; renderWcs(); }
  });
}
function openWcs() { $('#wcsBack').hidden = false; renderWcs(); }

function renderWcs() {
  const head = `<thead><tr><th style="width:30px"></th><th style="width:64px">Repère</th>
    <th style="width:96px">X<i>mm</i></th><th style="width:96px">Y<i>mm</i></th><th style="width:96px">Z<i>mm</i></th>
    <th>Note</th></tr></thead>`;
  const rows = state.wcs.map((w) => `<tr data-p="${w.p}" class="${w.p === state.wcsActiveP ? 'is-active' : ''}">
    <td class="c-sel"><label class="tt-radio"><input type="radio" name="wcs-active" ${w.p === state.wcsActiveP ? 'checked' : ''} data-act="wcs-sel" data-p="${w.p}"></label></td>
    <td class="c-id"><b>${w.code}</b> <span class="muted">P${w.p}</span></td>
    <td class="c-num"><input class="tt-in" type="number" step="0.001" value="${fmtn(w.x)}" data-p="${w.p}" data-field="x"></td>
    <td class="c-num"><input class="tt-in" type="number" step="0.001" value="${fmtn(w.y)}" data-p="${w.p}" data-field="y"></td>
    <td class="c-num"><input class="tt-in" type="number" step="0.001" value="${fmtn(w.z)}" data-p="${w.p}" data-field="z"></td>
    <td><input class="tt-in tt-text" type="text" value="${esc(w.note)}" data-p="${w.p}" data-field="note" placeholder="ex. OP 1 — brut"></td>
  </tr>`).join('');
  $('#wcsTable').innerHTML = head + `<tbody>${rows}</tbody>`;
}
function activeWcs() { return state.wcs.find((w) => w.p === state.wcsActiveP) || state.wcs[0]; }

function applyWcs() {
  const lines = state.wcs.map(wcsToG10);
  if (grbl.connected) { for (const l of lines) grbl.send(l); logSys(`${lines.length} décalages pièce → grblHAL (G10 L2).`, 'ok'); }
  else { $('#gcode').value = ['; Décalages pièce — G10 L2', ...lines, ''].join('\n'); logSys(`Hors ligne : ${lines.length} lignes G10 L2 générées.`, 'sys'); }
  flash($('#wcsApply'));
}
function wcsFromDro() {
  if (!grbl.connected) return logSys('Machine non connectée.', 'err');
  const w = activeWcs(); const d = droVec();
  w.x = round3(d.x); w.y = round3(d.y); w.z = round3(d.z);
  saveWcs(state.wcs); renderWcs();
  logSys(`${w.code} ← position (${w.x}, ${w.y}, ${w.z}).`, 'ok');
}
function wcsZeroHere() {
  const w = activeWcs();
  if (grbl.connected) { grbl.send(wcsSetHere(w, 0, 0, 0)); logSys(`${w.code} : position courante = origine (G10 L20 P${w.p}).`, 'ok'); }
  else logSys('Connecte la machine pour « Zéro ici ».', 'err');
}
function wcsActivate() {
  const w = activeWcs();
  if (grbl.connected) { grbl.send(w.code); logSys(`Repère actif → ${w.code}.`, 'ok'); }
  else logSys(`Hors ligne : ${w.code} serait activé.`, 'sys');
}
function round3(v) { return Math.round(v * 1000) / 1000; }
function fmtn(v) { const n = +v; return Number.isFinite(n) ? String(round3(n)) : '0'; }

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
  // Spread the existing tool first so table-only fields (pocket, xOffset, tipDir,
  // fluteLen, note) survive an edit made from this compact left-panel form.
  Object.assign(t, mkTool({
    ...t,
    name: $('#tName').value, type: $('#tType').value, material: $('#tMat').value,
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

function refreshTableIfOpen() { if (toolTable && toolTable.isOpen()) toolTable.render(); }

function addTool() {
  const id = nextToolId(state.tools);
  const t = mkTool({ id, name: `Outil ${id}`, dia: 6, lenGeom: 45, flutes: 2 });
  state.tools.push(t); saveTools(state.tools);
  selectTool(id); refreshTableIfOpen(); logSys(`Outil T${id} ajouté.`);
}
function deleteTool() {
  if (state.tools.length <= 1) return logSys('Au moins un outil requis.');
  state.tools = state.tools.filter((t) => t.id !== state.activeId);
  saveTools(state.tools);
  selectTool(state.tools[0].id); refreshTableIfOpen();
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
  if (!state.contour.length) return logSys('Aucun profil. Charge la géométrie démo ou un DXF.', 'err');
  const id = +$('#compTool').value;
  const t = state.tools.find((x) => x.id === id) || state.tools[0];
  const r = effRadius(t);
  const stock = STRATEGY[state.strategy].stock;
  state.compSide = $('#compSide').value;                 // single source of truth = the control

  if (state.compSide === 'pocket') {
    const cut = computeCutting({ tool: t, materialKey: state.materialKey, strategy: state.strategy, rpmMax: state.rpmMax });
    const step = Math.max(0.2, cut.ae || effDia(t) * 0.45);
    const res = pocketClear(state.contour, r, step, stock);
    state.toolPaths = res.passes; state.machined = [];
    viz.setScene({ contour: state.contour, toolPaths: state.toolPaths, machined: [], toolRadius: r });
    viz.fit(); hideBadge();
    if (res.gouge) logSys('⚠ Outil plus grand que la poche — évidement impossible.', 'err');
    else logSys(`Évidement T${id} · R${r.toFixed(3)} · pas ae ${step.toFixed(2)} → ${res.rings} passe(s).`, 'ok');
    return;
  }

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
  if (state.compSide === 'pocket') return logSys('Le contrôle de cote s\'applique au contournage, pas à l\'évidement de poche.', 'sys');
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
  $('#btnImportDxf').addEventListener('click', () => $('#fileDxf').click());
  $('#fileDxf').addEventListener('change', openDxf);
  $('#btnStream').addEventListener('click', streamGcode);
}

// Import a real 2D profile from a DXF and load it as the nominal contour.
function openDxf(e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const { polylines, bounds, count } = parseDXF(String(reader.result));
      if (!count) { logSys('DXF : aucun profil fermé trouvé (LINE/ARC/LWPOLYLINE/CIRCLE).', 'err'); return; }
      const main = largestLoop(polylines);
      state.contour = main;
      state.contours = polylines;
      state.toolPaths = []; state.machined = []; state.rapids = [];
      viz.setScene({ contour: main, contours: polylines, toolPaths: [], machined: [], rapids: [], toolRadius: effRadius(activeTool()) });
      viz.fit(); hideBadge();
      $('#gcode').value = profileGcode(main);
      $('#inspectOut').innerHTML = `<span class="muted">DXF chargé : ${count} profil(s), cadre ${bounds.w.toFixed(1)} × ${bounds.h.toFixed(1)} mm. Le plus grand contour est compensable.</span>`;
      logSys(`DXF « ${file.name} » : ${count} profil(s), ${bounds.w.toFixed(1)}×${bounds.h.toFixed(1)} mm.`, 'ok');
    } catch (err) { logSys('DXF illisible : ' + (err.message || err), 'err'); }
  };
  reader.readAsText(file);
  e.target.value = '';
}

function loadDemo() {
  state.contour = demoContour('bracket');
  state.contours = []; state.toolPaths = []; state.machined = [];
  const b = polyBounds([state.contour]);
  viz.setScene({ contour: state.contour, contours: [], toolPaths: [], rapids: [], machined: [], toolRadius: effRadius(activeTool()) });
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
  openConnDialog();
}

// ---------- connection dialog (ioSender-style) ----------
let _connPorts = [];
function bindConnDialog() {
  $('#connClose').addEventListener('click', closeConnDialog);
  $('#connCancel').addEventListener('click', closeConnDialog);
  $('#connBack').addEventListener('mousedown', (e) => { if (e.target === $('#connBack')) closeConnDialog(); });
  $('#connScan').addEventListener('click', scanPorts);
  $('#connOk').addEventListener('click', doConnect);
  $$('#connTabs button').forEach((b) => b.addEventListener('click', () => {
    $$('#connTabs button').forEach((x) => x.classList.toggle('is-active', x === b));
    $$('.conn-pane').forEach((p) => (p.hidden = p.dataset.pane !== b.dataset.tab));
  }));
}
function openConnDialog() { $('#connBack').hidden = false; scanPorts(); }
function closeConnDialog() { $('#connBack').hidden = true; }

async function scanPorts() {
  const sel = $('#connPort');
  _connPorts = await grbl.listPorts();
  const opts = ['<option value="prompt">— choisir à la connexion (navigateur) —</option>'];
  _connPorts.forEach((p, i) => {
    let label = `Port autorisé ${i + 1}`;
    try { const info = p.getInfo?.(); if (info && info.usbVendorId != null) label += ` · USB ${hex4(info.usbVendorId)}:${hex4(info.usbProductId)}`; } catch (_) {}
    opts.push(`<option value="${i}">${label}</option>`);
  });
  sel.innerHTML = opts.join('');
}
function hex4(n) { return (n ?? 0).toString(16).padStart(4, '0').toUpperCase(); }

async function doConnect() {
  const activeTab = $('#connTabs .is-active')?.dataset.tab;
  if (activeTab === 'network') { logSys('Réseau non disponible via Web Serial — utilise l\'onglet Série.', 'err'); return; }
  const baud = parseInt($('#connBaud').value, 10) || 115200;
  const portSel = $('#connPort').value;
  const onConn = $('#connOnConnect').value;
  const port = portSel !== 'prompt' ? _connPorts[+portSel] : null;
  closeConnDialog();
  try {
    setConn('busy', 'Connexion…');
    await grbl.connect(baud, port);
    logSys(`Port série ouvert (${baud} bauds).`, 'ok');
    if (onConn && onConn !== 'none') setTimeout(() => runOnConnect(onConn), 400);
  } catch (err) {
    setConn('err', 'Échec');
    logSys('Connexion : ' + err.message, 'err');
  }
}
function runOnConnect(action) {
  switch (action) {
    case 'status': grbl.realtime('?'); break;
    case 'unlock': grbl.unlock(); logSys('On connect → déverrouillage ($X).', 'sys'); break;
    case 'home': grbl.home(); logSys('On connect → prise d\'origine ($H).', 'sys'); break;
  }
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
    case 'import-dxf': $('#fileDxf').click(); break;
    case 'open-gcode': $('#fileInput').click(); break;
    case 'save-gcode': download('program.nc', $('#gcode').value); break;
    case 'export-tools': download('tools.json', JSON.stringify(state.tools, null, 2)); break;
    case 'import-tools': $('#fileTools').click(); break;
    case 'clear-gcode': $('#gcode').value = ''; break;
    case 'clear-comp': state.toolPaths = []; state.machined = []; viz.setScene({ toolPaths: [], machined: [] }); break;
    case 'set-rpm': ask('RPM max broche', state.rpmMax, (v) => { state.rpmMax = +v || state.rpmMax; $('#fRpmMax').value = state.rpmMax; computeFeeds(); }); break;
    case 'set-tol': ask('Tolérance de contrôle (mm)', state.tol, (v) => { state.tol = +v || state.tol; }); break;
    case 'set-cutz': ask('Z de coupe (mm)', state.cutZ, (v) => { state.cutZ = parseFloat(v); }); break;
    case 'open-tooltable': toolTable.open(); break;
    case 'add-tool': addTool(); break;
    case 'push-tools': pushTools(); break;
    case 'reset-tools': localStorage.removeItem('grblhal-studio.tools.v1'); state.tools = loadTools(); selectTool(state.tools[0].id); renderToolList(); refreshCompToolSelect(); refreshTableIfOpen(); break;
    case 'ins-G0': insG('G0 X0 Y0'); break;
    case 'ins-G1': insG('G1 X0 Y0 F600'); break;
    case 'ins-G2': insG('G2 X0 Y0 I0 J0 F600'); break;
    case 'ins-G43': insG('G43 H1'); break;
    case 'ins-M3': insG('M3 S12000'); break;
  }
}
function insG(t) { const ta = $('#gcode'); ta.value += (ta.value.endsWith('\n') || !ta.value ? '' : '\n') + t + '\n'; }
$('#fileTools')?.addEventListener?.('change', (e) => {
  const file = e.target.files[0]; if (!file) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const text = String(r.result).replace(/^﻿/, '');
      const isCsv = /\.csv$/i.test(file.name) || (!text.trim().startsWith('[') && !text.trim().startsWith('{'));
      const tools = isCsv ? csvToTools(text) : JSON.parse(text).map(mkTool);
      if (!tools.length) throw new Error('vide');
      state.tools = tools; saveTools(state.tools);
      selectTool(state.tools[0].id); renderToolList(); refreshCompToolSelect(); refreshTableIfOpen();
      logSys(`${tools.length} outils importés (${isCsv ? 'CSV' : 'JSON'}).`, 'ok');
    } catch (err) { logSys('Fichier outils invalide (CSV ou JSON attendu).', 'err'); }
  };
  r.readAsText(file); e.target.value = '';
});

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
