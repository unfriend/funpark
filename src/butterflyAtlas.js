import * as THREE from 'three';

// Butterfly wing patterns, painted once at startup into a single atlas so every
// butterfly can share one InstancedMesh and one material.
//
// Layout: 1024x512 canvas, 4x2 tiles of 256 px, tile i = SPECIES[i] (row 0 on
// top). Each tile holds the RIGHT wing pair seen from above: hinge along the
// tile's left edge, head toward the top. The left wing is the same quad
// mirrored. Outside the wings alpha is 0 (the material uses alphaTest), and a
// 24 px square in each tile's bottom-left corner holds the body colour.

const TILE = 256, COLS = 4, ROWS = 2;
const EDGE = 6; // px left clear on the top/right/bottom edges against mipmap bleed
const HINGE = 2; // px the wing base starts in from the left edge (hidden under the body),
// so the hinge doesn't bleed into the right edge of the tile to its left
const PATCH = 24; // body patch, px

// Art is drawn in millimetres on the reference wing quad: 60 mm out from the
// hinge, 80 mm from tail (y = -42) to head (y = +38), y up. The tile is square,
// so this pre-stretches the art to look right on that 3:4 quad.
const QUAD_W = 0.06, QUAD_L = 0.08, QUAD_TOP = 38;
const SX = TILE / (QUAD_W * 1000), SY = TILE / (QUAD_L * 1000);

// `scale` is a suggested instance scale for the reference quad (~12 cm span);
// small species are a little oversized so they still read in VR.
export const SPECIES = [
  { name: 'monarch', latin: 'Danaus plexippus', scale: 0.85, color: 0xef7d1a, body: 0x1b1512 },
  { name: 'blue morpho', latin: 'Morpho peleides', scale: 1.1, color: 0x2f8ff0, body: 0x2a2018 },
  { name: 'brimstone', latin: 'Gonepteryx rhamni', scale: 0.66, color: 0xe4ee8a, body: 0x4c4b36 },
  { name: 'cabbage white', latin: 'Pieris rapae', scale: 0.58, color: 0xf6f4ea, body: 0x303034 },
  { name: 'peacock', latin: 'Aglais io', scale: 0.64, color: 0xb3262b, body: 0x2a1d18 },
  { name: 'red admiral', latin: 'Vanessa atalanta', scale: 0.66, color: 0xe5492a, body: 0x1c1718 },
  { name: 'swallowtail', latin: 'Papilio machaon', scale: 0.8, color: 0xf3d544, body: 0x19170f },
  { name: 'common blue', latin: 'Polyommatus icarus', scale: 0.44, color: 0x8aa6ff, body: 0x2c3040 },
];

// Convex outline in tile-local uv (counter-clockwise, v up) that contains every
// species' wing art and none of the body patch; triangulate it as a fan from
// vertex 0. Using it instead of the whole unit square saves a third of the
// alpha-tested fragments, hides the body patch (which the full square shows as
// a dark square beside the tail) and never samples the neighbouring tiles.
export const WING_HULL = [
  [0, 0.196], [0.444, 0.023], [0.832, 0.247], [0.977, 0.937], [0.896, 0.977], [0.634, 0.977], [0, 0.726],
];

// --- wing outlines ------------------------------------------------------------
// An outline from cubic Bézier segments [c1, c2, end, opts], clockwise with y up
// (hinge front -> costa -> apex -> outer margin -> back to the hinge), so the
// inward normal of a direction (dx, dy) is (dy, -dx).
// opts.m marks the outer margin (bands, marginal spots), opts.c the costa, and
// opts.sc = [depth, n] cuts n scallops into the silhouette between vein tips.
function wing(start, segs) {
  const outline = [start], margin = [], costa = [];
  let [x0, y0] = start;
  for (const [c1, c2, p, o = {}] of segs) {
    const n = o.sc ? 24 * o.sc[1] : 32;
    for (let i = o.m || o.c ? 0 : 1; i <= n; i++) {
      const t = i / n, s = 1 - t;
      const x = s * s * s * x0 + 3 * s * s * t * c1[0] + 3 * s * t * t * c2[0] + t * t * t * p[0];
      const y = s * s * s * y0 + 3 * s * s * t * c1[1] + 3 * s * t * t * c2[1] + t * t * t * p[1];
      const dx = 3 * s * s * (c1[0] - x0) + 6 * s * t * (c2[0] - c1[0]) + 3 * t * t * (p[0] - c2[0]);
      const dy = 3 * s * s * (c1[1] - y0) + 6 * s * t * (c2[1] - c1[1]) + 3 * t * t * (p[1] - c2[1]);
      const l = Math.hypot(dx, dy) || 1;
      const nx = dy / l, ny = -dx / l;
      if (o.m) margin.push([x, y, nx, ny]);
      if (o.c) costa.push([x, y, nx, ny]);
      if (i === 0) continue;
      const d = o.sc ? o.sc[0] * Math.abs(Math.sin(Math.PI * o.sc[1] * t)) : 0;
      outline.push([x + nx * d, y + ny * d]);
    }
    [x0, y0] = p;
  }
  const path = new Path2D();
  outline.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
  path.closePath();
  return { path, margin: polyline(margin), costa: polyline(costa) };
}

// Arc-length parametrised polyline: at(t) -> [x, y, inward nx, ny], t in [0, 1].
function polyline(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  const len = cum[cum.length - 1];
  const at = (t) => {
    const d = Math.min(Math.max(t, 0), 1) * len;
    let i = 1;
    while (i < pts.length - 1 && cum[i] < d) i++;
    const a = pts[i - 1], b = pts[i], k = (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    return a.map((v, j) => v + (b[j] - v) * k);
  };
  return { pts, len, at };
}

// A simple venation: a discal cell from the wing base, veins fanning from the
// cell to the margin, plus a costal vein (forewing) or anal vein (hindwing).
function addVeins(w, base, [ta, ka, tb, kb], n, t0, t1) {
  const lerp = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  const c1 = lerp(base, w.margin.at(ta), ka), c2 = lerp(base, w.margin.at(tb), kb);
  const p = new Path2D();
  p.moveTo(...base); p.lineTo(...c1); p.lineTo(...c2); p.lineTo(...base);
  // Vein roots run along the cell's far end and partway back along its sides.
  const roots = polyline([lerp(base, c1, 0.45), c1, c2, lerp(base, c2, 0.5)]);
  for (let i = 0; i < n; i++) {
    const k = i / (n - 1);
    const [ox, oy] = roots.at(k), [ex, ey] = w.margin.at(t0 + (t1 - t0) * k);
    // Leave the root heading away from the base, then bend to the tip.
    const rx = ox - base[0], ry = oy - base[1], rl = Math.hypot(rx, ry) || 1;
    const reach = Math.hypot(ex - ox, ey - oy) * 0.4;
    p.moveTo(ox, oy);
    p.quadraticCurveTo(ox + (rx / rl) * reach, oy + (ry / rl) * reach, ex, ey);
  }
  if (w.costa.len) {
    const [ex, ey] = w.costa.at(0.6);
    p.moveTo(...base); p.quadraticCurveTo(ex * 0.45, ey - 2, ex, ey - 0.6);
  } else {
    const [ex, ey] = w.margin.at(1);
    p.moveTo(...base); p.quadraticCurveTo(ex * 0.3 + 3, (base[1] + ey) * 0.55, ex + 1.5, ey + 0.6);
  }
  w.veins = p;
  return w;
}

const fore = (start, segs, base = [1.2, 6]) => addVeins(wing(start, segs), base, [0, 0.46, 1, 0.48], 8, 0.04, 0.97);
const hind = (start, segs, base = [1.2, 2]) => addVeins(wing(start, segs), base, [0.1, 0.42, 0.62, 0.44], 7, 0.12, 0.9);

// Shapes per species (mm). The hindwing's leading edge hides under the forewing.
function createShapes() {
  // A rounded hindwing lobe, shared with small variations.
  const lobe = (out, sc) => hind([0, 6], [
    [[12, 10], [30, 9], [out, 2]],
    [[out + 8, -7], [out + 3, -25], [27, -30], { m: 1, sc }],
    [[17, -33], [9, -30], [5, -26], { m: 1 }],
    [[2, -23], [0, -18], [0, -14]],
  ]);
  return [
    { // monarch: long forewing, rounded apex
      fw: fore([0, 9], [
        [[10, 20], [30, 33], [49, 34.5], { c: 1 }],
        [[54, 34.6], [56.5, 31], [55.5, 27], { m: 1 }],
        [[54, 18], [45, 3], [37, -1], { m: 1 }],
        [[25, -3], [10, 0], [0, 2]],
      ]),
      hw: hind([0, 6], [
        [[10, 10], [28, 9], [39, 3]],
        [[48, -5], [44, -21], [30, -28.5], { m: 1 }],
        [[22, -32], [12, -31], [6, -27], { m: 1 }],
        [[3, -24], [1, -20], [0, -16]],
      ]),
    },
    { // blue morpho: big, broad, slightly hooked apex, softly scalloped
      fw: fore([0, 10], [
        [[12, 22], [32, 35.5], [50, 35.8], { c: 1 }],
        [[55, 36], [58, 33.5], [57.6, 28.5], { m: 1 }],
        [[56, 18], [51, 5], [44, -2], { m: 1, sc: [0.5, 6] }],
        [[30, -4], [12, 0], [0, 2]],
      ]),
      hw: hind([0, 6], [
        [[14, 10], [34, 8], [46, 2]],
        [[56, -8], [51, -25], [36, -31], { m: 1, sc: [0.8, 5] }],
        [[26, -35], [14, -34], [8, -29], { m: 1 }],
        [[4, -26], [1, -20], [0, -15]],
      ]),
    },
    { // brimstone: leaf-like, pointed forewing apex and a hindwing point
      fw: fore([0, 9], [
        [[14, 20], [38, 32], [54, 35], { c: 1 }],
        [[51, 24], [47, 9], [40, -1], { m: 1 }],
        [[28, -4], [10, 0], [0, 2]],
      ]),
      hw: hind([0, 6], [
        [[14, 10], [34, 8], [43, 0]],
        [[46.5, -4], [47, -9], [45, -14], { m: 1 }],
        [[39, -23], [27, -31], [15, -31.5], { m: 1 }],
        [[9, -31.5], [4, -27], [1, -19], { m: 1 }],
      ]),
    },
    { // cabbage white: rounded and plain
      fw: fore([0, 9], [
        [[10, 20], [28, 31], [45, 33], { c: 1 }],
        [[53, 34], [56.5, 28.5], [55, 22], { m: 1 }],
        [[53, 12], [46, 2], [38, -2], { m: 1 }],
        [[25, -4], [10, 0], [0, 2]],
      ]),
      hw: lobe(40),
    },
    { // peacock: angular forewing, scalloped hindwing
      fw: fore([0, 9], [
        [[12, 22], [32, 33], [49, 34.5], { c: 1 }],
        [[54, 34.6], [56.5, 31.5], [55.5, 27], { m: 1 }],
        [[50, 18], [48, 6], [40, -2], { m: 1, sc: [0.6, 5] }],
        [[28, -4], [10, 0], [0, 2]],
      ]),
      hw: lobe(42, [1.3, 5]),
    },
    { // red admiral: concave termen below the apex, scalloped hindwing
      fw: fore([0, 9], [
        [[12, 22], [32, 34], [50, 35], { c: 1 }],
        [[55, 35.2], [57.5, 32], [55.5, 28], { m: 1 }],
        [[49, 22], [50, 8], [40, -2], { m: 1, sc: [0.5, 6] }],
        [[28, -4], [10, 0], [0, 2]],
      ]),
      hw: lobe(41, [1.0, 6]),
    },
    { // swallowtail: long triangular forewing, scalloped hindwing with a tail
      fw: fore([0, 9], [
        [[12, 22], [34, 34], [51, 35], { c: 1 }],
        [[55.5, 35.2], [57.5, 32.5], [56, 29], { m: 1 }],
        [[52, 18], [46, 6], [40, -1], { m: 1, sc: [0.5, 6] }],
        [[28, -4], [10, 0], [0, 2]],
      ]),
      hw: hind([0, 6], [
        [[12, 10], [30, 9], [42, 2]],
        [[49, -4], [47, -15], [37.5, -22.5], { m: 1, sc: [1.3, 3] }],
        [[35, -25], [31.5, -27.5], [30, -31], { m: 1 }],
        [[29, -34], [29.3, -37], [27.3, -38.8], { m: 1 }],
        [[25.5, -40], [23.5, -37.5], [23.8, -33], { m: 1 }],
        [[24, -30.5], [21, -30], [16, -31], { m: 1, sc: [0.8, 2] }],
        [[10, -32], [6, -29], [4, -25], { m: 1 }],
        [[2, -22], [0, -18], [0, -14]],
      ]),
    },
    { // common blue: small rounded wings (drawn tile-sized; `scale` shrinks it)
      fw: fore([0, 9], [
        [[10, 20], [29, 31.5], [46, 33.5], { c: 1 }],
        [[52.5, 34.2], [55.5, 30], [54, 24], { m: 1 }],
        [[52, 13], [46, 2.5], [38, -2], { m: 1 }],
        [[25, -4], [10, 0], [0, 2]],
      ]),
      hw: lobe(39),
    },
  ];
}

// --- paint helpers (all in wing millimetres) ------------------------------------
const fillAll = (ctx, style) => { ctx.fillStyle = style; ctx.fillRect(-5, -50, 70, 95); };

function radial(ctx, x, y, r, stops) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c));
  return g;
}

function dot(ctx, x, y, r, color, ry = r, rot = 0) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(x, y, r, ry, rot, 0, Math.PI * 2);
  ctx.fill();
}

// A band of `width` mm just inside a polyline (the outer margin by default).
function band(ctx, line, width, color, t0 = 0, t1 = 1) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width * 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  const steps = Math.max(2, Math.ceil(line.pts.length * (t1 - t0)));
  for (let i = 0; i <= steps; i++) {
    const [x, y] = line.at(t0 + ((t1 - t0) * i) / steps);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.stroke();
}

// n spots spaced along a polyline, `inset` mm inside it.
function along(line, n, t0, t1, inset, fn) {
  for (let i = 0; i < n; i++) {
    const [x, y, nx, ny] = line.at(t0 + ((t1 - t0) * (i + 0.5)) / n);
    fn(x + nx * inset, y + ny * inset, i, Math.atan2(ny, nx));
  }
}

function veins(ctx, w, width, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.stroke(w.veins);
}

// Concentric rings, outermost first: [[radius, color], ...].
function eyespot(ctx, x, y, rings) {
  for (const [r, c] of rings) dot(ctx, x, y, r, c);
}

// Fill everything beyond a curved boundary (an apical patch, say): the region
// on the far side of the quadratic a -> b -> c, closed through `far` corners.
function patch(ctx, color, a, b, c, ...far) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(...a);
  ctx.quadraticCurveTo(...b, ...c);
  for (const p of far) ctx.lineTo(...p);
  ctx.closePath();
  ctx.fill();
}

// Paint inside one wing's silhouette.
function inWing(ctx, w, fn) {
  ctx.save();
  ctx.clip(w.path);
  fn(w);
  ctx.restore();
}

// Base dusting: butterflies are darker and hairy where the wings meet the body.
const baseShade = (ctx, x, y, r, color) => fillAll(ctx, radial(ctx, x, y, r, [color, color.replace(/[\d.]+\)$/, '0)')]));

// --- species ----------------------------------------------------------------------
const PAINTERS = [
  function monarch(ctx, { fw, hw }) {
    const black = '#1b1512';
    inWing(ctx, hw, (w) => {
      fillAll(ctx, radial(ctx, 2, -6, 44, ['#c8561a', '#ea7a1f', '#f59a32']));
      baseShade(ctx, 0, -4, 12, 'rgba(60,20,8,0.55)');
      veins(ctx, w, 1.1, black);
      band(ctx, w.margin, 4.4, black);
      along(w.margin, 13, 0.1, 1, 1.4, (x, y) => dot(ctx, x, y, 0.55, '#fffaf0'));
      along(w.margin, 11, 0.12, 0.98, 3.1, (x, y) => dot(ctx, x, y, 0.6, '#fffaf0'));
    });
    shadowOver(ctx, hw, fw);
    inWing(ctx, fw, (w) => {
      fillAll(ctx, radial(ctx, 2, 6, 54, ['#cf5c1a', '#ec7d1f', '#f7a139']));
      baseShade(ctx, 0, 5, 10, 'rgba(60,20,8,0.55)');
      veins(ctx, w, 1.0, black);
      band(ctx, w.costa, 1.6, black);
      band(ctx, w.margin, 4.2, black);
      patch(ctx, black, [30, 40], [40, 23], [60, 12], [62, 12], [62, 40]);
      for (const [x, y, r] of [[41.5, 30.6, 1.4], [45.5, 27, 1.5], [49.8, 23.3, 1.5]]) dot(ctx, x, y, r, '#f39a35', r * 0.7, -0.7);
      for (const [x, y, r] of [[36, 33.6, 0.7], [47.5, 32.2, 0.8], [51.5, 29.5, 0.85], [53.8, 25.6, 0.7], [44, 33.4, 0.6], [52.5, 19, 0.6]]) dot(ctx, x, y, r, '#fffaf0');
      along(w.margin, 10, 0.3, 0.97, 1.4, (x, y) => dot(ctx, x, y, 0.55, '#fffaf0'));
      along(w.margin, 8, 0.32, 0.95, 3.0, (x, y) => dot(ctx, x, y, 0.6, '#fffaf0'));
    });
  },

  function blueMorpho(ctx, { fw, hw }) {
    const ink = '#0c1526';
    const blue = (x, y, r) => radial(ctx, x, y, r, ['#8ae4ff', '#3cb0ff', '#1e78ea', '#1550c4', '#123a8e']);
    const sheen = () => {
      const g = ctx.createLinearGradient(6, -20, 40, 30);
      g.addColorStop(0, 'rgba(190,240,255,0)');
      g.addColorStop(0.5, 'rgba(190,240,255,0.28)');
      g.addColorStop(1, 'rgba(190,240,255,0)');
      fillAll(ctx, g);
    };
    inWing(ctx, hw, (w) => {
      fillAll(ctx, blue(12, -6, 40));
      sheen();
      baseShade(ctx, 0, -3, 9, 'rgba(15,25,60,0.7)');
      veins(ctx, w, 0.45, 'rgba(10,30,90,0.35)');
      band(ctx, w.margin, 7, 'rgba(12,21,38,0.45)');
      band(ctx, w.margin, 4.6, ink);
      along(w.margin, 7, 0.22, 0.95, 2.3, (x, y) => dot(ctx, x, y, 0.75, '#e8f4ff'));
    });
    shadowOver(ctx, hw, fw);
    inWing(ctx, fw, (w) => {
      fillAll(ctx, blue(10, 8, 46));
      sheen();
      baseShade(ctx, 0, 5, 9, 'rgba(15,25,60,0.7)');
      veins(ctx, w, 0.45, 'rgba(10,30,90,0.35)');
      band(ctx, w.costa, 3.5, 'rgba(12,21,38,0.5)');
      band(ctx, w.costa, 2.2, ink);
      band(ctx, w.margin, 8, 'rgba(12,21,38,0.45)');
      band(ctx, w.margin, 5.6, ink);
      patch(ctx, ink, [36, 40], [46, 30], [62, 22], [62, 40]);
      for (const [x, y, r] of [[45.5, 31.5, 1.2], [50.5, 30.2, 1], [53.8, 27, 0.9], [52.6, 21, 0.8], [49.5, 13, 0.7]]) dot(ctx, x, y, r, '#eef6ff');
    });
  },

  function brimstone(ctx, { fw, hw }) {
    const lemon = (x, y, r) => radial(ctx, x, y, r, ['#cbdb5c', '#e0ec7c', '#eef5a0']);
    const tips = (w, n) => along(w.margin, n, 0.04, 0.98, 0.45, (x, y) => dot(ctx, x, y, 0.42, '#b0652d'));
    inWing(ctx, hw, (w) => {
      fillAll(ctx, lemon(2, -6, 40));
      baseShade(ctx, 0, -2, 9, 'rgba(110,120,60,0.45)');
      veins(ctx, w, 0.5, 'rgba(150,160,60,0.55)');
      dot(ctx, 22.5, -12, 1.7, '#f08326');
      tips(w, 8);
    });
    shadowOver(ctx, hw, fw);
    inWing(ctx, fw, (w) => {
      fillAll(ctx, lemon(2, 6, 50));
      baseShade(ctx, 0, 5, 8, 'rgba(110,120,60,0.45)');
      veins(ctx, w, 0.5, 'rgba(150,160,60,0.55)');
      band(ctx, w.costa, 0.7, '#b9a84a');
      dot(ctx, 25.5, 15.5, 1.5, '#f08326');
      tips(w, 8);
    });
  },

  function cabbageWhite(ctx, { fw, hw }) {
    const dusk = 'rgba(120,130,125,0.6)';
    const grey = '#3d3e43';
    inWing(ctx, hw, (w) => {
      fillAll(ctx, radial(ctx, 0, -6, 44, ['#ecebe0', '#f7f5ec', '#fbfaf3']));
      baseShade(ctx, 0, -3, 15, dusk);
      veins(ctx, w, 0.4, 'rgba(120,120,110,0.3)');
      dot(ctx, 35, -3.5, 2, grey);
    });
    shadowOver(ctx, hw, fw);
    inWing(ctx, fw, (w) => {
      fillAll(ctx, radial(ctx, 0, 6, 54, ['#ecebe0', '#f7f5ec', '#fbfaf3']));
      baseShade(ctx, 0, 5, 14, dusk);
      veins(ctx, w, 0.4, 'rgba(120,120,110,0.3)');
      band(ctx, w.costa, 0.8, 'rgba(70,72,76,0.6)', 0.1, 1);
      patch(ctx, grey, [37, 40], [46, 27], [60, 18], [62, 18], [62, 40]);
      dot(ctx, 36, 14, 2.4, grey);
      dot(ctx, 29.5, 3.5, 2.1, grey);
    });
  },

  function peacock(ctx, { fw, hw }) {
    const brown = '#3c2b27', dark = '#21171a';
    inWing(ctx, hw, (w) => {
      fillAll(ctx, radial(ctx, 2, -6, 40, ['#5a2722', '#9f2329', '#b8292e']));
      band(ctx, w.margin, 9, '#4b3530');
      band(ctx, w.margin, 2.2, dark);
      baseShade(ctx, 0, -4, 14, 'rgba(50,30,28,0.9)');
      veins(ctx, w, 0.4, 'rgba(40,10,10,0.3)');
      eyespot(ctx, 30, -16, [[10, '#8b7a72'], [8.6, '#18121a'], [6.6, '#4a78c8'], [5, '#2a3360'], [3.3, '#18121a']]);
      for (const [x, y, r] of [[26.5, -13, 0.9], [33.5, -12.5, 0.7], [27, -20, 0.6], [34.2, -19.4, 0.8]]) dot(ctx, x, y, r, '#cfe0ff');
    });
    shadowOver(ctx, hw, fw);
    inWing(ctx, fw, (w) => {
      fillAll(ctx, radial(ctx, 2, 6, 52, ['#6a2420', '#b3262b', '#c8322f']));
      baseShade(ctx, 0, 5, 14, 'rgba(50,30,28,0.9)');
      veins(ctx, w, 0.4, 'rgba(40,10,10,0.3)');
      band(ctx, w.margin, 2.6, brown);
      band(ctx, w.costa, 2.4, dark);
      along(w.costa, 4, 0.35, 0.72, 0.9, (x, y, i, a) => dot(ctx, x, y, 1.4, '#e9d6a4', 0.6, a));
      eyespot(ctx, 45, 25, [[10.5, '#efd99c'], [8.4, '#2c1a20'], [7, '#6c94de'], [5.6, '#b8b3ea'], [4.4, '#2a1620'], [3, '#86222a']]);
      for (const [x, y, r] of [[42, 28, 0.7], [48.5, 21.5, 0.6], [41, 22, 0.5]]) dot(ctx, x, y, r, '#fff8ec');
    });
  },

  function redAdmiral(ctx, { fw, hw }) {
    const ink = '#1d1719', red = '#e8492a';
    inWing(ctx, hw, (w) => {
      fillAll(ctx, radial(ctx, 2, -6, 40, ['#3a2c2a', '#261e1f', '#1d1719']));
      band(ctx, w.margin, 6.2, red, 0.2, 1);
      band(ctx, w.margin, 1.4, ink);
      along(w.margin, 5, 0.3, 0.85, 3.6, (x, y) => dot(ctx, x, y, 0.85, ink));
      dot(ctx, 11.5, -28, 1.6, '#5a86dc', 1.1);
      along(w.margin, 6, 0, 1, 0.25, (x, y) => dot(ctx, x, y, 0.5, '#efe9e0'));
    });
    shadowOver(ctx, hw, fw);
    inWing(ctx, fw, (w) => {
      fillAll(ctx, radial(ctx, 2, 6, 50, ['#3a2c2a', '#231b1d', '#1b1618']));
      ctx.strokeStyle = red;
      ctx.lineWidth = 6.4;
      ctx.beginPath();
      ctx.moveTo(25, 37); ctx.quadraticCurveTo(31, 17, 43, -4);
      ctx.stroke();
      for (const [x, y, r, ry] of [[40, 30.6, 2.3, 1.4], [46.2, 32, 1, 1], [50, 29.6, 1.1, 1.1], [53, 26.4, 1, 1], [50.4, 22.4, 1.2, 1.2], [45.5, 20, 0.8, 0.8]]) dot(ctx, x, y, r, '#f6f2ea', ry, -0.5);
      along(w.margin, 8, 0, 1, 0.25, (x, y) => dot(ctx, x, y, 0.45, '#efe9e0'));
      along(w.margin, 3, 0.7, 1, 1.6, (x, y) => dot(ctx, x, y, 0.55, '#6d8ee0'));
    });
  },

  function swallowtail(ctx, { fw, hw }) {
    const black = '#18160f', yellow = '#f6d847';
    const lemon = (x, y, r) => radial(ctx, x, y, r, ['#efcb35', '#f4d541', '#f8e070']);
    inWing(ctx, hw, (w) => {
      fillAll(ctx, lemon(2, -6, 40));
      baseShade(ctx, 0, -2, 12, 'rgba(24,22,15,0.95)');
      veins(ctx, w, 0.9, black);
      band(ctx, w.margin, 7.6, black);
      along(w.margin, 6, 0.06, 0.82, 4.6, (x, y, i, a) => dot(ctx, x, y, 1.6, '#4f7fd8', 0.9, a));
      along(w.margin, 6, 0.06, 0.82, 1.6, (x, y, i, a) => dot(ctx, x, y, 0.8, yellow, 1.8, a));
      eyespot(ctx, 9.5, -25, [[2.8, black], [2.2, '#e23a2a'], [1, '#5a86dc']]);
    });
    shadowOver(ctx, hw, fw);
    inWing(ctx, fw, (w) => {
      fillAll(ctx, lemon(2, 6, 50));
      baseShade(ctx, 0, 5, 14, 'rgba(24,22,15,0.95)');
      veins(ctx, w, 0.8, black);
      band(ctx, w.costa, 2, black);
      along(w.costa, 3, 0.35, 0.8, 1.2, (x, y, i, a) => dot(ctx, x, y, 2.4, black, 1.6, a));
      band(ctx, w.margin, 7.2, black);
      along(w.margin, 8, 0.05, 0.98, 2.7, (x, y, i, a) => dot(ctx, x, y, 1.1, yellow, 1.25, a));
    });
  },

  function commonBlue(ctx, { fw, hw }) {
    const blue = (x, y, r) => radial(ctx, x, y, r, ['#5664c4', '#7f98f4', '#94aeff', '#8b9df2']);
    const edge = (w) => {
      band(ctx, w.margin, 2.6, '#33356e');
      band(ctx, w.margin, 1.6, '#fbfbff');
    };
    inWing(ctx, hw, (w) => {
      fillAll(ctx, blue(0, -6, 42));
      veins(ctx, w, 0.4, 'rgba(40,40,120,0.35)');
      along(w.margin, 5, 0.3, 0.95, 3.6, (x, y) => dot(ctx, x, y, 0.8, '#33356e'));
      edge(w);
    });
    shadowOver(ctx, hw, fw);
    inWing(ctx, fw, (w) => {
      fillAll(ctx, blue(0, 6, 52));
      veins(ctx, w, 0.4, 'rgba(40,40,120,0.35)');
      band(ctx, w.costa, 0.8, 'rgba(240,244,255,0.8)', 0.2, 1);
      dot(ctx, 28.5, 15.5, 0.7, '#33356e', 1.5, 0.6);
      edge(w);
    });
  },
];

// A soft shadow on the hindwing along the forewing's edge, so overlapping wings
// of the same colour still read as two.
function shadowOver(ctx, hw, fw) {
  inWing(ctx, hw, () => {
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.lineWidth = 2.2;
    ctx.stroke(fw.path);
  });
}

const css = (hex) => '#' + hex.toString(16).padStart(6, '0');

/**
 * Paints all species into one atlas. Tile-local uv (u, v) in [0, 1]^2 (u = 0 at
 * the hinge, v = 1 at the head end) maps to atlas uv = uv * tileScale + tileOffset(i).
 */
export function createButterflyAtlas() {
  const canvas = document.createElement('canvas');
  canvas.width = TILE * COLS;
  canvas.height = TILE * ROWS;
  const ctx = canvas.getContext('2d');
  const shapes = createShapes();

  SPECIES.forEach((sp, i) => {
    const tx = (i % COLS) * TILE, ty = Math.floor(i / COLS) * TILE;
    ctx.save();
    // Hard guard for the layout contract: wing art stays EDGE px off the
    // top/right/bottom edges and clear of the body patch.
    ctx.beginPath();
    ctx.rect(tx + HINGE, ty + EDGE, TILE - EDGE - HINGE, TILE - 2 * EDGE);
    ctx.rect(tx + HINGE, ty + TILE - PATCH - EDGE, PATCH + EDGE - HINGE, PATCH);
    ctx.clip('evenodd');
    ctx.setTransform(SX, 0, 0, -SY, tx, ty + QUAD_TOP * SY);
    PAINTERS[i](ctx, shapes[i]);
    ctx.restore();
    ctx.fillStyle = css(sp.body);
    ctx.fillRect(tx, ty + TILE - PATCH, PATCH, PATCH);
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;

  return {
    texture,
    species: SPECIES,
    tileScale: [1 / COLS, 1 / ROWS],
    tileOffset: (i) => [(i % COLS) / COLS, 1 - (Math.floor(i / COLS) + 1) / ROWS],
  };
}
