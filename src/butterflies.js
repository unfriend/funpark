import * as THREE from 'three';
import { WING_HULL } from './butterflyAtlas.js';

// Butterflies: a few dozen individuals, each a small state machine.
//   FLY       erratic fluttering legs between flowers, gliding now and then
//   APPROACH  homing in on a landing spot (a flower, or a perch someone holds still)
//   LANDED    sitting, slowly opening and closing its wings to bask
// Everything is in the meadow's local space (metres, +Y up).

const FLY = 0, APPROACH = 1, LANDED = 2;
const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

export const BUTTERFLY_PARAMS = {
  radius: 8, // m roaming area around the origin (smaller in AR)
  minY: 0.25,
  maxY: 2.4,
  flowerChance: 0.4, // chance a new flight leg ends on a flower
  perchDelay: 1.0, // s a perch must be held still before butterflies take an interest
  perchRate: 0.45, // per second while still: how readily one sets off for it ("sometimes")
  perchRange: 4, // m
};

const WING_CLOSED = 1.45; // rad above horizontal: wings held together over the back
const WING_OPEN = 0.25; // basking, nearly flat

// Near life-size wingspans from the atlas (1 = the 12.4 cm reference wing),
// with the tiniest species nudged up a little so they still read in VR.
const sizeFor = (species) => Math.max(0.55, species.scale ?? 1) * 1.1;

export class ButterflySwarm {
  /**
   * @param {number} count
   * @param {{ sites: {position: THREE.Vector3, normal: THREE.Vector3}[], species: {scale?: number}[] }} opts
   */
  constructor(count, { sites, species }) {
    this.params = { ...BUTTERFLY_PARAMS };
    this.sites = sites;
    this.activeSites = sites.length;
    this.flowerTaken = new Uint8Array(sites.length);
    this.speciesSizes = species.map(sizeFor);
    this.list = [];
    this.tmp = {
      goal: new THREE.Vector3(), quat: new THREE.Quaternion(), up: new THREE.Vector3(), d: new THREE.Vector3(),
      desired: new THREE.Vector3(), yawQ: new THREE.Quaternion(), euler: new THREE.Euler(), q2: new THREE.Quaternion(),
    };
    this.setCount(count);
  }

  setCount(n) {
    while (this.list.length < n) this.list.push(this.spawn());
    while (this.list.length > n) this.release(this.list.pop());
  }

  spawn() {
    const P = this.params;
    const a = Math.random() * TAU, r = Math.sqrt(Math.random()) * P.radius * 0.8;
    const species = (Math.random() * this.speciesSizes.length) | 0;
    const b = {
      pos: new THREE.Vector3(Math.cos(a) * r, rand(0.5, 1.8), Math.sin(a) * r),
      vel: new THREE.Vector3(),
      quat: new THREE.Quaternion(),
      target: new THREE.Vector3(),
      jitter: new THREE.Vector3(),
      state: FLY, site: null, timer: 0, legTimer: 0, noLand: rand(0, 3), jitterTimer: 0,
      cruise: rand(0.7, 1.35), species, size: this.speciesSizes[species] * rand(0.9, 1.1),
      yaw: Math.random() * TAU,
      phase: Math.random() * TAU, flapRate: rand(38, 52), wingCenter: 0.55, wingAmp: 0.9,
      gliding: false, glideTimer: rand(0.5, 2), basking: false, baskTimer: rand(1, 4), bob: 0,
    };
    b.target.copy(b.pos);
    return b;
  }

  // Shrink/grow the roaming area and the set of usable flowers (AR uses a small ring).
  configure({ radius, activeSites, maxY }) {
    this.params.radius = radius;
    this.params.maxY = maxY;
    this.activeSites = Math.min(activeSites, this.sites.length);
    for (const b of this.list) {
      if (b.site?.flower >= this.activeSites) this.takeoff(b, false);
      const h = Math.hypot(b.pos.x, b.pos.z);
      if (h > radius) b.pos.multiplyScalar(radius / h * 0.8); // pull strays into the new area
    }
  }

  /**
   * @param {number} dt
   * @param {object} input local-space { rays: [{origin, dir, radius}], calls: [Vector3],
   *   perches: [{ perch: Perch, pos: Vector3, quat: Quaternion, claimed, taken: boolean[capacity] }], head: Vector3 }
   */
  update(dt, input) {
    if (!(dt > 0)) return;
    const P = this.params;

    // Who is heading for / sitting on which perch spot.
    for (const w of input.perches) {
      w.claimed = 0;
      w.taken.fill(false);
    }
    for (const b of this.list) {
      const w = b.site?.perch;
      if (w) {
        w.claimed++;
        w.taken[b.site.spot] = true;
      }
    }
    // A still, upturned perch sometimes draws a butterfly in.
    for (const w of input.perches) {
      if (!w.perch.active || w.perch.stillTime < P.perchDelay || w.claimed >= w.perch.capacity) continue;
      if (Math.random() > dt * P.perchRate) continue;
      const b = this.nearestAvailable(w.pos, P.perchRange);
      if (!b) continue;
      const spot = w.taken.indexOf(false);
      if (spot < 0) continue;
      this.release(b);
      b.state = APPROACH;
      b.site = { perch: w, spot, yaw: rand(-0.8, 0.8) };
      w.claimed++;
      w.taken[spot] = true;
    }

    for (const b of this.list) {
      b.noLand -= dt;
      this.startle(b, input);
      if (b.state === LANDED) this.sit(b, dt);
      else if (b.state === APPROACH) this.approach(b, dt, input);
      else this.fly(b, dt, input);
      this.animate(b, dt);
    }
  }

  nearestAvailable(pos, range) {
    let best = null, bestD = range * range;
    for (const b of this.list) {
      const free = (b.state === FLY && b.noLand <= 0) || (b.state === LANDED && b.site?.flower !== undefined);
      if (!free) continue;
      const d = b.pos.distanceToSquared(pos);
      if (d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

  // --- flying ---------------------------------------------------------------
  fly(b, dt, input) {
    const P = this.params, { desired, d } = this.tmp;
    if ((b.legTimer -= dt) <= 0 || b.pos.distanceToSquared(b.target) < 0.09) this.newLeg(b, input);
    if ((b.jitterTimer -= dt) <= 0) {
      // Butterflies zig-zag: a fresh random lurch every few wing beats.
      b.jitter.set(rand(-1, 1), rand(-0.6, 0.8), rand(-1, 1)).multiplyScalar(0.9 * b.cruise);
      b.jitterTimer = rand(0.12, 0.4);
    }
    desired.subVectors(b.target, b.pos).normalize().multiplyScalar(b.cruise).add(b.jitter);
    if (b.pos.y < P.minY) desired.y += (P.minY - b.pos.y) * 8;
    if (b.pos.y > P.maxY) desired.y -= (b.pos.y - P.maxY) * 4;
    const h = Math.hypot(b.pos.x, b.pos.z);
    if (h > P.radius) desired.addScaledVector(d.set(-b.pos.x / h, 0, -b.pos.z / h), (h - P.radius) * 2);
    // Keep out of the viewer's face.
    d.subVectors(b.pos, input.head);
    const dh = d.length();
    if (dh < 0.5) desired.addScaledVector(d.normalize(), 2 * (1 - dh / 0.5));
    b.vel.lerp(desired, Math.min(1, dt * 2.5));
    b.pos.addScaledVector(b.vel, dt);
    if (b.pos.y < 0.05) b.pos.y = 0.05;
    this.faceVelocity(b, dt);
  }

  newLeg(b, input) {
    const P = this.params;
    if (input.calls.length) {
      // Called: flutter around the hand.
      const c = input.calls[(Math.random() * input.calls.length) | 0];
      b.target.set(rand(-1, 1), rand(-0.6, 0.8), rand(-1, 1)).normalize().multiplyScalar(rand(0.15, 0.4)).add(c);
      b.legTimer = rand(0.5, 1.1);
      return;
    }
    if (b.noLand <= 0 && Math.random() < P.flowerChance) {
      const idx = this.pickFlower(b.pos);
      if (idx >= 0) {
        b.state = APPROACH;
        b.site = { flower: idx, yaw: Math.random() * TAU };
        this.flowerTaken[idx] = 1;
        return;
      }
    }
    // Curious about a perch that's being held still: come and have a look.
    for (const w of input.perches) {
      if (w.perch.active && w.perch.stillTime > 0.4 && b.pos.distanceTo(w.pos) < 3 && Math.random() < 0.35) {
        b.target.set(rand(-1, 1), rand(0.2, 1), rand(-1, 1)).normalize().multiplyScalar(rand(0.3, 0.7)).add(w.pos);
        b.legTimer = rand(1, 2);
        return;
      }
    }
    // Otherwise drift over to somewhere above another flower.
    const site = this.sites[(Math.random() * this.activeSites) | 0];
    if (site) b.target.copy(site.position).add(this.tmp.d.set(rand(-1.2, 1.2), rand(0.15, 1.1), rand(-1.2, 1.2)));
    else b.target.set(rand(-2, 2), rand(0.5, 1.5), rand(-2, 2));
    b.target.y = Math.min(Math.max(b.target.y, P.minY + 0.1), P.maxY);
    b.legTimer = rand(1.5, 4);
  }

  pickFlower(pos) {
    let best = -1, bestD = 16; // within 4 m
    for (let k = 0; k < 10; k++) {
      const i = (Math.random() * this.activeSites) | 0;
      if (this.flowerTaken[i]) continue;
      const d = this.sites[i].position.distanceToSquared(pos);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  // --- landing -------------------------------------------------------------
  siteValid(b) {
    const s = b.site;
    if (!s) return false;
    if (s.perch) {
      // Follow a hand that drifts a little, but not one that's on the move.
      const limit = b.state === LANDED ? 0.7 : 0.35;
      return s.perch.perch.active && s.perch.perch.speed < limit;
    }
    return s.flower < this.activeSites;
  }

  // Where the butterfly sits on its site, and which way is up there.
  sitePose(b, outPos, outQuat, outUp) {
    const s = b.site, { yawQ } = this.tmp;
    yawQ.setFromAxisAngle(Y_AXIS, s.yaw);
    if (s.perch) {
      const w = s.perch, [x, z] = w.perch.spots[s.spot] || [0, 0];
      outQuat.copy(w.quat);
      outPos.set(x, 0, z).applyQuaternion(outQuat).add(w.pos);
    } else {
      const site = this.sites[s.flower];
      outQuat.setFromUnitVectors(Y_AXIS, site.normal);
      outPos.copy(site.position);
    }
    outUp.copy(Y_AXIS).applyQuaternion(outQuat);
    outQuat.multiply(yawQ);
    outPos.addScaledVector(outUp, 0.004 * b.size); // feet on the surface, not the body centre
  }

  approach(b, dt, input) {
    if (!this.siteValid(b)) {
      this.release(b);
      b.state = FLY;
      b.noLand = rand(1, 2.5);
      this.newLeg(b, input);
      return;
    }
    const { goal, quat, up, desired } = this.tmp;
    this.sitePose(b, goal, quat, up);
    const dist = b.pos.distanceTo(goal);
    // Come in from slightly above, slowing right down for the touch-down.
    desired.copy(goal).addScaledVector(up, Math.min(0.08, dist * 0.5)).sub(b.pos);
    const speed = Math.min(b.cruise, 0.08 + dist * 1.5);
    desired.normalize().multiplyScalar(speed);
    desired.addScaledVector(b.jitter, 0.6 * THREE.MathUtils.clamp((dist - 0.05) / 0.5, 0, 1));
    if ((b.jitterTimer -= dt) <= 0) {
      b.jitter.set(rand(-1, 1), rand(-0.6, 0.8), rand(-1, 1)).multiplyScalar(0.9 * b.cruise);
      b.jitterTimer = rand(0.12, 0.4);
    }
    b.vel.lerp(desired, Math.min(1, dt * 4));
    b.pos.addScaledVector(b.vel, dt);
    this.faceVelocity(b, dt);
    if (dist < 0.15) b.quat.slerp(quat, 1 - dist / 0.15); // settle into the landing pose
    if (dist < 0.02) this.land(b);
  }

  land(b) {
    b.state = LANDED;
    b.vel.set(0, 0, 0);
    b.timer = b.site.perch ? rand(8, 22) : rand(3, 10);
    b.basking = false;
    b.baskTimer = rand(1, 3);
    b.site.perch?.perch.onLand?.();
  }

  sit(b, dt) {
    if (!this.siteValid(b)) {
      this.takeoff(b, true);
      return;
    }
    const { up } = this.tmp;
    this.sitePose(b, b.pos, b.quat, up);
    if ((b.timer -= dt) <= 0) this.takeoff(b, false);
  }

  takeoff(b, startled) {
    const { up, d } = this.tmp;
    up.copy(Y_AXIS).applyQuaternion(b.quat);
    if (up.y < 0.2) up.set(0, 1, 0);
    this.release(b);
    b.state = FLY;
    b.vel.copy(up).multiplyScalar(0.9).add(d.set(rand(-0.6, 0.6), 0, rand(-0.6, 0.6)));
    b.noLand = startled ? rand(3, 6) : rand(1.5, 4);
    b.target.copy(b.pos).addScaledVector(up, 0.8).add(d.set(rand(-1.5, 1.5), 0, rand(-1.5, 1.5)));
    b.legTimer = rand(0.8, 1.6);
    d.set(0, 0, 1).applyQuaternion(b.quat);
    b.yaw = Math.atan2(d.x, d.z);
  }

  release(b) {
    if (b.site?.flower !== undefined) this.flowerTaken[b.site.flower] = 0;
    b.site = null;
  }

  // Shoo: rays from taps/triggers, and hands swiping fast nearby.
  startle(b, input) {
    const { d } = this.tmp;
    let hit = null;
    for (const r of input.rays) {
      const t = Math.max(0, d.subVectors(b.pos, r.origin).dot(r.dir));
      d.addScaledVector(r.dir, -t); // offset from the ray
      if (d.lengthSq() < r.radius * r.radius) { hit = d; break; }
    }
    if (!hit) {
      for (const w of input.perches) {
        if (w.perch.active && w.perch.speed > 1.2 && b.pos.distanceToSquared(w.pos) < 0.12) {
          hit = d.subVectors(b.pos, w.pos);
          break;
        }
      }
    }
    if (!hit) return;
    if (b.state === LANDED) {
      this.takeoff(b, true);
    } else if (b.noLand < 2.5) {
      this.release(b);
      b.state = FLY;
      b.noLand = rand(3, 5);
      hit.normalize();
      b.vel.addScaledVector(hit, 2);
      b.target.copy(b.pos).addScaledVector(hit, 2).add(d.set(0, rand(0.2, 0.8), 0));
      b.legTimer = rand(0.8, 1.5);
    }
  }

  // --- looks ----------------------------------------------------------------
  faceVelocity(b, dt) {
    const h = Math.hypot(b.vel.x, b.vel.z);
    if (h > 0.05) {
      let dy = Math.atan2(b.vel.x, b.vel.z) - b.yaw;
      dy -= Math.round(dy / TAU) * TAU;
      b.yaw += dy * Math.min(1, dt * 6);
    }
    // Slightly nose-up, pitching with climbs and dives.
    const pitch = THREE.MathUtils.clamp(Math.atan2(b.vel.y, h) * 0.6, -0.5, 0.6) + 0.25;
    b.quat.setFromEuler(this.tmp.euler.set(-pitch, b.yaw, 0, 'YXZ'));
  }

  animate(b, dt) {
    let center, amp, rate, ease;
    if (b.state === LANDED) {
      if ((b.baskTimer -= dt) <= 0) {
        b.basking = !b.basking;
        b.baskTimer = b.basking ? rand(1.5, 4) : rand(2, 6);
      }
      center = b.basking ? WING_OPEN : WING_CLOSED;
      amp = 0.03;
      rate = 8;
      ease = 2.5;
    } else {
      if ((b.glideTimer -= dt) <= 0) {
        b.gliding = !b.gliding && Math.random() < 0.35 && b.state === FLY;
        b.glideTimer = b.gliding ? rand(0.2, 0.5) : rand(0.6, 2);
      }
      center = b.gliding ? 0.2 : 0.55;
      amp = b.gliding ? 0.06 : 0.95;
      rate = b.flapRate;
      ease = 12;
    }
    const k = Math.min(1, dt * ease);
    b.wingCenter += (center - b.wingCenter) * k;
    b.wingAmp += (amp - b.wingAmp) * k;
    b.phase = (b.phase + dt * rate) % TAU;
    // Each downstroke lifts the body a little: the characteristic bobbing flight.
    b.bob = b.state === LANDED ? 0 : Math.sin(b.phase) * 0.008 * b.wingAmp;
  }
}

// --- rendering ------------------------------------------------------------------

// Body along +Z (head forward), wings in the XZ plane hinged at the body.
// Each wing is the atlas's convex WING_HULL over a 60 x 80 mm area, mapping
// tile-local UVs per butterflyAtlas.js (u = 0 at the hinge, v = 1 at the head
// end), so the tile's opaque body-colour patch, which the body samples, stays
// outside the wing. The left wing mirrors the right.
function createButterflyGeometry() {
  const pos = [], uv = [], wing = [];
  const BODY_UV = [0.045, 0.045];
  const tri = (a, b, c) => {
    for (const v of [a, b, c]) { pos.push(...v); uv.push(...BODY_UV); wing.push(0); }
  };
  const segment = (z0, z1, r) => {
    const zm = (z0 + z1) / 2;
    const F = [0, 0, z1], B = [0, 0, z0], U = [0, r, zm], D = [0, -r, zm], L = [-r, 0, zm], R = [r, 0, zm];
    tri(F, U, R); tri(F, R, D); tri(F, D, L); tri(F, L, U);
    tri(B, R, U); tri(B, D, R); tri(B, L, D); tri(B, U, L);
  };
  // Sized to where the painted wings meet the body (about z -0.021 to +0.013).
  segment(-0.004, 0.017, 0.0042); // head + thorax
  segment(-0.027, 0.001, 0.003); // abdomen
  for (const s of [1, -1]) tri([s * 0.0008, 0.002, 0.014], [s * 0.0018, 0.002, 0.014], [s * 0.009, 0.007, 0.034]); // antennae

  for (const s of [1, -1]) {
    const vert = ([u, v]) => { pos.push(s * (0.002 + u * 0.06), 0, -0.042 + v * 0.08); uv.push(u, v); wing.push(1); };
    for (let i = 1; i < WING_HULL.length - 1; i++) {
      // Fan from vertex 0; mirrored wings get the reverse winding.
      const [b, c] = s > 0 ? [WING_HULL[i], WING_HULL[i + 1]] : [WING_HULL[i + 1], WING_HULL[i]];
      vert(WING_HULL[0]); vert(b); vert(c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aWing', new THREE.Float32BufferAttribute(wing, 1));
  return g;
}

export class ButterflyMesh {
  constructor(capacity, atlas) {
    this.atlas = atlas;
    const geometry = createButterflyGeometry();
    this.wing = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.wing.setUsage(THREE.DynamicDrawUsage);
    this.tile = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
    geometry.setAttribute('aWingState', this.wing);
    geometry.setAttribute('aTile', this.tile);

    const material = new THREE.MeshLambertMaterial({
      map: atlas.texture,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
      flatShading: true, // normals from screen derivatives follow the flapping wings
    });
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTileScale = { value: new THREE.Vector2(...atlas.tileScale) };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', /* glsl */ `#include <common>
          attribute float aWing;
          attribute vec3 aWingState; // x: beat phase, y: mean angle, z: amplitude (rad)
          attribute vec2 aTile;
          uniform vec2 uTileScale;`)
        .replace('#include <uv_vertex>', /* glsl */ `#include <uv_vertex>
          vMapUv = vMapUv * uTileScale + aTile;`)
        .replace('#include <begin_vertex>', /* glsl */ `#include <begin_vertex>
          if (aWing > 0.5) {
            // Rigid wing rotating about the body axis; both sides rise together.
            float a = aWingState.y + sin(aWingState.x) * aWingState.z;
            float r = abs(transformed.x);
            transformed.x = sign(transformed.x) * r * cos(a);
            transformed.y += r * sin(a);
          }`);
    };
    material.customProgramCacheKey = () => 'butterfly';

    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.matrix = new THREE.Matrix4();
    this.scale = new THREE.Vector3();
    this.position = new THREE.Vector3();
  }

  update(swarm) {
    const list = swarm.list, n = list.length;
    const m = this.mesh.instanceMatrix.array, w = this.wing.array, t = this.tile.array;
    for (let i = 0; i < n; i++) {
      const b = list[i];
      this.position.copy(b.pos);
      this.position.y += b.bob;
      this.matrix.compose(this.position, b.quat, this.scale.setScalar(b.size)).toArray(m, i * 16);
      w[i * 3] = b.phase;
      w[i * 3 + 1] = b.wingCenter;
      w[i * 3 + 2] = b.wingAmp;
      const [u, v] = this.atlas.tileOffset(b.species);
      t[i * 2] = u;
      t[i * 2 + 1] = v;
    }
    this.mesh.count = n;
    for (const attr of [this.mesh.instanceMatrix, this.wing, this.tile]) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, n * attr.itemSize);
      attr.needsUpdate = true;
    }
  }
}
