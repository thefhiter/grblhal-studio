// tools.js — tool table model.
// Each tool carries GEOMETRY values (nominal, measured at setup) and WEAR values
// (small runtime corrections). Effective = geometry + wear. This mirrors the pro
// D/H-register split and is exactly what grblHAL cannot do on its own for radius.

const STORE_KEY = 'grblhal-studio.tools.v1';

// Tool type catalog (from the whiteboard "Type d'outil"). Each has an icon id used
// by the SVG symbol set in index.html and a default flute count.
export const TOOL_TYPES = {
  endmill_flat:  { key: 'endmill_flat',  label: 'Fraise 2 tailles', icon: 'flat',   flutes: 2, ball: false },
  endmill_ball:  { key: 'endmill_ball',  label: 'Fraise boule',     icon: 'ball',   flutes: 2, ball: true  },
  endmill_bull:  { key: 'endmill_bull',  label: 'Fraise torique',   icon: 'bull',   flutes: 3, ball: false },
  drill:         { key: 'drill',         label: 'Foret',            icon: 'drill',  flutes: 2, ball: false },
  chamfer:       { key: 'chamfer',       label: 'Fraise à chanfrein',icon: 'chamfer',flutes: 1, ball: false },
  engrave:       { key: 'engrave',       label: 'Pointe à graver',  icon: 'engrave',flutes: 1, ball: false },
  facemill:      { key: 'facemill',      label: 'Surfaçage',        icon: 'face',   flutes: 4, ball: false },
  tap:           { key: 'tap',           label: 'Taraud',           icon: 'tap',    flutes: 3, ball: false },
};

function defaultTools() {
  return [
    mkTool({ id: 1, name: 'Fraise Ø6 2T',   type: 'endmill_flat', dia: 6,  lenGeom: 48.15, flutes: 2, material: 'CARBIDE' }),
    mkTool({ id: 2, name: 'Fraise Ø3 fin.',  type: 'endmill_flat', dia: 3,  lenGeom: 42.75, flutes: 3, material: 'CARBIDE' }),
    mkTool({ id: 3, name: 'Boule Ø4',        type: 'endmill_ball', dia: 4,  lenGeom: 51.10, flutes: 2, material: 'CARBIDE' }),
    mkTool({ id: 4, name: 'Foret Ø5',        type: 'drill',        dia: 5,  lenGeom: 66.40, flutes: 2, material: 'HSS' }),
  ];
}

export function mkTool(o = {}) {
  const dia = num(o.dia, 6);
  return {
    id: num(o.id, 1),
    name: o.name || `Outil ${o.id ?? ''}`.trim(),
    type: o.type || 'endmill_flat',
    material: o.material || 'CARBIDE',
    dia,                                   // nominal diameter (mm)
    radiusGeom: o.radiusGeom != null ? num(o.radiusGeom) : dia / 2, // R géométrie
    radiusWear: num(o.radiusWear, 0),      // R usure (mm, ±)
    lenGeom: num(o.lenGeom, 40),           // L géométrie (mm)
    lenWear: num(o.lenWear, 0),            // L usure (mm, ±)
    flutes: num(o.flutes, 2),              // nombre de dents
    fluteLen: num(o.fluteLen, 20),         // longueur coupante
    note: o.note || '',
  };
}

// Effective values (what the offset engine and G-code actually use).
export function effRadius(t) { return t.radiusGeom + t.radiusWear; }
export function effDia(t)    { return effRadius(t) * 2; }
export function effLength(t) { return t.lenGeom + t.lenWear; }

function num(v, d = 0) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }

// ---- persistence ----------------------------------------------------------
export function loadTools() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw).map(mkTool);
  } catch (e) { /* ignore corrupt store */ }
  return defaultTools();
}

export function saveTools(tools) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(tools)); } catch (e) {}
}

// Emit the grblHAL command that declares a tool in the controller's tool table.
// grblHAL applies Z (length) natively via G43 H; R (radius) is stored but used
// PC-side for compensation.
export function toolToG10(t) {
  const z = (-effLength(t)).toFixed(3);         // TLO is typically negative on Z
  const r = effRadius(t).toFixed(3);
  return `G10 L1 P${t.id} Z${z} R${r}`;
}

export function nextToolId(tools) {
  return tools.reduce((m, t) => Math.max(m, t.id), 0) + 1;
}
