import { defineConfig } from "vite";

// The built client is served by rook-web-server; `npm run dev` proxies the
// API and WebSocket to it while Vite serves the sources with hot reload.
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8080",
      "/ws": {
        target: "ws://127.0.0.1:8080",
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    target: "es2022",
  },
});
