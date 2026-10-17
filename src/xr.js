import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';
import { Perch } from './perch.js';

export async function detectXR() {
  const support = { vr: false, ar: false };
  if (!navigator.xr) return support;
  const check = (mode) => navigator.xr.isSessionSupported(mode).catch(() => false);
  [support.vr, support.ar] = await Promise.all([check('immersive-vr'), check('immersive-ar')]);
  return support;
}

/**
 * Request an immersive session and hand it to three.js.
 * Prefers a 'local-floor' reference space (y = 0 is the real floor) and falls
 * back to 'local' (origin at the starting head position) where it isn't offered.
 * Resolves to the reference space type that ended up in use.
 */
export async function startSession(renderer, mode, overlayRoot) {
  const init = mode === 'immersive-ar'
    ? { optionalFeatures: ['local-floor', 'hand-tracking', 'dom-overlay'], domOverlay: { root: overlayRoot } }
    : { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking', 'layers'] };
  const session = await navigator.xr.requestSession(mode, init);
  try {
    let space = 'local';
    if (session.enabledFeatures?.includes('local-floor')) {
      space = 'local-floor';
    } else {
      try {
        await session.requestReferenceSpace('local-floor');
        space = 'local-floor';
      } catch { /* stay on 'local' */ }
    }
    renderer.xr.setReferenceSpaceType(space);
    await renderer.xr.setSession(session);
    return space;
  } catch (err) {
    session.end().catch(() => {}); // don't leave a half-started session running
    throw err;
  }
}

const RAY_IDLE = 0x9fb4ff;
const RAY_ACTIVE = 0xffe28a;
const TAP_MS = 300; // phone AR: shorter touches are taps
const HOLD_MS = 350; // ...longer ones hold out a flower

/**
 * Tracks both XR input sources (controllers, hands, or screen taps in phone AR):
 * - trigger / right-hand pinch / tap -> "scatter" along the pointing ray (+ a burst on press)
 * - grip / left-hand pinch           -> "call" to a point in front of the hand
 * - A / X button                     -> onToggle();  B / Y button -> onNext()
 * Hands have no grip button (and not every browser fires squeeze for them),
 * so with hand tracking the left pinch does the calling.
 *
 * Each source also offers a Perch for butterflies: the palm or back of a
 * tracked hand, whichever faces up, or the top of a controller held level.
 * On phone AR (transient 'screen' input) a touch is only a tap if it's short:
 * a longer hold is exposed as `screenHold` so the app can hold out a flower.
 */
export class XRInput {
  constructor(renderer, scene, { onBurst, onToggle, onNext } = {}) {
    this.onBurst = onBurst;
    this.onToggle = onToggle;
    this.onNext = onNext;
    this.sources = [];
    this.perches = [];

    const controllerModels = new XRControllerModelFactory();
    const handModels = new XRHandModelFactory();
    const rayGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]);

    for (let i = 0; i < 2; i++) {
      const controller = renderer.xr.getController(i);
      const ray = new THREE.Line(rayGeometry, new THREE.LineBasicMaterial({ color: RAY_IDLE, transparent: true, opacity: 0.5 }));
      ray.scale.z = 3;
      ray.visible = false;
      controller.add(ray);
      scene.add(controller);

      const grip = renderer.xr.getControllerGrip(i);
      grip.add(controllerModels.createControllerModel(grip));
      scene.add(grip);

      const hand = renderer.xr.getHand(i);
      hand.add(handModels.createHandModel(hand, 'mesh'));
      scene.add(hand);

      const state = {
        controller, grip, hand, ray, inputSource: null,
        selecting: false, squeezing: false, buttons: [false, false], touchStart: 0,
        // A palm fits two butterflies side by side; a controller top fits one.
        handPerch: new Perch('hand', { capacity: 2, spots: [[-0.008, 0.01], [0.022, -0.026]] }),
        controllerPerch: new Perch('controller', {
          capacity: 1,
          onLand: () => state.inputSource?.gamepad?.hapticActuators?.[0]?.pulse?.(0.3, 35),
        }),
      };
      this.sources.push(state);
      this.perches.push(state.handPerch, state.controllerPerch);

      controller.addEventListener('connected', (e) => {
        state.inputSource = e.data;
        ray.visible = e.data.targetRayMode === 'tracked-pointer';
      });
      controller.addEventListener('disconnected', () => {
        state.inputSource = null;
        state.selecting = state.squeezing = false;
        state.touchStart = 0;
        ray.visible = false;
      });
      const pinchCalls = () => !!state.inputSource?.hand && state.inputSource.handedness === 'left';
      controller.addEventListener('selectstart', () => {
        if (state.inputSource?.targetRayMode === 'screen') {
          state.touchStart = performance.now();
          return;
        }
        if (pinchCalls()) {
          state.squeezing = true;
          return;
        }
        state.selecting = true;
        this.onBurst?.(this.rayOf(state));
      });
      controller.addEventListener('selectend', () => {
        if (state.touchStart) {
          if (performance.now() - state.touchStart < TAP_MS) this.onBurst?.(this.rayOf(state));
          state.touchStart = 0;
          return;
        }
        if (pinchCalls()) state.squeezing = false;
        state.selecting = false;
      });
      controller.addEventListener('squeezestart', () => { state.squeezing = true; });
      controller.addEventListener('squeezeend', () => { state.squeezing = false; });
    }

    this.tmp = { a: new THREE.Vector3(), b: new THREE.Vector3(), n: new THREE.Vector3(), f: new THREE.Vector3(),
      x: new THREE.Vector3(), z: new THREE.Vector3(), p: new THREE.Vector3(), m: new THREE.Matrix4(), q: new THREE.Quaternion() };
  }

  // World-space pointing ray. Controllers are direct children of the scene, so
  // their local transform is their world transform (and is fresh during events).
  rayOf(state) {
    const c = state.controller;
    return {
      origin: c.position.clone(),
      dir: new THREE.Vector3(0, 0, -1).applyQuaternion(c.quaternion),
    };
  }

  update(dt) {
    for (const s of this.sources) {
      const active = s.selecting || s.squeezing;
      s.ray.material.color.setHex(active ? RAY_ACTIVE : RAY_IDLE);
      s.ray.material.opacity = active ? 0.9 : 0.5;
      s.ray.scale.z = s.selecting ? 12 : 3;

      const buttons = s.inputSource?.gamepad?.buttons;
      const a = !!buttons?.[4]?.pressed, b = !!buttons?.[5]?.pressed;
      if (a && !s.buttons[0]) this.onToggle?.();
      if (b && !s.buttons[1]) this.onNext?.();
      s.buttons[0] = a;
      s.buttons[1] = b;

      const src = s.inputSource;
      const { p, q } = this.tmp;
      s.handPerch.update(dt, !!src?.hand && this.palmPose(s.hand, src.handedness, p, q), p, q);
      s.controllerPerch.update(dt, !!src?.gamepad && !src.hand && s.grip.visible && this.controllerPose(s.grip, p, q), p, q);
    }
  }

  // Landing pose on whichever side of the hand faces up (palm or back).
  palmPose(hand, handedness, outPos, outQuat) {
    const j = hand.joints;
    const wrist = j['wrist'], index = j['index-finger-phalanx-proximal'];
    const middle = j['middle-finger-phalanx-proximal'], pinky = j['pinky-finger-phalanx-proximal'];
    if (!wrist?.visible || !index?.visible || !middle?.visible || !pinky?.visible) return false;
    const { a, b, n, f } = this.tmp;
    // Knuckle-to-wrist vectors span the palm; their cross product points out of
    // the palm for a right hand and out of the back for a left one.
    a.subVectors(index.position, wrist.position);
    b.subVectors(pinky.position, wrist.position);
    n.crossVectors(a, b).normalize();
    if (handedness === 'left') n.negate();
    let skin;
    if (n.y > 0.55) skin = 0.02; // palm up
    else if (n.y < -0.55) { n.negate(); skin = 0.026; } // back of the hand up (it's thicker)
    else return false;
    outPos.lerpVectors(wrist.position, middle.position, 0.55).addScaledVector(n, skin);
    f.subVectors(middle.position, wrist.position); // along the fingers
    return this.frame(n, f, outQuat);
  }

  // Landing pose on the top of a controller held roughly level.
  controllerPose(grip, outPos, outQuat) {
    const { n, f } = this.tmp;
    n.set(0, 1, 0).applyQuaternion(grip.quaternion);
    if (n.y < 0.6) return false;
    f.set(0, 0, -1).applyQuaternion(grip.quaternion);
    outPos.copy(grip.position).addScaledVector(n, 0.035).addScaledVector(f, -0.01);
    return this.frame(n, f, outQuat);
  }

  // Orientation with +Y = up (surface normal) and -Z toward `forward`.
  frame(up, forward, outQuat) {
    const { x, z, m } = this.tmp;
    z.copy(forward).addScaledVector(up, -forward.dot(up));
    if (z.lengthSq() < 1e-8) z.set(0, 0, -1).addScaledVector(up, up.z);
    z.normalize().negate();
    x.crossVectors(up, z).normalize();
    z.crossVectors(x, up);
    outQuat.setFromRotationMatrix(m.makeBasis(x, up, z));
    return true;
  }

  // A phone-AR touch held for a while (not a tap), if any.
  get screenHold() {
    return this.sources.find((s) => s.touchStart && performance.now() - s.touchStart > HOLD_MS && s.inputSource) || null;
  }

  // Sources currently scattering / calling.
  get selecting() { return this.sources.filter((s) => s.selecting && s.inputSource); }
  get squeezing() { return this.sources.filter((s) => s.squeezing && s.inputSource); }

  reset() {
    for (const s of this.sources) {
      s.selecting = s.squeezing = false;
      s.touchStart = 0;
      s.handPerch.update(0, false);
      s.controllerPerch.update(0, false);
    }
  }
}
