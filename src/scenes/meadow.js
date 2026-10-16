import * as THREE from 'three';
import { createEnvironment } from '../environment.js';
import { createFlowers, createGrass } from '../meadowFlora.js';
import { createButterflyAtlas } from '../butterflyAtlas.js';
import { ButterflySwarm, ButterflyMesh } from '../butterflies.js';

const MAX_BUTTERFLIES = 150;
const NEAR_FLOWERS = 60; // the ring around your feet, all that's shown in AR

/** A summer meadow of butterflies that will land on a hand held still. See main.js for the scene interface. */
export function createMeadow({ isMobile, values, renderer }) {
  values.butterflies = THREE.MathUtils.clamp(
    Math.round(Number(values.butterflies) || (isMobile ? 36 : 48)), 5, MAX_BUTTERFLIES);

  const env = createEnvironment('day');
  const grass = createGrass({ count: isMobile ? 1600 : 2600 });
  env.group.add(grass.mesh); // part of the backdrop: hidden in AR

  const content = new THREE.Group();
  const flowers = createFlowers({ count: isMobile ? 380 : 520, nearCount: NEAR_FLOWERS });
  const atlas = createButterflyAtlas();
  atlas.texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const swarm = new ButterflySwarm(values.butterflies, { sites: flowers.sites, species: atlas.species });
  const mesh = new ButterflyMesh(MAX_BUTTERFLIES, atlas);
  content.add(flowers.group, mesh.mesh);

  // World-space input -> the swarm's local space. `content` is only ever
  // translated (with `world`), so orientations carry over unchanged.
  const inverse = new THREE.Matrix4();
  const wrappers = new Map(); // Perch -> its local-space pose and bookkeeping
  const local = { rays: [], calls: [], perches: [], head: new THREE.Vector3() };
  const toLocalRay = (r, radius) => ({
    origin: r.origin.clone().applyMatrix4(inverse),
    dir: r.dir.clone().transformDirection(inverse),
    radius,
  });

  function localInput(input) {
    content.updateMatrixWorld(true);
    inverse.copy(content.matrixWorld).invert();
    local.rays.length = local.calls.length = local.perches.length = 0;
    for (const b of input.bursts) local.rays.push(toLocalRay(b, 0.3 + 0.6 * b.strength));
    for (const b of input.beams) local.rays.push(toLocalRay(b, 0.5));
    // Grip / left pinch: butterflies flutter round a point just ahead of the hand.
    for (const c of input.calls) local.calls.push(c.origin.clone().addScaledVector(c.dir, 0.25).applyMatrix4(inverse));
    for (const perch of input.perches) {
      let w = wrappers.get(perch);
      if (!w) {
        w = { perch, pos: new THREE.Vector3(), quat: new THREE.Quaternion(), claimed: 0, taken: new Array(perch.capacity).fill(false) };
        wrappers.set(perch, w);
      }
      w.pos.copy(perch.position).applyMatrix4(inverse);
      w.quat.copy(perch.quaternion);
      local.perches.push(w);
    }
    local.head.copy(input.head).applyMatrix4(inverse);
    return local;
  }

  // Let them settle first, so some are already sitting on flowers.
  for (let i = 0; i < 240; i++) swarm.update(1 / 30, local);

  return {
    id: 'meadow',
    title: 'Butterfly meadow',
    env,
    content,
    usesPerches: true,
    overview: { position: new THREE.Vector3(0, 1.35, 2.6), target: new THREE.Vector3(0, 0.5, 0), minDistance: 0.4, maxDistance: 30 },
    inside: { position: new THREE.Vector3(0, 1.6, 0), look: new THREE.Vector3(0, -0.45, -1), label: 'Stand in the meadow' },
    hints: {
      mouse: 'Drag to orbit · press and hold still to hold out a flower: a butterfly may land on it · click to shoo',
      touch: 'Drag to orbit · hold your finger still to hold out a flower: a butterfly may land on it · tap to shoo',
      xr: 'Hold a hand still, palm or back up, and a butterfly may land on it (a controller held level works too). Trigger shoos · grip calls them over · B/Y next scene. With hands: right pinch shoos, left pinch calls.',
    },
    settings: [{ key: 'butterflies', type: 'range', label: 'Butterflies', min: 5, max: MAX_BUTTERFLIES, step: 5 }],
    toggles: {},
    values,

    set(key, value) {
      if (key === 'butterflies') {
        values.butterflies = value;
        swarm.setCount(value);
      }
    },

    setMode(mode) {
      const ar = mode === 'ar';
      // In AR: a small ring of flowers around your feet, butterflies in your room.
      flowers.setActiveCount(ar ? NEAR_FLOWERS : flowers.sites.length);
      swarm.configure({ radius: ar ? 2.4 : 8, maxY: ar ? 2.0 : 2.4, activeSites: ar ? NEAR_FLOWERS : flowers.sites.length });
    },

    update(dt, input) {
      grass.update(input.time);
      swarm.update(dt, localInput(input));
      mesh.update(swarm);
    },

    debug: { swarm, flowers, atlas },
  };
}
