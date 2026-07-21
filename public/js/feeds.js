// feeds.js — cutting parameters calculator.
//
// Whiteboard formulas:
//   N  = 1000 · Vc / (π · d)      spindle speed [rev/min]
//   Vf = fz · z · N               feed rate     [mm/min]
// where Vc = cutting speed [m/min] (from the material DB), d = effective tool
// diameter [mm], fz = feed per tooth [mm], z = number of teeth.

import { getMaterial, STRATEGY, TOOL_MATERIALS } from './materials.js';
import { effDia } from './tools.js';

// Compute everything from a tool + a material key + a strategy + machine limits.
export function computeCutting({ tool, materialKey, strategy = 'semifinition', rpmMax = 24000, fzOverride = null }) {
  const mat = getMaterial(materialKey);
  const strat = STRATEGY[strategy] || STRATEGY.semifinition;
  const d = Math.max(0.01, effDia(tool));           // effective diameter (geom + wear)
  const z = Math.max(1, tool.flutes || 1);

  // Cutting speed, adjusted per strategy (finition a bit faster, ébauche slower/heavier).
  const vc = mat.vc[tool.material] * strat.vcFactor; // m/min

  // Spindle speed N = 1000·Vc / (π·d)
  let n = (1000 * vc) / (Math.PI * d);               // rev/min
  const nUnclamped = n;
  const clamped = n > rpmMax;
  if (clamped) n = rpmMax;                            // respect "RPM max par broche"

  // Feed per tooth: scale the material base by strategy, allow manual override.
  // Light scaling with diameter keeps small tools from overloading.
  const fzBase = mat.fz * strat.fzFactor * diaScale(d);
  const fz = fzOverride != null && fzOverride > 0 ? fzOverride : fzBase;

  // Feed rate Vf = fz · z · N
  const vf = fz * z * n;                              // mm/min

  // Depth of cut guidance
  const ap = round(strat.apFactor * d, 3);           // axial depth [mm]
  const ae = round(strat.aeFactor * d, 3);           // radial width [mm]

  // Material removal rate (indicative) = ap · ae · Vf  [mm³/min]
  const mrr = round((ap * ae * vf) / 1000, 2);       // cm³/min

  return {
    material: mat, strategy: strat, toolMaterial: TOOL_MATERIALS[tool.material],
    d: round(d, 3), z,
    vc: round(vc, 1),
    n: Math.round(n), nUnclamped: Math.round(nUnclamped), clamped,
    fz: round(fz, 4),
    vf: Math.round(vf),
    ap, ae, mrr,
    stock: strat.stock,
  };
}

// Reverse helper: if the operator fixes N and fz, what feed?
export function feedFromRpm(n, fz, z) { return Math.round(fz * z * n); }

// Small tools want a slightly reduced chip load; large tools can take a bit more.
function diaScale(d) {
  if (d <= 1) return 0.4;
  if (d <= 2) return 0.6;
  if (d <= 3) return 0.8;
  if (d >= 12) return 1.25;
  return 1.0;
}

function round(v, p) { const f = Math.pow(10, p); return Math.round(v * f) / f; }
