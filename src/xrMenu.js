import * as THREE from 'three';

/*
 * In-world menu for XR sessions, where the page's HTML UI can't be seen.
 * A small round button on the back of the left wrist (shown while you look at
 * it) opens a panel with the scene switcher, scene options, Exit and Close.
 * Works with tracked hands (poke with the index fingertip, or point + pinch)
 * and controllers (point + trigger). Both are drawn unlit into canvas
 * textures, so they read the same in any scene's light and over passthrough.
 *
 * The panel is laid out in millimetres and the canvas is drawn in millimetres
 * too, so a button's layout rect doubles as its hit rect.
 */

const PX_PER_MM = 2;
const W = 360; // panel width; the height fits the content
const PAD = 16;
const INNER = W - 2 * PAD;
const GAP = 8;
const BUTTON_H = 46; // big targets: fingertips and rays both wobble
const TITLE_SIZE = 17;
const TITLE_H = 24;
const LABEL_SIZE = 13; // ~1.5 degrees tall at 0.5 m: easy to read in a Quest
const HELP_SIZE = 10;
const HELP_LINE = 14;
const CORNER = 18;
const BUTTON_CORNER = 10;
const MAX_BUTTONS = 30; // hover is tracked as a bitmask
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, sans-serif';

const INK = '#f6eee9';
const INK_DIM = 'rgba(246, 238, 233, 0.7)';
const GLASS = 'rgba(24, 28, 52, 0.86)';
const GLASS_EDGE = 'rgba(255, 255, 255, 0.16)';
const ACCENT = '#ffc58a';
const ACCENT_HOVER = '#ffdcb8';
const ACCENT_INK = '#2a1c12';
const OUTLINE = 'rgba(246, 238, 233, 0.4)';
const FILL = 'rgba(255, 255, 255, 0.06)';
const FILL_HOVER = 'rgba(255, 255, 255, 0.17)';
const EXIT = '#c4513f';
const EXIT_HOVER = '#dd6750';
const FLASH_FILL = '#fff6ec';

// Placement and interaction, in metres and seconds.
const OPEN_AHEAD = 0.48; // horizontally in front of the head, and ...
const OPEN_DROP = 0.15; // ... this far below eye level: 0.5 m away, within reach
const WRIST_SIZE = 0.035;
const WRIST_SHOW = 0.25; // dot(button face, direction to head) to show it ...
const WRIST_HIDE = 0.15; // ... and to hide it again (no flicker at the edge)
const WRIST_GRACE = 0.006; // pokes may land this far outside the small disc
const WRIST_HOVER = 0.03;
const POKE_ARMED = 0.01; // a press is a fingertip coming from at least this far in front ...
const POKE_TOUCH = 0.005; // ... to this close to the face (or through it)
const POKE_DEPTH = 0.04; // but not from further behind: that reached through, or tracking jumped
const POKE_REARM = 0.02; // after a press, back off this far before the next one
const POKE_COOLDOWN = 0.4;
const HOVER_DEPTH = 0.04; // a fingertip this close in front of a button highlights it
const FLASH = 0.15;

const WRIST_PX = 128;
const NONE = [];

// Fingertip approach to one surface. `armed` once it has been clearly in
// front, so touching the face counts as a press; reaching around from behind
// or sliding in along the face never does.
class Poke {
  constructor() {
    this.armed = false;
    this.pressed = false; // waiting for it to back off POKE_REARM
  }

  // z: fingertip height above the face. Returns true when it touches with
  // `ok` (over a target, not cooling down).
  step(z, ok) {
    if (z > (this.pressed ? POKE_REARM : POKE_ARMED)) {
      this.armed = true;
      this.pressed = false;
      return false;
    }
    if (!this.armed || z > POKE_TOUCH) return false;
    this.armed = false; // a touch is used up, pressed or not
    if (!ok || z < -POKE_DEPTH) return false;
    this.pressed = true;
    return true;
  }
}

class PointerState {
  constructor(id) {
    this.id = id;
    this.hasRay = false;
    this.origin = new THREE.Vector3();
    this.dir = new THREE.Vector3();
    this.hasTip = false;
    this.tip = new THREE.Vector3();
    this.panelT = -1; // distance along the ray to the panel (-1: misses)
    this.panelButton = -1; // button under the ray
    this.wristT = -1;
    this.panelPoke = new Poke();
    this.wristPoke = new Poke();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Compare against the stored copy field by field: setContent may be called
// every frame, and this allocates nothing.
function sameContent(a, b) {
  if (a.title !== (b.title ?? '') || a.help !== (b.help ?? '') || a.exitLabel !== (b.exitLabel ?? 'Exit')) return false;
  const as = a.scenes, bs = b.scenes || NONE;
  if (as.length !== bs.length) return false;
  for (let i = 0; i < as.length; i++) {
    if (as[i].id !== bs[i].id || as[i].label !== bs[i].label || as[i].current !== !!bs[i].current) return false;
  }
  const at = a.toggles, bt = b.toggles || NONE;
  if (at.length !== bt.length) return false;
  for (let i = 0; i < at.length; i++) {
    if (at[i].key !== bt[i].key || at[i].label !== bt[i].label || at[i].on !== !!bt[i].on) return false;
  }
  return true;
}

export class XRMenu {
  /**
   * @param {THREE.Scene} scene  menu objects are added to it (world space, the XR reference space)
   * @param {{ onAction: (action) => void }} opts  action: { type: 'scene', id } | { type: 'toggle', key } | { type: 'exit' }
   */
  constructor(scene, { onAction } = {}) {
    this.onAction = onAction;
    this.content = { title: 'Menu', scenes: [], toggles: [], help: '', exitLabel: 'Exit' };
    this.buttons = []; // { kind: 'scene'|'toggle'|'exit'|'close', x, y, w, h (mm from the top left), label, on, id, key }
    this.helpLines = [];
    this.helpY = 0;
    this.height = 0; // mm
    this.widthM = W / 1000;
    this.heightM = 0; // of the mesh, a hair taller than `height` (whole pixels)
    this.hitX = 0; // where the last rayPanel() hit, mm from the top left
    this.hitY = 0;
    this.time = 0;
    this.lastPress = -Infinity;
    this.flashButton = -1;
    this.flashUntil = 0;
    this.hoverMask = 0;
    this.dirty = true;
    this.opened = false;

    // --- panel ---
    this.canvas = document.createElement('canvas');
    this.canvas.width = W * PX_PER_MM;
    this.canvas.height = 640; // grows if some content needs more
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter; // stays crisp-ish if you step back
    const material = new THREE.MeshBasicMaterial({
      map: this.texture, transparent: true, depthWrite: false, toneMapped: false, fog: false,
    });
    this.panelMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    // After the scene's own transparent things (lasers, wings), so it blends over
    // them; depth-tested, so hands and controllers in front still hide it.
    this.panelMesh.renderOrder = 10;
    this.panel = new THREE.Group();
    this.panel.add(this.panelMesh);
    this.panel.visible = false;
    this.panel.matrixAutoUpdate = false; // world-locked: set once per open()
    this.panelInverse = new THREE.Matrix4();
    scene.add(this.panel);

    // --- wrist button ---
    this.wristCanvas = document.createElement('canvas');
    this.wristCanvas.width = this.wristCanvas.height = WRIST_PX;
    this.wristCtx = this.wristCanvas.getContext('2d');
    this.wristTexture = new THREE.CanvasTexture(this.wristCanvas);
    this.wristTexture.colorSpace = THREE.SRGBColorSpace;
    this.wristTexture.minFilter = THREE.LinearMipmapLinearFilter;
    this.wristButton = new THREE.Mesh(
      new THREE.PlaneGeometry(WRIST_SIZE, WRIST_SIZE),
      new THREE.MeshBasicMaterial({ map: this.wristTexture, transparent: true, depthWrite: false, toneMapped: false, fog: false }),
    );
    this.wristButton.renderOrder = 11;
    this.wristButton.visible = false;
    scene.add(this.wristButton);
    this.wristPos = new THREE.Vector3();
    this.wristX = new THREE.Vector3();
    this.wristY = new THREE.Vector3();
    this.wristZ = new THREE.Vector3();
    this.wristShown = false;
    this.wristHover = false;
    this.wristFlashUntil = 0;
    this.wristDrawn = -1; // which look is on the wrist canvas

    this.head = { position: new THREE.Vector3(0, 1.6, 0), quaternion: new THREE.Quaternion() };
    this.pointers = new Map();
    this.pointerList = [];
    this.tmp = { v: new THREE.Vector3(), d: new THREE.Vector3(), m: new THREE.Matrix4() };

    this.layout();
    this.drawWrist();
  }

  get isOpen() { return this.opened; }

  /** { title, scenes: [{ id, label, current }], toggles: [{ key, label, on }], help, exitLabel }. Cheap to call every frame. */
  setContent(content) {
    if (sameContent(this.content, content)) return;
    this.content = {
      title: content.title ?? '',
      help: content.help ?? '',
      exitLabel: content.exitLabel ?? 'Exit',
      scenes: (content.scenes || []).map((s) => ({ id: s.id, label: s.label, current: !!s.current })),
      toggles: (content.toggles || []).map((t) => ({ key: t.key, label: t.label, on: !!t.on })),
    };
    this.layout();
  }

  open() {
    const { position, quaternion } = this.head;
    // Straight ahead, levelled. Looking straight up or down, the top of the head points the way.
    const f = this.tmp.d.set(0, 0, -1).applyQuaternion(quaternion);
    const pitch = f.y;
    f.y = 0;
    if (f.lengthSq() < 1e-4) {
      f.set(0, pitch < 0 ? 1 : -1, 0).applyQuaternion(quaternion);
      f.y = 0;
      if (f.lengthSq() < 1e-8) f.set(0, 0, -1);
    }
    f.normalize();
    this.panel.position.copy(position).addScaledVector(f, OPEN_AHEAD);
    this.panel.position.y -= OPEN_DROP;
    this.panel.lookAt(position); // +Z (the face) toward the head: turned and tipped up to meet the eyes
    this.panel.updateMatrix();
    this.panel.updateMatrixWorld(true);
    this.panelInverse.copy(this.panel.matrixWorld).invert();
    this.panel.visible = true;
    this.opened = true;
    // A fingertip that happens to be at the new panel must first be seen in front of it.
    for (let i = 0; i < this.pointerList.length; i++) this.pointerList[i].panelPoke.armed = false;
    this.hoverMask = 0;
    if (this.dirty) this.draw();
  }

  close() {
    this.panel.visible = false;
    this.opened = false;
    for (let i = 0; i < this.pointerList.length; i++) this.pointerList[i].panelT = -1;
  }

  toggle() {
    if (this.opened) this.close();
    else this.open();
  }

  /**
   * Every XR frame, before rendering. All world space; the vectors are copied.
   * pointers: [{ id, ray: { origin, dir } | null, fingertip: Vector3 | null }]
   * wrist: { position, normal, up } | null   head: { position, quaternion }
   */
  update(dt, { pointers, wrist, head }) {
    this.time += dt;
    if (head) {
      this.head.position.copy(head.position);
      this.head.quaternion.copy(head.quaternion);
    }
    this.updateWrist(wrist);

    for (let i = 0; i < this.pointerList.length; i++) {
      const s = this.pointerList[i];
      s.hasRay = s.hasTip = false;
    }
    let hover = 0;
    let wristHover = false;
    let press = -1; // button index, or MAX_BUTTONS for the wrist button
    const ready = this.time - this.lastPress > POKE_COOLDOWN;
    const n = pointers ? pointers.length : 0;
    for (let i = 0; i < n; i++) {
      const p = pointers[i];
      const s = this.pointer(p.id);
      s.panelT = s.wristT = s.panelButton = -1;
      if (p.ray) {
        s.hasRay = true;
        s.origin.copy(p.ray.origin);
        s.dir.copy(p.ray.dir);
        if (this.opened) {
          s.panelT = this.rayPanel(s.origin, s.dir);
          if (s.panelT >= 0) {
            s.panelButton = this.buttonAt(this.hitX, this.hitY);
            if (s.panelButton >= 0) hover |= 1 << s.panelButton;
          }
        }
        if (this.wristShown) {
          s.wristT = this.rayWrist(s.origin, s.dir);
          // Whichever the ray reaches first.
          if (s.wristT >= 0 && s.panelT >= 0) {
            if (s.wristT < s.panelT) s.panelT = s.panelButton = -1;
            else s.wristT = -1;
          }
          if (s.wristT >= 0) wristHover = true;
        }
      }
      if (p.fingertip) {
        s.hasTip = true;
        s.tip.copy(p.fingertip);
        if (this.opened) {
          const local = this.tmp.v.copy(s.tip).applyMatrix4(this.panelInverse);
          const b = this.buttonAt((local.x + this.widthM / 2) * 1000, (this.heightM / 2 - local.y) * 1000);
          if (b >= 0 && local.z > -0.01 && local.z < HOVER_DEPTH) hover |= 1 << b;
          if (s.panelPoke.step(local.z, b >= 0 && ready) && press < 0) press = b;
        } else {
          s.panelPoke.armed = false;
        }
        if (this.wristShown) {
          const rel = this.tmp.v.subVectors(s.tip, this.wristPos);
          const z = rel.dot(this.wristZ);
          const radial = Math.sqrt(Math.max(0, rel.lengthSq() - z * z));
          if (radial < WRIST_SIZE / 2 + WRIST_HOVER && z > -0.01 && z < WRIST_HOVER) wristHover = true;
          if (s.wristPoke.step(z, radial < WRIST_SIZE / 2 + WRIST_GRACE && ready) && press < 0) press = MAX_BUTTONS;
        } else {
          s.wristPoke.armed = false;
        }
      }
    }
    // Lost tracking (or this pointer wasn't passed): it has to approach afresh.
    for (let i = 0; i < this.pointerList.length; i++) {
      const s = this.pointerList[i];
      if (!s.hasTip) s.panelPoke.armed = s.wristPoke.armed = false;
      if (!s.hasRay) s.panelT = s.wristT = s.panelButton = -1;
    }

    if (this.flashButton >= 0 && this.time >= this.flashUntil) {
      this.flashButton = -1;
      this.dirty = true;
    }
    if (hover !== this.hoverMask) {
      this.hoverMask = hover;
      this.dirty = true;
    }
    this.wristHover = wristHover;

    // Act after the loop: an action may change the content or close the panel.
    if (press === MAX_BUTTONS) this.pressWrist();
    else if (press >= 0) this.activate(press);

    if (this.opened && this.dirty) this.draw();
    if (this.wristShown) this.drawWrist();
  }

  /** A select (trigger / pinch) started on pointer `id`. True if the menu took it. */
  select(id) {
    const s = this.pointers.get(id);
    if (!s || !s.hasRay) return false;
    if (s.wristT >= 0) {
      this.pressWrist();
      return true;
    }
    if (s.panelT >= 0) {
      if (s.panelButton >= 0) this.activate(s.panelButton);
      return true; // the panel's background swallows it too
    }
    return false;
  }

  /** Distance along pointer `id`'s ray to the menu, or null if it misses. */
  hitDistance(id) {
    const s = this.pointers.get(id);
    if (!s || !s.hasRay) return null;
    if (s.wristT >= 0) return s.wristT;
    if (s.panelT >= 0) return s.panelT;
    return null;
  }

  // --- internals ---------------------------------------------------------------

  pointer(id) {
    let s = this.pointers.get(id);
    if (!s) {
      s = new PointerState(id);
      this.pointers.set(id, s);
      this.pointerList.push(s);
    }
    return s;
  }

  activate(i) {
    const b = this.buttons[i];
    if (!b) return;
    this.lastPress = this.time;
    this.flashButton = i;
    this.flashUntil = this.time + FLASH;
    this.dirty = true;
    if (b.kind === 'close') this.close();
    else if (b.kind === 'exit') {
      this.close();
      this.onAction?.({ type: 'exit' });
    } else if (b.kind === 'scene') this.onAction?.({ type: 'scene', id: b.id });
    else this.onAction?.({ type: 'toggle', key: b.key });
    if (this.opened && this.dirty) this.draw(); // show the flash this frame
  }

  pressWrist() {
    this.lastPress = this.time;
    this.wristFlashUntil = this.time + FLASH;
    this.toggle();
  }

  // Distance along a ray to the panel's face, or -1. Sets hitX/hitY (mm from
  // the top left). Rays from behind, or going away from the face, miss.
  rayPanel(origin, dir) {
    const o = this.tmp.v.copy(origin).applyMatrix4(this.panelInverse);
    const d = this.tmp.d.copy(dir).transformDirection(this.panelInverse);
    if (o.z <= 0 || d.z >= -1e-6) return -1;
    const t = -o.z / d.z;
    const x = o.x + d.x * t, y = o.y + d.y * t;
    if (Math.abs(x) > this.widthM / 2 || Math.abs(y) > this.heightM / 2) return -1;
    this.hitX = (x + this.widthM / 2) * 1000;
    this.hitY = (this.heightM / 2 - y) * 1000;
    return t;
  }

  rayWrist(origin, dir) {
    const o = this.tmp.v.subVectors(origin, this.wristPos);
    const oz = o.dot(this.wristZ), dz = dir.dot(this.wristZ);
    if (oz <= 0 || dz >= -1e-6) return -1;
    const t = -oz / dz;
    o.addScaledVector(dir, t);
    return o.lengthSq() < (WRIST_SIZE / 2 + 0.002) ** 2 ? t : -1;
  }

  buttonAt(x, y) {
    const bs = this.buttons;
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i];
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return i;
    }
    return -1;
  }

  updateWrist(wrist) {
    let shown = false;
    if (wrist) {
      const z = this.wristZ.copy(wrist.normal).normalize();
      this.wristPos.copy(wrist.position);
      const toHead = this.tmp.v.subVectors(this.head.position, this.wristPos).normalize();
      shown = z.dot(toHead) > (this.wristShown ? WRIST_HIDE : WRIST_SHOW);
      if (shown) {
        // Glyph upright along `up`, or along the head's up if that's edge-on.
        const y = this.wristY.copy(wrist.up).addScaledVector(z, -wrist.up.dot(z));
        if (y.lengthSq() < 1e-6) y.set(0, 1, 0).applyQuaternion(this.head.quaternion).addScaledVector(z, -y.dot(z));
        y.normalize();
        this.wristX.crossVectors(y, z);
        this.wristButton.position.copy(this.wristPos);
        this.wristButton.quaternion.setFromRotationMatrix(this.tmp.m.makeBasis(this.wristX, y, z));
      }
    }
    if (!shown) {
      this.wristHover = false;
      for (let i = 0; i < this.pointerList.length; i++) this.pointerList[i].wristT = -1;
    }
    this.wristShown = shown;
    this.wristButton.visible = shown;
  }

  // Button rects (mm), help text lines and the panel's size for the current content.
  layout() {
    const c = this.content, ctx = this.ctx;
    const bs = this.buttons;
    bs.length = 0;
    let y = PAD + TITLE_H + 10;
    if (c.scenes.length) {
      const w = (INNER - GAP * (c.scenes.length - 1)) / c.scenes.length;
      c.scenes.forEach((s, i) => bs.push({ kind: 'scene', x: PAD + i * (w + GAP), y, w, h: BUTTON_H, label: s.label, on: s.current, id: s.id }));
      y += BUTTON_H + GAP;
    }
    for (const t of c.toggles) {
      bs.push({ kind: 'toggle', x: PAD, y, w: INNER, h: BUTTON_H, label: t.label, on: t.on, key: t.key });
      y += BUTTON_H + GAP;
    }
    this.helpLines = [];
    if (c.help) {
      ctx.font = `${HELP_SIZE}px ${FONT}`;
      let line = '';
      for (const word of c.help.split(/\s+/)) {
        if (!word) continue;
        const next = line ? `${line} ${word}` : word;
        if (line && ctx.measureText(next).width > INNER) {
          this.helpLines.push(line);
          line = word;
        } else line = next;
      }
      if (line) this.helpLines.push(line);
      this.helpY = y + 4;
      y += 4 + this.helpLines.length * HELP_LINE + 6;
    } else {
      y += 2;
    }
    const half = (INNER - GAP) / 2;
    bs.push({ kind: 'exit', x: PAD, y, w: half, h: BUTTON_H, label: c.exitLabel });
    bs.push({ kind: 'close', x: PAD + half + GAP, y, w: half, h: BUTTON_H, label: 'Close' });
    if (bs.length > MAX_BUTTONS) bs.length = MAX_BUTTONS;
    y += BUTTON_H + PAD;

    this.height = y;
    const px = Math.ceil(y * PX_PER_MM);
    this.heightM = px / PX_PER_MM / 1000;
    if (px > this.canvas.height) {
      // Rare (lots of toggles): a bigger canvas needs a new GPU texture.
      this.canvas.height = Math.ceil(px / 64) * 64;
      this.texture.dispose();
    }
    // Show only the used top part of the canvas.
    const used = px / this.canvas.height;
    this.texture.repeat.set(1, used);
    this.texture.offset.set(0, 1 - used);
    this.panelMesh.scale.set(this.widthM, this.heightM, 1);
    if (this.flashButton >= bs.length) this.flashButton = -1;
    this.hoverMask = 0;
    this.dirty = true;
  }

  draw() {
    this.dirty = false;
    const ctx = this.ctx, c = this.content;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(PX_PER_MM, 0, 0, PX_PER_MM, 0, 0); // draw in mm

    roundRect(ctx, 0.5, 0.5, W - 1, this.height - 1, CORNER);
    ctx.fillStyle = GLASS;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = GLASS_EDGE;
    ctx.stroke();

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = INK;
    this.fitText(c.title, INNER, TITLE_SIZE, 650);
    ctx.fillText(c.title, PAD + 2, PAD + TITLE_H / 2);

    for (let i = 0; i < this.buttons.length; i++) {
      this.drawButton(this.buttons[i], (this.hoverMask & (1 << i)) !== 0, i === this.flashButton);
    }

    if (this.helpLines.length) {
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle = INK_DIM;
      ctx.font = `${HELP_SIZE}px ${FONT}`;
      for (let i = 0; i < this.helpLines.length; i++) ctx.fillText(this.helpLines[i], PAD, this.helpY + i * HELP_LINE + 1.5);
    }
    this.texture.needsUpdate = true;
  }

  drawButton(b, hover, flash) {
    const ctx = this.ctx;
    const filled = (b.kind === 'scene' && b.on) || b.kind === 'exit';
    let fill, ink, stroke = null;
    if (flash) {
      fill = FLASH_FILL;
      ink = ACCENT_INK;
    } else if (b.kind === 'exit') {
      fill = hover ? EXIT_HOVER : EXIT;
      ink = '#fff';
    } else if (filled) {
      fill = hover ? ACCENT_HOVER : ACCENT;
      ink = ACCENT_INK;
    } else {
      fill = hover ? FILL_HOVER : FILL;
      ink = INK;
      stroke = hover ? ACCENT : b.kind === 'toggle' && b.on ? 'rgba(255, 197, 138, 0.7)' : OUTLINE;
    }
    roundRect(ctx, b.x, b.y, b.w, b.h, BUTTON_CORNER);
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.lineWidth = hover ? 2 : 1.25;
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
    if (filled && hover && !flash) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    }

    const cy = b.y + b.h / 2 + 0.5;
    ctx.fillStyle = ink;
    ctx.textBaseline = 'middle';
    if (b.kind !== 'toggle') {
      ctx.textAlign = 'center';
      this.fitText(b.label, b.w - 12, LABEL_SIZE, 600);
      ctx.fillText(b.label, b.x + b.w / 2, cy);
      return;
    }

    // Toggle: label on the left, a switch and its state on the right.
    const sw = 30, sh = 16, sx = b.x + b.w - 12 - sw, sy = b.y + (b.h - sh) / 2;
    ctx.textAlign = 'left';
    this.fitText(b.label, sx - b.x - 50, LABEL_SIZE, 600);
    ctx.fillText(b.label, b.x + 14, cy);
    ctx.textAlign = 'right';
    ctx.font = `600 ${LABEL_SIZE - 2}px ${FONT}`;
    ctx.fillStyle = flash ? ACCENT_INK : b.on ? ACCENT : INK_DIM;
    ctx.fillText(b.on ? 'On' : 'Off', sx - 7, cy);
    roundRect(ctx, sx, sy, sw, sh, sh / 2);
    ctx.fillStyle = b.on ? ACCENT : 'rgba(246, 238, 233, 0.22)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(b.on ? sx + sw - sh / 2 : sx + sh / 2, sy + sh / 2, sh / 2 - 2, 0, Math.PI * 2);
    ctx.fillStyle = b.on ? ACCENT_INK : INK;
    ctx.fill();
  }

  // Set the font, shrunk if needed so `text` fits in `maxWidth`.
  fitText(text, maxWidth, size, weight) {
    const ctx = this.ctx;
    ctx.font = `${weight} ${size}px ${FONT}`;
    const width = ctx.measureText(text).width;
    if (width > maxWidth) ctx.font = `${weight} ${Math.max(size * 0.6, (size * maxWidth) / width).toFixed(2)}px ${FONT}`;
  }

  // Redraws only when its look changes: hover, open/closed, press flash.
  drawWrist() {
    const flash = this.time < this.wristFlashUntil;
    const key = flash ? 4 : (this.wristHover ? 2 : 0) + (this.opened ? 1 : 0);
    if (key === this.wristDrawn) return;
    this.wristDrawn = key;
    const ctx = this.wristCtx, s = WRIST_PX / 2;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, WRIST_PX, WRIST_PX);
    ctx.setTransform(s, 0, 0, s, s, s); // unit circle

    const lit = flash || this.wristHover;
    ctx.beginPath();
    ctx.arc(0, 0, 0.96, 0, Math.PI * 2);
    ctx.fillStyle = flash ? FLASH_FILL : lit ? ACCENT : 'rgba(24, 28, 52, 0.92)';
    ctx.fill();
    ctx.lineWidth = 0.08;
    ctx.strokeStyle = lit ? '#fff' : ACCENT;
    ctx.stroke();

    ctx.strokeStyle = lit ? ACCENT_INK : INK;
    ctx.lineCap = 'round';
    ctx.lineWidth = 0.13;
    ctx.beginPath();
    if (this.opened && !flash) {
      // Open: an X, since pressing it again closes the panel.
      ctx.moveTo(-0.3, -0.3); ctx.lineTo(0.3, 0.3);
      ctx.moveTo(0.3, -0.3); ctx.lineTo(-0.3, 0.3);
    } else {
      for (let y = -0.3; y < 0.31; y += 0.3) {
        ctx.moveTo(-0.38, y);
        ctx.lineTo(0.38, y);
      }
    }
    ctx.stroke();
    this.wristTexture.needsUpdate = true;
  }
}
