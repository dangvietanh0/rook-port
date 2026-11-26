# Web port: Roblox-standard R6 avatars, animations, local lights, and lower latency

Status: proposed, awaiting approval.

## Intent

The web port currently draws the place's custom `StarterCharacter` and only
reads body colours and scales from the avatar API. It also buffers movement
at 33 ms input / 50 ms snapshot / 50 ms interpolation / ~62 ms camera
smoothing, and it never sends `Scene::lights` to the browser. This change
makes the player's look and motion match Roblox's classic R6 avatar, and
makes lights inside enclosed rooms actually light them.

## Decisions

- **R6 classic.** Standard R6 body, body colours, classic Shirt/Pants, face,
  and the official R6 idle/walk/jump/fall/climb clips.
- **The player chooses the avatar in-game.** A panel in the existing HUD
  opens and closes without leaving the game; the player types a Roblox
  username and submits it. The server resolves the name, fetches the look,
  and swaps the character. No `--username` flag and no restart.
- **Standard avatar mode starts on the first accepted username.** The player
  is already in the place as the local player, so the first avatar applies
  to that player: rename it, set its `UserId`, mark it standard, force
  `StarterPlayer.GameSettingsAvatar = R6`, and respawn it. The place's
  `StarterCharacter` is bypassed for this player (not destroyed, so bots and
  other place code that clone it keep working).
- **No R15 clothing compositor in this pass.** R15 body colours and scales
  stay as they are; R15 can get the same treatment later.
- **Accessories are out of scope for this pass.** Shirt, pants, and face are
  the visible avatar assets. Hats/hair can reuse the same pipeline later.
- **No embedded animation data.** Standard clips are fetched from Roblox at
  runtime and parsed into keyframes.

## Latency

The server and browser run on the same machine, so the delay is buffering,
not network distance. Remove it at the source:

1. Browser sends `Move` every animation frame, capped at 60 Hz.
2. Server snapshots every simulation tick (60 Hz) instead of every 50 ms.
3. The local player is drawn from the latest authoritative transform, with
   no interpolation delay. Remote parts keep the existing interpolation.
4. The camera follows the local root immediately; drop the `FOLLOW_RATE`
   smoothing.
5. Keep the server authoritative. No client-side movement prediction is
   added in this pass.

This takes the local input-to-pixels path from roughly 150–200 ms to one
server tick plus one frame.

## In-game avatar panel

The HUD gains a player button beside the stats and fullscreen buttons. It
toggles a small panel laid out like the stats panel, so the existing controls
do not move. The panel holds a username field, a submit button, a close
button, and one status line.

- Opening the panel pauses movement input from the keyboard and the
  joystick until it closes, and the page does not send movement while the
  panel is open. Camera look can continue.
- Submitting sends `{ kind: "avatar", username }`. The panel shows
  "Looking up <name>…" and disables submit.
- The server answers with an `avatar` status message: `loading`, `error`
  (unknown user, network failure, no clothing), or `ready` once the new
  character exists.
- On `ready`, the panel shows the resolved name and closes after a short
  delay; the player can open it again and apply another username at any time.
- Escape and the close button dismiss the panel without changing the
  avatar. A failed request leaves the old character untouched.
- The panel is reachable on touch, has a 44 px hit target, and sits above the
  joystick and jump button.

The server handles avatar requests off the simulation thread:

1. `POST users.roblox.com/v1/usernames/users` resolves the name to
   `(id, name)`.
2. `GET avatar.roblox.com/v1/users/{id}/avatar` gives body colours, rig, and
   the Shirt/Pants/Face assets.
3. For a Shirt or Pants asset, fetch the asset, read its template image ID,
   and download the 585×559 PNG. Store both PNGs in `Shared` and announce
   them like any other image; `PlayerInfo.avatar` carries their
   `/api/image/{hash}` URLs.
4. For a Face asset, resolve its image ID and set the R6 Head's `face` Decal
   to `rbxassetid://<image>`; otherwise keep the default
   `rbxasset://textures/face.png`.
5. Send the resolved name, user ID, colours, and R6 rig to the session
   thread as one command. The session applies it to the server DataModel
   through `Game::apply_avatar` (`ToServer::Avatar`), writes the clothing
   hashes into `PlayerInfo`, and announces the result.

`PlayerInfo` gains `avatar`: the resolved name and user ID, the six body-part
net ids by R6 role, and the shirt/pants URLs. The engine's `dress` still
paints body colours. The browser composites the classic 585×559 templates
over those part colours.

The browser uses the reference `game.js` face rectangles for Torso, arms and
legs. Player body parts are drawn individually rather than in an instanced
pool so each can get its own clothing materials. `BoxGeometry`'s six groups
and UVs already match the reference's `o_` mapping; each face gets a cropped
canvas texture of that part's rectangle, in the order +X, −X, +Y, −Y, +Z,
−Z. If either template fails to load, that garment falls back to plain body
colour.

## R6 animations

- Fetch the standard R6 animation IDs from `humanoidR6AnimateChildren.rbxm`
  (idle `180435571`, walk/run `180426354`, jump `125750702`, fall
  `180436148`, climb `180436334`).
- Parse each `KeyframeSequence` into per-body-part tracks of
  `(time, CFrame)` using `rook-formats`.
- Each tick, read the local Humanoid's state and speed from the engine.
  Pick idle, walk, jump, fall, or climb; restart the clip on a state change.
- Sample between keyframes and write the pose CFrame to the matching
  `Motor6D.Transform`. Physics already applies that transform, so the
  server stays authoritative and remote snapshots show the animation.
- Walk speed scales clip playback with horizontal speed; jump uses the
  ascending half, fall the descending half.

## Local lights

- Add `lights` to the welcome and an optional `lights` delta to snapshots.
  Each entry carries position, kind (point/spot/surface), direction, angle,
  sRGB colour, brightness, range, and shadows.
- Serialize `Scene::lights` as-is; send the list again only when it changes.
- The browser creates `THREE.PointLight` and `THREE.SpotLight` objects with
  `distance = 0.8 * range + 5.5` and `decay = 1` (linear falloff, matching
  the measured Roblox curve), and intensity scaled from `Brightness`.
- Cap active local lights by distance to the camera (nearest 24) so mobile
  GPU shader cost stays bounded.
- No ambient/emissive workaround: rooms become light because their lights
  arrive.

## Files

- `apps/rook-web-server/src/main.rs`: avatar WebSocket command, lookup and
  clothing fetch off the session thread, avatar status replies.
- `apps/rook-web-server/src/session.rs`: avatar apply command, animations,
  light deltas, player body map.
- `apps/rook-web-server/src/protocol.rs`: player/light snapshots, avatar
  status.
- `apps/rook-web-server/src/snapshot.rs`: light serialization.
- `apps/rook-web-server/src/avatar.rs` (new): username, avatar JSON,
  clothing, face, animation fetching/parsing.
- `crates/rook-engine/src/session/host.rs` and `host/server.rs`:
  `ToServer::Avatar`, standard-avatar player flag, R6 override and respawn.
- `crates/rook-client/src/game.rs`: `apply_avatar` reaching the server thread.
- `crates/rook-lua/src/api/methods/characters/appearance.rs`: public avatar
  parser from the API JSON.
- `crates/rook-lua/src/api/methods/characters/rigs.rs`: standard-avatar
  override for `StarterCharacter`, default R6 face Decal.
- `web-client/index.html`, `style.css`, `main.ts`: avatar button and panel.
- `web-client/src/protocol.ts`: player body/avatar and lights.
- `web-client/src/world.ts`: 60 Hz interpolation window, local parts skip it,
  R6 clothing compositor, local light rendering.
- `web-client/src/player-camera.ts`: immediate follow.

## Failure and fallbacks

- Unknown username: the panel shows "no Roblox user named …"; the old
  character stays.
- Network or avatar API failure: the panel shows the reason; the old
  character stays.
- Clothing template failure: standard R6 body with body colours and default
  face; the status line says clothing was unavailable.
- Animation fetch/parse failure: static standard R6 body; log the reason.
- `--offline`: the panel still opens but reports that avatar lookup needs a
  network connection.

## Verification

- Unit/parse tests for avatar JSON, clothing XML, and keyframe sampling.
- `cargo check`, clippy, fmt; `npx tsc --noEmit`; `npm run build`.
- Smoke test: move, stop, jump, respawn; assert the standard R6 rig and
  clothing URLs are in the welcome after an avatar command.
- Phone check: latency, panel open/close, visible shirt/pants/face,
  walking/falling animation, and an enclosed room with a PointLight.
