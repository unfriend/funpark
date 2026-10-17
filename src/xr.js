import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
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
// XRControllerModelFactory's load callback dereferences the controller's
// motion controller, which is null if the controller disconnected while its
// model was downloading (e.g. putting controllers down for hand tracking).
// The model just loads again on the next connect, so drop that error.
class TolerantGLTFLoader extends GLTFLoader {
  load(url, onLoad, onProgress, onError) {
    return super.load(url, (asset) => {
      try {
        onLoad(asset);
      } catch (err) {
        if (!(err instanceof TypeError)) throw err;
      }
    }, onProgress, onError);
  }
}

const HOLD_MS = 350; // phone AR: shorter touches are taps, longer ones hold out a flower
const GUST_SPEED = 1.4; // m/s: a hand or controller swung faster than this sends a gust
const GUST_EVERY = 0.12; // s between gusts during one long swing
const GLITCH_SPEED = 8; // m/s: faster than any real hand, so a tracking jump

/**
 * Tracks both XR input sources (controllers, hands, or screen taps in phone AR):
 * - trigger / right-hand pinch / tap -> "scatter" along the pointing ray (+ a burst on press)
 * - grip / left-hand pinch           -> "call" to a point in front of the hand
 * - a quick swing of a hand or controller -> onGust({ origin, dir, speed }) along the swing
 * - A / X button -> onToggle();  B / Y button -> onMenu()
 * Hands have no grip button (and not every browser fires squeeze for them),
 * so with hand tracking the left pinch does the calling. A select that lands
 * on the in-world menu (`ui.select(i)` returns true) goes to the menu instead.
 *
 * It also exposes, every frame: `hands` (moving hands/controllers, for
 * obstacles), `pointers` (rays and index fingertips, for the menu) and `wrist`
 * (where the menu button sits: the back of the left wrist, or above the left
 * controller).
 *
 * Each source also offers a Perch for butterflies: the palm or back of a
 * tracked hand, whichever faces up, or the top of a controller held level.
 * On phone AR (transient 'screen' input) a touch is only a tap if it's short:
 * a longer hold is exposed as `screenHold` so the app can hold out a flower.
 */
export class XRInput {
  constructor(renderer, scene, { onBurst, onToggle, onMenu, onGust, ui } = {}) {
    this.renderer = renderer;
    this.onBurst = onBurst;
    this.onToggle = onToggle;
    this.onMenu = onMenu;
    this.onGust = onGust;
    this.ui = ui;
    this.sources = [];
    this.perches = [];
    this.hands = []; // motion of each tracked hand/controller this frame
    this.pointers = [];
    this.wrist = null;
    this.wristPose = { position: new THREE.Vector3(), normal: new THREE.Vector3(), up: new THREE.Vector3() };

    const controllerModels = new XRControllerModelFactory(new TolerantGLTFLoader());
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
        selecting: false, squeezing: false, buttons: [false, false], touchStart: 0, uiPress: false,
        motion: { tracked: false, position: new THREE.Vector3(), velocity: new THREE.Vector3(), speed: 0, last: new THREE.Vector3(), cooldown: 0 },
        pointer: { id: i, ray: null, fingertip: null, rayData: { origin: new THREE.Vector3(), dir: new THREE.Vector3() }, tip: new THREE.Vector3() },
        // A palm fits two butterflies side by side; a controller top fits one.
        handPerch: new Perch('hand', { capacity: 2, spots: [[-0.008, 0.01], [0.022, -0.026]] }),
        controllerPerch: new Perch('controller', {
          capacity: 1,
          onLand: () => state.inputSource?.gamepad?.hapticActuators?.[0]?.pulse?.(0.3, 35),
        }),
      };
      this.sources.push(state);
      this.perches.push(state.handPerch, state.controllerPerch);
      this.pointers.push(state.pointer);

      controller.addEventListener('connected', (e) => {
        state.inputSource = e.data;
        ray.visible = e.data.targetRayMode === 'tracked-pointer';
      });
      controller.addEventListener('disconnected', () => {
        state.inputSource = null;
        state.selecting = state.squeezing = state.uiPress = false;
        state.touchStart = 0;
        state.motion.tracked = false;
        ray.visible = false;
      });
      const pinchCalls = () => !!state.inputSource?.hand && state.inputSource.handedness === 'left';
      controller.addEventListener('selectstart', () => {
        if (state.inputSource?.targetRayMode === 'screen') {
          state.touchStart = performance.now();
          return;
        }
        this.updatePointer(state); // the event's pose is fresher than last frame's
        if (this.ui?.select(i)) {
          state.uiPress = true;
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
        if (state.uiPress) {
          state.uiPress = false;
          return;
        }
        if (state.touchStart) {
          if (performance.now() - state.touchStart < HOLD_MS) this.onBurst?.(this.rayOf(state));
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
    const blurred = this.renderer.xr.getSession()?.visibilityState === 'visible-blurred';
    this.hands.length = 0;
    this.wrist = null;
    for (let i = 0; i < this.sources.length; i++) {
      const s = this.sources[i];
      const buttons = s.inputSource?.gamepad?.buttons;
      const a = !!buttons?.[4]?.pressed, b = !!buttons?.[5]?.pressed;
      if (a && !s.buttons[0]) this.onToggle?.();
      if (b && !s.buttons[1]) this.onMenu?.();
      s.buttons[0] = a;
      s.buttons[1] = b;

      this.updatePointer(blurred ? null : s);
      if (!blurred) this.updateMotion(s, dt);
      if (!blurred && s.inputSource?.handedness === 'left') this.updateWrist(s);

      // The laser stops where it meets the menu.
      const active = s.selecting || s.squeezing;
      const ui = this.ui?.hitDistance(i);
      s.ray.material.color.setHex(active || ui != null ? RAY_ACTIVE : RAY_IDLE);
      s.ray.material.opacity = active || ui != null ? 0.9 : 0.5;
      s.ray.scale.z = ui ?? (s.selecting ? 12 : 3);

      // While a system menu blurs the session three stops updating poses, so
      // stale ones must not keep a perch alive.
      const src = !blurred && s.inputSource;
      const { p, q } = this.tmp;
      s.handPerch.update(dt, !!src?.hand && s.hand.visible &&
        this.palmPose(s.hand, src.handedness, s.handPerch.active, p, q), p, q);
      s.controllerPerch.update(dt, !!src?.gamepad && !src.hand && s.controller.visible &&
        this.controllerPose(s.controller, s.controllerPerch.active, p, q), p, q);
    }
  }

  // Ray and index fingertip of a source, for the menu (null when not tracked).
  updatePointer(s) {
    const ptr = s ? s.pointer : null;
    if (!ptr) {
      for (const p of this.pointers) p.ray = p.fingertip = null;
      return;
    }
    const src = s.inputSource;
    if (src?.targetRayMode === 'tracked-pointer' && s.controller.visible) {
      ptr.rayData.origin.copy(s.controller.position);
      ptr.rayData.dir.set(0, 0, -1).applyQuaternion(s.controller.quaternion);
      ptr.ray = ptr.rayData;
    } else {
      ptr.ray = null;
    }
    const tip = src?.hand && s.hand.joints['index-finger-tip'];
    ptr.fingertip = tip?.visible ? ptr.tip.copy(tip.position) : null;
  }

  // Track how a hand (palm centre) or controller (grip) moves, and send a gust
  // along any quick swing: that's how a wave of the hand shoos things.
  updateMotion(s, dt) {
    const m = s.motion, src = s.inputSource;
    const { p } = this.tmp;
    let tracked = false;
    if (src?.hand) {
      const w = s.hand.joints['wrist'], k = s.hand.joints['middle-finger-phalanx-proximal'];
      if (s.hand.visible && w?.visible && k?.visible) { p.lerpVectors(w.position, k.position, 0.5); tracked = true; }
    } else if (src?.gamepad && s.grip.visible) {
      p.copy(s.grip.position);
      tracked = true;
    }
    if (!tracked || !(dt > 0)) {
      m.tracked = false;
      return;
    }
    if (!m.tracked) {
      // (Re)acquired: no velocity yet, rather than reading the jump as a swing.
      m.last.copy(p);
      m.velocity.set(0, 0, 0);
      m.speed = 0;
    }
    m.tracked = true;
    m.position.copy(p);
    const raw = this.tmp.a.subVectors(p, m.last).divideScalar(dt);
    m.last.copy(p);
    if (raw.length() > GLITCH_SPEED) raw.set(0, 0, 0);
    m.velocity.lerp(raw, 1 - Math.exp(-dt / 0.05));
    m.speed = m.velocity.length();
    m.cooldown -= dt;
    if (m.speed > GUST_SPEED && m.cooldown <= 0) {
      m.cooldown = GUST_EVERY;
      this.onGust?.({ origin: m.position.clone(), dir: m.velocity.clone().normalize(), speed: m.speed });
    }
    this.hands.push(m);
  }

  // Where the menu button goes: on the back of the left wrist (facing out of
  // the back of the hand), or floating just above the left controller.
  updateWrist(s) {
    const src = s.inputSource, w = this.wristPose;
    const { a, b, n, f } = this.tmp;
    if (src.hand) {
      const j = s.hand.joints;
      const wrist = j['wrist'], index = j['index-finger-phalanx-proximal'];
      const middle = j['middle-finger-phalanx-proximal'], pinky = j['pinky-finger-phalanx-proximal'];
      if (!s.hand.visible || !wrist?.visible || !index?.visible || !middle?.visible || !pinky?.visible) return;
      a.subVectors(index.position, wrist.position);
      b.subVectors(pinky.position, wrist.position);
      n.crossVectors(a, b).normalize(); // out of the back of a left hand (see palmPose)
      f.subVectors(middle.position, wrist.position).normalize();
      w.position.copy(wrist.position).addScaledVector(n, 0.022).addScaledVector(f, -0.015);
      w.normal.copy(n);
      w.up.copy(f);
    } else if (src.gamepad && s.controller.visible) {
      n.set(0, 1, 0).applyQuaternion(s.controller.quaternion);
      f.set(0, 0, 1).applyQuaternion(s.controller.quaternion); // toward the wrist
      w.position.copy(s.controller.position).addScaledVector(n, 0.05).addScaledVector(f, 0.07);
      w.normal.copy(n).addScaledVector(f, 0.6).normalize(); // tipped toward the viewer
      w.up.copy(f).negate();
    } else {
      return;
    }
    this.wrist = w;
  }

  // Landing pose on whichever side of the hand faces up (palm or back).
  // `held`: the perch is already active, so tolerate more tilt before letting go.
  palmPose(hand, handedness, held, outPos, outQuat) {
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
    const flat = held ? 0.4 : 0.6;
    let skin;
    if (n.y > flat) skin = 0.02; // palm up
    else if (n.y < -flat) { n.negate(); skin = 0.026; } // back of the hand up (it's thicker)
    else return false;
    outPos.lerpVectors(wrist.position, middle.position, 0.55).addScaledVector(n, skin);
    f.subVectors(middle.position, wrist.position); // along the fingers
    return this.frame(n, f, outQuat);
  }

  // Landing pose on the top face of a controller held roughly level. On Quest
  // Touch controllers the face (buttons, thumbstick) is the target-ray space's
  // XZ plane, a few cm behind the ray origin; grip space is tilted 45 degrees.
  controllerPose(ray, held, outPos, outQuat) {
    const { n, f } = this.tmp;
    n.set(0, 1, 0).applyQuaternion(ray.quaternion);
    if (n.y < (held ? 0.6 : 0.8)) return false;
    f.set(0, 0, -1).applyQuaternion(ray.quaternion);
    outPos.copy(ray.position).addScaledVector(n, 0.012).addScaledVector(f, -0.05);
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
    this.hands.length = 0;
    this.wrist = null;
    for (const s of this.sources) {
      s.selecting = s.squeezing = s.uiPress = false;
      s.touchStart = 0;
      s.motion.tracked = false;
      s.pointer.ray = s.pointer.fingertip = null;
      s.handPerch.update(0, false);
      s.controllerPerch.update(0, false);
    }
  }
}
