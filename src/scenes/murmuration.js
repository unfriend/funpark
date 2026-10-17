import * as THREE from 'three';
import { Flock, Predator, FLOCK_PARAMS } from '../flock.js';
import { BirdMesh } from '../birds.js';
import { createEnvironment } from '../environment.js';

const MAX_BIRDS = 3000;
const AR_SCALE = 0.12; // in AR the whole flock shrinks to fit in a room: 0.5 m birds become 6 cm

/** Starlings at dusk, with an optional hawk. See main.js for the scene interface. */
export function createMurmuration({ isMobile, values }) {
  values.birds = THREE.MathUtils.clamp(Math.round(Number(values.birds) || (isMobile ? 700 : 1500)), 50, MAX_BIRDS);
  values.hawk = !!values.hawk;

  const env = createEnvironment('dusk');
  // `content` maps sim space into the world: identity, except shrunk into the room in AR.
  const content = new THREE.Group();

  const flock = new Flock(MAX_BIRDS, values.birds);
  const birds = new BirdMesh(MAX_BIRDS, { colors: [0x23252d, 0x2b2734, 0x1f2a2b, 0x2d2a27] });
  const hawk = new Predator();
  const hawkMesh = new BirdMesh(1, { size: 2.6, colors: [0x5a3d28], sizeJitter: 0 });
  hawkMesh.mesh.visible = values.hawk;
  content.add(birds.mesh, hawkMesh.mesh);

  // Warm up so the first frame already shows a flock, not a random cloud.
  for (let i = 0; i < 90; i++) flock.update(1 / 30);

  let mode = 'screen';
  const simInverse = new THREE.Matrix4();
  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();
  const repellers = [];
  const attractors = [];
  const hawkRepeller = {};

  // len and radius are in sim units (metres in VR; the flock is shrunk in AR).
  function addRepellerRay(origin, dir, radius, strength, len = 80) {
    const o = tmpA.copy(origin).applyMatrix4(simInverse);
    const d = tmpB.copy(dir).transformDirection(simInverse);
    repellers.push({ ox: o.x, oy: o.y, oz: o.z, dx: d.x, dy: d.y, dz: d.z, len, radius, strength });
  }

  return {
    id: 'murmuration',
    title: 'Murmuration',
    env,
    content,
    usesPerches: false,
    overview: { position: new THREE.Vector3(0, 1.8, 30), target: new THREE.Vector3(0, 8, 0), minDistance: 3, maxDistance: 80 },
    inside: { position: new THREE.Vector3(0, 1.6, 0), look: new THREE.Vector3(0, 0.25, -1), label: 'Inside the flock' },
    hints: {
      mouse: 'Drag to orbit · scroll to zoom · click or hold right button to scatter · H for the hawk',
      touch: 'Drag to orbit · pinch to zoom · tap to scatter the flock',
      xr: 'In VR/AR: wave a hand (or swing a controller) to scatter the flock · trigger or right pinch sends a beam · grip or left pinch calls the flock · A/X hawk · B/Y or the button on your left wrist opens the menu.',
    },
    settings: [
      { key: 'birds', type: 'range', label: 'Birds', min: 100, max: MAX_BIRDS, step: 100 },
      { key: 'hawk', type: 'checkbox', label: 'Hawk (it hunts, the flock flees)', menuLabel: 'Hawk' },
    ],
    toggles: { primary: 'hawk', keys: { h: 'hawk' } },
    values,

    set(key, value) {
      if (key === 'birds') {
        values.birds = value;
        flock.setCount(value);
      } else if (key === 'hawk') {
        values.hawk = value;
        if (value) hawk.reset();
        hawkMesh.mesh.visible = value;
      }
    },

    setMode(next) {
      mode = next;
      const ar = mode === 'ar';
      content.scale.setScalar(ar ? AR_SCALE : 1);
      content.position.set(0, ar ? 0.45 - FLOCK_PARAMS.minY * AR_SCALE : 0, 0); // lowest birds fly ~knee height
    },

    // World-space input -> sim-space repellers/attractors, then step the flock.
    update(dt, input) {
      content.updateMatrixWorld(true);
      simInverse.copy(content.matrixWorld).invert();
      const toSim = 1 / content.scale.x;
      repellers.length = 0;
      attractors.length = 0;

      for (const b of input.bursts) addRepellerRay(b.origin, b.dir, 4.5, 2.5 * b.strength);
      for (const b of input.beams) addRepellerRay(b.origin, b.dir, 3, 1.4);
      // A swing of the hand sends a gust out along it; faster swings reach further.
      for (const g of input.gusts) addRepellerRay(g.origin, g.dir, 3, 2.2 * g.strength, Math.min(20, 4 + g.speed * 5));
      // Birds that come close swerve around hands, as they do around your head.
      for (const h of input.hands) {
        const p = tmpA.copy(h.position).applyMatrix4(simInverse);
        repellers.push({ ox: p.x, oy: p.y, oz: p.z, dx: 0, dy: 0, dz: 0, len: 0, radius: Math.max(0.8, 0.3 * toSim), strength: 1.2 });
      }
      for (const c of input.calls) {
        // Call the flock to a point just in front of the hand.
        const p = tmpA.copy(c.origin).addScaledVector(c.dir, mode === 'ar' ? 0.4 : 2).applyMatrix4(simInverse);
        attractors.push({ x: p.x, y: Math.max(p.y, FLOCK_PARAMS.minY), z: p.z, strength: 2.5 });
      }
      // Birds swerve around the viewer's head (in XR the camera tracks the headset).
      const head = tmpA.copy(input.head).applyMatrix4(simInverse);
      repellers.push({ ox: head.x, oy: head.y, oz: head.z, dx: 0, dy: 0, dz: 0, len: 0,
        radius: Math.max(1.2, 0.5 * toSim), strength: 0.8 });
      if (values.hawk) repellers.push(hawk.asRepeller(hawkRepeller));

      flock.update(dt, repellers, attractors);
      birds.update(flock, dt);
      if (values.hawk) {
        hawk.update(dt, flock);
        hawkMesh.update(hawk, dt);
      }
    },

    debug: { flock, hawk, hawkMesh },
  };
}
