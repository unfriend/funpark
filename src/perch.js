import * as THREE from 'three';

// How still a perch must be. Hand tracking jitters by several millimetres a
// frame, so stillness is judged by staying near an anchor point rather than
// by instantaneous speed.
const STILL_RADIUS = 0.035; // m the (smoothed) perch may wander and still count as held still
const SMOOTHING = 0.1; // s time constant for position smoothing

/**
 * Somewhere a butterfly can land: a tracked hand, the top of a controller,
 * or the flower held out on a phone/desktop. Poses are world space with +Y
 * the landing surface's normal and -Z "forward" (along the fingers).
 */
export class Perch {
  constructor(kind, { capacity = 1, spots = [[0, 0]], onLand = null } = {}) {
    this.kind = kind; // 'hand' | 'controller' | 'wand'
    this.capacity = capacity;
    this.spots = spots; // [x, z] landing offsets on the surface, one per occupant
    this.onLand = onLand; // e.g. a haptic tick
    this.active = false; // tracked, and the surface faces up
    this.position = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.speed = 0; // smoothed m/s
    this.stillTime = 0; // seconds held still
    this.smoothed = new THREE.Vector3();
    this.anchor = new THREE.Vector3();
    this.last = new THREE.Vector3();
  }

  update(dt, active, position, quaternion) {
    if (!active) {
      this.active = false;
      this.stillTime = 0;
      this.speed = 0;
      return;
    }
    if (!this.active) {
      // (Re)acquired: start fresh rather than reading the jump as motion.
      this.smoothed.copy(position);
      this.anchor.copy(position);
      this.last.copy(position);
    }
    this.active = true;
    this.position.copy(position);
    this.quaternion.copy(quaternion);
    if (!(dt > 0)) return;

    this.smoothed.lerp(position, Math.min(1, dt / SMOOTHING));
    const v = this.smoothed.distanceTo(this.last) / dt;
    this.last.copy(this.smoothed);
    this.speed += (v - this.speed) * Math.min(1, dt / 0.2);
    if (this.smoothed.distanceTo(this.anchor) > STILL_RADIUS) {
      this.anchor.copy(this.smoothed);
      this.stillTime = 0;
    } else {
      this.stillTime += dt;
    }
  }
}

/**
 * The flower you "hold out" on desktop/phone (press and hold still): a daisy
 * on a stem. Returns { object, head } where `head` marks the landing surface.
 */
export function createWand() {
  const object = new THREE.Group();
  const petal = new THREE.CircleGeometry(0.011, 8).scale(0.42, 1, 1).translate(0, 0.017, 0);
  const petals = [];
  for (let i = 0; i < 12; i++) petals.push(petal.clone().rotateZ((i / 12) * Math.PI * 2));
  const headGeometry = new THREE.BufferGeometry();
  // Merge the petal ring by hand (all share one attribute layout).
  const pos = [];
  for (const p of petals) pos.push(...p.toNonIndexed().attributes.position.array);
  headGeometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  headGeometry.rotateX(-Math.PI / 2).computeVertexNormals();

  const head = new THREE.Group();
  head.add(
    new THREE.Mesh(headGeometry, new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide })),
    new THREE.Mesh(
      new THREE.SphereGeometry(0.009, 10, 6).scale(1, 0.45, 1),
      new THREE.MeshLambertMaterial({ color: 0xf6c21a }),
    ),
  );
  const stem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0022, 0.003, 0.4, 5).translate(0, -0.2, 0),
    new THREE.MeshLambertMaterial({ color: 0x4f8a2e }),
  );
  object.add(head, stem);
  object.visible = false;
  return { object, head };
}
