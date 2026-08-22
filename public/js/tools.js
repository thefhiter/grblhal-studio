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
  const id = num(o.id, 1);
  return {
    id,
    name: o.name || `Outil ${o.id ?? ''}`.trim(),
    type: o.type || 'endmill_flat',
    material: o.material || 'CARBIDE',
    pocket: num(o.pocket, id),              // Fach/Platz — poche du magasin/tourelle
    dia,                                    // nominal diameter (mm)
    radiusGeom: o.radiusGeom != null ? num(o.radiusGeom) : dia / 2, // R géométrie (nez d'outil)
    radiusWear: num(o.radiusWear, 0),       // R usure (mm, ±)
    xOffset: num(o.xOffset, 0),             // décalage X (tour : en Ø) — décalage géométrie
    lenGeom: num(o.lenGeom, 40),            // L / Z géométrie (mm)
    lenWear: num(o.lenWear, 0),             // L / Z usure (mm, ±)
    tipDir: num(o.tipDir, 0),               // direction de pointe 0..9 (tour) — voir TIP_DIRS
    flutes: num(o.flutes, 2),               // nombre de dents
    fluteLen: num(o.fluteLen, 20),          // longueur coupante
    note: o.note || '',
  };
}

// Lathe imaginary tool-nose orientation (Fanuc/Haas standard, verified against the
// Haas "Set Your Lathe Offsets Manually" tip: OD turning X-Z- = 3, boring bar X+Z- = 2,
// drill on-centre Z- = 7). Center 0/9 = on-centre (drills, mills). Used for G10 L1 Q.
export const TIP_DIRS = {
  0: { label: 'Sur l\'axe',  hint: 'foret / outil centré' },
  1: { label: 'X+ Z+',       hint: 'arrière-droite' },
  2: { label: 'X+ Z−',       hint: 'barre d\'alésage' },
  3: { label: 'X− Z−',       hint: 'outil de tournage ext.' },
  4: { label: 'X− Z+',       hint: 'avant-droite' },
  5: { label: 'X+',          hint: 'sur axe, vers +X' },
  6: { label: 'Z+',          hint: 'sur axe, vers +Z' },
  7: { label: 'Z−',          hint: 'foret (pointe −Z)' },
  8: { label: 'X−',          hint: 'sur axe, vers −X' },
};

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
// PC-side for radius compensation. On a lathe we also emit the X (diameter) offset
// and Q (tip orientation) — the two extra columns the Haas video sets by hand.
//   Mill : G10 L1 P<n> Z<-len> R<rad>
//   Lathe: G10 L1 P<n> X<xoff> Z<-len> R<rad> Q<tip>
export function toolToG10(t) {
  const z = (-effLength(t)).toFixed(3);         // TLO is typically negative on Z
  const r = effRadius(t).toFixed(3);
  let cmd = `G10 L1 P${t.id}`;
  if (t.xOffset) cmd += ` X${(+t.xOffset).toFixed(3)}`;
  cmd += ` Z${z} R${r}`;
  if (t.tipDir) cmd += ` Q${t.tipDir}`;
  return cmd;
}

export function nextToolId(tools) {
  return tools.reduce((m, t) => Math.max(m, t.id), 0) + 1;
}

// ---- tool-declaration G-code generator -------------------------------------
// Emit a self-contained program that DECLARES a tool (specific Ø + length),
// changes it in, applies the tool-length offset (G43 H) and the diameter cutter
// compensation (G41/G42 + D word), then cuts a closed rectangle profile so the
// comp actually engages. Interior vs exterior picks the comp side; the path is
// generated counter-clockwise so the chosen side is geometrically correct:
//   Exterior → G42 (tool stays OUTSIDE the profile)
//   Interior → G41 (tool stays INSIDE the profile)
// (MSG,…) + (TOOLDEF …) comments are echoed by ioSender so the operator sees the
// declared diameter / length / side while the job runs.
export function toolDeclGcode(opts = {}) {
  const id     = Math.max(1, Math.round(num(opts.id, 1)));
  const dia    = round3(num(opts.dia, 6));
  const length = round3(num(opts.length, 0));
  const side   = opts.side === 'interior' ? 'interior' : 'exterior';
  const W      = round3(num(opts.width, 70));
  const H      = round3(num(opts.height, 50));
  const safeZ  = num(opts.safeZ, 5);
  const cutZ   = num(opts.cutZ, -1);
  const feed   = Math.round(num(opts.feed, 600));
  const plunge = Math.round(num(opts.plunge, 200));
  const rpm    = Math.round(num(opts.rpm, 12000));
  const name   = (opts.name || '').trim();

  const r = round3(dia / 2);
  const G = side === 'exterior' ? 'G42' : 'G41';           // chosen convention
  const SIDE = side === 'exterior' ? 'EXTERIOR' : 'INTERIOR';
  const SIDE_FR = side === 'exterior' ? 'exterieur (droite)' : 'interieur (gauche)';
  const lead = round3(r + 4);                               // amorce offset (≥ rayon)

  // rectangle corners, counter-clockwise
  const A = [0, 0], B = [W, 0], C = [W, H], D = [0, H];
  const P = (p) => `X${f3(p[0])} Y${f3(p[1])}`;

  return [
    '%',
    `O${String(1000 + id).padStart(4, '0')} (DECLARATION OUTIL T${id}${name ? ' - ' + up(name) : ''})`,
    `(TOOLDEF T${id} DIA=${f3(dia)} LEN=${f3(length)} SIDE=${SIDE} COMP=${G})`,
    `(MSG, T${id} O${f3(dia)} L${f3(length)} - ${SIDE} comp ${G})`,
    'G21 G90 G17 G94 G40 G49',
    `G10 L1 P${id} Z${f3(-length)} R${f3(r)}   ; declare longueur (Z) + rayon (R) dans la table outils`,
    `T${id} M6                       ; changement d'outil`,
    `G43 H${id}                       ; ACTIVE la longueur d'outil (declaration/changement de longueur)`,
    `S${rpm} M3`,
    `G0 Z${f3(safeZ)}`,
    `G0 X${f3(-lead)} Y${f3(-lead)}          ; point d'amorce (hors matiere)`,
    `G1 Z${f3(cutZ)} F${plunge}`,
    `${G} D${id} F${feed}                 ; ACTIVE comp de diametre ${dia} mm - ${SIDE_FR}`,
    `G1 ${P(A)}                    ; amorce sur le profil (la comp s'etablit ici)`,
    `G1 ${P(B)}`,
    `G1 ${P(C)}`,
    `G1 ${P(D)}`,
    `G1 ${P(A)}                    ; contour ferme (sens trigonometrique / CCW)`,
    `G40                            ; annule la comp de diametre`,
    `G1 X${f3(-lead)} Y${f3(-lead)}          ; degagement`,
    `G0 Z${f3(safeZ)}`,
    `G49                            ; annule la longueur d'outil`,
    'M5',
    'M30',
    '%',
    '',
  ].join('\n');
}

function round3(v) { return Math.round(num(v) * 1000) / 1000; }
function f3(v) { return (Math.round(num(v) * 1000) / 1000).toFixed(3); }
function up(s) { return String(s).toUpperCase().replace(/[()]/g, ''); }

// ---- CSV export / import ("extract the full declared table") ----------------
// ';' delimiter + '.' decimals so it opens cleanly in French Excel.
export const CSV_COLS = [
  ['id', 'T#'], ['pocket', 'Poche'], ['name', 'Désignation'], ['type', 'Type'],
  ['dia', 'Ø nominal'], ['radiusGeom', 'R géométrie'], ['radiusWear', 'R usure'],
  ['xOffset', 'X (Ø)'], ['lenGeom', 'Z/L géométrie'], ['lenWear', 'L usure'],
  ['tipDir', 'Direction pointe'], ['flutes', 'Dents'],
];

export function toolsToCSV(tools) {
  const head = [...CSV_COLS.map((c) => c[1]), 'R effectif', 'L effectif', 'Ø effectif'];
  const rows = tools.map((t) => [
    ...CSV_COLS.map(([k]) => csvCell(t[k])),
    effRadius(t).toFixed(3), effLength(t).toFixed(3), effDia(t).toFixed(3),
  ]);
  return [head, ...rows].map((r) => r.join(';')).join('\r\n');
}

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[;"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function csvToTools(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const delim = lines[0].includes(';') ? ';' : ',';
  const header = splitCsv(lines[0], delim).map((h) => h.trim().toLowerCase());
  const idx = {};
  CSV_COLS.forEach(([key, label]) => {
    const i = header.findIndex((h) => h === label.toLowerCase() || h === key);
    if (i >= 0) idx[key] = i;
  });
  const out = [];
  for (let li = 1; li < lines.length; li++) {
    const cells = splitCsv(lines[li], delim);
    const o = {};
    for (const [key] of CSV_COLS) if (idx[key] != null) o[key] = cells[idx[key]];
    if (o.id == null && o.name == null) continue;
    out.push(mkTool(o));
  }
  return out;
}

function splitCsv(line, delim) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === delim) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
