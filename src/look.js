import * as THREE from 'three';

const DEG = Math.PI / 180;
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const SCREEN_FIX = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // -90° about X

/**
 * First-person look-around for the non-XR "inside the flock" view.
 * Uses the phone's gyroscope when it reports orientation ("magic window"),
 * and drag-to-look everywhere (on gyro devices, dragging adjusts heading only).
 */
export class LookControls {
  constructor(camera, element) {
    this.camera = camera;
    this.element = element;
    this.enabled = false;
    this.yaw = 0;
    this.pitch = 0;
    this.orientation = null; // latest DeviceOrientationEvent, if any
    this.headingOffset = null;
    this.drag = null;
    this.gyroQuat = new THREE.Quaternion();
    this.tmpQuat = new THREE.Quaternion();
    this.euler = new THREE.Euler();

    this.onOrientation = (e) => {
      if (e.alpha !== null) this.orientation = e;
    };
    this.onPointerDown = (e) => {
      if (!e.isPrimary) return;
      this.drag = { x: e.clientX, y: e.clientY };
    };
    this.onPointerMove = (e) => {
      if (!this.drag || !e.isPrimary) return;
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
      this.drag.x = e.clientX; this.drag.y = e.clientY;
      const k = (this.camera.fov * DEG) / this.element.clientHeight;
      this.yaw += dx * k;
      if (!this.orientation) this.pitch = THREE.MathUtils.clamp(this.pitch + dy * k, -1.4, 1.4);
    };
    this.onPointerUp = () => { this.drag = null; };
  }

  // Must run inside a user gesture: iOS only grants motion access from one.
  async enable() {
    this.enabled = true;
    this.headingOffset = null;
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === 'function') {
      try { await DOE.requestPermission(); } catch { /* fall back to drag */ }
    }
    window.addEventListener('deviceorientation', this.onOrientation);
    this.element.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
  }

  disable() {
    this.enabled = false;
    this.orientation = null;
    this.drag = null;
    window.removeEventListener('deviceorientation', this.onOrientation);
    this.element.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
  }

  // Look toward a world direction (used when entering the view).
  lookToward(dir) {
    this.yaw = Math.atan2(-dir.x, -dir.z);
    this.pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
  }

  update() {
    if (!this.enabled) return;
    const q = this.camera.quaternion;
    const o = this.orientation;
    if (o) {
      // Same mapping as the classic three.js DeviceOrientationControls.
      const screenAngle = (screen.orientation?.angle ?? window.orientation ?? 0) * DEG;
      this.euler.set(o.beta * DEG, o.alpha * DEG, -o.gamma * DEG, 'YXZ');
      this.gyroQuat.setFromEuler(this.euler).multiply(SCREEN_FIX)
        .multiply(this.tmpQuat.setFromAxisAngle(Z_AXIS, -screenAngle));
      if (this.headingOffset === null) {
        // Align the compass heading the phone happens to face with the current view.
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.gyroQuat);
        this.headingOffset = -Math.atan2(-fwd.x, -fwd.z);
      }
      q.setFromAxisAngle(Y_AXIS, this.headingOffset + this.yaw).multiply(this.gyroQuat);
    } else {
      q.setFromEuler(this.euler.set(this.pitch, this.yaw, 0, 'YXZ'));
    }
  }
}
