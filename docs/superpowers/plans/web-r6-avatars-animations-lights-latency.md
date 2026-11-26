# Web R6 avatars, animations, local lights and latency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the web port show a player-chosen Roblox R6 avatar with official animations and clothing, light enclosed rooms from their own lights, and remove the buffering that delays local movement.

**Architecture:** The existing session thread stays authoritative. Browser input goes over the WebSocket at frame rate; the session snapshots every tick and marks the local parts for zero-delay drawing. Avatar lookups run off the session thread, then reach the server DataModel as one `ToServer::Avatar` message that renames the player, forces R6, bypasses the place's StarterCharacter for that player, and respawns it. Animations are sampled in the session from Roblox's R6 keyframe files and written to `Motor6D.Transform`. `Scene::lights` is serialized into the welcome and snapshot deltas and drawn as Three lights.

**Tech Stack:** Rust (axum, tokio, rook-engine, rook-lua, rook-formats, rook-scene), TypeScript + Three.js, MessagePack wire format.

**Spec:** `docs/superpowers/specs/web-port-r6-avatars-animations-lights-latency.md`

## Global Constraints

- Keep all existing UI controls where they are; add the avatar panel without moving them.
- Server remains authoritative; no client-side prediction.
- R6 classic only; no R15 clothing compositor, accessories, or hats this pass.
- Apache-2.0 compliance stays; no Roblox assets are embedded.
- `web-port` is mirrored to `main` when done.

## Review Focus

- A username with a space, mixed case, leading `@`, or no Roblox account must produce a panel error, never a broken or half-swapped character.
- A second avatar submitted while the first is still fetching must end with the second one, not an older result.
- A player with no Shirt or Pants must get a body-coloured R6 avatar, not a transparent or black torso.
- The local player must not lag behind the camera after a fast direction change or jump.
- A room whose only light is a PointLight must be lit; a room with no lights must stay dark.

---

### Task 1: Remove latency buffering

**Files:**
- Modify: `apps/rook-web-server/src/session.rs:21`, `:370`
- Modify: `web-client/src/main.ts:276-288`
- Modify: `web-client/src/world.ts:17`, `:806-846`, `:452-461`
- Modify: `web-client/src/player-camera.ts:78-103`

**Interfaces:**
- Produces: `SNAPSHOT` = one `STEP`; snapshots carry every tick.
- Produces: `World.setPlayer` marks local parts; `partTransform` returns the latest transform for them without interpolation.

- [ ] Send moves every frame (60 Hz cap) instead of every 33 ms.
- [ ] Snapshot every simulation step (`SNAPSHOT = STEP`).
- [ ] For ids in `world.localParts`, `applySnapshot` and `step` use the latest transform immediately.
- [ ] Camera target follows the exact head/root position with no lerp.
- [ ] `cargo check -p rook-web-server` and `npx tsc --noEmit`.

### Task 2: Engine avatar apply path

**Files:**
- Modify: `crates/rook-lua/src/api/methods/characters.rs` (public `Avatar::from_api_json`)
- Modify: `crates/rook-lua/src/api/methods/characters/appearance.rs`
- Modify: `crates/rook-lua/src/api/methods/characters/rigs.rs`
- Modify: `crates/rook-lua/src/runtime/world.rs` (`standard_avatars`)
- Modify: `crates/rook-engine/src/session/host.rs` (`ToServer::Avatar`)
- Modify: `crates/rook-engine/src/session/host/server.rs` (`deliver`)
- Modify: `crates/rook-client/src/game.rs` (`apply_avatar`)

**Interfaces:**
- Produces: `Avatar::from_api_json(&serde_json::Value) -> Avatar`.
- Produces: `ToServer::Avatar { name: String, user_id: i64, avatar: Avatar }`.
- Produces: `Game::apply_avatar(name: &str, user_id: i64, avatar: Avatar) -> bool`.
- Produces: `ServerHost::deliver` renames the player, sets `UserId`/`DisplayName`, inserts into `World.avatars` and `standard_avatars`, sets `StarterPlayer.GameSettingsAvatar = R6`, and calls `load_character`.
- Produces: `rigs::body` skips `StarterCharacter` for a standard-avatar player and always builds R6.

- [ ] Implement the public parser and the standard-avatar override.
- [ ] Add `ToServer::Avatar` and its delivery.
- [ ] Expose `Game::apply_avatar` for Play mode.
- [ ] Unit test: an R6 avatar JSON parses its colours and rig; a standard player's body is R6 even with a custom StarterCharacter.
- [ ] `cargo test -p rook-lua` (focused tests), `cargo check -p rook-client`.

### Task 3: Avatar panel, lookup and clothing

**Files:**
- Create: `apps/rook-web-server/src/avatar.rs`
- Modify: `apps/rook-web-server/src/main.rs`
- Modify: `apps/rook-web-server/src/protocol.rs`
- Modify: `apps/rook-web-server/src/session.rs` (`Command::Avatar`, `PlayerInfo.avatar`)
- Modify: `web-client/index.html`, `web-client/src/style.css`, `web-client/src/main.ts`, `web-client/src/protocol.ts`, `web-client/src/world.ts`

**Interfaces:**
- Consumes: `Game::apply_avatar` from Task 2.
- Produces: `ClientMessage::Avatar { username }` and `ServerMessage::Avatar { status }` with `state: "loading" | "error" | "ready"`, `username`, `name`, `message`.
- Produces: `PlayerInfo.avatar: { name, userId, shirt: string | null, pants: string | null, body: Array<[string, number]> }`.
- Produces: `avatar::resolve(username, online) -> Result<Resolved, String>` with `Resolved { name, user_id, avatar, shirt: Option<Arc<[u8]>>, pants: Option<Arc<[u8]>> }`.

- [ ] Add the button and panel with submit/close/error/loading states.
- [ ] Socket loop sends loading, spawns `spawn_blocking(resolve)`, then sends `Command::Avatar`; a request generation drops stale answers.
- [ ] Session stores the PNGs in `Shared.images`, records hashes, applies the avatar, and includes the URLs/body map in `PlayerInfo`.
- [ ] Browser draws R6 clothing with the reference rectangles.
- [ ] Test: unknown username returns an error; known username produces two PNG hashes and a body map; no shirt still renders.

### Task 4: R6 animations

**Files:**
- Modify: `apps/rook-web-server/src/avatar.rs` (fetch/parse animation clips)
- Modify: `apps/rook-web-server/src/session.rs` (`animate`)
- Modify: `web-client/src/protocol.ts` only if the session must announce animation support (no wire change expected).

**Interfaces:**
- Produces: `AnimationSet { idle, walk, jump, fall, climb, sit: Clip }`, `Clip { duration, tracks: Vec<(String, Vec<(f32, CFrame)>)> }`.
- Produces: session `animate(dt)` writing `Motor6D.Transform` for the local character's joints each tick.

- [ ] Fetch the six R6 animation asset files once when an avatar is applied; parse `KeyframeSequence`/`Keyframe`/`Pose`.
- [ ] Each tick read the Humanoid state and root horizontal speed; choose idle/walk/jump/fall/climb; sample and write transforms.
- [ ] Test: sampling a clip at its start/mid/end returns the authored CFrames; a state change restarts the clip.
- [ ] Confirm limbs move in the browser.

### Task 5: Local lights

**Files:**
- Modify: `apps/rook-web-server/src/protocol.rs` (light structs)
- Modify: `apps/rook-web-server/src/snapshot.rs` (serialize `Scene::lights`)
- Modify: `apps/rook-web-server/src/session.rs` (welcome + changed-only light delta)
- Modify: `web-client/src/protocol.ts`, `web-client/src/world.ts`

**Interfaces:**
- Produces: `LightSnapshot { position, kind, direction, color, brightness, range, shadows }`.
- Produces: `Welcome.lights` and `Snapshot.lights?: LightSnapshot[]`.

- [ ] Serialize point, spot and surface lights; send only on change.
- [ ] Create `THREE.PointLight`/`SpotLight` with linear falloff; cap to the nearest 24.
- [ ] Test: a room with a PointLight has a nonzero light near it; an unchanged scene sends no light delta.
- [ ] Verify an enclosed lit room is no longer dark.

### Task 6: Verify and ship

- [ ] `cargo fmt --all -- --check`
- [ ] `cargo clippy -p rook-web-server --all-targets -- -D warnings`
- [ ] `cargo check -p rook-client -p rook-lua`
- [ ] `npx tsc --noEmit` and `npm run build` in `web-client`
- [ ] Smoke test: move, stop, jump, avatar lookup, lights.
- [ ] Push `web-port`, mirror to `main`, confirm CI, ask for a phone retest.
