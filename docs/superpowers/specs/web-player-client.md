# Web player client: character, camera, and mobile touch UI

Status: proposed, awaiting approval.

## Intent

The web port can draw a place and stream snapshots, but it still opens as a
spectator: the browser flies its own camera and nothing drives the local
`Player1` character. This design makes the web client a playable client:
a character the player controls in third person (with a smooth zoom into
first person), camera-relative movement and jumping, and a touch layout that
feels like Roblox on a phone. It also replaces the debug readout with a small
stats button and a panel that stays out of the way.

## Goals

- Control the server's existing local character from the browser: move,
  walk direction follows the camera, jump, and follow the engine's
  automatic respawn (the controller and camera rebind; no manual reset
  button in this pass).
- Third-person orbit camera by default; wheel/pinch zoom from far to
  first person; drag or mouse look; camera collision with the scene.
- Mobile touch controls modelled on Roblox: a fixed analog joystick at the
  lower left, a jump button at the lower right, and a look area everywhere
  else. Safe-area aware, landscape first, usable in portrait.
- A compact top-left bar with the Rook mark, a stats button, and a
  fullscreen button on browsers that support it. FPS, ping, place, parts
  and connection status live in the panel behind the stats button.
- Keep the browser thin: the session remains authoritative for the
  character and the world; the browser sends input and draws.
- Keep performance: no per-frame DOM work beyond the stats readout, no
  new per-frame allocations in the hot path, and no extra network frames
  when the player is idle.

## Non-goals

- Full Roblox `PlayerModule` parity: shift lock, VR, gamepad UI, touch
  buttons placed by the game, and the Roblox top bar are not in scope.
- Shipping or downloading Roblox's CoreScripts. Rook's own PlayerModule
  remains future work.
- Multiple players sharing one session. The web server still has one local
  player; every connected browser controls the same character.
- Text input from the mobile keyboard into in-game TextBoxes. The existing
  key events still work with a hardware keyboard.
- Exact camera occlusion; the first pass uses a coarse scene collision grid.

## Constraints

- The existing Play session already spawns a character and runs client-side
  physics; the browser must not duplicate that simulation.
- The engine has no built-in PlayerModule in this build, and Roblox's
  PlayerModule needs downloaded packages and a developer build. The solution
  must work from the web server as built today.
- Keep the Cargo workspace and the web client buildable in CI; heavy builds
  stay in GitHub Actions.
- Apache-2.0: modified upstream files stay noted in `NOTICE`/docs.

## Current state

The web port draws and streams the place, but nothing drives the local
character and the browser owns a free camera. Two uncommitted changes are
the base this builds on: the draw-call batching in `world.ts` and
`materials.ts` (51 FPS on the test phone), and the welcome-time GUI layout
sync. They should be committed first so this work's diff is only the
player client.

## Approaches considered

1. **Small web controller in Luau + browser camera (chosen).** A LocalScript
   in the client's `PlayerScripts` reads a movement vector from a player
   attribute and calls `Humanoid:Move`; the browser owns the orbit camera and
   the touch UI. This follows the engine's client-owned character model,
   needs no downloaded packages, and gives us full control of the touch
   experience. The trade-off is that we implement camera feel ourselves.
2. **Roblox PlayerModule.** Download the Studio DataModelPatch at runtime
   and build the server with developer overrides. Most authentic, but
   depends on the network and packages, and the engine has no browser touch
   input path for `UserInputService` yet. Rejected for this pass; it can
   replace the web controller later.
3. **Rust-side controller.** The browser sends a vector and the session sets
   `Humanoid.MoveDirection`/`Jump` directly. Avoids Luau, but duplicates the
   Humanoid controller and bypasses the client ownership model. Rejected.

## Server design

### Protocol

Add a player description to the welcome and every snapshot:

```ts
interface PlayerInfo {
  root: number | null;   // net id of HumanoidRootPart
  head: number | null;   // net id of Head
  parts: number[];       // net ids of all rendered character parts
}
```

- `Welcome` gains `player: PlayerInfo | null`, `play: boolean`, and
  `controller: boolean`. `play` tells the browser whether this session has
  a local player at all (`--run` has none); `controller` says the injected
  movement controller is running, so a place with its own `PlayerModule`,
  `ControlScript` or `CameraScript` leaves the browser in spectator mode
  instead of showing a dead joystick.
- `Snapshot` gains `player: PlayerInfo | null`. It is small and sent every
  snapshot so respawns and character teardown need no extra change flag.
- `PartSnapshot` gains `anchored: boolean`, read from `BasePart.Anchored`
  (terrain entries are anchored). The camera collision grid uses it to
  index only geometry that is not expected to move.
- Add `ClientMessage::Move { x: f32, z: f32 }`: a world-space horizontal
  direction, length at most 1. The browser computes it from its camera yaw.

`PlayerInfo` is read from the session's client DataModel: local player ->
`Character` -> `HumanoidRootPart` and `Head`, plus every rendered BasePart
descendant. Net ids come from the existing `NetIds` map; no new ids are
minted for missing entries. `NetIds` gains a reverse index from an
instance's raw id to its drawn ids, so a character's face decal and other
layers are included without scanning every net id each snapshot.

The welcome is built before the character necessarily exists, so `player`
may be null there even in Play mode; `play` says whether to wait for one.
The browser keeps the saved view until the first snapshot with a player,
then snaps the orbit camera to the character.

### Movement bridge

`Command::Move` stores the vector on the local player as the `RookMove`
attribute (a `Vector3`). The attribute is set only when it changes by more
than a small epsilon, but the session's watchdog is refreshed by every
`Move`, changed or not. The browser repeats the vector at 30 Hz while it is
non-zero, so a held direction is a steady stream; the session zeroes it
after 500 ms without one, so a closed tab or a backgrounded phone cannot
leave the character walking. The browser also sends zero on `blur`,
`pagehide`, and `visibilitychange`.

### Controller injection

The session passes a small controller as `Setup.client_script`, so the
client runs it as `PlayerScripts.RookScript` immediately after its own
LocalScripts start. The controller's first lines return if the player
already has a `PlayerModule`, `ControlScript`, or `CameraScript`; places
that bring their own controller keep it, and the browser then follows the
server camera as it does today. The source lives next to the server and is
included with `include_str!`.

The controller:

- waits for `Players.LocalPlayer.Character` and its `Humanoid`;
- on every `Heartbeat`, reads `RookMove` and calls
  `Humanoid:Move(vector, false)` when the humanoid is alive, and stops
  instead while `UserInputService:GetFocusedTextBox()` returns a box;
- re-binds on `CharacterAdded`;
- jumps on `Space` through `UserInputService.InputBegan`, ignoring input
  the GUI already processed and any jump while a TextBox has focus.

`Humanoid:Move` with a world-space vector keeps the engine's normal
auto-rotation and walk speed. The character remains client-owned; poses
continue to replicate to the server thread as they do now.

The controller runs after the engine's own `note_camera_scripts` check, so
it never makes `scripted_camera` true: the browser keeps the camera. A
place that does bring camera code still takes the camera back.

### Scene focus

While a local character exists, `step_scene` focuses terrain/content loads
on the character's root rather than the browser camera. This keeps streaming
correct when the camera is far away and removes the need for high-frequency
camera messages in player mode.

## Browser camera

A `PlayerCamera` replaces the free camera when a local character exists and
the game is not driving the camera.

- **Target:** the head part (fallback: root + 1.5 studs), smoothed with an
  exponential follow so snapshots at 20 Hz look continuous.
- **Orbit:** yaw around Y, pitch on X, clamped to about ±85°. Mouse drag,
  pointer lock, and one-finger drag all feed the same yaw/pitch.
- **Distance:** default 12.5, min 0.5, max 32; wheel and two-finger pinch
  change it smoothly. The min distance enters first person.
- **First person:** below ~1.5 studs the local character's parts are hidden
  by the `World` (`setHiddenParts`), so the camera can sit at the head
  without seeing the inside of the head. A little hysteresis avoids flicker
  at the threshold. Hidden parts are zero-scaled in their pool or made
  invisible as individual meshes, so the batching path is kept.
- **Collision:** `World` keeps a coarse uniform grid of anchored part
  AABBs from the welcome and from parts created later. Each frame a short
  ray from the head to the desired camera position is tested against the
  cells it crosses; the camera is pulled in to the nearest hit.
  Transparent, overlay, tiny, unanchored, and local-character parts are
  ignored; boxes whose part was destroyed are skipped. An indexed part
  whose transform or size changes is dropped from the grid, so a moving
  door or platform stops colliding instead of leaving a stale box. This is
  intentionally approximate and can be disabled with `?cameraCollision=0`.
- **Fallback:** no local character or `--run` keeps the existing fly camera;
  a camera the game marks scripted is applied from snapshots and disables
  both local cameras. When `controller` is false (the place brought its own
  controller), the joystick and jump stay hidden and the browser behaves as
  a spectator; a Play session waiting for its character holds the saved
  view instead of flying away.
- **World API:** `World` keeps the latest `PlayerInfo` from the welcome and
  snapshots (updating the collision exclusion before new parts are added),
  `World.step(now)` interpolates and places parts, `World.render(now)` draws,
  `World.partTransform(id, now)` returns the interpolated head/root
  transform, and `World.setHiddenParts(ids)` hides or restores the local
  character. `main` runs `step`, then the camera, then `render`, so the
  camera follows the same frame the browser draws.

The camera uses the place's saved FOV. Zoom is local; no server round trip.

## Browser input

### Movement

- Desktop: WASD or arrow keys, analog 1. Mobile: the joystick's analog
  magnitude.
- Direction is camera-relative: forward/right from the camera yaw, combined
  and clamped to length 1. The world-space result is sent as `Move` at 30 Hz
  while it is non-zero, and immediately as zero when it stops, so holding a
  direction is a stream the session can time out. If a script takes the
  camera while the controller is active, the yaw comes from the scripted
  camera snapshot instead of the orbit camera.
- Space jumps; the mobile jump button sends the same `Space` key events.
- The existing key/mouse events continue to reach the engine for scripts and
  GUI.

### Look and zoom

- Desktop: click to lock the pointer, move to orbit, wheel to zoom;
  right-button drag also works without locking. Escape releases the lock.
- Mobile: one-finger drag on the look area; two-finger pinch zooms. The
  joystick, jump button, top bar, stats panel, and interactive game GUI
  take their own pointers first.
- Touch/mouse sensitivity is configurable in one place; touch is higher.
- A touch that starts on the canvas is a look drag; if it ends almost where
  it began, it also becomes a click for the engine (mouse move, down, up) so
  ClickDetectors and tool activation still work. A touch on an interactive
  GUI node stays with the GUI; the joystick, jump button and top bar take
  their own pointers with capture.
- `touch-action: none`, `overscroll-behavior: none` and
  `user-scalable=no` keep the browser from scrolling or zooming the page.

## Mobile UI

Reference: the supplied Roblox mobile layout. The black pill on the left is
the iPhone Dynamic Island and is ignored; safe-area insets still keep our
controls clear of it.

- **Top-left bar:** a translucent dark pill holding the Rook mark, a stats
  button, and a fullscreen button (when supported). Height 52 px on touch,
  44 px on desktop. Buttons are 44×44 px with pressed feedback.
- **Stats panel:** opens below the bar. Rows for FPS, ping, place, parts,
  draw calls, triangles, light slots, resolution, brightness, shadows, asset
  prefetch progress, and connection status. Resolution and brightness have
  sliders with reset buttons; shadows and asset prefetch have toggles.
  Closes on outside press or Escape. The stats button carries a small
  connection dot and `aria-expanded`.
- **Joystick:** bottom left, a 132 px translucent ring with a 56 px thumb,
  fixed but with a generous hit area. Analog; dead zone 0.12; resets on
  release. Hidden on fine-pointer devices unless `?touch=1`.
- **Jump:** bottom right, a 76 px translucent circle with a white up-arrow
  SVG. Sends Space down on press and up on release. Pressed scale 0.94.
- **Look:** everywhere else. A first-run hint fades after the first drag.
- **Safe areas:** every fixed control uses `env(safe-area-inset-*)` plus a
  base inset. The joystick and jump never sit under the home indicator.
- **Landscape first:** the layout above is the landscape layout. In portrait
  the same corners are used with slightly smaller controls; no blocking
  "rotate" screen.
- **Loading/status:** full-screen loading with the Rook mark and spinner;
  a top-center "Reconnecting…" toast for a lost socket.
- **Desktop:** the joystick/jump are hidden; a small controls hint sits at
  the bottom center and fades after the first input.

Visual direction: dark translucent glass, 12–16 px radii, 1 px white-at-12%
borders, soft blue accent, green/amber/red connection states. No external
fonts or image assets; inline SVG icons and the existing `/rook.svg`. Motion
is 150–220 ms and respects `prefers-reduced-motion`.

## Performance

- `World` splits its frame into `step(now)` (transform interpolation and
  pool flushes) and `render(now)` (sun/sky around the camera, draw,
  adaptive resolution), so the camera can use this frame's character
  position before rendering.
- Static parts keep the current "no per-frame work" path; the camera reads
  the already-computed head/root positions.
- Move messages are throttled to 30 Hz; idle clients send nothing, and the
  session stops a character whose client went quiet.
- The stats DOM is written at most twice a second, and only while the
  panel is open; the panel is hidden when closed.
- The forward renderer uses fixed light slots (six point, two spot) filled
  from lights inside their own range, so shader programs never recompile as
  the nearest set changes. The sun's shadow map is redrawn only when a part
  moves or the camera travels far enough, throttled to 15 Hz on touch
  devices and 30 Hz elsewhere.
- Static instanced pools compute a bounding sphere over their live slots
  and stay frustum-culled; pools with snapshot-driven instances remain
  unculled. Interpolation follows the measured snapshot interval (30–60 ms)
  instead of a fixed window.
- The collision grid is built incrementally and only queried for a short
  ray; no per-frame scene scan.

## Testing

- `npx tsc --noEmit` and `npm run build` in `web-client`.
- `cargo check -p rook-web-server` locally if feasible; the CI workflow
  builds x86_64 and arm64.
- Extend `apps/rook-web-server/tests/smoke.py`: assert the welcome says
  `controller` and `play`, read snapshots until `player.root` exists (the
  character can spawn a frame after the welcome), send a `Move` vector
  every 50 ms for about a second, assert the root appears in
  `updatedTransforms` and its position changed, then send zero and assert
  the root stops. This exercises the protocol, the injected controller,
  the watchdog and the session.
- Manual on the Android phone: joystick, look, pinch zoom, jump, first-person
  transition, stats panel, fullscreen, safe areas, background/foreground
  (movement must stop when the tab hides).
- Manual desktop: pointer lock, wheel zoom, collision near a wall, and the
  fly-camera fallback with `--run`.

## Decisions left to the builder

- Exact camera sensitivity constants and smoothing rates.
- Whether the stats panel has a compact single-row form on very short
  landscape screens.
- Exact joystick ring/thumb sizes within the stated touch targets.
- How aggressively camera collision ignores small/transparent parts.
