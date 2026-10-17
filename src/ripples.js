import * as THREE from 'three';

const LIFE = 0.35; // s
const Z_AXIS = new THREE.Vector3(0, 0, 1);

/**
 * Faint rings that pop out of a hand when a swing sends a gust, so you can
 * see that the wave registered. A long swing leaves a short trail of them.
 */
export class Ripples {
  constructor(scene, count = 10) {
    const geometry = new THREE.RingGeometry(0.82, 1, 40);
    this.rings = [];
    this.next = 0;
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
      }));
      mesh.visible = false;
      mesh.renderOrder = 2;
      scene.add(mesh);
      this.rings.push({ mesh, age: LIFE });
    }
  }

  // A ring at `position`, facing along `dir` (the swing).
  spawn(position, dir) {
    const r = this.rings[this.next];
    this.next = (this.next + 1) % this.rings.length;
    r.age = 0;
    r.mesh.position.copy(position);
    r.mesh.quaternion.setFromUnitVectors(Z_AXIS, dir);
    r.mesh.visible = true;
  }

  update(dt) {
    for (const r of this.rings) {
      if (r.age >= LIFE) continue;
      r.age += dt;
      const t = Math.min(1, r.age / LIFE);
      r.mesh.scale.setScalar(0.05 + 0.3 * Math.sqrt(t));
      r.mesh.material.opacity = 0.45 * (1 - t);
      if (t >= 1) r.mesh.visible = false;
    }
  }

  clear() {
    for (const r of this.rings) {
      r.age = LIFE;
      r.mesh.visible = false;
    }
  }
}
