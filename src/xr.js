import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';

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

/**
 * Tracks both XR input sources (controllers, hands, or screen taps in phone AR):
 * - trigger / right-hand pinch / tap -> "scatter" along the pointing ray (+ a burst on press)
 * - grip / left-hand pinch           -> "call" the flock to a point in front of the hand
 * - A / X button                     -> onToggle()
 * Hands have no grip button (and not every browser fires squeeze for them),
 * so with hand tracking the left pinch does the calling.
 */
export class XRInput {
  constructor(renderer, scene, { onBurst, onToggle } = {}) {
    this.onBurst = onBurst;
    this.onToggle = onToggle;
    this.sources = [];

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

      const state = { controller, ray, inputSource: null, selecting: false, squeezing: false, buttonA: false };
      this.sources.push(state);

      controller.addEventListener('connected', (e) => {
        state.inputSource = e.data;
        ray.visible = e.data.targetRayMode === 'tracked-pointer';
      });
      controller.addEventListener('disconnected', () => {
        state.inputSource = null;
        state.selecting = state.squeezing = false;
        ray.visible = false;
      });
      const pinchCalls = () => !!state.inputSource?.hand && state.inputSource.handedness === 'left';
      controller.addEventListener('selectstart', () => {
        if (pinchCalls()) {
          state.squeezing = true;
          return;
        }
        state.selecting = true;
        this.onBurst?.(this.rayOf(state));
      });
      controller.addEventListener('selectend', () => {
        if (pinchCalls()) state.squeezing = false;
        state.selecting = false;
      });
      controller.addEventListener('squeezestart', () => { state.squeezing = true; });
      controller.addEventListener('squeezeend', () => { state.squeezing = false; });

      const grip = renderer.xr.getControllerGrip(i);
      grip.add(controllerModels.createControllerModel(grip));
      scene.add(grip);

      const hand = renderer.xr.getHand(i);
      hand.add(handModels.createHandModel(hand, 'mesh'));
      scene.add(hand);
    }
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

  update() {
    for (const s of this.sources) {
      const active = s.selecting || s.squeezing;
      s.ray.material.color.setHex(active ? RAY_ACTIVE : RAY_IDLE);
      s.ray.material.opacity = active ? 0.9 : 0.5;
      s.ray.scale.z = s.selecting ? 12 : 3;

      const pressed = !!s.inputSource?.gamepad?.buttons[4]?.pressed;
      if (pressed && !s.buttonA) this.onToggle?.();
      s.buttonA = pressed;
    }
  }

  // Sources currently scattering / calling the flock.
  get selecting() { return this.sources.filter((s) => s.selecting && s.inputSource); }
  get squeezing() { return this.sources.filter((s) => s.squeezing && s.inputSource); }

  reset() {
    for (const s of this.sources) s.selecting = s.squeezing = false;
  }
}
