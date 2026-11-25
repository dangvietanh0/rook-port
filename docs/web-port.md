# The web port

`rook-web-server` runs a Roblox place headlessly with Rook's own session and
streams what its local player sees to a browser. The browser is a thin
Three.js client: it draws parts, terrain, decals and lighting, interpolates
transforms, and sends keyboard, mouse and touch input back. In Play mode it
drives the local character with a Roblox-style third/first-person camera:
WASD or touch joystick, drag to look, wheel or pinch to zoom, Space or the
jump button. The DataModel, Luau VM, scheduler, replication, physics and
content resolver are the upstream Rook ones, unchanged.

The only gameplay code the web port adds is
`apps/rook-web-server/src/player_controller.luau`, injected as
`Setup.client_script` after the client's own LocalScripts start. It reads the
local player's `RookMove` attribute (a world-space direction the browser
sends) and calls `Humanoid:Move`; it returns early when the place already has
its own `PlayerModule`, `ControlScript` or `CameraScript`, and the welcome's
`controller` flag then keeps the browser a spectator.

## Running

```sh
# Build the browser client once.
cd web-client
npm install
npm run build

# Run a place. Rook's asset delivery uses ROOK_OPEN_CLOUD_API_KEY (or the
# OS credential store, via `rook key set`) for assets Roblox serves.
cd ..
cargo run -p rook-web-server --release -- path/to/place.rbxl --addr 127.0.0.1:8080
```

Then open <http://127.0.0.1:8080>. The same binary serves `web-client/dist`;
`--web-root` selects another build. `--offline` uses only the local content
cache and folders, which avoids Roblox's asset delivery.

For client development:

```sh
cd web-client
npm run dev
```

Vite serves the sources on port 5173 and proxies `/api` and `/ws` to a server
on `127.0.0.1:8080`.

## Checks

The quick gate while working on this machine:

```sh
cargo check -p rook-web-server
cd web-client && npx tsc --noEmit && npm run build
```

`.github/workflows/web-port.yml` runs the heavier checks on GitHub's
machines: `cargo fmt --check`, `cargo clippy -p rook-web-server
--all-targets -- -D warnings`, a release build, a startup smoke test, and
the client's type check and production build. The smoke test starts the
built server against a generated place and reads `/api/health`, the
WebSocket welcome (with parts, the scripted ScreenGui and the player),
then holds a movement direction and checks that the character's root part
moves and stops. Upstream's `check.yml` still covers the rest of the
workspace.

The workflow also cross-compiles the server for `aarch64-unknown-linux-gnu`
on an Ubuntu 24.04 runner and uploads the `rook-web-server-aarch64`
artifact. The runner's glibc is the ceiling for the binary, so hosts older
than 24.04 need an older runner rather than a newer one.

## Protocol

The WebSocket at `/ws` carries MessagePack frames. Every frame is one
internally-tagged `ServerMessage`: `welcome` has the whole scene the first
time, then `snapshot` frames carry deltas at 20 Hz:

- `created` and `destroyed` add and remove drawn entries;
- `updatedProps` replaces an entry's look;
- `updatedTransforms` gives just a position, quaternion and (when resized) a
  size, which the client slerps between snapshots;
- `lighting` is the current sun, ambient, fog and sky;
- `camera` is the scripted camera, when a script drives one;
- `player` is the local character: `root` and `head` net ids plus every
  drawn part, so the client can follow and hide it;
- `gui` is the local player's ScreenGuis as a tree of laid-out nodes, sent
  only when the GUI changed (the client draws it with HTML/CSS);
- `meshes` and `images` name assets loaded since the last frame.

The welcome also carries `play` (this session has a local player) and
`controller` (Rook's movement controller is running). Part entries carry
`anchored`, which the client uses to build its camera collision grid.

The browser sends `move { x, z }`, a world-space horizontal direction, at
30 Hz while a direction is held and once as zero when it stops. The session
stores it as `RookMove` on the local player and stops the character after
500 ms without a message, so a closed tab cannot leave it walking. Key,
mouse and text messages still reach the engine for scripts and GUIs; the
mobile jump button sends the same `Space` key events.

The browser asks for assets by content hash:

```text
GET /api/mesh/{hash}    positions, normals, UVs, vertex colours and indices
GET /api/image/{hash}   PNG (the first mip no larger than 1024)
GET /api/health         counters, for a quick check
```

A mesh is a small binary blob:

```text
"RKMW" | u32 version=1 | u32 vertices | u32 indices | u32 flags
f32 positions[3n] | f32 normals[3n]? | f32 uvs[2n]?
u8 colours[4n]? | u32 indices[m]
```

Flags: 1 normals, 2 UVs, 4 colours. `web-client/src/mesh.ts` is the reader.

## What is implemented

- Headless Play-mode session at 60 Hz (`Game`, `ClientHost`, `ServerThread`).
- Scene extraction through `SceneCache`, including terrain and grass entries
  that belong to no instance, using stable wire ids assigned by the session.
- Delta snapshots with part creation/removal, property changes and
  transform-only updates; client-side interpolation.
- Instanced primitives grouped by shape, material, shadow and side; individual
  meshes for textured/file parts and transparent parts.
- Decals and Textures: face planes for primitives, mesh-UV overlays for file
  meshes, tiled repeats from `Tiling`; material maps (colour, normal,
  roughness, metalness) through the same image endpoint.
- sRGB output, ACES tone mapping, hemisphere + sun light with a shadow map,
  fog, gradient sky and skybox, with exposure and the Retro tonemapper.
- Playable character: camera-relative walk, jump, automatic respawn, and a
  third-person orbit camera that zooms smoothly into first person, follows
  the head, and pulls in against anchored geometry. The character is hidden
  in first person so the camera never sits inside the head.
- Roblox-style mobile controls: a top-left glass bar with stats and
  fullscreen, an analog joystick, a jump button, drag look and pinch zoom,
  safe-area insets, and responsive portrait/landscape sizes. GUI nodes that
  are interactive keep their own pointers.
- Free spectator camera (WASD/QE/Shift, drag or pointer lock) when a place
  runs without a player or brings its own controller, input injection, and
  reconnect.
- ScreenGuis mapped to HTML/CSS: the session reads `rook-gui`'s laid-out
  `AbsolutePosition`/`AbsoluteSize`/`AbsoluteRotation` and the look
  properties (background, border, UICorner, UIStroke, text, images and
  sprite-sheet rectangles) into a node tree; the client builds absolutely
  positioned elements over the canvas. Only objects Rook would give a press
  take the pointer (an `Active` object, a button, a TextBox, a
  ScrollingFrame), so clicking one does not lock the camera and clicking an
  inactive Frame still reaches the world. Either way the click reaches
  Rook's own GUI hit-testing, which is what fires `Activated`, focuses
  TextBoxes and so on.

## Deferred

- ScreenGui fidelity: `ZIndexBehavior` is approximated as Sibling,
  CanvasGroup `GroupTransparency` is not applied to children, ScrollingFrame
  scrolling (`CanvasPosition`) is not wired, RichText markup is shown as
  plain text, and `ScaleType` Slice is drawn stretched.
- Cascaded shadow maps: one 2048² sun shadow map follows the camera for now.
- Truss parts draw nothing yet (their bar mesh is built by `rook-render` but
  is not exported as a file mesh).
- Surface patterns (studs, inlets, ...), `Highlight`s and particle effects.
- Multi-session: one place per server process; each browser connection joins
  the same player's stream.
- True asset loading budgets: the session starts streaming immediately and
  serves meshes as they decode, rather than waiting for a whole ring.

## Licensing

The new app and client are Apache-2.0, like upstream Rook. See `NOTICE` for
the modified upstream files. The client depends on Three.js (MIT),
`@msgpack/msgpack` (ISC), Vite (MIT) and TypeScript (Apache-2.0).
