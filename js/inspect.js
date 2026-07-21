// inspect.js — part inspection ("contrôler les pièces").
// Given the nominal profile and the tool-centre path actually programmed (for a
// given effective radius), reconstruct the wall the tool leaves and compare it to
// the nominal geometry. Reports per-side deviation and a pass/fail vs tolerance.

import { offsetClosed, polyBounds } from './geometry.js';

export function inspect(nominal, toolCenterPolys, radius, side = 'outside', tol = 0.05) {
  // Re-offset the tool centre back by the radius to recover the machined boundary.
  const back = side === 'inside' ? radius : -radius;
  let machined = [];
  for (const tc of toolCenterPolys) machined = machined.concat(offsetClosed(tc, back, 'round'));

  const nb = polyBounds([nominal]);
  const mb = polyBounds(machined.length ? machined : [nominal]);

  const devW = (mb.w - nb.w) / 2;   // per-wall deviation in X (mm)
  const devH = (mb.h - nb.h) / 2;   // per-wall deviation in Y (mm)
  const maxDev = Math.max(Math.abs(devW), Math.abs(devH));

  return {
    nominal: nb, machined: mb, machinedPolys: machined,
    devW: round(devW, 4), devH: round(devH, 4), maxDev: round(maxDev, 4),
    tol, pass: maxDev <= tol,
    dims: [
      { axis: 'X', nominal: round(nb.w, 3), actual: round(mb.w, 3), dev: round(mb.w - nb.w, 4) },
      { axis: 'Y', nominal: round(nb.h, 3), actual: round(mb.h, 3), dev: round(mb.h - nb.h, 4) },
    ],
  };
}

// Extract part outer dimensions from a G-code toolpath bounds (the "traitement
// automatique des dimensions du pièce" branch on the whiteboard).
export function dimensionsFromBounds(bounds, toolDia = 0) {
  return {
    x: round(bounds.w - toolDia, 3),
    y: round(bounds.h - toolDia, 3),
    note: toolDia ? 'brut estimé (bornes − Ø outil)' : 'bornes de la trajectoire',
  };
}

function round(v, p) { const f = Math.pow(10, p); return Math.round(v * f) / f; }
