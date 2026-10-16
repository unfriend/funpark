import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { terrainHeight } from './environment.js';
import { detectXR, startSession, XRInput } from './xr.js';
import { LookControls } from './look.js';
import { Perch, createWand } from './perch.js';
import { createMurmuration } from './scenes/murmuration.js';
import { createMeadow } from './scenes/meadow.js';

/*
 * Scene interface. Each scene module returns:
 *   id, title
 *   env        { group, lights, fog, clearColor } from createEnvironment(); `group` is hidden in AR
 *   content    THREE.Group placed in `world` (stays visible in AR; never rotated)
 *   overview   { position, target, minDistance, maxDistance } for the orbit camera
 *   inside     { position, look, label } for the first-person view
 *   hints      { mouse, touch, xr } help text
 *   settings   [{ key, type: 'range' | 'checkbox', label, min, max, step }] shown in Settings
 *   values     the scene's persisted settings (an object owned by main.js)
 *   toggles    { primary?: key toggled by A/X, keys?: { [key]: settingKey } }
 *   usesPerches  whether to offer the press-and-hold flower outside XR
 *   set(key, value), setMode('screen' | 'vr' | 'ar'), update(dt, input)
 * where `input` (all world space) is
 *   { bursts: [{ origin, dir, strength 0..1 }], beams: [{ origin, dir }], calls: [{ origin, dir }],
 *     perches: [Perch], head: Vector3, mode, time }
 */
const SCENES = {
  murmuration: { tab: 'Birds', create: createMurmuration },
  meadow: { tab: 'Butterflies', create: createMeadow },
};
const SCENE_ALIASES = { birds: 'murmuration', butterflies: 'meadow' };
const SCENE_IDS = Object.keys(SCENES);

const ua = navigator.userAgent;
const isTouch = matchMedia('(pointer: coarse)').matches;
const isMobile = /Android|iPhone|iPad|iPod|OculusBrowser|Quest|Mobile/i.test(ua) || (isTouch && /Macintosh/.test(ua));

// --- settings (persisted per browser, overridable from the URL) ----------------
const STORAGE_KEY = 'wings';
const settings = { scene: 'murmuration', scenes: {} };
try {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  if (saved) Object.assign(settings, saved);
  else {
    // Settings from before there were scenes.
    const old = JSON.parse(localStorage.getItem('murmuration') || 'null');
    if (old) settings.scenes.murmuration = old;
  }
} catch { /* private mode */ }
for (const id of SCENE_IDS) settings.scenes[id] ??= {};
const query = new URLSearchParams(location.search);
if (query.has('scene')) settings.scene = SCENE_ALIASES[query.get('scene')] || query.get('scene');
if (!SCENES[settings.scene]) settings.scene = 'murmuration';
if (query.has('birds')) settings.scenes.murmuration.birds = Number(query.get('birds'));
if (query.has('hawk')) settings.scenes.murmuration.hawk = query.get('hawk') !== '0';
if (query.has('butterflies')) settings.scenes.meadow.butterflies = Number(query.get('butterflies'));
const saveSettings = () => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
};

// --- renderer, stage ---------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
document.getElementById('app').appendChild(renderer.domElement);
const canvas = renderer.domElement;

const scene = new THREE.Scene();
// `world` holds everything placed relative to the floor (moved under the
// viewer in AR); the active scene's backdrop and content live in it.
const world = new THREE.Group();
scene.add(world);

const loaded = {};
let current = null;

// --- cameras & non-XR views ----------------------------------------------------
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 1500);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.58;
controls.mouseButtons.RIGHT = null; // right button scatters instead of panning

const look = new LookControls(camera, canvas);
let view = 'orbit'; // 'orbit' | 'inside'

function resetView() {
  if (view === 'orbit') {
    const o = current.overview;
    camera.position.copy(o.position);
    controls.target.copy(o.target);
    controls.minDistance = o.minDistance;
    controls.maxDistance = o.maxDistance;
    controls.update();
  } else {
    camera.position.copy(current.inside.position);
    look.lookToward(current.inside.look.clone().normalize());
  }
}

async function setView(next) {
  if (next === view) return;
  view = next;
  controls.enabled = view === 'orbit';
  resetView();
  if (view === 'inside') {
    const motion = await look.enable();
    if (!motion) ui.flash('Motion access was refused, so drag to look around.');
  } else {
    look.disable();
  }
  ui.update();
}

// --- scenes --------------------------------------------------------------------
const load = (id) => (loaded[id] ??= SCENES[id].create({ isMobile, values: settings.scenes[id], renderer }));

function activate(id) {
  if (current?.id === id) return;
  const next = load(id);
  if (current) {
    world.remove(current.env.group, current.content);
    scene.remove(current.env.lights);
  }
  current = next;
  world.add(current.env.group, current.content);
  scene.add(current.env.lights);
  bursts.length = 0;
  applyMode();
  settings.scene = id;
  saveSettings();
  if (!xrMode) resetView();
  ui.update();
}

function nextScene() {
  activate(SCENE_IDS[(SCENE_IDS.indexOf(current.id) + 1) % SCENE_IDS.length]);
}

// Backdrop, fog and clear colour for the current scene in the current mode.
function applyMode() {
  const mode = xrMode === 'immersive-ar' ? 'ar' : xrMode ? 'vr' : 'screen';
  const ar = mode === 'ar';
  current.env.group.visible = !ar;
  scene.fog = ar ? null : current.env.fog;
  renderer.setClearColor(ar ? 0x000000 : current.env.clearColor, ar ? 0 : 1);
  current.setMode(mode);
  return mode;
}

function setSetting(key, value) {
  current.set(key, value);
  saveSettings();
  ui.update();
}
const toggleSetting = (key) => key && setSetting(key, !current.values[key]);

// --- pointer interaction (desktop & phones outside XR) -------------------------
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const bursts = []; // world-space rays that scatter things for a moment
const pointer = { down: null, ids: new Set(), beam: false }; // ids: pointers pressed on the canvas
const HOLD_DELAY = 350; // ms of pressing still before the flower appears
const WAND_DISTANCE = 0.9; // m in front of the camera (0.35 m in front of the phone in AR)

function setNdc(x, y) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
}
function cameraRay() {
  raycaster.setFromCamera(ndc, camera);
  return { origin: raycaster.ray.origin.clone(), dir: raycaster.ray.direction.clone() };
}
function addBurst(ray) {
  bursts.push({ ...ray, age: 0, life: 0.9 });
}

canvas.addEventListener('pointerdown', (e) => {
  pointer.ids.add(e.pointerId);
  // A tap is a single short touch/click that barely moves; a second finger cancels it.
  pointer.down = pointer.ids.size === 1
    ? { x: e.clientX, y: e.clientY, t: performance.now(), button: e.button, moved: false }
    : null;
  if (e.button === 2) {
    pointer.beam = true;
    setNdc(e.clientX, e.clientY);
  }
});
window.addEventListener('pointermove', (e) => {
  const d = pointer.down;
  if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) >= 10) d.moved = true;
  if (!pointer.beam) return;
  if (e.buttons & 2) setNdc(e.clientX, e.clientY);
  else pointer.beam = false; // released somewhere we didn't hear about
});
const endPointer = (e) => {
  if (!pointer.ids.delete(e.pointerId)) return; // didn't start on the canvas
  if (e.button === 2 || e.type === 'pointercancel') pointer.beam = false;
  const d = pointer.down;
  pointer.down = null;
  if (e.type === 'pointerup' && d && d.button === 0 && !d.moved && performance.now() - d.t < 300) {
    setNdc(e.clientX, e.clientY);
    addBurst(cameraRay());
  }
};
window.addEventListener('pointerup', endPointer);
window.addEventListener('pointercancel', endPointer);
window.addEventListener('blur', () => {
  pointer.ids.clear();
  pointer.down = null;
  pointer.beam = false;
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  const key = current.toggles.keys?.[e.key.toLowerCase()];
  if (key) toggleSetting(key);
  if (e.key === ' ') {
    e.preventDefault();
    ndc.set(0, 0);
    addBurst(cameraRay());
  }
});

// Press and hold still (without dragging) to hold out a flower for butterflies.
const wand = createWand();
scene.add(wand.object);
const wandPerch = new Perch('wand');
const wandUp = new THREE.Vector3();
const wandPos = new THREE.Vector3();

// The ray the flower is held out along this frame, or null.
function wandRay() {
  if (!current.usesPerches) return null;
  if (xrMode) {
    const s = xrInput.screenHold; // phone AR: finger held on the screen
    return s && xrInput.rayOf(s);
  }
  const d = pointer.down;
  if (!d || d.button !== 0 || d.moved || pointer.ids.size !== 1 || performance.now() - d.t < HOLD_DELAY) return null;
  setNdc(d.x, d.y);
  return cameraRay();
}

function updateWand(dt) {
  const ray = wandRay();
  const holding = !!ray;
  wand.object.visible = holding;
  if (holding) {
    wandPos.copy(ray.origin).addScaledVector(ray.dir, xrMode ? 0.35 : WAND_DISTANCE);
    // Upright, tipped a little toward the viewer so you see the flower's face.
    wandUp.set(0, 1, 0).addScaledVector(ray.dir, -0.6).normalize();
    wand.object.position.copy(wandPos);
    wand.object.quaternion.setFromUnitVectors(THREE.Object3D.DEFAULT_UP, wandUp);
    wand.head.updateWorldMatrix(true, false);
  }
  wandPerch.update(dt, holding, wandPos.set(0, 0.004, 0).applyMatrix4(wand.head.matrixWorld), wand.object.quaternion);
}

// --- XR ---------------------------------------------------------------------
const xrOverlay = document.getElementById('xr-overlay');
const xrInput = new XRInput(renderer, scene, {
  onBurst: (ray) => addBurst(ray),
  onToggle: () => toggleSetting(current.toggles.primary),
  onNext: () => nextScene(),
});
let xrMode = null;
let referenceSpace = 'local-floor';
let needsPlacement = false;
let xrStarting = false;
const savedCamera = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), fov: camera.fov };

async function enterXR(mode) {
  if (xrStarting || renderer.xr.isPresenting) return; // double-clicked, or already in a session
  xrStarting = true;
  savedCamera.position.copy(camera.position);
  savedCamera.quaternion.copy(camera.quaternion);
  savedCamera.fov = camera.fov;
  try {
    referenceSpace = await startSession(renderer, mode, xrOverlay);
  } catch (err) {
    console.error(err);
    ui.flash(`Couldn't start ${mode === 'immersive-ar' ? 'AR' : 'VR'}: ${err.message || err}`);
    return;
  } finally {
    xrStarting = false;
  }
  xrMode = mode;
  needsPlacement = true;
  controls.enabled = false;
  document.body.classList.add('in-xr');
  if (mode === 'immersive-ar') document.body.classList.add('in-ar');
  applyMode();
}

// Put the world where the viewer is, once their first pose is known.
function placeWorld(frame) {
  const pose = frame.getViewerPose(renderer.xr.getReferenceSpace());
  if (!pose) return;
  needsPlacement = false;
  const head = pose.transform.position;
  const ar = xrMode === 'immersive-ar';
  // With a 'local' space the origin is at head height, so guess where the floor is.
  const floorY = referenceSpace === 'local-floor' ? 0 : head.y - (ar ? 1.4 : 1.6);
  // In AR the scene centres on where you stand; in VR you stand at its centre.
  if (ar) world.position.set(head.x, floorY, head.z);
  else world.position.set(0, floorY, 0);
}

renderer.xr.addEventListener('sessionend', () => {
  xrMode = null;
  xrInput.reset();
  world.position.set(0, 0, 0);
  applyMode();
  camera.position.copy(savedCamera.position);
  camera.quaternion.copy(savedCamera.quaternion);
  camera.fov = savedCamera.fov;
  camera.zoom = 1;
  onResize();
  controls.enabled = view === 'orbit';
  document.body.classList.remove('in-xr', 'in-ar');
});

document.getElementById('btn-exit-ar').addEventListener('click', () => renderer.xr.getSession()?.end());
// Taps on the AR overlay's own buttons shouldn't also count as XR input.
xrOverlay.addEventListener('beforexrselect', (e) => {
  if (e.target.closest('button')) e.preventDefault();
});

// --- per-frame input for the active scene --------------------------------------
const input = { bursts: [], beams: [], calls: [], perches: [], head: camera.position, mode: 'screen', time: 0 };
const nonXRPerches = [wandPerch];
const xrPerches = [...xrInput.perches, wandPerch];

function gatherInput(dt, time) {
  input.bursts.length = input.beams.length = input.calls.length = 0;
  for (let i = bursts.length - 1; i >= 0; i--) {
    const b = bursts[i];
    b.age += dt;
    if (b.age >= b.life) bursts.splice(i, 1);
    else input.bursts.push({ origin: b.origin, dir: b.dir, strength: 1 - b.age / b.life });
  }
  if (xrMode) {
    for (const s of xrInput.selecting) input.beams.push(xrInput.rayOf(s));
    for (const s of xrInput.squeezing) input.calls.push(xrInput.rayOf(s));
    // Phone AR: a held touch holds out the flower where there are perches, else it sweeps.
    const hold = !current.usesPerches && xrInput.screenHold;
    if (hold) input.beams.push(xrInput.rayOf(hold));
    input.perches = xrPerches;
  } else {
    if (pointer.beam) input.beams.push(cameraRay());
    input.perches = nonXRPerches;
  }
  input.mode = xrMode === 'immersive-ar' ? 'ar' : xrMode ? 'vr' : 'screen';
  input.time = time;
  return input;
}

// --- main loop ------------------------------------------------------------------
const clock = new THREE.Clock();

renderer.setAnimationLoop((time, frame) => {
  const dt = Math.min(clock.getDelta(), 1 / 25);

  if (xrMode) {
    if (needsPlacement && frame) placeWorld(frame);
    xrInput.update(dt);
  } else if (view === 'orbit') {
    controls.update();
    // Keep the orbit camera above the ground.
    const minY = terrainHeight(camera.position.x, camera.position.z) + 0.3;
    if (camera.position.y < minY) camera.position.y = minY;
  } else {
    look.update();
  }
  updateWand(dt);

  current.update(dt, gatherInput(dt, time / 1000));
  renderer.render(scene, camera);
});

function onResize() {
  if (renderer.xr.isPresenting) return;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}
window.addEventListener('resize', onResize);

// --- UI -------------------------------------------------------------------------
const ui = (() => {
  const $ = (id) => document.getElementById(id);
  const btnVR = $('btn-vr'), btnAR = $('btn-ar'), btnView = $('btn-view');
  const title = $('scene-title'), hint = $('hint'), xrHelp = $('xr-help'), toast = $('toast');
  const tabs = $('scene-tabs'), settingsEl = $('settings');
  let toastTimer = 0;
  let controlsFor = null; // scene the settings controls were built for
  const inputs = {};

  for (const id of SCENE_IDS) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.dataset.scene = id;
    tab.textContent = SCENES[id].tab;
    tab.addEventListener('click', () => activate(id));
    tabs.append(tab);
  }

  function buildSettings() {
    controlsFor = current;
    for (const k in inputs) delete inputs[k];
    settingsEl.replaceChildren(...current.settings.map((d) => {
      const row = document.createElement('label');
      row.className = 'row';
      const text = document.createElement('span');
      text.textContent = d.label;
      const el = document.createElement('input');
      inputs[d.key] = el;
      if (d.type === 'range') {
        Object.assign(el, { type: 'range', min: d.min, max: d.max, step: d.step });
        const out = document.createElement('output');
        el.addEventListener('input', () => { out.value = el.value; });
        el.addEventListener('change', () => setSetting(d.key, Number(el.value)));
        el.output = out;
        row.append(text, el, out);
      } else {
        el.type = 'checkbox';
        el.addEventListener('change', () => setSetting(d.key, el.checked));
        row.append(el, text);
      }
      return row;
    }));
  }

  btnView.addEventListener('click', () => setView(view === 'orbit' ? 'inside' : 'orbit'));
  btnVR.addEventListener('click', () => enterXR('immersive-vr'));
  btnAR.addEventListener('click', () => enterXR('immersive-ar'));

  detectXR().then((support) => {
    btnVR.hidden = !support.vr;
    btnAR.hidden = !support.ar;
    if (support.vr || support.ar) xrHelp.hidden = false;
    else if (!window.isSecureContext) $('xr-note').textContent = 'VR/AR needs HTTPS (or localhost).';
    else if (!navigator.xr) $('xr-note').textContent = 'No WebXR in this browser: enjoy the 3D view.';
  });

  return {
    update() {
      if (controlsFor !== current) buildSettings();
      for (const tab of tabs.children) tab.setAttribute('aria-selected', String(tab.dataset.scene === current.id));
      title.textContent = current.title;
      hint.textContent = isTouch ? current.hints.touch : current.hints.mouse;
      xrHelp.textContent = current.hints.xr;
      for (const d of current.settings) {
        const el = inputs[d.key];
        if (d.type === 'range') el.value = el.output.value = current.values[d.key];
        else el.checked = current.values[d.key];
      }
      btnView.textContent = view === 'orbit' ? current.inside.label : 'Overview';
    },
    flash(message) {
      toast.textContent = message;
      toast.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toast.hidden = true; }, 5000);
    },
  };
})();

activate(settings.scene);

// Build the other scenes once the page is idle, so switching (e.g. with B/Y
// inside VR) doesn't stall on terrain generation and simulation warm-up.
const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1500));
for (const id of SCENE_IDS) idle(() => load(id), { timeout: 4000 });

// Handy for poking at the app from the console (and for the tests).
window.app = { renderer, scene, camera, world, xrInput, wandPerch, get current() { return current; }, activate, loaded };
