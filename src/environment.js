import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Open country around the viewer, in two lights:
// - dusk: the classic setting for a starling murmuration. The low sun sits
//   behind the flock as seen from the default camera, so the birds read as
//   dark silhouettes against the glow.
// - day: a bright summer meadow for the butterflies.

const PRESETS = {
  dusk: {
    sunDir: [-0.35, 0.09, -1],
    sky: { top: 0x1f2d5c, mid: 0x7b6fa6, horizon: 0xf2a179, below: 0x8a6a74, sun: 0xffd08a },
    sunGlow: [0.35, 0.8, 3.0], // broad glow, halo, disc
    sunDisc: [0.9994, 0.9997], // cosines of the disc's outer and inner edge
    fog: { color: 0xc89386, near: 70, far: 380 },
    ground: { low: 0x3d5534, dry: 0x6e6a3c, high: 0x2b3a30, shore: 0x5a5446 },
    water: { color: 0x8c8fb8, specular: 0xffc49a },
    trees: { saturation: 0.35, lightness: 0.18 },
    hemi: [0xffd6c4, 0x3a4436, 1.5],
    sun: [0xffb37d, 2.2],
  },
  day: {
    sunDir: [0.45, 0.62, -0.65],
    sky: { top: 0x2f6fd0, mid: 0x7fb2ea, horizon: 0xe3eef6, below: 0x9bb38a, sun: 0xfff4d6 },
    sunGlow: [0.12, 0.3, 2.5],
    sunDisc: [0.99986, 0.99992], // a high sun looks small
    fog: { color: 0xcfe2f2, near: 60, far: 420 },
    ground: { low: 0x5f9a3c, dry: 0xa8a64e, high: 0x4c7a3a, shore: 0x8a8466 },
    water: { color: 0x5d8fcf, specular: 0xffffff },
    trees: { saturation: 0.45, lightness: 0.24 },
    hemi: [0xdff1ff, 0x5d7d3a, 1.2],
    sun: [0xfff2d8, 2.4],
  },
};
const LAKE = { x: 28, z: -62, r: 26 };

// --- noise -------------------------------------------------------------------
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
function fbm(x, y) {
  let s = 0, a = 0.5;
  for (let o = 0; o < 4; o++) {
    s += a * noise2(x, y);
    x *= 2.03; y *= 2.03; a *= 0.5;
  }
  return s;
}
const smoothstep = (a, b, x) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

// Flat where the viewer stands (so the VR floor matches), rolling meadows
// further out, hills on the horizon, and a lake basin.
export function terrainHeight(x, z) {
  const r = Math.hypot(x, z);
  const rolling = (fbm(x * 0.03, z * 0.03) - 0.47) * 2.2 * smoothstep(6, 25, r);
  const rise = smoothstep(45, 260, r);
  let h = rolling + rise * (fbm(x * 0.008 + 10, z * 0.008 - 4) * 70 - 8);
  const ld = Math.hypot(x - LAKE.x, z - LAKE.z) / LAKE.r;
  if (ld < 1.7) h += (-2.2 - h) * (1 - smoothstep(0.75, 1.7, ld));
  return h;
}

function createSky(preset, sunDir) {
  const c = (hex) => new THREE.Color(hex);
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTop: { value: c(preset.sky.top) },
      uMid: { value: c(preset.sky.mid) },
      uHorizon: { value: c(preset.sky.horizon) },
      uBelow: { value: c(preset.sky.below) },
      uSun: { value: c(preset.sky.sun) },
      uSunDir: { value: sunDir },
      uSunGlow: { value: new THREE.Vector3(...preset.sunGlow) },
      uSunDisc: { value: new THREE.Vector2(...preset.sunDisc) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uTop, uMid, uHorizon, uBelow, uSun, uSunDir, uSunGlow;
      uniform vec2 uSunDisc;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float s = max(dot(d, uSunDir), 0.0);
        // The horizon glows warmer toward the sun and cooler away from it.
        vec3 horizon = mix(uMid * 1.15, uHorizon, 0.45 + 0.55 * s * s);
        vec3 col = mix(horizon, uMid, smoothstep(0.0, 0.28, d.y));
        col = mix(col, uTop, smoothstep(0.2, 0.85, d.y));
        col = mix(uBelow, col, smoothstep(-0.12, 0.0, d.y)); // GLSL smoothstep needs edge0 < edge1
        col += uSun * dot(uSunGlow, vec3(pow(s, 6.0), pow(s, 80.0), smoothstep(uSunDisc.x, uSunDisc.y, s)));
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(600, 32, 16), material);
  sky.renderOrder = -1;
  return sky;
}

function createTerrain(preset) {
  const size = 700, seg = 140;
  const geometry = new THREE.PlaneGeometry(size, size, seg, seg);
  geometry.rotateX(-Math.PI / 2);
  const p = geometry.attributes.position;
  const colors = new Float32Array(p.count * 3);
  const { ground } = preset;
  const low = new THREE.Color(ground.low), dry = new THREE.Color(ground.dry), high = new THREE.Color(ground.high);
  const shore = new THREE.Color(ground.shore), c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    const h = terrainHeight(x, z);
    p.setY(i, h);
    c.copy(low).lerp(dry, smoothstep(0.45, 0.75, fbm(x * 0.05 + 3, z * 0.05)));
    c.lerp(high, smoothstep(2, 30, h));
    c.lerp(shore, 1 - smoothstep(-1.6, 0.2, h));
    c.toArray(colors, i * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ vertexColors: true }));
}

function createLake(preset) {
  const water = new THREE.Mesh(
    new THREE.CircleGeometry(LAKE.r * 1.5, 48),
    new THREE.MeshPhongMaterial({ ...preset.water, shininess: 60 }),
  );
  water.rotation.x = -Math.PI / 2;
  water.position.set(LAKE.x, -0.6, LAKE.z);
  return water;
}

function createTrees(preset, count = 260) {
  const crown = new THREE.ConeGeometry(1.4, 4.2, 6).translate(0, 4.1, 0);
  const trunk = new THREE.CylinderGeometry(0.18, 0.25, 2.2, 5).translate(0, 1.1, 0);
  const paint = (g, hex) => {
    const col = new THREE.Color(hex);
    const arr = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < arr.length; i += 3) col.toArray(arr, i);
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return g;
  };
  const geometry = mergeGeometries([paint(crown, 0xffffff), paint(trunk, 0x6b4c3a)]);
  const mesh = new THREE.InstancedMesh(
    geometry,
    new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
    count,
  );
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), t = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0), color = new THREE.Color();
  let placed = 0, tries = 0;
  while (placed < count && tries++ < count * 20) {
    const a = Math.random() * Math.PI * 2;
    const r = 38 + Math.pow(Math.random(), 0.7) * 230;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (Math.hypot(x - LAKE.x, z - LAKE.z) < LAKE.r * 1.25) continue;
    // Clumps: favour spots where a low-frequency noise is high.
    if (fbm(x * 0.02 - 7, z * 0.02 + 5) < 0.42 + Math.random() * 0.2) continue;
    q.setFromAxisAngle(up, Math.random() * Math.PI * 2);
    const k = 0.8 + Math.random() * 1.1;
    s.set(k, k * (0.8 + Math.random() * 0.5), k);
    t.set(x, terrainHeight(x, z) - 0.2, z);
    mesh.setMatrixAt(placed, m.compose(t, q, s));
    mesh.setColorAt(placed, color.setHSL(0.27 + Math.random() * 0.08, preset.trees.saturation, preset.trees.lightness + Math.random() * 0.08));
    placed++;
  }
  mesh.count = placed;
  return mesh;
}

/**
 * @param {'dusk'|'day'} name
 * @returns {{ group: THREE.Group, lights: THREE.Group, fog: THREE.Fog, clearColor: THREE.Color }}
 *   `group` is the backdrop (sky, land, lake, trees) that AR hides; `lights` stay on in AR.
 */
export function createEnvironment(name = 'dusk') {
  const preset = PRESETS[name];
  const sunDir = new THREE.Vector3(...preset.sunDir).normalize();
  const group = new THREE.Group();
  group.add(createSky(preset, sunDir), createTerrain(preset), createLake(preset), createTrees(preset));

  const lights = new THREE.Group();
  lights.add(new THREE.HemisphereLight(...preset.hemi));
  const sun = new THREE.DirectionalLight(...preset.sun);
  sun.position.copy(sunDir).multiplyScalar(100);
  lights.add(sun);

  const fog = new THREE.Fog(preset.fog.color, preset.fog.near, preset.fog.far);
  return { group, lights, fog, clearColor: fog.color };
}
