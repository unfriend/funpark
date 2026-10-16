import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Flock, Predator, FLOCK_PARAMS } from './flock.js';
import { BirdMesh } from './birds.js';
import { createEnvironment, FOG_COLOR, terrainHeight } from './environment.js';
import { detectXR, startSession, XRInput } from './xr.js';
import { LookControls } from './look.js';

const MAX_BIRDS = 3000;
const ua = navigator.userAgent;
const isTouch = matchMedia('(pointer: coarse)').matches;
const isMobile = /Android|iPhone|iPad|iPod|OculusBrowser|Quest|Mobile/i.test(ua) || (isTouch && /Macintosh/.test(ua));
const AR_SCALE = 0.12; // in AR the whole flock shrinks to fit in a room: 0.5 m birds become 6 cm

// --- settings (persisted per browser, overridable via ?birds=&hawk=) ---------
const settings = { birds: isMobile ? 700 : 1500, hawk: false };
try { Object.assign(settings, JSON.parse(localStorage.getItem('murmuration') || '{}')); } catch { /* private mode */ }
const query = new URLSearchParams(location.search);
if (query.has('birds')) settings.birds = Number(query.get('birds')) || settings.birds;
if (query.has('hawk')) settings.hawk = query.get('hawk') !== '0';
settings.birds = THREE.MathUtils.clamp(Math.round(settings.birds), 50, MAX_BIRDS);
const saveSettings = () => {
  try { localStorage.setItem('murmuration', JSON.stringify(settings)); } catch { /* ignore */ }
};

// --- renderer, scene ---------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(FOG_COLOR, 1);
renderer.xr.enabled = true;
document.getElementById('app').appendChild(renderer.domElement);
const canvas = renderer.domElement;

const scene = new THREE.Scene();
const env = createEnvironment();
scene.fog = env.fog;
scene.add(env.lights);

// `world` holds everything that is placed relative to the floor; `flockRoot`
// maps sim space into it (identity, except shrunk into the room in AR).
const world = new THREE.Group();
const flockRoot = new THREE.Group();
world.add(env.group, flockRoot);
scene.add(world);

const flock = new Flock(MAX_BIRDS, settings.birds);
const birds = new BirdMesh(MAX_BIRDS, { colors: [0x23252d, 0x2b2734, 0x1f2a2b, 0x2d2a27] });
const hawk = new Predator();
const hawkMesh = new BirdMesh(1, { size: 2.6, colors: [0x5a3d28], sizeJitter: 0 });
hawkMesh.mesh.visible = settings.hawk;
flockRoot.add(birds.mesh, hawkMesh.mesh);

// Warm up so the first frame already shows a flock, not a random cloud.
for (let i = 0; i < 90; i++) flock.update(1 / 30);

// --- cameras & non-XR views ----------------------------------------------------
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 1500);
const OVERVIEW_POS = new THREE.Vector3(0, 1.8, 30);
const OVERVIEW_TARGET = new THREE.Vector3(0, 8, 0);
const INSIDE_POS = new THREE.Vector3(0, 1.6, 0);
camera.position.copy(OVERVIEW_POS);

const controls = new OrbitControls(camera, canvas);
controls.target.copy(OVERVIEW_TARGET);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 3;
controls.maxDistance = 80;
controls.maxPolarAngle = Math.PI * 0.58;
controls.mouseButtons.RIGHT = null; // right button scatters the flock instead of panning
controls.update();

const look = new LookControls(camera, canvas);
let view = 'orbit'; // 'orbit' | 'inside'

async function setView(next) {
  if (next === view) return;
  view = next;
  if (view === 'inside') {
    controls.enabled = false;
    camera.position.copy(INSIDE_POS);
    look.lookToward(new THREE.Vector3(0, 0.25, -1).normalize());
    const motion = await look.enable();
    if (!motion) ui.flash('Motion access was refused, so drag to look around.');
  } else {
    look.disable();
    camera.position.copy(OVERVIEW_POS);
    controls.target.copy(OVERVIEW_TARGET);
    controls.enabled = true;
    controls.update();
  }
  ui.update();
}

// --- pointer interaction (desktop & phones outside XR) -------------------------
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const bursts = []; // world-space rays that scatter the flock for a moment
const pointer = { down: null, ids: new Set(), beam: false }; // ids: pointers pressed on the canvas

function setNdc(e) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
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
  pointer.down = pointer.ids.size === 1 ? { x: e.clientX, y: e.clientY, t: performance.now(), button: e.button } : null;
  if (e.button === 2) {
    pointer.beam = true;
    setNdc(e);
  }
});
window.addEventListener('pointermove', (e) => {
  if (!pointer.beam) return;
  if (e.buttons & 2) setNdc(e);
  else pointer.beam = false; // released somewhere we didn't hear about
});
const endPointer = (e) => {
  if (!pointer.ids.delete(e.pointerId)) return; // didn't start on the canvas
  if (e.button === 2 || e.type === 'pointercancel') pointer.beam = false;
  const d = pointer.down;
  pointer.down = null;
  if (e.type === 'pointerup' && d && d.button === 0 && performance.now() - d.t < 300 &&
      Math.hypot(e.clientX - d.x, e.clientY - d.y) < 10) {
    setNdc(e);
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
  if (e.key === 'h' || e.key === 'H') setHawk(!settings.hawk);
  if (e.key === ' ') {
    e.preventDefault();
    ndc.set(0, 0);
    addBurst(cameraRay());
  }
});

function setHawk(on) {
  settings.hawk = on;
  if (on) hawk.reset();
  hawkMesh.mesh.visible = on;
  saveSettings();
  ui.update();
}

function setBirdCount(n) {
  settings.birds = n;
  flock.setCount(n);
  saveSettings();
  ui.update();
}

// --- XR ---------------------------------------------------------------------
const xrOverlay = document.getElementById('xr-overlay');
const xrInput = new XRInput(renderer, scene, {
  onBurst: (ray) => addBurst(ray),
  onToggle: () => setHawk(!settings.hawk),
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
  if (mode === 'immersive-ar') {
    document.body.classList.add('in-ar');
    env.group.visible = false;
    scene.fog = null;
    renderer.setClearColor(0x000000, 0);
    flockRoot.scale.setScalar(AR_SCALE);
  }
}

// Put the flock where the viewer is, once their first pose is known.
function placeWorld(frame) {
  const pose = frame.getViewerPose(renderer.xr.getReferenceSpace());
  if (!pose) return;
  needsPlacement = false;
  const head = pose.transform.position;
  const ar = xrMode === 'immersive-ar';
  // With a 'local' space the origin is at head height, so guess where the floor is.
  const floorY = referenceSpace === 'local-floor' ? 0 : head.y - (ar ? 1.4 : 1.6);
  if (ar) {
    world.position.set(head.x, floorY, head.z);
    flockRoot.position.y = 0.45 - FLOCK_PARAMS.minY * AR_SCALE; // lowest birds fly ~knee height
  } else {
    world.position.set(0, floorY, 0);
  }
}

renderer.xr.addEventListener('sessionend', () => {
  xrMode = null;
  xrInput.reset();
  world.position.set(0, 0, 0);
  flockRoot.position.set(0, 0, 0);
  flockRoot.scale.setScalar(1);
  env.group.visible = true;
  scene.fog = env.fog;
  renderer.setClearColor(FOG_COLOR, 1);
  camera.position.copy(savedCamera.position);
  camera.quaternion.copy(savedCamera.quaternion);
  camera.fov = savedCamera.fov;
  camera.zoom = 1;
  onResize();
  controls.enabled = view === 'orbit';
  document.body.classList.remove('in-xr', 'in-ar');
});

document.getElementById('btn-exit-ar').addEventListener('click', () => renderer.xr.getSession()?.end());
// Taps on the AR overlay's own buttons shouldn't also scatter the flock.
xrOverlay.addEventListener('beforexrselect', (e) => {
  if (e.target.closest('button')) e.preventDefault();
});

// --- per-frame interaction -> sim-space repellers/attractors -------------------
const simInverse = new THREE.Matrix4();
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const repellers = [];
const attractors = [];
const hawkRepeller = {};

function addRepellerRay(origin, dir, radius, strength) {
  const o = tmpA.copy(origin).applyMatrix4(simInverse);
  const d = tmpB.copy(dir).transformDirection(simInverse);
  repellers.push({ ox: o.x, oy: o.y, oz: o.z, dx: d.x, dy: d.y, dz: d.z, len: 80, radius, strength });
}

function gatherInteraction(dt) {
  flockRoot.updateMatrixWorld(true);
  simInverse.copy(flockRoot.matrixWorld).invert();
  const toSim = 1 / flockRoot.scale.x;
  repellers.length = 0;
  attractors.length = 0;

  for (let i = bursts.length - 1; i >= 0; i--) {
    const b = bursts[i];
    b.age += dt;
    if (b.age >= b.life) bursts.splice(i, 1);
    else addRepellerRay(b.origin, b.dir, 4.5, 2.5 * (1 - b.age / b.life));
  }

  if (xrMode) {
    for (const s of xrInput.selecting) {
      const ray = xrInput.rayOf(s);
      addRepellerRay(ray.origin, ray.dir, 3, 1.4);
    }
    for (const s of xrInput.squeezing) {
      // Call the flock to a point just in front of the hand.
      const ray = xrInput.rayOf(s);
      const p = ray.origin.addScaledVector(ray.dir, xrMode === 'immersive-ar' ? 0.4 : 2).applyMatrix4(simInverse);
      attractors.push({ x: p.x, y: Math.max(p.y, FLOCK_PARAMS.minY), z: p.z, strength: 2.5 });
    }
  } else if (pointer.beam) {
    const ray = cameraRay();
    addRepellerRay(ray.origin, ray.dir, 3, 1.4);
  }

  // Birds swerve around the viewer's head (in XR the camera tracks the headset).
  const head = tmpA.copy(camera.position).applyMatrix4(simInverse);
  repellers.push({ ox: head.x, oy: head.y, oz: head.z, dx: 0, dy: 0, dz: 0, len: 0,
    radius: Math.max(1.2, 0.5 * toSim), strength: 0.8 });

  if (settings.hawk) repellers.push(hawk.asRepeller(hawkRepeller));
}

// --- main loop ------------------------------------------------------------------
const clock = new THREE.Clock();

renderer.setAnimationLoop((time, frame) => {
  const dt = Math.min(clock.getDelta(), 1 / 25);

  if (xrMode) {
    if (needsPlacement && frame) placeWorld(frame);
    xrInput.update();
  } else if (view === 'orbit') {
    controls.update();
    // Keep the orbit camera above the ground.
    const minY = terrainHeight(camera.position.x, camera.position.z) + 0.6;
    if (camera.position.y < minY) camera.position.y = minY;
  } else {
    look.update();
  }

  gatherInteraction(dt);
  flock.update(dt, repellers, attractors);
  birds.update(flock, dt);
  if (settings.hawk) {
    hawk.update(dt, flock);
    hawkMesh.update(hawk, dt);
  }

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
  const count = $('count'), countOut = $('count-out'), hawkBox = $('hawk'), hint = $('hint'), toast = $('toast');
  let toastTimer = 0;

  hint.textContent = isTouch
    ? 'Drag to orbit · pinch to zoom · tap to scatter the flock'
    : 'Drag to orbit · scroll to zoom · click or hold right button to scatter · H for the hawk';

  count.max = MAX_BIRDS;
  count.addEventListener('input', () => { countOut.value = count.value; });
  count.addEventListener('change', () => setBirdCount(Number(count.value)));
  hawkBox.addEventListener('change', () => setHawk(hawkBox.checked));
  btnView.addEventListener('click', () => setView(view === 'orbit' ? 'inside' : 'orbit'));
  btnVR.addEventListener('click', () => enterXR('immersive-vr'));
  btnAR.addEventListener('click', () => enterXR('immersive-ar'));

  detectXR().then((support) => {
    btnVR.hidden = !support.vr;
    btnAR.hidden = !support.ar;
    if (support.vr || support.ar) $('xr-help').hidden = false;
    else if (!window.isSecureContext) $('xr-note').textContent = 'VR/AR needs HTTPS (or localhost).';
    else if (!navigator.xr) $('xr-note').textContent = 'No WebXR in this browser: enjoy the 3D view.';
  });

  return {
    update() {
      count.value = settings.birds;
      countOut.value = settings.birds;
      hawkBox.checked = settings.hawk;
      btnView.textContent = view === 'orbit' ? 'Inside the flock' : 'Overview';
    },
    flash(message) {
      toast.textContent = message;
      toast.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toast.hidden = true; }, 5000);
    },
  };
})();
ui.update();

// Handy for poking at the simulation from the console.
Object.assign(window, { flock, hawk, renderer, scene, camera, world, flockRoot });
