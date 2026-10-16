import * as THREE from 'three';

// Low-poly bird, ~0.5 m wingspan, facing +Z with wings along ±X.
// `aWing` is -1 for body vertices and, for wing vertices, the distance from the
// wing root; the vertex shader uses it to rotate the wing about the body axis.
const WING_ROOT = 0.03;

function createBirdGeometry() {
  const positions = [];
  const wing = [];
  const tri = (a, b, c, isWing = false) => {
    for (const v of [a, b, c]) {
      positions.push(v[0], v[1], v[2]);
      wing.push(isWing ? Math.abs(v[0]) - WING_ROOT : -1);
    }
  };

  // Body: a stretched octahedron.
  const N = [0, 0.005, 0.17], T = [0, 0.01, -0.1];
  const U = [0, 0.035, 0.03], D = [0, -0.03, 0.02];
  const L = [-WING_ROOT, 0, 0.03], R = [WING_ROOT, 0, 0.03];
  tri(N, U, R); tri(N, R, D); tri(N, D, L); tri(N, L, U);
  tri(T, R, U); tri(T, D, R); tri(T, L, D); tri(T, U, L);
  // Tail fan.
  tri([0, 0.01, -0.08], [0.055, 0.012, -0.2], [-0.055, 0.012, -0.2]);
  // Wings: swept back, pointed tips.
  for (const s of [1, -1]) {
    const rf = [s * WING_ROOT, 0.01, 0.06], rb = [s * WING_ROOT, 0.01, -0.04];
    const mf = [s * 0.14, 0.01, 0.045], mb = [s * 0.13, 0.01, -0.05];
    const tip = [s * 0.25, 0.0, -0.07];
    tri(rf, mf, mb, true); tri(rf, mb, rb, true); tri(mf, tip, mb, true);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aWing', new THREE.Float32BufferAttribute(wing, 1));
  return geometry;
}

function createBirdMaterial() {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.7,
    metalness: 0.1,
    flatShading: true, // normals come from screen derivatives, so they follow the flapping
    side: THREE.DoubleSide,
  });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */ `#include <common>
        attribute float aWing;
        attribute vec2 aFlapState; // x: wing-beat phase, y: amplitude (0 = gliding)`)
      .replace('#include <begin_vertex>', /* glsl */ `#include <begin_vertex>
        if (aWing >= 0.0) {
          // Gliding holds the wings in a slight V; flapping swings them ±50°.
          float angle = sin(aFlapState.x) * 0.85 * aFlapState.y + (1.0 - aFlapState.y) * 0.12;
          float bend = angle * (1.0 + aWing * 2.0); // wing tips lag/bend further
          float side = sign(transformed.x);
          transformed.x = side * (${WING_ROOT} + aWing * cos(bend));
          transformed.y += aWing * sin(bend);
          transformed.z -= aWing * aFlapState.y * 0.08 * cos(aFlapState.x);
        }`);
  };
  material.customProgramCacheKey = () => 'flapping-bird';
  return material;
}

/**
 * Draws every bird of a Flock (or the Predator) in one instanced draw call.
 * Orientation follows velocity, with banking from sideways acceleration.
 */
export class BirdMesh {
  constructor(capacity, { size = 1, colors = [0x24262e], sizeJitter = 0.15 } = {}) {
    const geometry = createBirdGeometry();
    this.flapState = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
    this.flapState.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aFlapState', this.flapState);

    this.mesh = new THREE.InstancedMesh(geometry, createBirdMaterial(), capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false; // birds are spread over the whole sky anyway
    this.mesh.count = 0;

    this.scale = new Float32Array(capacity);
    this.roll = new Float32Array(capacity);
    const color = new THREE.Color();
    for (let i = 0; i < capacity; i++) {
      this.scale[i] = size * (1 + (Math.random() * 2 - 1) * sizeJitter);
      color.set(colors[i % colors.length]).offsetHSL(0, 0, (Math.random() - 0.5) * 0.06);
      this.mesh.setColorAt(i, color);
    }
  }

  update(source, dt) {
    const n = source.count;
    const m = this.mesh.instanceMatrix.array;
    const flap = this.flapState.array;
    const { pos, vel, acc, phase, amp } = source;
    const rollEase = Math.min(1, dt * 6);

    for (let i = 0; i < n; i++) {
      const i3 = i * 3, o = i * 16;
      // Forward axis Z = normalized velocity.
      let zx = vel[i3], zy = vel[i3 + 1], zz = vel[i3 + 2];
      const zl = Math.sqrt(zx * zx + zy * zy + zz * zz) || 1;
      zx /= zl; zy /= zl; zz /= zl;
      // Right axis X = up × Z (fall back to world X when flying straight up/down).
      let xx = zz, xz = -zx;
      let xl = Math.sqrt(xx * xx + xz * xz);
      if (xl < 1e-4) { xx = 1; xz = 0; xl = 1; }
      xx /= xl; xz /= xl;
      // Y = Z × X
      const yx = zy * xz, yy = zz * xx - zx * xz, yz = -zy * xx;

      // Bank into turns: roll toward the sideways component of acceleration.
      const lateral = acc[i3] * xx + acc[i3 + 2] * xz;
      const targetRoll = Math.max(-1.2, Math.min(1.2, lateral * 0.09));
      const roll = (this.roll[i] += (targetRoll - this.roll[i]) * rollEase);
      const c = Math.cos(roll), s = Math.sin(roll);
      const bxx = c * xx - s * yx, bxy = -s * yy, bxz = c * xz - s * yz;
      const byx = c * yx + s * xx, byy = c * yy, byz = c * yz + s * xz;

      const k = this.scale[i];
      m[o] = bxx * k; m[o + 1] = bxy * k; m[o + 2] = bxz * k; m[o + 3] = 0;
      m[o + 4] = byx * k; m[o + 5] = byy * k; m[o + 6] = byz * k; m[o + 7] = 0;
      m[o + 8] = zx * k; m[o + 9] = zy * k; m[o + 10] = zz * k; m[o + 11] = 0;
      m[o + 12] = pos[i3]; m[o + 13] = pos[i3 + 1]; m[o + 14] = pos[i3 + 2]; m[o + 15] = 1;

      flap[i * 2] = phase[i];
      flap[i * 2 + 1] = amp[i];
    }

    this.mesh.count = n;
    const im = this.mesh.instanceMatrix;
    im.clearUpdateRanges();
    im.addUpdateRange(0, n * 16);
    im.needsUpdate = true;
    this.flapState.clearUpdateRanges();
    this.flapState.addUpdateRange(0, n * 2);
    this.flapState.needsUpdate = true;
  }
}
