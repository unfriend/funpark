// Boids flocking simulation on the CPU.
//
// Everything here lives in "sim space": metres, +Y up, the flock roaming a
// soft-walled cylinder centred over the origin. main.js scales/offsets that
// space into the room for AR, so nothing in here knows about rendering.
//
// Neighbour lookup uses a hashed uniform grid rebuilt every step with a
// counting sort, which keeps a step roughly O(n) even with thousands of birds.

const TABLE_BITS = 13;
const TABLE_SIZE = 1 << TABLE_BITS;
const TABLE_MASK = TABLE_SIZE - 1;
const TAU = Math.PI * 2;

export const FLOCK_PARAMS = {
  center: { x: 0, y: 8, z: 0 },
  radius: 16, // horizontal soft boundary
  minY: 1.2, // soft floor / ceiling
  maxY: 15,
  perception: 2.0, // neighbour radius, also the grid cell size
  separation: 1.0,
  minSpeed: 3.5,
  cruiseSpeed: 6,
  maxSpeed: 8,
  maxForce: 10, // m/s², per steering rule
  alignment: 2.5,
  cohesion: 3, // spring toward the local centre, 1/s²
  separationWeight: 18, // m/s² per fully-overlapping neighbour
  wander: 0.8, // pull toward the slowly drifting flock target...
  flockRadius: 4, // ...felt only by birds farther than this from it
  maxNeighbors: 14,
  maxCandidates: 120, // distance checks per bird before the search stops widening
};

// The 27 neighbouring cells ordered outward in symmetric rings (self, faces,
// edges, corners). The search only stops between rings, so truncating it in a
// dense clump never biases a bird toward one side.
const CELL_OFFSETS = [];
for (let ring = 0; ring <= 3; ring++) {
  for (let z = -1; z <= 1; z++) for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
    if (Math.abs(x) + Math.abs(y) + Math.abs(z) === ring) CELL_OFFSETS.push(x, y, z);
  }
}
const RING_ENDS = [1, 7, 19];

function hashCell(ix, iy, iz) {
  return (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) & TABLE_MASK;
}

// Steering accumulator shared by the hot loop (avoids per-bird allocations).
let ax = 0, ay = 0, az = 0;

// Reynolds steering: turn the current velocity toward `dir` at `speed`,
// limited to `maxForce`, weighted by `w`.
function steer(dx, dy, dz, vx, vy, vz, speed, maxForce, w) {
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 1e-6) return;
  const k = speed / len;
  let sx = dx * k - vx, sy = dy * k - vy, sz = dz * k - vz;
  const sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
  if (sl > maxForce) {
    const c = maxForce / sl;
    sx *= c; sy *= c; sz *= c;
  }
  ax += sx * w; ay += sy * w; az += sz * w;
}

export class Flock {
  constructor(capacity, count, params = FLOCK_PARAMS) {
    this.capacity = capacity;
    this.params = params;
    this.count = 0;
    this.time = Math.random() * 1000;

    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.acc = new Float32Array(capacity * 3);
    this.panic = new Float32Array(capacity);

    // Wing-beat animation state, read by BirdMesh.
    this.phase = new Float32Array(capacity);
    this.amp = new Float32Array(capacity);
    this.glide = new Uint8Array(capacity);
    this.glideTimer = new Float32Array(capacity);

    this.cellOf = new Int32Array(capacity);
    this.sorted = new Int32Array(capacity);
    this.cellStart = new Int32Array(TABLE_SIZE);
    this.cellCount = new Int32Array(TABLE_SIZE);
    this.stamp = new Int32Array(TABLE_SIZE); // which bird last searched each bucket

    this.target = { x: 0, y: params.center.y, z: 0 };
    this.setCount(count);
  }

  setCount(n) {
    n = Math.max(0, Math.min(this.capacity, n | 0));
    for (let i = this.count; i < n; i++) this.spawn(i);
    this.count = n;
  }

  spawn(i) {
    const P = this.params;
    const a = Math.random() * TAU;
    const r = Math.sqrt(Math.random()) * P.radius * 0.6;
    const i3 = i * 3;
    this.pos[i3] = P.center.x + Math.cos(a) * r;
    this.pos[i3 + 1] = P.minY + 1.5 + Math.random() * (P.maxY - P.minY - 3);
    this.pos[i3 + 2] = P.center.z + Math.sin(a) * r;
    // Start roughly circling so the flock organises quickly.
    const h = a + Math.PI / 2 + (Math.random() - 0.5) * 0.8;
    const s = (P.minSpeed + P.maxSpeed) / 2;
    this.vel[i3] = Math.cos(h) * s;
    this.vel[i3 + 1] = (Math.random() - 0.5) * 0.5;
    this.vel[i3 + 2] = Math.sin(h) * s;
    this.acc[i3] = this.acc[i3 + 1] = this.acc[i3 + 2] = 0;
    this.panic[i] = 0;
    this.phase[i] = Math.random() * TAU;
    this.amp[i] = 1;
    this.glide[i] = 0;
    this.glideTimer[i] = Math.random() * 3;
  }

  // A slowly wandering point the whole flock is loosely drawn to; this is what
  // makes the murmuration sweep around instead of settling into one blob.
  updateTarget() {
    const P = this.params, t = this.time, R = P.radius;
    this.target.x = P.center.x + Math.sin(t * 0.11) * R * 0.55 + Math.sin(t * 0.27 + 1.3) * R * 0.2;
    this.target.z = P.center.z + Math.cos(t * 0.093) * R * 0.55 + Math.sin(t * 0.21) * R * 0.2;
    this.target.y = P.center.y + Math.sin(t * 0.17) * 3;
  }

  buildGrid() {
    const n = this.count, pos = this.pos, inv = 1 / this.params.perception;
    const { cellOf, sorted, cellStart, cellCount } = this;
    cellCount.fill(0);
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const k = hashCell(Math.floor(pos[i3] * inv), Math.floor(pos[i3 + 1] * inv), Math.floor(pos[i3 + 2] * inv));
      cellOf[i] = k;
      cellCount[k]++;
    }
    let sum = 0;
    for (let k = 0; k < TABLE_SIZE; k++) {
      cellStart[k] = sum;
      sum += cellCount[k];
    }
    // Scatter into `sorted`, using cellCount as a cursor and restoring it after.
    for (let i = 0; i < n; i++) {
      const k = cellOf[i];
      sorted[cellStart[k] + --cellCount[k]] = i;
    }
    for (let i = 0; i < n; i++) cellCount[cellOf[i]]++;
  }

  /**
   * Advance the simulation.
   * @param {number} dt seconds
   * @param {Array} repellers sim-space capsules: {ox,oy,oz, dx,dy,dz, len, radius, strength}
   *   (len 0 = a sphere). Birds inside are pushed away and get startled.
   * @param {Array} attractors sim-space points: {x,y,z, strength}. Birds swirl around them.
   */
  update(dt, repellers = [], attractors = []) {
    const P = this.params, n = this.count;
    if (n === 0 || !(dt > 0)) return;
    this.time += dt;
    this.updateTarget();
    this.buildGrid();

    const { pos, vel, acc, panic, sorted, cellStart, cellCount, stamp, target } = this;
    stamp.fill(-1);
    const inv = 1 / P.perception;
    const r2 = P.perception * P.perception;
    const sep2 = P.separation * P.separation;
    const C = P.center, maxF = P.maxForce;
    const maxAcc = maxF * 3;

    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const px = pos[i3], py = pos[i3 + 1], pz = pos[i3 + 2];
      const vx = vel[i3], vy = vel[i3 + 1], vz = vel[i3 + 2];

      // --- gather neighbours -------------------------------------------------
      let cnt = 0, cand = 0, ring = 0, neighbourPanic = 0;
      let avx = 0, avy = 0, avz = 0, cx = 0, cy = 0, cz = 0, sx = 0, sy = 0, sz = 0;
      const ix = Math.floor(px * inv), iy = Math.floor(py * inv), iz = Math.floor(pz * inv);
      for (let c = 0; c < 27; c++) {
        if (c === RING_ENDS[ring]) {
          if (cand >= P.maxCandidates) break;
          ring++;
        }
        const k = hashCell(ix + CELL_OFFSETS[c * 3], iy + CELL_OFFSETS[c * 3 + 1], iz + CELL_OFFSETS[c * 3 + 2]);
        if (stamp[k] === i) continue; // hash collisions can map two nearby cells to one bucket
        stamp[k] = i;
        const end = cellStart[k] + cellCount[k];
        cand += end - cellStart[k];
        for (let s = cellStart[k]; s < end; s++) {
          const j = sorted[s];
          if (j === i) continue;
          const j3 = j * 3;
          const dx = pos[j3] - px, dy = pos[j3 + 1] - py, dz = pos[j3 + 2] - pz;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 >= r2) continue;
          if (d2 < sep2 && d2 > 1e-8) {
            // Push grows as birds crowd closer: 0 at the separation radius, 1 when touching.
            const d = Math.sqrt(d2);
            const w = (P.separation - d) / (P.separation * d);
            sx -= dx * w; sy -= dy * w; sz -= dz * w;
          }
          if (cnt < P.maxNeighbors) {
            avx += vel[j3]; avy += vel[j3 + 1]; avz += vel[j3 + 2];
            cx += dx; cy += dy; cz += dz;
            if (panic[j] > neighbourPanic) neighbourPanic = panic[j];
            cnt++;
          }
        }
      }

      // Startle waves: fear spreads from bird to bird, fading with each hop.
      let pa = Math.max(panic[i] - dt * 1.1, neighbourPanic * 0.86 - 0.04, 0);
      const maxSpeed = P.maxSpeed * (1 + 0.55 * pa);

      // --- steering rules ----------------------------------------------------
      ax = sx * P.separationWeight; ay = sy * P.separationWeight; az = sz * P.separationWeight;
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz) + 1e-6;
      if (cnt > 0) {
        steer(avx, avy, avz, vx, vy, vz, speed, maxF, P.alignment * (1 + pa));
        const kc = P.cohesion / cnt;
        ax += cx * kc; ay += cy * kc; az += cz * kc;
      }
      // A leash to the drifting target: slack within flockRadius, so the flock
      // forms one cloud that overshoots and swings back rather than orbiting.
      const tx = target.x - px, ty = target.y - py, tz = target.z - pz;
      const td = Math.sqrt(tx * tx + ty * ty + tz * tz);
      const leash = Math.min(Math.max((td - P.flockRadius) / 6, 0), 1.5);
      if (leash > 0) steer(tx, ty, tz, vx, vy, vz, speed, maxF, P.wander * leash);
      // Settle back to cruising speed (faster while startled).
      const cruise = P.cruiseSpeed * (1 + 0.4 * pa);
      const ks = ((cruise - speed) * 1.5) / speed;
      ax += vx * ks; ay += vy * ks; az += vz * ks;

      // Soft walls: push back proportionally to how far a bird has strayed.
      const dxc = px - C.x, dzc = pz - C.z;
      const rh = Math.sqrt(dxc * dxc + dzc * dzc);
      if (rh > P.radius) {
        const k = (Math.min((rh - P.radius) / 5, 2) * maxF) / rh;
        ax -= dxc * k; az -= dzc * k;
      }
      if (py < P.minY) ay += Math.min(P.minY - py, 3) * maxF * 1.5;
      else if (py > P.maxY) ay -= Math.min((py - P.maxY) / 2, 2) * maxF;

      // --- interaction -------------------------------------------------------
      for (let r = 0; r < repellers.length; r++) {
        const d = repellers[r];
        let qx = d.ox, qy = d.oy, qz = d.oz;
        if (d.len > 0) {
          const t = Math.min(Math.max((px - d.ox) * d.dx + (py - d.oy) * d.dy + (pz - d.oz) * d.dz, 0), d.len);
          qx += d.dx * t; qy += d.dy * t; qz += d.dz * t;
        }
        const ex = px - qx, ey = py - qy, ez = pz - qz;
        const e2 = ex * ex + ey * ey + ez * ez;
        if (e2 >= d.radius * d.radius) continue;
        const e = Math.sqrt(e2) + 1e-4;
        const f = 1 - e / d.radius;
        const k = (d.strength * maxF * f) / e;
        ax += ex * k; ay += ey * k; az += ez * k;
        if (f * d.strength > pa) pa = Math.min(1, f * d.strength);
      }
      for (let a = 0; a < attractors.length; a++) {
        const t = attractors[a];
        const tx = t.x - px, ty = t.y - py, tz = t.z - pz;
        const dist = Math.sqrt(tx * tx + ty * ty + tz * tz) + 1e-4;
        // Pull in toward an orbit ~1.5 m out, plus a sideways swirl so birds
        // circle the point instead of collapsing onto it.
        const radial = Math.max(-1, Math.min(1, (dist - 1.5) / 1.5));
        const swx = -tz / dist, swz = tx / dist;
        steer((tx / dist) * radial + swx * 0.9, (ty / dist) * radial, (tz / dist) * radial + swz * 0.9,
          vx, vy, vz, maxSpeed, maxF, t.strength);
      }

      ax += (Math.random() - 0.5) * 1.5;
      ay += (Math.random() - 0.5) * 0.8;
      az += (Math.random() - 0.5) * 1.5;

      // --- integrate ---------------------------------------------------------
      const am = Math.sqrt(ax * ax + ay * ay + az * az);
      if (am > maxAcc) {
        const c = maxAcc / am;
        ax *= c; ay *= c; az *= c;
      }
      let nvx = vx + ax * dt, nvy = vy + ay * dt, nvz = vz + az * dt;
      nvy *= 1 - 0.6 * dt; // birds prefer level flight
      const sp = Math.sqrt(nvx * nvx + nvy * nvy + nvz * nvz) + 1e-6;
      const clamped = Math.min(Math.max(sp, P.minSpeed), maxSpeed);
      if (clamped !== sp) {
        const c = clamped / sp;
        nvx *= c; nvy *= c; nvz *= c;
      }
      acc[i3] = (nvx - vx) / dt; acc[i3 + 1] = (nvy - vy) / dt; acc[i3 + 2] = (nvz - vz) / dt;
      vel[i3] = nvx; vel[i3 + 1] = nvy; vel[i3 + 2] = nvz;
      pos[i3] = px + nvx * dt;
      pos[i3 + 1] = Math.max(py + nvy * dt, 0.3);
      pos[i3 + 2] = pz + nvz * dt;
      panic[i] = pa;

      this.animateWings(i, dt, nvy / clamped, pa);
    }
  }

  // Flap harder when climbing or startled; otherwise alternate flapping with glides.
  animateWings(i, dt, climb, pa) {
    if ((this.glideTimer[i] -= dt) <= 0) {
      this.glide[i] ^= 1;
      this.glideTimer[i] = this.glide[i] ? 0.4 + Math.random() * 1.4 : 0.8 + Math.random() * 2.5;
    }
    const gliding = this.glide[i] && pa < 0.2 && climb < 0.2;
    const targetAmp = gliding ? 0.1 : 1;
    this.amp[i] += (targetAmp - this.amp[i]) * Math.min(1, dt * 5);
    const rate = (15 + 12 * pa + 10 * Math.max(climb, 0)) * (0.5 + 0.5 * this.amp[i]);
    this.phase[i] = (this.phase[i] + dt * rate) % TAU;
  }
}

// A hawk that circles above the flock and periodically dives at a bird.
// Exposes the same per-bird arrays as Flock (count = 1) so BirdMesh can draw it.
export class Predator {
  constructor(params = FLOCK_PARAMS) {
    this.params = params;
    this.count = 1;
    this.pos = new Float32Array(3);
    this.vel = new Float32Array(3);
    this.acc = new Float32Array(3);
    this.phase = new Float32Array(1);
    this.amp = new Float32Array(1);
    this.reset();
  }

  reset() {
    const P = this.params;
    this.pos.set([P.center.x + P.radius, P.maxY + 4, P.center.z]);
    this.vel.set([0, 0, -6]);
    this.state = 'patrol';
    this.timer = 4 + Math.random() * 4;
    this.prey = 0;
    this.angle = 0;
    this.amp[0] = 0.15;
  }

  update(dt, flock) {
    if (!(dt > 0)) return;
    const P = this.params, pos = this.pos, vel = this.vel;
    const vx = vel[0], vy = vel[1], vz = vel[2];
    this.timer -= dt;
    ax = 0; ay = 0; az = 0;

    let speed;
    if (this.state === 'patrol' || flock.count === 0) {
      // Soar in a wide circle high above the flock.
      speed = 6.5;
      this.angle += dt * 0.25;
      const r = P.radius * 0.7;
      steer(P.center.x + Math.cos(this.angle) * r - pos[0], P.maxY + 4 - pos[1],
        P.center.z + Math.sin(this.angle) * r - pos[2], vx, vy, vz, speed, 6, 1);
      if (this.timer <= 0 && flock.count > 0) {
        this.state = 'hunt';
        this.timer = 5 + Math.random() * 4;
        this.prey = (Math.random() * flock.count) | 0;
      }
    } else {
      // Pursue: aim at where the prey will be.
      speed = 10.5;
      const j3 = Math.min(this.prey, flock.count - 1) * 3, fp = flock.pos, fv = flock.vel;
      const dx = fp[j3] - pos[0], dy = fp[j3 + 1] - pos[1], dz = fp[j3 + 2] - pos[2];
      const lead = Math.min(Math.sqrt(dx * dx + dy * dy + dz * dz) / speed, 1.5);
      steer(dx + fv[j3] * lead, dy + fv[j3 + 1] * lead, dz + fv[j3 + 2] * lead, vx, vy, vz, speed, 9, 1);
      if (this.timer <= 0 || dx * dx + dy * dy + dz * dz < 0.36) {
        this.state = 'patrol';
        this.timer = 6 + Math.random() * 8;
      }
    }
    if (pos[1] < P.minY + 0.5) ay += (P.minY + 0.5 - pos[1]) * 20;

    let nvx = vx + ax * dt, nvy = vy + ay * dt, nvz = vz + az * dt;
    const sp = Math.sqrt(nvx * nvx + nvy * nvy + nvz * nvz) + 1e-6;
    const c = Math.min(Math.max(sp, 4), speed) / sp;
    nvx *= c; nvy *= c; nvz *= c;
    this.acc[0] = (nvx - vx) / dt; this.acc[1] = (nvy - vy) / dt; this.acc[2] = (nvz - vz) / dt;
    vel[0] = nvx; vel[1] = nvy; vel[2] = nvz;
    pos[0] += nvx * dt; pos[1] += nvy * dt; pos[2] += nvz * dt;

    // Soaring hawks barely flap; they beat hard when chasing and climbing.
    const flapping = this.state === 'hunt' ? nvy > -2 : nvy > 0.8;
    this.amp[0] += ((flapping ? 1 : 0.12) - this.amp[0]) * Math.min(1, dt * 3);
    this.phase[0] = (this.phase[0] + dt * 9 * (0.4 + 0.6 * this.amp[0])) % TAU;
  }

  // The hawk as a sim-space repeller the flock flees from.
  asRepeller(out = {}) {
    out.ox = this.pos[0]; out.oy = this.pos[1]; out.oz = this.pos[2];
    out.dx = 0; out.dy = 0; out.dz = 0; out.len = 0;
    out.radius = 7;
    out.strength = 1.6;
    return out;
  }
}
