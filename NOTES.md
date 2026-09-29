# Sketchpact devlog

## M1: canvas + state server + sync
- Server: plain `http` + `ws` on 127.0.0.1. `GET/PUT /api/scene`, `/ws`, `/health`. Persists to `.sketchpact/canvas.excalidraw` (atomic tmp+rename). Port 3210, falls back to a random port; `.sketchpact/server.json` records the actual one.
- Tested at the server's HTTP+WS seam only (vitest, real server on port 0): health, empty scene, PUT + restart persistence, WS initial scene + relay to other clients, API writes pushed to WS clients.
- Web: Vite + React + `<Excalidraw/>`. Debounced (250ms) push of elements over WS; remote updates applied with `updateScene`. The Vite dev server proxies `/api` and `/ws`; the built app is served by the canvas server from `dist/web`.
- Surprise: Excalidraw loads fonts from a CDN by default, which breaks the no-internet constraint. Fix: `EXCALIDRAW_ASSET_PATH=/excalidraw-assets/` (set in its own module because ES imports are hoisted) and fonts copied from `node_modules` by `scripts/copy-assets.mjs` (postinstall). Verified: zero non-local requests on page load.
- Verified in a browser: seeded scene renders; dragging a shape pushes to the server and `customData.sketchpactId` survives the round trip (the sticky-id plan works).
- Known gap: last-writer-wins on the whole element array. Fine for turn-taking (one editor at a time), revisit if M6 needs concurrent editors.

## M2: semantic scene, diff, formatters (`src/shared`)
- Tested at three function seams (`extractScene`, `diffScenes`, `formatScene`/`formatDiff`) with hand-built element fixtures in `test/fixtures/elements.ts`. 28 tests total.
- Id decision: semantic id = `customData.sketchpactId`, falling back to the Excalidraw element id. Excalidraw ids are already stable across edits, so user-drawn shapes need no id assignment. The "sticky ids" idea reduces to "ops stamp the agent's chosen id into customData". Simpler than planned.
- Clusters: a frame is a cluster. A group counts only if it has 2+ shapes (a shape and its bound label share a `groupIds` entry, so a lone shape's group is noise). Nested groups resolve to the outermost id. A frame wins over a group.
- Warnings (`unlabeled`, `unbound start/end`) live in the scene and are diffed as added/removed, so the agent hears about half-drawn arrows the user leaves behind. An arrow bound to a non-node (e.g. a text note) counts as unbound.
- Diff ignores geometry and style entirely (test: move + recolor + resize yields an empty diff). A shape kind change (rect -> ellipse) is deliberately not reported.
- Diff output format is line-based rather than YAML (`+node`, `-node`, `~node`, `~edge`, `>node` for cluster moves, `!warning`), which is the cheapest thing that reads unambiguously.
- Dead end: my first edge test failed after adding warnings because its fixture had unlabeled nodes. The behaviour was right, the fixture was sloppy. Fixed the fixture.
- Not covered yet: text bound to arrows inside frames, arrows connected to frames, elements with `frameId` pointing at a deleted frame (treated as no cluster).
