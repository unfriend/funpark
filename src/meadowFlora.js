import * as THREE from 'three';
import { terrainHeight } from './environment.js';

// Wild flowers and grass for the butterfly meadow, built for a mobile VR GPU.
// - Flowers: one draw call for all stems and leaves, one for all heads. Every head
//   type shares one index buffer of small patches; a float texture holds each
//   type's vertex positions, normals and colours, and the vertex shader picks the
//   type per instance (the patches a type doesn't use collapse to nothing).
// - Grass: one draw call, with the wind in the vertex shader.
// Only the grass's time uniform changes per frame.

const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);

// --- helpers -------------------------------------------------------------------
// Seeded, so the meadow (and with it the butterflies' landing sites) is the same every visit.
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const lerp = (a, b, t) => a + (b - a) * t;
const gauss = (rand) => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(TAU * rand());
const smoothstep = (a, b, x) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};
function hash2(x, y) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function noise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// Petals, leaves and blades are single sheets seen from both sides. Shading the
// back with the front's normal (three flips it) reads as sun shining through
// them, and avoids dark undersides.
function shadeBothSides(shader) {
  shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>',
    '#include <normal_fragment_begin>\n\tnormal = normalize( vNormal );');
}

const _color = new THREE.Color();
// Colours are hex (sRGB) or [r, g, b] linear gains, which may exceed 1.
function toLinear(c, out, offset) {
  if (typeof c === 'number') _color.set(c).toArray(out, offset);
  else for (let i = 0; i < 3; i++) out[offset + i] = c[i];
}

// --- flower heads -------------------------------------------------------------
// A head is SLOTS patches of PATCH vertices: a base point, then three rows of
// (left, middle, right). A patch is a petal, a floret, or a sector of a centre.
const SLOTS = 16, PATCH = 10, HEAD_VERTS = SLOTS * PATCH;

function headIndex() {
  const index = [];
  for (let s = 0; s < SLOTS; s++) {
    const b = s * PATCH, v = (row, col) => b + 1 + row * 3 + col;
    index.push(b, v(0, 0), v(0, 1), b, v(0, 1), v(0, 2));
    for (let r = 0; r < 2; r++) {
      index.push(v(r, 0), v(r + 1, 0), v(r + 1, 1), v(r, 0), v(r + 1, 1), v(r, 1));
      index.push(v(r, 1), v(r + 1, 1), v(r + 1, 2), v(r, 1), v(r + 1, 2), v(r, 2));
    }
  }
  return index;
}

function newHead() {
  return {
    pos: new Float32Array(HEAD_VERTS * 3),
    normal: new Float32Array(HEAD_VERTS * 3), // explicit normals; zero = derive from the surface
    color: new Float32Array(HEAD_VERTS * 4), // rgb, a = 1 to multiply by the instance colour
    hint: new Float32Array(SLOTS * 3), // the side each patch's derived normals should face
    slot: 0,
    top: 0, // height of the landing point above the head's origin
  };
}

// Fills the next patch. point(row, col) -> [x, y, z], row 0 being the base point;
// colors: one per row (base, 1, 2, 3); tint: 1 to multiply by the instance colour.
function patch(head, point, colors, tint, hint, normal) {
  const s = head.slot++;
  if (s >= SLOTS) throw new Error('meadowFlora: flower head has too many patches');
  for (let k = 0; k < PATCH; k++) {
    const row = k === 0 ? 0 : 1 + Math.floor((k - 1) / 3), col = k === 0 ? 1 : (k - 1) % 3;
    const v = s * PATCH + k;
    head.pos.set(point(row, col), v * 3);
    if (normal) head.normal.set(normal(row, col), v * 3);
    toLinear(colors[row], head.color, v * 4);
    head.color[v * 4 + 3] = tint;
  }
  head.hint.set(hint, s * 3);
}

// A petal or floret pointing out along azimuth `az`. It leaves the centre at
// `elev` above horizontal and bends by `curl` towards its tip; `cup` lifts its
// edges so it is gently concave. w: widths at the three rows, t: their places
// along the length, tip: extra length of the middle tip vertex (< 0 = notched).
function petal(head, az, { r0 = 0, y0 = 0, len, w, t = [0.3, 0.7, 1], tip = 0, elev = 0, curl = 0, cup = 0, colors, tint = 1 }) {
  const dx = Math.cos(az), dz = Math.sin(az);
  const along = (f) => {
    const th = elev + curl * f;
    if (Math.abs(curl) < 1e-3) return [r0 + len * f * Math.cos(elev), y0 + len * f * Math.sin(elev), th];
    return [r0 + (len / curl) * (Math.sin(th) - Math.sin(elev)), y0 + (len / curl) * (Math.cos(elev) - Math.cos(th)), th];
  };
  const mid = elev + curl * 0.5;
  patch(head, (row, col) => {
    if (row === 0) return [r0 * dx, y0, r0 * dz];
    const width = w[row - 1];
    const [r, y, th] = along(t[row - 1] + (row === 3 && col === 1 ? tip : 0));
    const lift = col === 1 ? 0 : cup * width;
    const rr = r - Math.sin(th) * lift, yy = y + Math.cos(th) * lift;
    const side = (col - 1) * width * 0.5;
    return [rr * dx - side * dz, yy, rr * dz + side * dx];
  }, colors, tint, [-Math.sin(mid) * dx, Math.cos(mid), -Math.sin(mid) * dz]);
}

// A flower's centre: n sectors from the apex down three rings to the rim, with
// smooth normals across the sectors. The apex is where butterflies land.
function dome(head, { r, h, rim, colors, n = 4, rings = [0.4, 0.75, 1] }) {
  const slope = (2 * (h - rim)) / (r * r); // of y = h - (h - rim)(ρ/r)²
  for (let s = 0; s < n; s++) {
    const angle = (col) => ((s + col / 2) / n) * TAU;
    const rho = (row) => (row === 0 ? 0 : rings[row - 1] * r);
    patch(head, (row, col) => {
      const p = rho(row), a = angle(col);
      return [Math.cos(a) * p, h - (h - rim) * (p / r) ** 2, Math.sin(a) * p];
    }, colors, 0, [0, 1, 0], (row, col) => {
      const g = slope * rho(row), a = angle(col), l = Math.hypot(g, 1);
      return [(Math.cos(a) * g) / l, 1 / l, (Math.sin(a) * g) / l];
    });
  }
  head.top = Math.max(head.top, h);
}

// The head variants, in texture-row order. Sizes in metres at head scale 1.
function buildHeads(rand) {
  const jit = (a) => (rand() - 0.5) * a;
  const heads = [];
  const add = (head) => heads.push(head) - 1;

  const daisy = (elev, curl) => {
    const h = newHead();
    dome(h, { r: 0.0105, h: 0.0072, rim: 0.0026, colors: [0xe59a0c, 0xf0b31a, 0xf7c829, 0xedb620] });
    for (let k = 0; k < 12; k++) {
      petal(h, ((k + jit(0.35)) / 12) * TAU, {
        r0: 0.0085, y0: 0.0016, len: 0.027 * (1 + jit(0.16)), w: [0.006, 0.0088, 0.0074], t: [0.22, 0.64, 0.93],
        tip: 0.07, elev: elev + jit(0.25), curl, cup: 0.12, colors: [0xd4dea6, 0xffffff, 0xffffff, 0xfafafa],
      });
    }
    return add(h);
  };

  const buttercup = () => {
    const h = newHead();
    dome(h, { r: 0.0058, h: 0.0062, rim: 0.0032, colors: [0xa8b02a, 0xc4bf2e, 0xe8c21e, 0xf0b814] });
    for (let k = 0; k < 5; k++) {
      petal(h, ((k + jit(0.2)) / 5) * TAU, {
        r0: 0.0025, y0: 0.0012, len: 0.021, w: [0.011, 0.0195, 0.0165], t: [0.28, 0.68, 0.94], tip: 0.06,
        elev: 0.62 + jit(0.15), curl: -0.3, cup: 0.22, colors: [[0.85, 0.66, 0.22], [0.97, 0.92, 0.8], 0xffffff, 0xffffff],
      });
    }
    return add(h);
  };

  const poppy = (elev, curl) => {
    const h = newHead();
    dome(h, { r: 0.0064, h: 0.0135, rim: 0.0036, rings: [0.45, 0.82, 1], colors: [0x3a2c4c, 0x4c3e64, 0x93a265, 0x6f8448] });
    for (let k = 0; k < 6; k++) {
      // A ring of dark stamens around the seed pod.
      petal(h, ((k + 0.5) / 6) * TAU, {
        r0: 0.0042, y0: 0.0028, len: 0.0085, w: [0.0045, 0.0075, 0.0068], t: [0.3, 0.7, 1], tip: -0.1,
        elev: 1.15, curl: -1.1, cup: 0.05, colors: [0x14100f, 0x1c1518, 0x231a20, 0x3b3224], tint: 0,
      });
    }
    for (let k = 0; k < 4; k++) {
      const inner = k % 2 === 1; // two inner petals sit higher and more upright
      petal(h, (k / 4) * TAU + jit(0.2), {
        r0: 0.0042, y0: inner ? 0.0016 : 0.0006, len: (inner ? 0.041 : 0.047) * (1 + jit(0.08)),
        w: inner ? [0.026, 0.056, 0.046] : [0.03, 0.064, 0.052], t: [0.2, 0.6, 0.92], tip: 0.07,
        elev: elev + (inner ? 0.22 : 0) + jit(0.12), curl, cup: 0.17,
        colors: [[0.03, 0.025, 0.03], [0.8, 0.8, 0.8], [1, 1, 1], [1.04, 1.04, 1.04]],
      });
    }
    return add(h);
  };

  const cornflower = () => {
    const h = newHead();
    dome(h, { r: 0.0066, h: 0.0098, rim: 0.0046, colors: [0x5a2a7e, 0x4d2c80, 0x40308a, 0x37408e] });
    for (let k = 0; k < 11; k++) {
      // Funnel-shaped florets flaring to a toothed tip.
      petal(h, ((k + jit(0.4)) / 11) * TAU, {
        r0: 0.0045, y0: 0.0042, len: 0.022 * (1 + jit(0.14)), w: [0.0034, 0.0092, 0.0145], t: [0.4, 0.78, 1], tip: -0.14,
        elev: 0.48 + jit(0.3), curl: -0.35, cup: 0.3, colors: [[0.25, 0.22, 0.5], [0.62, 0.6, 0.86], [1, 1, 1], [1.08, 1.08, 1.08]],
      });
    }
    return add(h);
  };

  const cosmos = (elev, curl, cup) => {
    const h = newHead();
    dome(h, { r: 0.0078, h: 0.0062, rim: 0.0026, colors: [0xd08c12, 0xe3a820, 0xf0c02e, 0xc58a16] });
    for (let k = 0; k < 8; k++) {
      petal(h, ((k + jit(0.2)) / 8) * TAU, {
        r0: 0.0062, y0: 0.0016, len: 0.036 * (1 + jit(0.1)), w: [0.011, 0.021, 0.0205], t: [0.22, 0.68, 1], tip: -0.08,
        elev: elev + jit(0.2), curl, cup, colors: [[0.42, 0.36, 0.42], [0.86, 0.84, 0.86], [1, 1, 1], [1.05, 1.05, 1.05]],
      });
    }
    return add(h);
  };

  // A lupin-like spike: a pointed axis wrapped in whorls of hooded florets that
  // shrink and pale towards the top. Butterflies land on the tip.
  const spike = () => {
    const h = newHead(), L = 0.12;
    patch(h, (row, col) => {
      if (row === 0) return [0, 0, 0];
      const f = [0.45, 0.88, 1][row - 1], a = (col / 3) * TAU, r = 0.0045 * (1 - f * 0.9);
      return [Math.cos(a) * r, L * f, Math.sin(a) * r];
    }, [[0.5, 0.5, 0.5], [0.8, 0.8, 0.8], [1.15, 1.12, 1.1], [1.3, 1.25, 1.2]], 1, [0, 1, 0],
    (row, col) => [Math.cos((col / 3) * TAU) * 0.8, 0.6, Math.sin((col / 3) * TAU) * 0.8]);
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 3; j++) {
        const f = i / 4, k = lerp(1, 0.55, f);
        petal(h, ((j + i * 0.5 + jit(0.3)) / 3) * TAU, {
          r0: 0.0035 * (1 - f * 0.5), y0: L * (0.04 + 0.74 * f), len: 0.028 * k, w: [0.011 * k, 0.02 * k, 0.016 * k],
          t: [0.3, 0.7, 0.95], tip: 0.08, elev: lerp(0.0, 0.65, f), curl: 1.0, cup: 0.3,
          colors: [[0.55, 0.5, 0.6], [0.9, 0.9, 0.95], [1.05 + f * 0.25, 1.05 + f * 0.2, 1.05 + f * 0.15], [1.15 + f * 0.3, 1.15 + f * 0.25, 1.15 + f * 0.2]],
        });
      }
    }
    h.top = L;
    return add(h);
  };

  // share: fraction of the meadow; height: stem length (m); scale: head size;
  // colors: instance tints for the petals; stem: a tint for the stem and leaves.
  const types = [
    { share: 0.24, height: [0.26, 0.46], scale: [0.92, 1.15], heads: [daisy(0.1, -0.6), daisy(0.32, -0.32)],
      colors: [0xffffff, 0xfffcf2, 0xf9f7ff], stem: 0xffffff },
    { share: 0.16, height: [0.27, 0.42], scale: [0.95, 1.2], heads: [buttercup()],
      colors: [0xffd21c, 0xffc414, 0xffdb2e], stem: 0xf2ffe6 },
    { share: 0.18, height: [0.42, 0.68], scale: [0.88, 1.14], heads: [poppy(0.62, -0.75), poppy(0.95, -0.5)],
      colors: [0xe8251a, 0xf23a1c, 0xd81e20, 0xf0521c], stem: 0xd8ecc8 },
    { share: 0.14, height: [0.38, 0.62], scale: [1.0, 1.22], heads: [cornflower()],
      colors: [0x3b6ff0, 0x4a86f6, 0x5866e0, 0x2f5fe0], stem: 0xc8dcc8 },
    { share: 0.19, height: [0.48, 0.72], scale: [0.88, 1.12], heads: [cosmos(0.08, -0.25, 0.1), cosmos(0.3, -0.35, 0.16)],
      colors: [0xf27ab4, 0xe2489a, 0xf6b9d6, 0xfbf0f6, 0xbb68d8, 0xd9508f], stem: 0xffffff },
    { share: 0.09, height: [0.42, 0.62], scale: [0.9, 1.1], heads: [spike()],
      colors: [0x8e5fe0, 0x7650d8, 0xa070e8, 0x6c5ae8, 0xc070d8], stem: 0xd0e0c8 },
  ];
  return { heads, types };
}

// Bakes every variant's positions, normals and colours into rows of a float
// texture, three rows per variant, one texel per head vertex.
function bakeHeads(heads, index) {
  const data = new Float32Array(HEAD_VERTS * heads.length * 3 * 4);
  const geometry = new THREE.BufferGeometry().setIndex(index);
  heads.forEach((head, i) => {
    geometry.setAttribute('position', new THREE.BufferAttribute(head.pos, 3));
    geometry.computeVertexNormals();
    const derived = geometry.attributes.normal.array;
    for (let v = 0; v < HEAD_VERTS; v++) {
      const v3 = v * 3, h3 = Math.floor(v / PATCH) * 3;
      let nx = head.normal[v3], ny = head.normal[v3 + 1], nz = head.normal[v3 + 2];
      if (nx === 0 && ny === 0 && nz === 0) {
        nx = derived[v3]; ny = derived[v3 + 1]; nz = derived[v3 + 2];
        if (nx * head.hint[h3] + ny * head.hint[h3 + 1] + nz * head.hint[h3 + 2] < 0) { nx = -nx; ny = -ny; nz = -nz; }
      }
      const row = (r) => ((i * 3 + r) * HEAD_VERTS + v) * 4;
      data.set([head.pos[v3], head.pos[v3 + 1], head.pos[v3 + 2], 1], row(0));
      data.set([nx, ny, nz, 0], row(1));
      data.set(head.color.subarray(v * 4, v * 4 + 4), row(2));
    }
  });
  geometry.dispose();
  const texture = new THREE.DataTexture(data, HEAD_VERTS, heads.length * 3, THREE.RGBAFormat, THREE.FloatType);
  texture.needsUpdate = true;
  return texture;
}

function headMaterial(texture) {
  const material = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uHeads = { value: texture };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */ `#include <common>
        attribute float aHead; // head variant: which row triple of uHeads to read
        uniform highp sampler2D uHeads;`)
      .replace('#include <color_vertex>', /* glsl */ `
        ivec2 headTexel = ivec2(gl_VertexID, int(aHead) * 3);
        vec3 headPosition = texelFetch(uHeads, headTexel, 0).xyz;
        vec3 headNormal = texelFetch(uHeads, headTexel + ivec2(0, 1), 0).xyz;
        vec4 headColor = texelFetch(uHeads, headTexel + ivec2(0, 2), 0);
        vColor = mix(headColor.rgb, headColor.rgb * instanceColor, headColor.a);`)
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = headNormal;')
      .replace('#include <begin_vertex>', 'vec3 transformed = headPosition;');
    shadeBothSides(shader);
  };
  material.customProgramCacheKey = () => 'meadow-flower-head';
  return material;
}

// --- stems ----------------------------------------------------------------------
// A unit-height stem (instances scale y to their length) that curves BEND metres
// sideways, so a stem leaning one way bends back up towards the light. Leaves are
// authored for a typical 0.45 m stem and stretch a little with it.
const BEND = 0.03;

function stemGeometry() {
  const pos = [], color = [], index = [];
  const vertex = (p, c) => {
    pos.push(p[0], p[1], p[2]);
    toLinear(c, color, color.length);
    return pos.length / 3 - 1;
  };
  const shade = (a, b, t) => _color.set(a).lerp(new THREE.Color(b), t).toArray([]);

  const SIDES = 3, RINGS = 5;
  for (let r = 0; r < RINGS; r++) {
    const y = r / (RINGS - 1), radius = lerp(0.0024, 0.0016, y);
    for (let s = 0; s < SIDES; s++) {
      const a = (s / SIDES) * TAU;
      vertex([BEND * y * y + Math.cos(a) * radius, y, Math.sin(a) * radius], shade(0x426f24, 0x7cab44, y));
    }
  }
  for (let r = 0; r < RINGS - 1; r++) {
    for (let s = 0; s < SIDES; s++) {
      const a = r * SIDES + s, b = r * SIDES + ((s + 1) % SIDES);
      index.push(a, a + SIDES, b, b, a + SIDES, b + SIDES);
    }
  }

  const leaf = (y, az, len, width) => {
    const dx = Math.cos(az), dz = Math.sin(az), toUnits = 1 / 0.45;
    const at = (f, side, lift) => {
      const r = 0.002 + len * f, rise = len * (0.75 * f - 0.62 * f * f) + lift;
      return [BEND * y * y + r * dx - side * dz, y + rise * toUnits, r * dz + side * dx];
    };
    const base = vertex(at(0, 0, 0), 0x4a7a28);
    const rows = [[0.3, width, 0x5e9a32], [0.66, width * 0.72, 0x70aa3c]].map(([f, w, c]) =>
      [-1, 0, 1].map((s) => vertex(at(f, s * w * 0.5, s === 0 ? 0 : w * 0.18), c)));
    const tip = vertex(at(1, 0, 0), 0x8abc4c);
    const [[l1, c1, r1], [l2, c2, r2]] = rows;
    index.push(base, c1, l1, base, r1, c1, l1, c2, l2, l1, c1, c2, c1, r2, c2, c1, r1, r2, l2, c2, tip, c2, r2, tip);
  };
  leaf(0.03, 0.4, 0.09, 0.014);
  leaf(0.2, 2.3, 0.07, 0.012);
  leaf(0.42, -1.3, 0.052, 0.01);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(color, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  // Tip the stem's normals up a little: a few-mm stem should catch the sky, not
  // read as a black wire from its shady side.
  const n = geometry.attributes.normal, v = new THREE.Vector3();
  for (let i = 0; i < SIDES * RINGS; i++) {
    v.fromBufferAttribute(n, i);
    v.y += 0.5;
    v.normalize();
    n.setXYZ(i, v.x, v.y, v.z);
  }
  return geometry;
}

// --- flower layout ----------------------------------------------------------------
function pickType(rand, types) {
  let x = rand() * types.reduce((s, t) => s + t.share, 0);
  for (let i = 0; i < types.length; i++) if ((x -= types[i].share) <= 0) return i;
  return types.length - 1;
}

// [x, z, type] per flower: first a ring of little bunches 0.7–2.2 m out (all
// that's shown in AR), then drifts and strays out to ~12 m.
function layoutFlowers(rand, types, count, nearCount) {
  const spots = [];
  const free = (x, z, gap) => spots.every((s) => (s[0] - x) ** 2 + (s[1] - z) ** 2 > gap * gap);
  const place = (sample, rMin, rMax, gap) => {
    for (let tries = 0; ; tries++) {
      const [x, z, type] = sample();
      const r = Math.hypot(x, z);
      if ((r >= rMin && r <= rMax && free(x, z, gap)) || tries > 60) {
        // Give up gracefully on a crowded spot: pull it into range, overlap allowed.
        const k = r > 0 ? THREE.MathUtils.clamp(r, rMin, rMax) / r : 0;
        spots.push(r > 0 ? [x * k, z * k, type] : [rMin, 0, type]);
        return;
      }
    }
  };

  // Near ring: nine bunches, every type in at least one, mostly a single type each.
  const bunches = [];
  const order = types.map((_, i) => i).sort(() => rand() - 0.5);
  const turn = rand() * TAU;
  for (let k = 0; k < 9; k++) {
    const a = turn + ((k + (rand() - 0.5) * 0.5) / 9) * TAU, r = lerp(1.0, 1.75, rand());
    bunches.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, type: k < order.length ? order[k] : pickType(rand, types) });
  }
  for (let i = 0; i < nearCount; i++) {
    const b = bunches[i % bunches.length];
    place(() => [b.x + gauss(rand) * 0.14, b.z + gauss(rand) * 0.14, rand() < 0.8 ? b.type : pickType(rand, types)], 0.74, 2.16, 0.075);
  }

  // Drifts: elongated patches, mostly of one type, plus a few strays anywhere.
  const drifts = [];
  for (let k = 0; k < 42; k++) {
    const a = rand() * TAU, r = lerp(1.4, 11.5, Math.sqrt(rand()));
    const rx = lerp(0.35, 1.5, rand()), ry = rx * lerp(0.35, 0.9, rand()), rot = rand() * Math.PI;
    drifts.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, rx, ry, c: Math.cos(rot), s: Math.sin(rot), type: pickType(rand, types), w: rx * ry });
  }
  const total = drifts.reduce((s, d) => s + d.w, 0);
  for (let i = nearCount; i < count; i++) {
    place(() => {
      if (rand() < 0.12) {
        const a = rand() * TAU, r = Math.sqrt(lerp(0.36, 144, rand()));
        return [Math.cos(a) * r, Math.sin(a) * r, pickType(rand, types)];
      }
      let x = rand() * total, d = drifts[0];
      for (d of drifts) if ((x -= d.w) <= 0) break;
      const u = gauss(rand) * d.rx * 0.5, v = gauss(rand) * d.ry * 0.5;
      return [d.x + u * d.c - v * d.s, d.z + u * d.s + v * d.c, rand() < 0.82 ? d.type : pickType(rand, types)];
    }, 0.66, 12.3, 0.08);
  }
  return spots;
}

/**
 * Meadow flowers: daisies, buttercups, poppies, cornflowers, cosmos and lupin-like
 * spikes. Static, in two instanced draw calls (stems with leaves, heads).
 * Flowers 0..nearCount-1 form a ring 0.7–2.2 m around the origin; the rest grow in
 * drifts out to ~12 m, never within 0.6 m of the origin.
 * @returns {{ group: THREE.Group, sites: { position: THREE.Vector3, normal: THREE.Vector3 }[], setActiveCount(n: number): void }}
 *   sites[i]: where a butterfly lands on flower i (the top of its head, in the group's
 *   space) and the head's up normal.
 */
export function createFlowers({ count = 520, nearCount = 60, heightAt = terrainHeight } = {}) {
  count = Math.max(0, Math.floor(count));
  nearCount = Math.min(Math.max(0, Math.floor(nearCount)), count);
  const rand = mulberry32(0x6d65616f);
  const { heads, types } = buildHeads(rand);
  const index = headIndex();
  const texture = bakeHeads(heads, index);

  const headGeometry = new THREE.BufferGeometry();
  // The real positions come from the texture; these are only for the vertex
  // count and bounds. The bounding sphere covers every variant.
  headGeometry.setAttribute('position', new THREE.BufferAttribute(heads[0].pos, 3));
  headGeometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(HEAD_VERTS * 3), 3));
  headGeometry.setIndex(index);
  let reach = 0;
  for (const h of heads) for (let i = 0; i < h.pos.length; i += 3) reach = Math.max(reach, Math.hypot(h.pos[i], h.pos[i + 1], h.pos[i + 2]));
  headGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), reach * 1.2);
  const variant = new Float32Array(count);
  headGeometry.setAttribute('aHead', new THREE.InstancedBufferAttribute(variant, 1));

  const stemMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  stemMaterial.onBeforeCompile = shadeBothSides;
  stemMaterial.customProgramCacheKey = () => 'meadow-stem';
  const stems = new THREE.InstancedMesh(stemGeometry(), stemMaterial, count);
  const headMesh = new THREE.InstancedMesh(headGeometry, headMaterial(texture), count);
  // The head shader reads instanceColor, so it must exist even with no flowers.
  headMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
  stems.name = 'flower-stems';
  headMesh.name = 'flower-heads';

  const spots = layoutFlowers(rand, types, count, nearCount);
  const sites = [];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), spin = new THREE.Quaternion(), euler = new THREE.Euler();
  const p = new THREE.Vector3(), s = new THREE.Vector3(), top = new THREE.Vector3(), up = new THREE.Vector3();
  const color = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const [x, z, t] = spots[i], type = types[t];
    const length = lerp(type.height[0], type.height[1], rand());
    // Lean the stem at its root; its built-in bend brings the top back nearer
    // upright. Re-roll (leaning less) if that puts the head outside its band.
    const [near, far] = i < nearCount ? [0.7, 2.2] : [0.6, Infinity];
    p.set(x, heightAt(x, z) - 0.01, z);
    for (let tries = 0; tries < 10; tries++) {
      q.setFromEuler(euler.set(0, rand() * TAU, (0.04 + rand() * 0.16) * (1 - tries / 10), 'YXZ'));
      top.set(BEND, 1, 0).applyMatrix4(m.compose(p, q, s.set(1, length, 1)));
      const r = Math.hypot(top.x, top.z);
      if (r >= near && r <= far) break;
    }
    stems.setMatrixAt(i, m);
    stems.setColorAt(i, color.set(type.stem).multiplyScalar(0.9 + rand() * 0.2));

    up.set(2 * BEND, length, 0).applyQuaternion(q).normalize();
    up.x += (rand() - 0.5) * 0.24;
    up.z += (rand() - 0.5) * 0.24;
    up.normalize();
    const k = lerp(type.scale[0], type.scale[1], rand());
    const v = type.heads[Math.floor(rand() * type.heads.length)];
    q.setFromUnitVectors(UP, up).multiply(spin.setFromAxisAngle(UP, rand() * TAU));
    headMesh.setMatrixAt(i, m.compose(top, q, s.set(k, k, k)));
    headMesh.setColorAt(i, color.set(type.colors[Math.floor(rand() * type.colors.length)]).multiplyScalar(0.94 + rand() * 0.08));
    variant[i] = v;
    sites.push({ position: top.clone().addScaledVector(up, heads[v].top * k), normal: up.clone() });
  }
  // Bounds over every flower, computed once now so a later setActiveCount can't shrink them.
  stems.computeBoundingSphere();
  headMesh.computeBoundingSphere();

  const group = new THREE.Group();
  group.name = 'flowers';
  group.add(stems, headMesh);
  return {
    group,
    sites,
    setActiveCount(n) {
      stems.count = headMesh.count = Math.min(Math.max(0, Math.floor(n) || 0), count);
    },
  };
}

// --- grass --------------------------------------------------------------------------
// One clump, authored at GRASS_H and scaled per instance: a few long arching
// blades (three segments) over a skirt of shorter, broader ones (two segments).
const GRASS_H = 0.3;
const LONG = { rows: [0, 0.4, 0.75, 1], widths: [1, 0.85, 0.55, 0] };
const SHORT = { rows: [0, 0.55, 1], widths: [1, 0.7, 0] };

function clumpGeometry(rand) {
  const pos = [], normal = [], color = [], index = [];
  const root = new THREE.Color(0x2f5a1c), mid = new THREE.Color(0x5a9a36), tip = new THREE.Color(0xb4d46a);
  const straw = new THREE.Color(0xd8d68a), c = new THREE.Color();
  const tangent = new THREE.Vector3(), side = new THREE.Vector3(), n = new THREE.Vector3();
  const BLADES = 9;
  for (let b = 0; b < BLADES; b++) {
    const long = b % 3 === 0, kind = long ? LONG : SHORT;
    // Roots scattered over a small patch, each blade leaning roughly away from the
    // middle, so clumps knit together instead of reading as separate stars.
    const ra = ((b + rand() * 0.8) / BLADES) * TAU, off = 0.07 * Math.sqrt(rand());
    const ox = Math.cos(ra) * off, oz = Math.sin(ra) * off;
    const az = ra + (rand() - 0.5) * 1.8, dx = Math.cos(az), dz = Math.sin(az);
    const height = GRASS_H * (long ? 0.8 + rand() * 0.2 : 0.35 + rand() * 0.3);
    const width = long ? 0.009 + rand() * 0.005 : 0.014 + rand() * 0.01;
    // Angle from vertical at the root, plus more towards the tip.
    const lean = long ? 0.08 + rand() * 0.25 : 0.45 + rand() * 0.6, bend = long ? 0.5 + rand() * 0.8 : 0.3 + rand() * 0.5;
    const twist = (rand() - 0.5) * 1.2, dry = rand() * rand() * 0.7, shade = 0.85 + rand() * 0.3;
    const first = pos.length / 3;
    kind.rows.forEach((t, i) => {
      const th = lean + bend * t;
      const r = (height / bend) * (Math.cos(lean) - Math.cos(th));
      const y = (height / bend) * (Math.sin(th) - Math.sin(lean));
      const sa = az + Math.PI / 2 + twist * t;
      side.set(Math.cos(sa), 0, Math.sin(sa));
      tangent.set(Math.sin(th) * dx, Math.cos(th), Math.sin(th) * dz);
      n.crossVectors(side, tangent).normalize();
      if (n.y < 0) n.negate();
      n.lerp(UP, 0.35).normalize(); // soften: a clump reads as a mass, not as facets
      if (t < 0.45) c.copy(root).lerp(mid, t / 0.45);
      else c.copy(mid).lerp(tip, (t - 0.45) / 0.55).lerp(straw, dry * (t - 0.45) * 1.8);
      c.multiplyScalar(shade);
      const half = width * 0.5 * kind.widths[i];
      for (const k of t === 1 ? [0] : [-1, 1]) {
        pos.push(ox + r * dx + side.x * half * k, y, oz + r * dz + side.z * half * k);
        normal.push(n.x, n.y, n.z);
        color.push(c.r, c.g, c.b);
      }
    });
    const quads = kind.rows.length - 2;
    for (let q = 0; q < quads; q++) {
      const l = first + q * 2;
      index.push(l, l + 1, l + 2, l + 1, l + 3, l + 2);
    }
    const l = first + quads * 2;
    index.push(l, l + 1, l + 2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(color, 3));
  geometry.setIndex(index);
  return geometry;
}

/**
 * Meadow grass: instanced clumps of arching blades, densest near the origin (none
 * within 0.35 m), swaying in a wind that ripples across the field. One draw call.
 * @returns {{ mesh: THREE.InstancedMesh, update(time: number): void }} time in seconds.
 */
export function createGrass({ count = 2600, radius = 14, heightAt = terrainHeight } = {}) {
  count = Math.max(0, Math.floor(count));
  const rand = mulberry32(0x67726173);
  const uniforms = { uTime: { value: 0 }, uWind: { value: new THREE.Vector2(0.8, -0.6) } };
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */ `#include <common>
        uniform float uTime;
        uniform vec2 uWind; // unit wind direction across the meadow (xz)`)
      .replace('#include <project_vertex>', /* glsl */ `
        vec4 mvPosition = instanceMatrix * vec4(transformed, 1.0);
        // Sway grows with the square of height, so roots stay put. Gusts roll
        // downwind, so the field ripples instead of nodding in unison.
        vec2 at = instanceMatrix[3].xz;
        float give = transformed.y * ${(1 / GRASS_H).toFixed(4)};
        give *= give * length(instanceMatrix[1].xyz);
        float wave = dot(at, uWind) * 0.55 - uTime * 1.6;
        float gust = 0.45 + 0.35 * sin(wave) + 0.15 * sin(wave * 2.3 + at.y * 1.7);
        float flutter = 0.2 * sin(uTime * 4.3 + at.x * 6.3 + at.y * 4.7);
        vec2 sway = (uWind * gust + vec2(-uWind.y, uWind.x) * flutter) * (0.055 * give);
        mvPosition.xz += sway;
        mvPosition.y -= dot(sway, sway) * 2.5; // roughly keeps the blade's length as it leans
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;`);
    shadeBothSides(shader);
  };
  material.customProgramCacheKey = () => 'meadow-grass';

  const mesh = new THREE.InstancedMesh(clumpGeometry(rand), material, count);
  mesh.name = 'grass';
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
  const color = new THREE.Color();
  const R0 = 2.5, spread = Math.log(1 + (radius / R0) ** 2);
  const CLEAR = 0.42; // clump centres; their roots spread ~0.1 m, so the 0.35 m round your feet stays bare
  for (let i = 0; i < count; i++) {
    let x, z, r, patchiness;
    for (let tries = 0; ; tries++) {
      // Density falls off as 1 / (1 + (r / R0)²): thick round your feet, thinner far
      // out, where bigger clumps (below) and the grazing view fill the gaps.
      r = R0 * Math.sqrt(Math.exp(rand() * spread) - 1);
      const a = rand() * TAU;
      x = Math.cos(a) * r;
      z = Math.sin(a) * r;
      patchiness = noise2(x * 0.32 + 17.3, z * 0.32 - 4.1);
      if ((r >= CLEAR && (rand() < 0.45 + 0.55 * patchiness || tries > 8)) || tries > 40) break; // tufts thicken where the noise is high
    }
    if (r < CLEAR) { x *= CLEAR / (r || 1); z *= CLEAR / (r || 1); r = CLEAR; }
    const k = (0.8 + rand() * 0.5) * (1 + r * 0.13), tall = (0.8 + rand() * 0.7) * (0.85 + 0.3 * patchiness) * (1 + r * 0.02);
    q.setFromAxisAngle(UP, rand() * TAU);
    mesh.setMatrixAt(i, m.compose(p.set(x, heightAt(x, z) - 0.01, z), q, s.set(k, tall, k)));
    // Drier, yellower patches a few metres across; the sparse spots darker and bluer.
    const dry = smoothstep(0.45, 0.8, noise2(x * 0.22 - 3.7, z * 0.22 + 9.1)), damp = 1 - smoothstep(0.15, 0.5, patchiness);
    const v = (0.84 + rand() * 0.26) * (1 - 0.22 * damp);
    color.setRGB(lerp(0.88, 1.4, dry) * v, lerp(1.0, 1.1, dry) * v, lerp(lerp(0.92, 1.12, damp), 0.45, dry) * v);
    mesh.setColorAt(i, color);
  }
  mesh.computeBoundingSphere();

  return {
    mesh,
    update(time) {
      uniforms.uTime.value = time;
    },
  };
}
