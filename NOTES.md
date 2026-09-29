# Sketchpact devlog

## M1: canvas + state server + sync
- Server: plain `http` + `ws` on 127.0.0.1. `GET/PUT /api/scene`, `/ws`, `/health`. Persists to `.sketchpact/canvas.excalidraw` (atomic tmp+rename). Port 3210, falls back to a random port; `.sketchpact/server.json` records the actual one.
- Tested at the server's HTTP+WS seam only (vitest, real server on port 0): health, empty scene, PUT + restart persistence, WS initial scene + relay to other clients, API writes pushed to WS clients.
- Web: Vite + React + `<Excalidraw/>`. Debounced (250ms) push of elements over WS; remote updates applied with `updateScene`. The Vite dev server proxies `/api` and `/ws`; the built app is served by the canvas server from `dist/web`.
- Surprise: Excalidraw loads fonts from a CDN by default, which breaks the no-internet constraint. Fix: `EXCALIDRAW_ASSET_PATH=/excalidraw-assets/` (set in its own module because ES imports are hoisted) and fonts copied from `node_modules` by `scripts/copy-assets.mjs` (postinstall). Verified: zero non-local requests on page load.
- Verified in a browser: seeded scene renders; dragging a shape pushes to the server and `customData.sketchpactId` survives the round trip (the sticky-id plan works).
- Known gap: last-writer-wins on the whole element array. Fine for turn-taking (one editor at a time), revisit if M6 needs concurrent editors.
