# Wings

Birds and butterflies that run in the browser on desktop and phones, and in VR or passthrough AR on Meta Quest headsets. Built with [three.js](https://threejs.org) and WebXR. There's no build step: it's static files plus three.js loaded from a CDN.

Pick a scene from the tabs at the top of the page. In VR/AR, look at the back of your left wrist (or at your left controller) and tap the round menu button, or press B / Y. A menu panel opens where you can switch scenes, toggle options and exit. In phone AR the scene tabs sit in the top-left corner.

## Scenes

### Murmuration (birds)

A flock of starlings at dusk.

- **Flocking**: about 700–1500 birds (up to 3000) steer with the classic boids rules (separation, alignment, cohesion), using a hashed spatial grid so each step stays roughly linear in the number of birds. A slowly drifting target loosely tethers the flock, so it sweeps around the sky as one cloud and changes shape as it goes.
- **Startle waves**: a frightened bird panics, and the panic spreads from neighbour to neighbour, fading as it goes. That's the ripple you see in real murmurations.
- **Hawk** (optional): a predator circles above the flock and dives at a bird now and then. The flock bursts away from it.
- **Birds avoid you**: in VR or AR they swerve around your head and your hands.
- **Wave them away**: with hand tracking (or a controller), a quick wave or flick of the hand sends a gust along the swing. It scatters the part of the flock it reaches, and the startle spreads from there. A faint ripple at your hand shows the wave registered.
- **Rendering**: all birds are drawn in a single instanced draw call. The wing beats run in the vertex shader. Each bird banks into its turns and alternates between flapping and gliding.

### Butterfly meadow

A summer meadow full of flowers and a few dozen butterflies of eight species.

- **Behaviour**: butterflies flutter in zig-zag legs from flower to flower, glide now and then, land, and bask, slowly opening and closing their wings.
- **Landing on your hand**: hold a hand still, palm or back of the hand facing up, and after a moment a nearby butterfly *sometimes* comes over and lands on it. A palm takes up to two. It rides along while you move gently, and flies off if you move suddenly, turn your hand over, or after a while.
- **Other perches**: a Quest controller held level works too, and gives a small haptic tick when a butterfly lands on it. On desktop and phones, press and hold still to hold out a flower instead.
- **Shooing and calling**: tapping, pulling the trigger or waving your hand near butterflies shoos them away. Grip (or a left-hand pinch) calls them over to flutter around your hand.
- **AR**: you get a ring of flowers around your feet, with the butterflies flying in your room.

## Controls

| Where | Look around | Birds | Butterflies |
| --- | --- | --- | --- |
| Desktop | drag to orbit, scroll to zoom | click or hold the right button to scatter · `H` toggles the hawk | press and hold still to hold out a flower · click to shoo |
| Phone | drag to orbit, pinch to zoom; the **Inside** view uses the gyroscope | tap to scatter | hold your finger still to hold out a flower · tap to shoo |
| Quest, controllers | your head | swing to scatter · trigger beam · grip calls · A / X hawk | hold a controller level and still · swing or trigger shoos · grip calls |
| Quest, hand tracking | your head | wave to scatter · right pinch beam · left pinch calls | hold a hand still, palm or back up · wave or right pinch shoos · left pinch calls |
| Phone AR | move the phone | tap to scatter | tap to shoo |

In VR/AR, the menu (wrist button or B / Y) switches scenes, toggles the hawk and exits. Poke its buttons with a fingertip, or point and pinch / pull the trigger.

The **Inside the flock** / **Stand in the meadow** button puts the camera in the middle of the scene at standing height, like VR without a headset. On phones it follows the gyroscope, and dragging adjusts the heading. iOS asks for motion permission the first time.

In AR the flock shrinks to fit your room. It centres on where you stand and flies between knee and head height.

**URL options:**
- `?scene=birds` or `?scene=butterflies` picks the scene.
- `?birds=2000` sets the flock size, and `?hawk=1` starts with the hawk.
- `?butterflies=80` sets how many butterflies there are.

Settings are remembered per browser.

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
- **iPhone / iPad Safari**: there's no WebXR, so you get the 3D view and the gyroscope-driven *Inside* view.
- **Desktop Chrome / Edge with a PC VR headset** (SteamVR, Quest Link): *Enter VR* works the same as on Quest.

## Code layout

```
index.html              page, scene menu, import map (three.js r180 from jsDelivr)
style.css
src/main.js             scene host: renderer, views, input (bursts, beams, calls, perches), XR lifecycle, UI
src/scenes/murmuration.js   the birds scene
src/scenes/meadow.js        the butterfly scene
src/flock.js            boids simulation (Flock) and the hawk (Predator); pure JS, no three.js
src/birds.js            bird geometry and the instanced, wing-flapping material
src/butterflies.js      butterfly behaviour (ButterflySwarm) and the instanced wing-flapping mesh
src/butterflyAtlas.js   procedurally painted wing patterns for the eight species
src/meadowFlora.js      flowers (with landing spots) and wind-swayed grass
src/perch.js            stillness tracking for hands/controllers, and the hold-out flower
src/environment.js      sky shader, terrain, lake, trees, lights, fog (dusk and day presets)
src/xr.js               WebXR support check, session start, controller and hand input, gestures (waves), hand/controller perches
src/xrMenu.js           the in-headset menu panel and wrist button
src/ripples.js          the ripple a hand wave leaves
src/look.js             first-person look controls (gyroscope or drag)
```

A scene is a small object with an environment, content, settings, hints and `update(dt, input)`. The interface is documented at the top of `src/main.js`, so adding another scene means writing one module and listing it in `SCENES`.

- **Flocking** parameters live in `FLOCK_PARAMS` in `src/flock.js`. The simulation works in metres, inside a soft-walled cylinder about 32 m across, so you can tune it without touching the rendering code.
- **Butterfly behaviour** is set by `BUTTERFLY_PARAMS` in `src/butterflies.js`. For example, `perchDelay` and `perchRate` control how long you have to hold still and how readily a butterfly comes to you.
