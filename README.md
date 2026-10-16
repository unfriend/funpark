# Murmuration

A flock of birds (a starling murmuration at dusk) that runs in the browser on desktop and phones, and in VR or passthrough AR on Meta Quest headsets. Built with [three.js](https://threejs.org) and WebXR. There's no build step: it's static files plus three.js loaded from a CDN.

## What it does

- **Flocking**: about 700–1500 birds (up to 3000) steer with the classic boids rules (separation, alignment, cohesion), using a hashed spatial grid so each step stays roughly linear in the number of birds. A slowly drifting target loosely tethers the flock, so it sweeps around the sky as one cloud and changes shape as it goes.
- **Startle waves**: a frightened bird panics, and the panic spreads from neighbour to neighbour, fading as it goes. That's the ripple you see in real murmurations.
- **Hawk** (optional): a predator circles above the flock and dives at a bird now and then. The flock bursts away from it.
- **Birds avoid you**: in VR or AR they swerve around your head.
- **Rendering**: all birds are drawn in a single instanced draw call. The wing beats run in the vertex shader. Each bird banks into its turns and alternates between flapping and gliding.

## Controls

| Where | Look around | Scatter the flock | Call the flock | Hawk |
| --- | --- | --- | --- | --- |
| Desktop | drag to orbit, scroll to zoom | click, or hold the right mouse button and sweep | — | `H` key / Settings |
| Phone | drag to orbit, pinch to zoom; **Inside the flock** uses the gyroscope | tap | — | Settings |
| Quest VR / AR | your head | trigger (or pinch with hand tracking) | hold grip: the birds swirl around your hand | A / X button |
| Phone AR | move the phone | tap the screen | — | Settings |

**Inside the flock** puts the camera in the middle of the flock at standing height, like VR without a headset. On phones it follows the gyroscope, and dragging adjusts the heading. iOS asks for motion permission the first time.

In AR the whole flock shrinks to fit your room: it centres on where you stand and flies between knee and head height.

URL options: `?birds=2000` sets the flock size, `?hawk=1` starts with the hawk. Settings are remembered per browser.

## Running it

WebXR only works in a secure context, meaning HTTPS or `http://localhost`.

**On a desktop:**

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

Any static file server works. To try the VR path without a headset, install Meta's [Immersive Web Emulator](https://github.com/meta-quest/immersive-web-emulator) browser extension.

**On a Quest or Android phone over USB:** serve the folder as above, then forward the port so the device can open it as `localhost`:

```sh
adb reverse tcp:8000 tcp:8000
# then open http://localhost:8000 in the Quest Browser / Chrome on the phone
```

**Hosted:** the repo includes a GitHub Pages workflow (`.github/workflows/pages.yml`). It deploys on pushes to `main`, or you can run it by hand. Set **Settings → Pages → Source** to *GitHub Actions* once, then open `https://<user>.github.io/<repo>/` on any device. Any other static HTTPS host works too.

## Platform notes

- **Meta Quest Browser**: shows *Enter VR* and *Enter AR* (passthrough). Controller and hand models come from the WebXR input-profiles CDN.
- **Android Chrome** (with ARCore): shows *Enter AR*. While AR is running, a DOM overlay provides an *Exit AR* button.
- **iPhone / iPad Safari**: there's no WebXR, so you get the 3D view and the gyroscope-driven *Inside the flock* mode.
- **Desktop Chrome / Edge with a PC VR headset** (SteamVR, Quest Link): *Enter VR* works the same as on Quest.

## Code layout

```
index.html           page, UI, import map (three.js r180 from jsDelivr)
style.css
src/main.js          renderer, scene, views, pointer input, XR session lifecycle, main loop
src/flock.js         boids simulation (Flock) and the hawk (Predator); pure JS, no three.js
src/birds.js         bird geometry and the instanced, wing-flapping material
src/environment.js   dusk sky shader, terrain, lake, trees, lights, fog
src/xr.js            WebXR support check, session start, controller and hand input
src/look.js          first-person look controls (gyroscope or drag)
```

All flocking parameters live in `FLOCK_PARAMS` in `src/flock.js`. The simulation works in metres, inside a soft-walled cylinder about 32 m across, so you can tune it without touching the rendering code.
