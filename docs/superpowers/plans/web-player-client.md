# Web Player Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the web client playable: drive `Player1` with camera-relative movement and jumping, add a Roblox-style third/first-person orbit camera, and replace the debug HUD with a compact mobile touch layout.

**Architecture:** A small Luau controller injected as `Setup.client_script` reads a world-space move vector from the local player's `RookMove` attribute and calls `Humanoid:Move`. The browser owns the orbit camera, computes the camera-relative vector, and sends it over the existing WebSocket. The server adds `PlayerInfo` (root/head/parts) to welcome and snapshots, plus a `controller` flag and `anchored` part data for camera collision.

**Tech Stack:** Rust (Axum, MessagePack), Luau, TypeScript, Three.js, HTML/CSS.

**Spec:** `docs/superpowers/specs/web-player-client.md`

## Global Constraints

- Branch `web-port`, mirrored to `main`; commit after each task.
- Server authoritative; browser sends input and draws.
- 60 Hz session, 20 Hz snapshots, 30 Hz move stream while non-zero.
- Apache-2.0; keep `LICENSE`/`NOTICE` current.
- `cargo check -p rook-web-server` and `npx tsc --noEmit` must pass locally.
- No external fonts or image assets; inline SVG plus `/rook.svg`.
- `prefers-reduced-motion` respected; touch targets at least 44 px.

## Review Focus

- A held direction must keep moving past the 500 ms watchdog (30 Hz stream; watchdog refreshed by every `Move`).
- A place with its own `PlayerModule`/`ControlScript`/`CameraScript` must not show a dead joystick (`controller` flag; spectator fallback).
- Typing in a TextBox must not walk the character (`GetFocusedTextBox`).
- First person must not show the inside of the head (hide character parts with hysteresis).
- Mobile controls must not scroll the page or steal interactive GUI pointers.

---

### Task 1: Server protocol and player info

**Files:**
- Modify: `apps/rook-web-server/src/protocol.rs`
- Modify: `apps/rook-web-server/src/session.rs`
- Modify: `apps/rook-web-server/src/main.rs`

**Interfaces:**
- `PlayerInfo { root: Option<u64>, head: Option<u64>, parts: Vec<u64> }`
- `Welcome { player: Option<PlayerInfo>, play: bool, controller: bool, .. }`
- `Snapshot { player: Option<PlayerInfo>, .. }`
- `PartSnapshot { anchored: bool, .. }`
- `ClientMessage::Move { x: f32, z: f32 }`
- `Command::Move { x: f32, z: f32 }`
- `NetIds::ids_of(&self, raw: u64) -> &[u64]`
- `Session::player_info(&self) -> Option<PlayerInfo>`
- `Session::has_own_controller(&self) -> bool`
- `Session::set_move(&mut self, x: f32, z: f32)`
- `Session::expire_move(&mut self)`

- [ ] Add the wire types and the `Move` message; add `anchored` to `PartSnapshot` and to `transform_only`'s comparison.
- [ ] Add `NetIds.by_instance` and maintain it in `id`/`remove`; add `ids_of`.
- [ ] In `entries()`, set `anchored` from `BasePart.Anchored` for layer 0, false for layers, true for terrain.
- [ ] Add `Session::player_info` (local player -> character -> `HumanoidRootPart`/`Head` + drawn descendant ids), `has_own_controller` (PlayerScripts names), `set_move` (clamp, write `RookMove` only when changed), `expire_move` (zero after 500 ms).
- [ ] Fill `player`, `play`, `controller` in the welcome and `player` in snapshots; focus `step_scene` on the character root.
- [ ] Map `ClientMessage::Move` to `Command::Move` in `main.rs`; call `expire_move` each loop.
- [ ] Run `cargo check -p rook-web-server`; commit.

### Task 2: Luau controller

**Files:**
- Create: `apps/rook-web-server/src/player_controller.luau`
- Modify: `apps/rook-web-server/src/session.rs`

**Interfaces:**
- The controller reads `LocalPlayer:GetAttribute("RookMove")` (Vector3), calls `Humanoid:Move(vector, false)` on `Heartbeat`, re-binds on `CharacterAdded`, jumps on `Space`, and returns early if `PlayerScripts` has `PlayerModule`, `ControlScript`, or `CameraScript`.

- [ ] Write the controller with the guard, focus check, and jump handler.
- [ ] Pass it as `Setup.client_script` when `play` is true.
- [ ] Run `cargo check -p rook-web-server`; commit.

### Task 3: Smoke test movement

**Files:**
- Modify: `apps/rook-web-server/tests/smoke.py`

- [ ] Assert `welcome.play` and `welcome.controller`.
- [ ] Read snapshots until `player.root` exists; record its position.
- [ ] Send `{"kind":"move","x":1.0,"z":0.0}` every 50 ms for ~1 s; assert the root appears in `updatedTransforms` with a changed position.
- [ ] Send zero; assert the root stops moving.
- [ ] Run the test against a locally built server; commit.

### Task 4: Client wire types

**Files:**
- Modify: `web-client/src/protocol.ts`

- [ ] Add `PlayerInfo`, `Welcome.player/play/controller`, `Snapshot.player`, `PartSnapshot.anchored`, and `ClientMessage` `move`.
- [ ] Run `npx tsc --noEmit`; commit.

### Task 5: World step/render, collision grid, hidden parts

**Files:**
- Modify: `web-client/src/world.ts`

**Interfaces:**
- `World.player: PlayerInfo | null`
- `World.step(now: number): void`
- `World.render(now: number): void`
- `World.partTransform(id: number, now: number): Trs | undefined`
- `World.setHiddenParts(ids: Iterable<number>): void`
- `World.collisionRay(from: THREE.Vector3, to: THREE.Vector3): number | null`

- [ ] Split `update` into `step` (interpolation + pool flush) and `render` (sun/sky + draw + adapt).
- [ ] Keep the latest `player`; update the local-character exclusion before adding parts; add anchored AABBs to a uniform grid; drop an indexed part from the grid when its transform/size changes.
- [ ] Hide pooled parts by zero-scaling their slot and individual parts with `visible = false`; restore on unhide.
- [ ] Run `npx tsc --noEmit`; commit.

### Task 6: Player camera

**Files:**
- Create: `web-client/src/player-camera.ts`

**Interfaces:**
- `PlayerCamera(world: World)`
- `update(dt: number, now: number): void`
- `look(dx: number, dy: number): void`
- `wheel(delta: number): void`
- `pinch(scale: number): void`
- `snap(): void`
- `readonly yaw: number`
- `readonly firstPerson: boolean`

- [ ] Implement head-target follow, yaw/pitch orbit, distance 0.5–32 with smoothing, collision pull-in, first-person threshold 1.5 with hysteresis, and yaw from the root's look on first snap.
- [ ] Run `npx tsc --noEmit`; commit.

### Task 7: HUD, touch controls, and wiring

**Files:**
- Modify: `web-client/index.html`
- Modify: `web-client/src/style.css`
- Modify: `web-client/src/main.ts`

- [ ] Replace the debug panel with the top-left pill (Rook mark, stats, fullscreen), stats panel, joystick, jump button, hint, reconnect toast, and loading mark.
- [ ] Add safe-area CSS, `touch-action: none`, coarse-pointer visibility, pressed states, and reduced-motion rules.
- [ ] Wire touch look/pinch, joystick analog move, jump Space events, stats toggle, fullscreen, and the 30 Hz `Move` send; zero on stop/blur/pagehide/visibilitychange.
- [ ] Use the player camera when `play && controller && !cameraScripted`; otherwise keep the fly/scripted camera.
- [ ] Run `npx tsc --noEmit` and `npm run build`; commit.

### Task 8: Docs, verification, and handoff

**Files:**
- Modify: `docs/web-port.md`
- Modify: `web-client/README.md`

- [ ] Document the player protocol, controls, `controller`/`anchored` fields, and new source files.
- [ ] Run `cargo check -p rook-web-server`, `npx tsc --noEmit`, `npm run build`, and the smoke test.
- [ ] Commit and push `web-port` and `main`; start the server for the phone test.
