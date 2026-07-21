// materials.js — cutting-speed database (Vc, m/min) indexed by workpiece material
// and tool material. This is the "base de données (tableau)" the whiteboard refers to
// for computing spindle speed N = 1000·Vc / (π·d).
//
// Values are typical starting points for milling and are conservative; the operator
// tunes them per machine rigidity. Sources: standard machining handbooks / tooling
// manufacturer charts (HSS vs carbide ranges).

// Tool materials
export const TOOL_MATERIALS = {
  HSS: { key: 'HSS', label: 'ARS / HSS', desc: 'Acier rapide' },
  CARBIDE: { key: 'CARBIDE', label: 'Carbure', desc: 'P.C. carburé' },
};

// Workpiece materials → Vc (m/min) for {HSS, CARBIDE}, plus a suggested feed-per-tooth
// range fz (mm/tooth) scaled later by tool diameter, and a chip-load hint.
export const MATERIALS = [
  { key: 'alu',      label: 'Aluminium',           vc: { HSS: 120, CARBIDE: 400 }, fz: 0.050, color: '#cfd6dd' },
  { key: 'brass',    label: 'Laiton',              vc: { HSS: 90,  CARBIDE: 250 }, fz: 0.040, color: '#d8b45a' },
  { key: 'copper',   label: 'Cuivre',              vc: { HSS: 70,  CARBIDE: 200 }, fz: 0.040, color: '#c07a3e' },
  { key: 'steel_mild', label: 'Acier doux (S235)', vc: { HSS: 30,  CARBIDE: 120 }, fz: 0.030, color: '#8fa3b3' },
  { key: 'steel_med',  label: 'Acier mi-dur (C45)',vc: { HSS: 25,  CARBIDE: 100 }, fz: 0.028, color: '#7c8ea0' },
  { key: 'steel_hard', label: 'Acier allié',       vc: { HSS: 18,  CARBIDE: 80  }, fz: 0.022, color: '#6d7f92' },
  { key: 'stainless',  label: 'Inox (304/316)',    vc: { HSS: 15,  CARBIDE: 90  }, fz: 0.025, color: '#9aa7b2' },
  { key: 'cast_iron',  label: 'Fonte',             vc: { HSS: 20,  CARBIDE: 110 }, fz: 0.030, color: '#5f6b76' },
  { key: 'titanium',   label: 'Titane',            vc: { HSS: 12,  CARBIDE: 50  }, fz: 0.018, color: '#b8c6d0' },
  { key: 'plastic',    label: 'Plastique (POM/PA)',vc: { HSS: 200, CARBIDE: 500 }, fz: 0.060, color: '#a7d3c8' },
  { key: 'wood',       label: 'Bois / MDF',        vc: { HSS: 300, CARBIDE: 600 }, fz: 0.080, color: '#c9a06a' },
  { key: 'pcb',        label: 'PCB / composite',   vc: { HSS: 60,  CARBIDE: 150 }, fz: 0.020, color: '#3f8f5f' },
];

export function getMaterial(key) {
  return MATERIALS.find((m) => m.key === key) || MATERIALS[0];
}

// Depth-of-cut guidance as a fraction of tool diameter, per strategy.
// ap = axial depth, ae = radial width of cut.
export const STRATEGY = {
  ebauche:     { key: 'ebauche',     label: 'Ébauche',       apFactor: 1.0,  aeFactor: 0.50, vcFactor: 0.85, fzFactor: 1.15, stock: 0.30 },
  semifinition:{ key: 'semifinition',label: 'Semi-finition', apFactor: 0.5,  aeFactor: 0.30, vcFactor: 1.00, fzFactor: 1.00, stock: 0.10 },
  finition:    { key: 'finition',    label: 'Finition',      apFactor: 0.25, aeFactor: 0.10, vcFactor: 1.15, fzFactor: 0.80, stock: 0.00 },
};
