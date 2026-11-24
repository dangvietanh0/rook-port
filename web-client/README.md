# Rook web client

Vite + TypeScript + Three.js. See `docs/web-port.md` at the repository root
for the protocol and how to run it.

```sh
npm install
npm run dev     # proxies /api and /ws to 127.0.0.1:8080
npm run build   # dist/, served by rook-web-server
```

Source layout:

- `src/protocol.ts` — the MessagePack wire types, mirrored from
  `apps/rook-web-server/src/protocol.rs`.
- `src/net.ts` — WebSocket connection and reconnection.
- `src/mesh.ts` — the `RKMW` mesh blob reader, mesh cache and image textures.
- `src/materials.ts` — Roblox material presets and the Three materials.
- `src/world.ts` — the scene, part instancing, decals, lighting and sky.
- `src/main.ts` — input injection, the free camera and the HUD.
