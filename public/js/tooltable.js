// tooltable.js — the "Correction d'outil" editable offset grid (gmoccapy / ioSender
// style). A spreadsheet where every number is edited in place: T#, poche, Ø, rayon
// de nez (géométrie + usure), décalage X (Ø, tour), longueur/Z (géométrie + usure),
// direction de pointe, désignation. An "Appliquer" button pushes the whole table to
// grblHAL as G10 L1 lines — exactly the workflow the Haas tip-of-the-day teaches,
// plus the geometry/wear split grblHAL can't compute for radius on its own.
import { TOOL_TYPES, TIP_DIRS, mkTool, effRadius, effDia, effLength, toolToG10, nextToolId } from './tools.js';

// Column set. `lathe` flag marks columns only relevant when turning.
const COLS = [
  { key: 'sel',    label: '',        w: 30,  kind: 'sel' },
  { key: 'id',     label: 'T#',      w: 46,  kind: 'int',  title: 'Numéro d\'outil' },
  { key: 'pocket', label: 'Poche',   w: 52,  kind: 'int',  title: 'Fach / Platz — emplacement magasin' },
  { key: 'name',   label: 'Désignation', w: 150, kind: 'text' },
  { key: 'type',   label: 'Type',    w: 116, kind: 'type' },
  { key: 'dia',    label: 'Ø nom',   w: 70,  kind: 'num',  unit: 'mm', title: 'Diamètre nominal' },
  { key: 'radiusGeom', label: 'R géom', w: 68, kind: 'num', unit: 'mm', title: 'Rayon de nez — géométrie' },
  { key: 'radiusWear', label: 'R usure', w: 66, kind: 'num', unit: '±', wear: true, title: 'Rayon — usure' },
  { key: 'xOffset', label: 'X (Ø)',  w: 70,  kind: 'num', unit: 'mm', lathe: true, title: 'Décalage X en diamètre (tour)' },
  { key: 'lenGeom', label: 'Z / L géom', w: 78, kind: 'num', unit: 'mm', title: 'Longueur (Z) — géométrie' },
  { key: 'lenWear', label: 'L usure', w: 66, kind: 'num', unit: '±', wear: true, title: 'Longueur — usure' },
  { key: 'tipDir', label: 'Pointe',  w: 64,  kind: 'tip', lathe: true, title: 'Direction de pointe (0–9)' },
  { key: 'flutes', label: 'z',       w: 40,  kind: 'int', title: 'Nombre de dents' },
  { key: 'eff',    label: 'Effectif Ø · L', w: 128, kind: 'eff' },
  { key: 'del',    label: '',        w: 34,  kind: 'del' },
];

export class ToolTable {
  // opts: { back, table, deps:{ getTools, setTools, persist, getActiveId, setActiveId,
  //         onApply, getDRO, log }, controls:{...button els} }
  constructor(opts) {
    this.o = opts;
    this.mode = 'mill';                 // 'mill' | 'lathe'
    this.tipPicker = opts.tipPicker;    // { back, grid } elements
    this._bind();
  }

  get tools() { return this.o.deps.getTools(); }

  open() { this.o.back.hidden = false; this.render(); }
  close() { this.o.back.hidden = true; }
  isOpen() { return !this.o.back.hidden; }

  setMode(m) {
    this.mode = m;
    this.o.modeBtns.forEach((b) => b.classList.toggle('is-active', b.dataset.mode === m));
    this.o.back.classList.toggle('is-lathe', m === 'lathe');
    this.render();
  }

  visibleCols() {
    return COLS.filter((c) => this.mode === 'lathe' || !c.lathe);
  }

  render() {
    const t = this.o.table;
    const cols = this.visibleCols();
    const active = this.o.deps.getActiveId();
    // header
    const thead = `<thead><tr>${cols.map((c) =>
      `<th style="width:${c.w}px"${c.title ? ` title="${c.title}"` : ''}>${c.label}${c.unit ? `<i>${c.unit}</i>` : ''}</th>`).join('')}</tr></thead>`;
    // body
    const rows = this.tools.map((tool) => this._row(tool, cols, active)).join('');
    t.innerHTML = thead + `<tbody>${rows}</tbody>`;
    this._updateColgroupHint();
  }

  _row(tool, cols, active) {
    const cells = cols.map((c) => `<td class="c-${c.kind}${c.wear ? ' wear' : ''}">${this._cell(c, tool)}</td>`).join('');
    return `<tr data-id="${tool.id}" class="${tool.id === active ? 'is-active' : ''}">${cells}</tr>`;
  }

  _cell(c, tool) {
    const id = tool.id;
    switch (c.kind) {
      case 'sel':
        return `<label class="tt-radio"><input type="radio" name="tt-active" ${tool.id === this.o.deps.getActiveId() ? 'checked' : ''} data-id="${id}" data-act="select"></label>`;
      case 'int':
        return `<input class="tt-in" type="number" step="1" value="${tool[c.key]}" data-id="${id}" data-field="${c.key}">`;
      case 'num':
        return `<input class="tt-in" type="number" step="0.001" value="${fmt(tool[c.key])}" data-id="${id}" data-field="${c.key}">`;
      case 'text':
        return `<input class="tt-in tt-text" type="text" value="${esc(tool.name)}" data-id="${id}" data-field="name">`;
      case 'type':
        return `<select class="tt-in tt-sel" data-id="${id}" data-field="type">${Object.values(TOOL_TYPES).map((tt) =>
          `<option value="${tt.key}" ${tt.key === tool.type ? 'selected' : ''}>${tt.label}</option>`).join('')}</select>`;
      case 'tip':
        return `<button class="tt-tip" data-id="${id}" data-act="tip" title="${TIP_DIRS[tool.tipDir]?.hint || ''}">${tipGlyph(tool.tipDir)}<b>${tool.tipDir}</b></button>`;
      case 'eff':
        return `<span class="tt-eff" data-eff="${id}">${effStr(tool)}</span>`;
      case 'del':
        return `<button class="tt-del" data-id="${id}" data-act="del" title="Supprimer">✕</button>`;
      default: return '';
    }
  }

  _updateColgroupHint() {
    // show/hide the lathe hint line in the footer
    if (this.o.latheHint) this.o.latheHint.hidden = this.mode !== 'lathe';
  }

  // ---- events -------------------------------------------------------------
  _bind() {
    const { table } = this.o;

    // live edits (event delegation)
    table.addEventListener('input', (e) => {
      const el = e.target;
      const id = +el.dataset.id;
      const field = el.dataset.field;
      if (!field) return;
      const tool = this.tools.find((x) => x.id === id);
      if (!tool) return;
      if (field === 'name' || field === 'type') tool[field] = el.value;
      else if (field === 'id') { /* handled on change to avoid mid-type collisions */ }
      else tool[field] = num(el.value, tool[field]);
      // keep radiusGeom coherent with dia if user edits dia and R was the default half
      this._refreshEff(id);
      this.o.deps.persist();
      this.o.deps.onChanged && this.o.deps.onChanged(id);
    });

    table.addEventListener('change', (e) => {
      const el = e.target;
      if (el.dataset.field === 'id') {
        const oldId = +el.dataset.id;
        const newId = Math.max(1, Math.round(+el.value) || oldId);
        this._renumber(oldId, newId);
      }
      if (el.dataset.field === 'type') { this.o.deps.persist(); this.o.deps.onChanged && this.o.deps.onChanged(+el.dataset.id); }
    });

    // clicks: row-select, tip picker, delete
    table.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]');
      if (act) {
        const id = +act.dataset.id;
        if (act.dataset.act === 'select') this._select(id);
        else if (act.dataset.act === 'del') this._delete(id);
        else if (act.dataset.act === 'tip') this._openTip(id, act);
        return;
      }
      const tr = e.target.closest('tr[data-id]');
      if (tr && !e.target.closest('input,select,button')) this._select(+tr.dataset.id);
    });

    // footer controls
    const C = this.o.controls;
    C.add   && C.add.addEventListener('click', () => this._add());
    C.del   && C.del.addEventListener('click', () => this._delete(this.o.deps.getActiveId()));
    C.reload&& C.reload.addEventListener('click', () => { this.render(); this.o.deps.log('Table rechargée.', 'sys'); });
    C.apply && C.apply.addEventListener('click', () => this.o.deps.onApply(this.tools, this.mode));
    C.grabZ && C.grabZ.addEventListener('click', () => this._touchZ());
    C.grabX && C.grabX.addEventListener('click', () => this._measureDia());
    C.close && C.close.addEventListener('click', () => this.close());
    this.o.back.addEventListener('mousedown', (e) => { if (e.target === this.o.back) this.close(); });

    // mode segmented
    this.o.modeBtns.forEach((b) => b.addEventListener('click', () => this.setMode(b.dataset.mode)));

    // tip picker grid
    if (this.tipPicker) {
      this.tipPicker.back.addEventListener('mousedown', (e) => { if (e.target === this.tipPicker.back) this._closeTip(); });
      this.tipPicker.grid.addEventListener('click', (e) => {
        const cell = e.target.closest('[data-dir]');
        if (!cell) return;
        const dir = +cell.dataset.dir;
        const tool = this.tools.find((x) => x.id === this._tipForId);
        if (tool) { tool.tipDir = dir; this.o.deps.persist(); this.render(); this.o.deps.onChanged && this.o.deps.onChanged(tool.id); }
        this._closeTip();
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { if (this.tipPicker && !this.tipPicker.back.hidden) this._closeTip(); else if (this.isOpen()) this.close(); }
    });
  }

  _refreshEff(id) {
    const tool = this.tools.find((x) => x.id === id); if (!tool) return;
    const span = this.o.table.querySelector(`[data-eff="${id}"]`);
    if (span) span.textContent = effStr(tool);
  }

  _select(id) {
    this.o.deps.setActiveId(id);
    this.o.table.querySelectorAll('tr[data-id]').forEach((tr) => tr.classList.toggle('is-active', +tr.dataset.id === id));
    const radio = this.o.table.querySelector(`input[data-act="select"][data-id="${id}"]`);
    if (radio) radio.checked = true;
    this.o.deps.onChanged && this.o.deps.onChanged(id);
  }

  _renumber(oldId, newId) {
    if (oldId === newId) return;
    const tools = this.tools;
    if (tools.some((t) => t.id === newId)) { this.o.deps.log(`T${newId} existe déjà.`, 'err'); this.render(); return; }
    const tool = tools.find((t) => t.id === oldId); if (!tool) return;
    tool.id = newId;
    if (tool.pocket === oldId) tool.pocket = newId;
    if (this.o.deps.getActiveId() === oldId) this.o.deps.setActiveId(newId);
    this.o.deps.persist();
    this.render();
    this.o.deps.onChanged && this.o.deps.onChanged(newId);
  }

  _add() {
    const tools = this.tools;
    const id = nextToolId(tools);
    const t = mkTool({ id, pocket: id, name: `Outil ${id}`, dia: 6, radiusGeom: 3, lenGeom: 45, flutes: 2 });
    tools.push(t);
    this.o.deps.persist();
    this._select(id);
    this.render();
    this.o.deps.log(`Outil T${id} ajouté.`, 'sys');
  }

  _delete(id) {
    const tools = this.tools;
    if (tools.length <= 1) { this.o.deps.log('Au moins un outil requis.', 'err'); return; }
    const idx = tools.findIndex((t) => t.id === id);
    if (idx < 0) return;
    tools.splice(idx, 1);
    this.o.deps.setTools(tools);
    this.o.deps.persist();
    if (this.o.deps.getActiveId() === id) this.o.deps.setActiveId(tools[0].id);
    this.render();
    this.o.deps.onChanged && this.o.deps.onChanged(this.o.deps.getActiveId());
    this.o.deps.log(`Outil T${id} supprimé.`, 'sys');
  }

  // Touch-off: Z face measure — grab current machine Z as this tool's length offset.
  _touchZ() {
    const dro = this.o.deps.getDRO();
    if (!dro) { this.o.deps.log('Machine non connectée — pas de position à mesurer.', 'err'); return; }
    const tool = this.tools.find((x) => x.id === this.o.deps.getActiveId()); if (!tool) return;
    tool.lenGeom = round3(Math.abs(dro.z));
    this.o.deps.persist(); this.render();
    this.o.deps.log(`T${tool.id} : face Z mesurée → L géométrie ${tool.lenGeom} mm (depuis DRO Z ${fmt(dro.z)}).`, 'ok');
  }

  // Touch-off: X diameter measure — enter the diameter you just measured (Haas popup).
  _measureDia() {
    const tool = this.tools.find((x) => x.id === this.o.deps.getActiveId()); if (!tool) return;
    const v = window.prompt(`T${tool.id} — Mesure Ø X\nEntre le diamètre mesuré (mm) :`, fmt(tool.xOffset || tool.dia));
    if (v == null) return;
    const d = num(v, NaN);
    if (!Number.isFinite(d)) { this.o.deps.log('Diamètre invalide.', 'err'); return; }
    tool.xOffset = round3(d);
    if (this.mode !== 'lathe') this.setMode('lathe');
    this.o.deps.persist(); this.render();
    this.o.deps.log(`T${tool.id} : Ø X réglé à ${tool.xOffset} mm (mesure micromètre).`, 'ok');
  }

  _openTip(id, anchor) {
    if (!this.tipPicker) return;
    this._tipForId = id;
    const tool = this.tools.find((x) => x.id === id);
    // build 3×3 grid: rows X+ / X0 / X-, cols Z+ / Zc / Z- (matches Fanuc/Haas chart)
    const layout = [
      [1, 5, 2],   // X+  : Z+ , +X axis , Z-
      [6, 0, 7],   // X0  : +Z axis, centre, -Z axis
      [4, 8, 3],   // X-  : Z+ , -X axis , Z-
    ];
    this.tipPicker.grid.innerHTML = layout.flat().map((dir) =>
      `<button class="tip-cell ${dir === (tool?.tipDir ?? 0) ? 'on' : ''}" data-dir="${dir}" title="${TIP_DIRS[dir].label} — ${TIP_DIRS[dir].hint}">${tipGlyph(dir)}<span>${dir}</span></button>`).join('');
    this.tipPicker.back.hidden = false;
  }
  _closeTip() { if (this.tipPicker) this.tipPicker.back.hidden = true; }
}

// ---- formatting helpers -----------------------------------------------------
function num(v, d = 0) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }
function round3(v) { return Math.round(v * 1000) / 1000; }
function fmt(v) { const n = +v; return Number.isFinite(n) ? String(round3(n)) : '0'; }
function effStr(t) { return `Ø ${effDia(t).toFixed(3)} · L ${effLength(t).toFixed(2)}`; }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// A tiny arrow glyph for a tip direction (points where the imaginary tool nose is).
function tipGlyph(dir) {
  const map = { 0: '•', 1: '↗', 2: '↘', 3: '↙', 4: '↖', 5: '→', 6: '↑', 7: '↓', 8: '←' };
  return `<i class="tip-g">${map[dir] ?? '•'}</i>`;
}

export { COLS };
